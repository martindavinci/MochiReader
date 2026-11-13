// SPDX-License-Identifier: GPL-3.0-or-later
//! The engine pack: ONNX Runtime and eSpeak NG, downloaded once as a zip, checked, unpacked into its own folder, and
//! loaded from there by full path, never from wherever Windows would look.

use super::espeak::Espeak;
use super::paths::PART_SUFFIX;
use super::TtsError;
use std::fs::File;
use std::path::{Path, PathBuf};

pub const ONNX_RUNTIME: &str = "onnxruntime.dll";
pub const ESPEAK: &str = "espeak-ng.dll";
pub const ESPEAK_DATA: &str = "espeak-ng-data";
/// A file every eSpeak voice needs: without it the data folder is not whole.
const ESPEAK_PHONEMES: &str = "phontab";
const VERSION_FILE: &str = "VERSION";
/// The oldest ONNX Runtime the pinned `ort` speaks to (its API 17).
const MIN_ORT_MINOR: u32 = 17;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineState {
    Missing,
    Ready { bytes: u64 },
    Broken(String),
}

fn broken(message: impl std::fmt::Display) -> TtsError {
    TtsError::Engine(message.to_string())
}

fn required(dir: &Path) -> [PathBuf; 4] {
    [
        dir.join(ONNX_RUNTIME),
        dir.join(ESPEAK),
        dir.join(ESPEAK_DATA).join(ESPEAK_PHONEMES),
        dir.join(VERSION_FILE),
    ]
}

fn folder_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.metadata() {
            Ok(meta) if meta.is_dir() => folder_bytes(&entry.path()),
            Ok(meta) => meta.len(),
            Err(_) => 0,
        })
        .sum()
}

pub fn state(dir: &Path) -> EngineState {
    if !dir.exists() {
        return EngineState::Missing;
    }
    match required(dir).iter().find(|file| !file.is_file()) {
        Some(missing) => EngineState::Broken(format!("{} is missing", missing.display())),
        None => EngineState::Ready {
            bytes: folder_bytes(dir),
        },
    }
}

/// Unpacks the verified `zip` into `into` (`…\engine\1`). It goes to `…\engine\1.part` first and takes its name only
/// when whole; an entry that would land outside the folder refuses the whole pack.
pub fn install(zip: &Path, into: &Path, sha256: &str) -> Result<(), TtsError> {
    let found = crate::native::sha256(File::open(zip).map_err(broken)?).map_err(broken)?;
    if !found.eq_ignore_ascii_case(sha256) {
        return Err(broken("the engine pack is not the one expected"));
    }
    let mut part = into.as_os_str().to_owned();
    part.push(PART_SUFFIX);
    let part = PathBuf::from(part);
    let outcome = unpack(zip, &part).and_then(|()| match state(&part) {
        EngineState::Ready { .. } => {
            if into.exists() {
                std::fs::remove_dir_all(into).map_err(broken)?;
            }
            std::fs::rename(&part, into).map_err(broken)
        }
        EngineState::Broken(why) => Err(broken(why)),
        EngineState::Missing => Err(broken("the engine pack is empty")),
    });
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&part);
    }
    outcome
}

fn unpack(zip: &Path, into: &Path) -> Result<(), TtsError> {
    if into.exists() {
        std::fs::remove_dir_all(into).map_err(broken)?;
    }
    std::fs::create_dir_all(into).map_err(broken)?;
    let mut archive = zip::ZipArchive::new(File::open(zip).map_err(broken)?).map_err(broken)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(broken)?;
        let Some(name) = entry.enclosed_name() else {
            return Err(broken(format!(
                "the engine pack has an entry outside its folder: {:?}",
                entry.name()
            )));
        };
        let target = into.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(broken)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(broken)?;
        }
        let mut out = File::create(&target).map_err(broken)?;
        std::io::copy(&mut entry, &mut out).map_err(broken)?;
    }
    Ok(())
}

/// The engine, loaded: what Piper needs to make sound.
pub struct Loaded {
    pub environment: ort::environment::Environment,
    pub espeak: Espeak,
}

/// Loads ONNX Runtime and eSpeak from `dir`. ONNX Runtime can be loaded once per run of the app.
pub fn load(dir: &Path) -> Result<Loaded, TtsError> {
    if let EngineState::Broken(why) = state(dir) {
        return Err(broken(why));
    }
    crate::native::add_library_folder(dir).map_err(broken)?;
    let runtime = dir.join(ONNX_RUNTIME);
    match ort::util::probe(&runtime) {
        Some(minor) if minor >= MIN_ORT_MINOR => {}
        Some(minor) => return Err(broken(format!("ONNX Runtime 1.{minor} is too old"))),
        None => return Err(broken("ONNX Runtime did not load")),
    }
    let environment = ort::init_from(&runtime)
        .map_err(broken)?
        .with_name("MochiReader")
        .build()
        .map_err(broken)?;
    let espeak = Espeak::load(&dir.join(ESPEAK), dir)?;
    Ok(Loaded {
        environment,
        espeak,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn pack(dir: &Path, entries: &[(&str, &[u8])]) -> (PathBuf, String) {
        let path = dir.join("engine.zip");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        let sha = crate::native::sha256(File::open(&path).unwrap()).unwrap();
        (path, sha)
    }

    const WHOLE: [(&str, &[u8]); 4] = [
        ("onnxruntime.dll", b"ort"),
        ("espeak-ng.dll", b"espeak"),
        ("espeak-ng-data/phontab", b"data"),
        ("VERSION", b"1"),
    ];

    #[test]
    fn a_whole_engine_zip_is_installed() {
        let dir = tempfile::tempdir().unwrap();
        let (zip, sha) = pack(dir.path(), &WHOLE);
        let into = dir.path().join("engine").join("1");
        install(&zip, &into, &sha).unwrap();
        assert!(matches!(state(&into), EngineState::Ready { bytes } if bytes > 0));
        assert!(!dir.path().join("engine").join("1.part").exists());
    }

    #[test]
    fn an_engine_zip_with_a_parent_path_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut entries = WHOLE.to_vec();
        entries.push(("../evil.dll", b"evil"));
        let (zip, sha) = pack(dir.path(), &entries);
        let into = dir.path().join("engine").join("1");
        assert!(matches!(
            install(&zip, &into, &sha),
            Err(TtsError::Engine(_))
        ));
        assert!(!into.exists());
        assert!(!dir.path().join("engine").join("evil.dll").exists());
        assert!(!dir.path().join("engine").join("1.part").exists());
    }

    #[test]
    fn an_engine_folder_missing_a_file_is_broken() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(ONNX_RUNTIME), b"ort").unwrap();
        assert!(matches!(state(dir.path()), EngineState::Broken(_)));
        assert_eq!(state(&dir.path().join("none")), EngineState::Missing);
    }

    #[test]
    fn an_engine_zip_with_a_wrong_hash_installs_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (zip, _) = pack(dir.path(), &WHOLE);
        let into = dir.path().join("engine").join("1");
        assert!(install(&zip, &into, &"0".repeat(64)).is_err());
        assert!(!into.exists());
    }
}
