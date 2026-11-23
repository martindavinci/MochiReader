// SPDX-License-Identifier: GPL-3.0-or-later
//! The reader's own voices: two or three Kokoro voices mixed, each with a weight. Only the recipe is kept, in
//! `mixes.json` beside the voices; the sound comes from the styles of the voices it names.

use super::catalog::Catalog;
use super::TtsError;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub const MIXES_FILE: &str = "mixes.json";
const MIN_PARTS: usize = 2;
const MAX_PARTS: usize = 3;
const MAX_WEIGHT: f32 = 100.0;
const MAX_NAME: usize = 40;
const MAX_ID: usize = 32;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixPart {
    pub voice: String,
    pub weight: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mix {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub parts: Vec<MixPart>,
}

/// A mix as the voice manager shows it: the names of the voices it needs that are not on this PC.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixView {
    pub mix: Mix,
    pub missing: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct MixesFile {
    version: u32,
    mixes: Vec<Mix>,
}

fn refused(message: impl Into<String>) -> TtsError {
    TtsError::Refused(message.into())
}

/// A fresh id: eight lowercase hex digits.
fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos() as u64);
    let mixed = now
        ^ COUNTER
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("{:08x}", (mixed ^ (mixed >> 32)) as u32)
}

/// The mix as it is kept: its name trimmed, its weights adding up to 1, an id when it had none. Refused: a name empty
/// or longer than 40, fewer than 2 or more than 3 voices, a voice that is not a Kokoro voice or comes twice, a weight
/// outside 0–100, all weights 0, a language none of its voices speaks.
pub fn validate(mix: &Mix, catalog: &Catalog) -> Result<Mix, TtsError> {
    let name = mix.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME {
        return Err(refused("a mix needs a name of 1 to 40 characters"));
    }
    if !(MIN_PARTS..=MAX_PARTS).contains(&mix.parts.len()) {
        return Err(refused("a mix has two or three voices"));
    }
    let id = if mix.id.is_empty() {
        new_id()
    } else if mix.id.len() <= MAX_ID
        && mix
            .id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
    {
        mix.id.clone()
    } else {
        return Err(refused("not the id of a mix"));
    };
    let mut langs = Vec::new();
    for (index, part) in mix.parts.iter().enumerate() {
        let voice = catalog
            .kokoro_voice(&part.voice)
            .ok_or_else(|| refused(format!("{} is not a Kokoro voice", part.voice)))?;
        if mix.parts[..index]
            .iter()
            .any(|before| before.voice == part.voice)
        {
            return Err(refused(format!("{} comes twice", part.voice)));
        }
        if !(0.0..=MAX_WEIGHT).contains(&part.weight) {
            return Err(refused("a weight goes from 0 to 100"));
        }
        langs.push(voice.lang.as_str());
    }
    let sum: f32 = mix.parts.iter().map(|part| part.weight).sum();
    if sum <= 0.0 {
        return Err(refused("at least one voice weighs more than 0"));
    }
    if !langs.contains(&mix.lang.as_str()) {
        return Err(refused(
            "the language of a mix is the language of one of its voices",
        ));
    }
    Ok(Mix {
        id,
        name: name.to_owned(),
        lang: mix.lang.clone(),
        parts: mix
            .parts
            .iter()
            .map(|part| MixPart {
                voice: part.voice.clone(),
                weight: part.weight / sum,
            })
            .collect(),
    })
}

/// The mixes kept in `path`; none when it is not there or does not read (the file is left as it is).
pub fn load(path: &Path) -> Vec<Mix> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<MixesFile>(&bytes).ok())
        .map(|file| file.mixes)
        .unwrap_or_default()
}

