// SPDX-License-Identifier: GPL-3.0-or-later
//! The engine: ONNX Runtime and eSpeak NG, installed with the app in its `engine` folder and loaded from there by full
//! path, never from wherever Windows would look.

use super::espeak::Espeak;
use super::TtsError;
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

/// The engine of this process: ONNX Runtime allows one environment per process, so whoever needs it after the first
/// gets the one already loaded (the app has one `Voices`; the engine tests make several in one process).
pub fn shared(dir: &Path) -> Result<std::sync::Arc<Loaded>, TtsError> {
    static LOADED: std::sync::Mutex<Option<std::sync::Arc<Loaded>>> = std::sync::Mutex::new(None);
    let mut loaded = LOADED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(found) = loaded.as_ref() {
        return Ok(std::sync::Arc::clone(found));
    }
    let made = std::sync::Arc::new(load(dir)?);
    *loaded = Some(std::sync::Arc::clone(&made));
    Ok(made)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_whole_engine_folder_is_ready() {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in [
            (ONNX_RUNTIME, &b"ort"[..]),
            (ESPEAK, b"espeak"),
            ("espeak-ng-data/phontab", b"data"),
            (VERSION_FILE, b"1"),
        ] {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        assert!(matches!(state(dir.path()), EngineState::Ready { bytes } if bytes > 0));
    }

    #[test]
    fn an_engine_folder_missing_a_file_is_broken() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(ONNX_RUNTIME), b"ort").unwrap();
        assert!(matches!(state(dir.path()), EngineState::Broken(_)));
        assert_eq!(state(&dir.path().join("none")), EngineState::Missing);
    }
}
