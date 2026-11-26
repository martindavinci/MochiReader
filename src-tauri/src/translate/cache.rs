// SPDX-License-Identifier: GPL-3.0-or-later
//! Translated chapters on disk: `<root>/cache/<book>/<pair>-<version>/<section>.json`, one entry per translatable
//! block of the section (`null` for a block the engine left alone). `<book>` is the start of the SHA-256 of the
//! book's key, so that no path or title of a book shows in a folder name.

use crate::tts::TtsError;
use std::path::{Path, PathBuf};

const CACHE: &str = "cache";
const BOOK_NAME_CHARS: usize = 16;
const SECTION_SUFFIX: &str = ".json";

pub type Texts = Vec<Option<String>>;

fn local(error: impl std::fmt::Display) -> TtsError {
    TtsError::Refused(error.to_string())
}

pub struct Cache {
    root: PathBuf,
}

impl Cache {
    /// `root` is the translation folder, as for the models.
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.join(CACHE),
        }
    }

    fn folder(&self, key: &str, pair: &str, version: &str) -> Result<PathBuf, TtsError> {
        let plain = |text: &str| {
            !text.is_empty()
                && !text.contains("..")
                && text
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        };
        if !plain(pair) || !plain(version) {
            return Err(TtsError::Refused(format!(
                "no such translation {pair} {version}"
            )));
        }
        let book = crate::native::sha256(key.as_bytes()).map_err(local)?;
        Ok(self
            .root
            .join(&book[..BOOK_NAME_CHARS])
            .join(format!("{pair}-{version}")))
    }

    fn file(folder: &Path, section: u32) -> PathBuf {
        folder.join(format!("{section}{SECTION_SUFFIX}"))
    }

    pub fn get(
        &self,
        key: &str,
        pair: &str,
        version: &str,
        section: u32,
    ) -> Result<Option<Texts>, TtsError> {
        let file = Self::file(&self.folder(key, pair, version)?, section);
        match std::fs::read(&file) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(local(error)),
        }
    }

    pub fn put(
        &self,
        key: &str,
        pair: &str,
        version: &str,
        section: u32,
        texts: &Texts,
    ) -> Result<(), TtsError> {
        let file = Self::file(&self.folder(key, pair, version)?, section);
        let bytes = serde_json::to_vec(texts).map_err(local)?;
        crate::state::write_atomically(&file, &bytes).map_err(local)
    }

    pub fn sections(&self, key: &str, pair: &str, version: &str) -> Result<Vec<u32>, TtsError> {
        let Ok(entries) = std::fs::read_dir(self.folder(key, pair, version)?) else {
            return Ok(Vec::new());
        };
        let mut sections: Vec<u32> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter_map(|name| name.strip_suffix(SECTION_SUFFIX)?.parse().ok())
            .collect();
        sections.sort_unstable();
        Ok(sections)
    }

    /// Every book's translations with this pair, at any version.
    pub fn delete_pair(&self, pair: &str) -> Result<(), TtsError> {
        let prefix = format!("{pair}-");
        let Ok(books) = std::fs::read_dir(&self.root) else {
            return Ok(());
        };
        for book in books.filter_map(Result::ok) {
            let Ok(sets) = std::fs::read_dir(book.path()) else {
                continue;
            };
            for set in sets.filter_map(Result::ok) {
                let name = set.file_name().to_string_lossy().into_owned();
                // en-it-2.1 belongs to en-it; en-it-x… cannot be another pair, since a version starts with a digit
                let ours = name
                    .strip_prefix(&prefix)
                    .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
                if ours {
                    std::fs::remove_dir_all(set.path()).map_err(local)?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts() -> Texts {
        vec![
            Some("Capitolo uno".into()),
            None,
            Some("<i>Ciao</i>".into()),
        ]
    }

    #[test]
    fn put_then_get_returns_the_texts() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path());
        cache.put("epub:abc", "en-it", "2.1", 3, &texts()).unwrap();
        assert_eq!(
            cache.get("epub:abc", "en-it", "2.1", 3).unwrap(),
            Some(texts())
        );
    }

    #[test]
    fn a_missing_section_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path());
        assert_eq!(cache.get("epub:abc", "en-it", "2.1", 0).unwrap(), None);
    }

    #[test]
    fn sections_lists_what_was_put() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path());
        for section in [4, 0, 12] {
            cache
                .put("epub:abc", "en-it", "2.1", section, &texts())
                .unwrap();
        }
        assert_eq!(
            cache.sections("epub:abc", "en-it", "2.1").unwrap(),
            vec![0, 4, 12]
        );
        assert!(cache
            .sections("epub:other", "en-it", "2.1")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn another_version_is_another_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path());
        cache.put("epub:abc", "en-it", "2.0", 1, &texts()).unwrap();
        assert_eq!(cache.get("epub:abc", "en-it", "2.1", 1).unwrap(), None);
    }

    #[test]
    fn delete_of_a_pair_removes_its_caches_in_every_book() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path());
        cache.put("epub:a", "en-it", "2.1", 1, &texts()).unwrap();
        cache.put("epub:b", "en-it", "2.0", 1, &texts()).unwrap();
        cache.put("epub:b", "en-fr", "2.0", 1, &texts()).unwrap();
        cache.delete_pair("en-it").unwrap();
        assert_eq!(cache.get("epub:a", "en-it", "2.1", 1).unwrap(), None);
        assert_eq!(cache.get("epub:b", "en-it", "2.0", 1).unwrap(), None);
        assert_eq!(
            cache.get("epub:b", "en-fr", "2.0", 1).unwrap(),
            Some(texts())
        );
    }

    #[test]
    fn a_book_folder_does_not_show_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path());
        cache
            .put("c:/books/secret.epub", "en-it", "2.1", 1, &texts())
            .unwrap();
        let names: Vec<String> = std::fs::read_dir(dir.path().join(CACHE))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].len(), BOOK_NAME_CHARS);
        assert!(!names[0].contains("secret"));
    }

    #[test]
    fn a_pair_or_version_with_a_path_in_it_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path());
        assert!(cache.put("epub:a", "../x", "2.1", 1, &texts()).is_err());
        assert!(cache.get("epub:a", "en-it", "../2", 1).is_err());
    }
}
