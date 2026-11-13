// SPDX-License-Identifier: GPL-3.0-or-later
//! The voices the app offers, from app/speech/voices.json, which is built into the program: the page and Rust read the
//! same list, and nobody can change it without a new release.

use super::TtsError;
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Catalog {
    pub version: u32,
    #[serde(default)]
    pub unavailable: Vec<String>,
    pub voices: Vec<CatalogVoice>,
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
}
