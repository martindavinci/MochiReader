// SPDX-License-Identifier: GPL-3.0-or-later
//! The voices the app offers, from app/speech/voices.json, which is built into the program: the page and Rust read the
//! same list, and nobody can change it without a new release.

use super::TtsError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const EMBEDDED: &str = include_str!("../../../app/speech/voices.json");

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct RemoteFile {
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct CatalogVoice {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub quality: String,
    pub license: String,
    pub card: String,
    pub sample: String,
    #[serde(default)]
    pub speaker: i64,
    pub model: RemoteFile,
    pub config: RemoteFile,
}

/// A Kokoro voice: a 510×256 style matrix of float32, read by the one Kokoro model.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct KokoroVoice {
    pub id: String,
    pub name: String,
    pub lang: String,
    /// The Overall Grade its author gives it; empty when it has none.
    pub grade: String,
    pub file: RemoteFile,
}

/// The Kokoro model shared by every Kokoro voice, its vocabulary (phoneme → token id) and its voices.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct KokoroCatalog {
    pub commit: String,
    pub license: String,
    pub card: String,
    pub model: RemoteFile,
    pub vocab: HashMap<String, i64>,
    pub voices: Vec<KokoroVoice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Catalog {
    pub version: u32,
    #[serde(default)]
    pub unavailable: Vec<String>,
    pub voices: Vec<CatalogVoice>,
    #[serde(default)]
    pub kokoro: Option<KokoroCatalog>,
}

impl Catalog {
    pub fn embedded() -> Result<Self, TtsError> {
        Self::parse(EMBEDDED)
    }

    pub fn parse(text: &str) -> Result<Self, TtsError> {
        serde_json::from_str(text)
            .map_err(|error| TtsError::Voice(format!("the catalog does not parse: {error}")))
    }

    pub fn voice(&self, id: &str) -> Option<&CatalogVoice> {
        self.voices.iter().find(|voice| voice.id == id)
    }

    pub fn kokoro_voice(&self, id: &str) -> Option<&KokoroVoice> {
        self.kokoro
            .as_ref()?
            .voices
            .iter()
            .find(|voice| voice.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_catalog_parses() {
        let catalog = Catalog::embedded().unwrap();
        assert!(!catalog.voices.is_empty());
        let paola = catalog.voice("it_IT-paola-medium").unwrap();
        assert_eq!(paola.lang, "it-IT");
        assert!(catalog.voice("../x").is_none());
    }

    #[test]
    fn the_embedded_catalog_has_kokoro() {
        let catalog = Catalog::embedded().unwrap();
        assert_eq!(catalog.kokoro_voice("if_sara").unwrap().lang, "it-IT");
        assert!(catalog.kokoro_voice("../x").is_none());
        assert!(catalog.kokoro.as_ref().unwrap().vocab.len() >= 100);
    }
}
