// SPDX-License-Identifier: GPL-3.0-or-later
//! The translation models the app offers, from app/translate/models.json (tools/translation-catalog.mjs), which is
//! built into the program: listing them never asks anything of the network.

use crate::tts::catalog::RemoteFile;
use crate::tts::TtsError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const EMBEDDED: &str = include_str!("../../../app/translate/models.json");

/// One direction between two languages, at one version: a model, its shortlist and one or two vocabularies.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Pair {
    pub from: String,
    pub to: String,
    pub version: String,
    /// By kind: `model`, `lex`, and `vocab` or `srcvocab` and `trgvocab`.
    pub files: BTreeMap<String, RemoteFile>,
}

impl Pair {
    /// `en-it`.
    pub fn id(&self) -> String {
        format!("{}-{}", self.from, self.to)
    }

    pub fn bytes(&self) -> u64 {
        self.files.values().map(|file| file.bytes).sum()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Catalog {
    pub version: u32,
    pub pairs: Vec<Pair>,
}

impl Catalog {
    pub fn embedded() -> Result<Self, TtsError> {
        Self::parse(EMBEDDED)
    }

    pub fn parse(text: &str) -> Result<Self, TtsError> {
        serde_json::from_str(text).map_err(|error| {
            TtsError::Refused(format!("the translation catalog does not parse: {error}"))
        })
    }

    pub fn pair(&self, id: &str) -> Option<&Pair> {
        self.pairs.iter().find(|pair| pair.id() == id)
    }
}

/// `2.1` against `2.0`, part by part as numbers.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |text: &str| -> Vec<u64> {
        text.split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parts(a), parts(b));
    let len = a.len().max(b.len());
    (0..len)
        .map(|i| a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0)))
        .find(|order| order.is_ne())
        .unwrap_or(std::cmp::Ordering::Equal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_catalog_parses_and_has_english_to_italian() {
        let catalog = Catalog::embedded().unwrap();
        let pair = catalog.pair("en-it").unwrap();
        assert!(pair.files.contains_key("model") && pair.files.contains_key("lex"));
        assert!(pair.bytes() > 10_000_000);
    }

    #[test]
    fn versions_compare_as_numbers() {
        use std::cmp::Ordering::*;
        assert_eq!(compare_versions("2.10", "2.9"), Greater);
        assert_eq!(compare_versions("2.0", "2"), Equal);
        assert_eq!(compare_versions("1.0", "2.1"), Less);
    }
}