pub fn store(path: &Path, mixes: &[Mix]) -> Result<(), TtsError> {
    let file = MixesFile {
        version: 1,
        mixes: mixes.to_vec(),
    };
    let bytes =
        serde_json::to_vec_pretty(&file).map_err(|error| TtsError::Voice(error.to_string()))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| TtsError::Voice(error.to_string()))?;
    }
    let part = super::paths::part_of(path);
    std::fs::write(&part, bytes)
        .and_then(|()| std::fs::rename(&part, path))
        .map_err(|error| {
            let _ = std::fs::remove_file(&part);
            TtsError::Voice(error.to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::manager::testing::kokoro_catalog_with;

    fn mix(parts: &[(&str, f32)], lang: &str) -> Mix {
        Mix {
            id: String::new(),
            name: " Mia voce ".into(),
            lang: lang.into(),
            parts: parts
                .iter()
                .map(|(voice, weight)| MixPart {
                    voice: (*voice).into(),
                    weight: *weight,
                })
                .collect(),
        }
    }

    fn catalog() -> Catalog {
        kokoro_catalog_with(b"model", b"voice")
    }

    #[test]
    fn weights_are_normalized() {
        let valid = validate(
            &mix(&[("if_sara", 40.0), ("af_heart", 60.0)], "it-IT"),
            &catalog(),
        )
        .unwrap();
        assert!((valid.parts[0].weight - 0.4).abs() < 1e-6);
        assert!((valid.parts[1].weight - 0.6).abs() < 1e-6);
        assert_eq!(valid.name, "Mia voce");
        assert_eq!(valid.id.len(), 8);
        assert!(valid
            .id
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()));
    }

    #[test]
    fn a_mix_keeps_its_id() {
        let mut kept = mix(&[("if_sara", 50.0), ("af_heart", 50.0)], "en-US");
        kept.id = "0a1b2c3d".into();
        assert_eq!(validate(&kept, &catalog()).unwrap().id, "0a1b2c3d");
        kept.id = "../x".into();
        assert!(matches!(
            validate(&kept, &catalog()),
            Err(TtsError::Refused(_))
        ));
    }

    #[test]
    fn one_part_is_refused() {
        assert!(matches!(
            validate(&mix(&[("if_sara", 50.0)], "it-IT"), &catalog()),
            Err(TtsError::Refused(_))
        ));
    }

    #[test]
    fn four_parts_are_refused() {
        let four = mix(
            &[
                ("if_sara", 1.0),
                ("af_heart", 1.0),
                ("if_sara", 1.0),
                ("af_heart", 1.0),
            ],
            "it-IT",
        );
        assert!(matches!(
            validate(&four, &catalog()),
            Err(TtsError::Refused(_))
        ));
    }

    #[test]
    fn all_zero_is_refused() {
        let zero = mix(&[("if_sara", 0.0), ("af_heart", 0.0)], "it-IT");
        assert!(matches!(
            validate(&zero, &catalog()),
            Err(TtsError::Refused(_))
        ));
        let out_of_range = mix(&[("if_sara", 120.0), ("af_heart", 1.0)], "it-IT");
        assert!(matches!(
            validate(&out_of_range, &catalog()),
            Err(TtsError::Refused(_))
        ));
        let nan = mix(&[("if_sara", f32::NAN), ("af_heart", 1.0)], "it-IT");
        assert!(matches!(
            validate(&nan, &catalog()),
            Err(TtsError::Refused(_))
        ));
    }

    #[test]
    fn unknown_voice_is_refused() {
        let unknown = mix(&[("if_sara", 50.0), ("it_IT-paola-medium", 50.0)], "it-IT");
        assert!(matches!(
            validate(&unknown, &catalog()),
            Err(TtsError::Refused(_))
        ));
    }

    #[test]
    fn same_voice_twice_is_refused() {
        let twice = mix(&[("if_sara", 50.0), ("if_sara", 50.0)], "it-IT");
        assert!(matches!(
            validate(&twice, &catalog()),
            Err(TtsError::Refused(_))
        ));
    }

    #[test]
    fn lang_must_be_a_parts_lang() {
        let french = mix(&[("if_sara", 50.0), ("af_heart", 50.0)], "fr-FR");
        assert!(matches!(
            validate(&french, &catalog()),
            Err(TtsError::Refused(_))
        ));
    }

    #[test]
    fn a_name_is_needed_and_short() {
        let mut nameless = mix(&[("if_sara", 50.0), ("af_heart", 50.0)], "it-IT");
        nameless.name = "   ".into();
        assert!(matches!(
            validate(&nameless, &catalog()),
            Err(TtsError::Refused(_))
        ));
        nameless.name = "x".repeat(41);
        assert!(matches!(
            validate(&nameless, &catalog()),
            Err(TtsError::Refused(_))
        ));
    }

    #[test]
    fn a_broken_mixes_file_is_no_mixes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(MIXES_FILE);
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(load(&path).is_empty());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"{ not json",
            "left as it is"
        );
        assert!(load(&dir.path().join("none.json")).is_empty());
    }

    #[test]
    fn saved_mixes_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(MIXES_FILE);
        let valid = validate(
            &mix(&[("if_sara", 70.0), ("af_heart", 30.0)], "it-IT"),
            &catalog(),
        )
        .unwrap();
        store(&path, std::slice::from_ref(&valid)).unwrap();
        assert_eq!(load(&path), vec![valid]);
    }
}
