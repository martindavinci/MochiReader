// SPDX-License-Identifier: GPL-3.0-or-later
//! Where the downloaded voices live: beside a portable copy, in the local app data otherwise. The engine that makes
//! them speak is part of the app, in the `engine` folder beside it.

use std::path::{Path, PathBuf};

const VOICES: &str = "voices";
/// The folder of the engine, among the resources of the app.
pub const ENGINE: &str = "engine";
pub const PART_SUFFIX: &str = ".part";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Places {
    pub voices: PathBuf,
    pub engine: PathBuf,
}

impl Places {
    /// `portable` is the `data` folder of a portable copy; `local_app_data` is where an installed copy keeps big files;
    /// `engine` is the engine folder of the app.
    pub fn resolve(portable: Option<&Path>, local_app_data: &Path, engine: &Path) -> Self {
        let root = portable.unwrap_or(local_app_data);
        Self {
            voices: root.join(VOICES),
            engine: engine.to_owned(),
        }
    }

    pub fn voice(&self, id: &str) -> PathBuf {
        self.voices.join(id)
    }
}

/// `file.onnx` → `file.onnx.part`.
pub fn part_of(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(PART_SUFFIX);
    PathBuf::from(name)
}

/// Removes what a download that never finished left behind: `*.part` files and folders, one level deep.
pub fn sweep_parts(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_part = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(PART_SUFFIX));
        if is_part {
            let _ = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        } else if path.is_dir() {
            sweep_parts_flat(&path);
        }
    }
}

fn sweep_parts_flat(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(PART_SUFFIX))
        {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_portable_copy_keeps_voices_beside_it() {
        let places = Places::resolve(
            Some(Path::new(r"D:\Mochi\data")),
            Path::new(r"C:\Users\a\AppData\Local\x"),
            Path::new(r"D:\Mochi\engine"),
        );
        assert_eq!(places.voices, Path::new(r"D:\Mochi\data\voices"));
        assert_eq!(places.engine, Path::new(r"D:\Mochi\engine"));
    }

    #[test]
    fn an_installed_copy_keeps_them_in_local_app_data() {
        let local = Path::new(r"C:\Users\a\AppData\Local\io.github.martindavinci.mochireader");
        let app = Path::new(r"C:\Users\a\AppData\Local\MochiReader\engine");
        let places = Places::resolve(None, local, app);
        assert_eq!(places.voices, local.join("voices"));
        assert_eq!(places.engine, app);
    }

    #[test]
    fn leftover_parts_are_swept_at_start() {
        let dir = tempfile::tempdir().unwrap();
        let voice = dir.path().join("it_IT-paola-medium");
        std::fs::create_dir_all(&voice).unwrap();
        std::fs::write(voice.join("model.onnx.part"), b"half").unwrap();
        std::fs::write(voice.join("model.onnx"), b"whole").unwrap();
        std::fs::create_dir_all(dir.path().join("de_DE-thorsten-medium.part")).unwrap();
        sweep_parts(dir.path());
        assert!(!voice.join("model.onnx.part").exists());
        assert!(voice.join("model.onnx").exists());
        assert!(!dir.path().join("de_DE-thorsten-medium.part").exists());
    }
}
