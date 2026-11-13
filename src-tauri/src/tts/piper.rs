// SPDX-License-Identifier: GPL-3.0-or-later
//! Piper voices: the phonemes of eSpeak become the ids of the model, ONNX Runtime turns them into sound, and the
//! length the model gives each phoneme says where each word is.

use super::espeak::Espeak;
use super::{utf16_words, Synthesis, TtsError, WordSpan};
use ort::session::Session;
use ort::value::Tensor;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

pub type PhonemeIdMap = HashMap<String, Vec<i64>>;

const BOS: &str = "^";
const EOS: &str = "$";
const PAD: &str = "_";
const SPACE: char = ' ';
/// What Piper writes after a clause: no part of any word.
const PUNCTUATION: [char; 6] = ['.', ',', ';', ':', '?', '!'];
/// Samples per frame of the length the model gives each phoneme, when the config does not say.
pub const DURATIONS_OUTPUT_HOP: usize = 256;

#[derive(Debug, Clone, Deserialize)]
pub struct Audio {
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EspeakVoice {
    pub voice: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Inference {
    pub noise_scale: f32,
    pub length_scale: f32,
    pub noise_w: f32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub audio: Audio,
    pub espeak: EspeakVoice,
    pub inference: Inference,
    pub phoneme_id_map: PhonemeIdMap,
    #[serde(default = "one")]
    pub num_speakers: u32,
    #[serde(default)]
    pub phoneme_type: Option<String>,
    #[serde(default)]
    pub hop_length: Option<usize>,
    /// Pairs of phonemes the model knows as one (piper 1.5 and later).
    #[serde(default)]
    pub vowel_clusters: Vec<Vec<String>>,
}

const fn one() -> u32 {
    1
}

/// The ids of a sentence, and for each word the indices of its ids.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Encoded {
    pub ids: Vec<i64>,
    pub groups: Vec<Vec<usize>>,
}

/// `^`, `_`, each phoneme followed by `_`, `$`, as Piper writes them. Unknown phonemes are left out.
pub fn phoneme_ids(phonemes: &str, map: &PhonemeIdMap) -> Vec<i64> {
    encode(phonemes, map, &[]).ids
}

pub fn encode(phonemes: &str, map: &PhonemeIdMap, clusters: &[Vec<String>]) -> Encoded {
    let pad = map.get(PAD).cloned().unwrap_or_default();
    let mut out = Encoded::default();
    let push = |out: &mut Encoded, key: &str| -> Option<(usize, usize)> {
        let ids = map.get(key)?;
        let first = out.ids.len();
        out.ids.extend(ids);
        out.ids.extend(&pad);
        Some((first, out.ids.len()))
    };
    if let Some(ids) = map.get(BOS) {
        out.ids.extend(ids);
        out.ids.extend(&pad);
    }
    let chars: Vec<char> = phonemes.chars().collect();
    let mut word: Option<Vec<usize>> = None;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let pair: Option<String> = chars.get(i + 1).map(|next| [ch, *next].iter().collect());
        let clustered = pair.filter(|pair| {
            map.contains_key(pair) && clusters.iter().any(|cluster| cluster.concat() == *pair)
        });
        let key = clustered.clone().unwrap_or_else(|| ch.to_string());
        i += if clustered.is_some() { 2 } else { 1 };
        if ch == SPACE || PUNCTUATION.contains(&ch) {
            out.groups.extend(word.take());
            push(&mut out, &key);
            continue;
        }
        if let Some((first, end)) = push(&mut out, &key) {
            word.get_or_insert_with(Vec::new).extend(first..end);
        }
    }
    out.groups.extend(word.take());
    if let Some(ids) = map.get(EOS) {
        out.ids.extend(ids);
    }
    out
}

/// Where each word of `text` is in the sound, from the length in frames the model gave each id. Nothing when the
/// words and the groups of phonemes do not match one to one, or when the lengths do not add up to the sound: then no
/// word is marked rather than a wrong one.
pub fn align(
    text: &str,
    groups: &[Vec<usize>],
    durations: &[f32],
    hop: usize,
    total: usize,
) -> Vec<WordSpan> {
    let words = utf16_words(text);
    if words.len() != groups.len() || groups.iter().any(Vec::is_empty) {
        return Vec::new();
    }
    let mut prefix = Vec::with_capacity(durations.len() + 1);
    let mut sum = 0usize;
    prefix.push(0);
    for frames in durations {
        sum += frames.max(0.0).round() as usize;
        prefix.push(sum);
    }
    if (sum * hop).abs_diff(total) > hop {
        return Vec::new();
    }
    let mut spans = Vec::with_capacity(words.len());
    for ((start, end), group) in words.into_iter().zip(groups) {
        let (Some(first), Some(last)) = (group.iter().min(), group.iter().max()) else {
            return Vec::new();
        };
        let (Some(from), Some(to)) = (prefix.get(*first), prefix.get(last + 1)) else {
            return Vec::new();
        };
        spans.push(WordSpan {
            start,
            end,
            from: (from * hop).min(total),
            to: (to * hop).min(total),
        });
    }
    spans
}

pub struct PiperVoice {
    pub config: Config,
    speaker: i64,
    session: Mutex<Session>,
    audio_output: String,
    durations_output: Option<String>,
}

fn engine(error: impl std::fmt::Display) -> TtsError {
    TtsError::Engine(error.to_string())
}

impl PiperVoice {
    pub fn load(
        environment: &ort::environment::Environment,
        onnx: &Path,
        config: &Path,
        speaker: i64,
    ) -> Result<Self, TtsError> {
        let text =
            std::fs::read_to_string(config).map_err(|error| TtsError::Voice(error.to_string()))?;
        let config: Config =
            serde_json::from_str(&text).map_err(|error| TtsError::Voice(error.to_string()))?;
        if config
            .phoneme_type
            .as_deref()
            .is_some_and(|kind| kind != "espeak")
        {
            return Err(TtsError::Voice(
                "the voice needs phonemes the app does not make".into(),
            ));
        }
        let session = Session::builder(environment)
            .map_err(engine)?
            .commit_from_file(onnx)
            .map_err(engine)?;
        let outputs: Vec<String> = session
            .outputs()
            .iter()
            .map(|outlet| outlet.name().to_owned())
            .collect();
        let audio_output = outputs
            .first()
            .cloned()
            .ok_or_else(|| engine("the voice gives no sound"))?;
        let durations_output = outputs.get(1).cloned();
        Ok(Self {
            config,
            speaker,
            session: Mutex::new(session),
            audio_output,
            durations_output,
        })
    }

    pub fn synthesize(&self, espeak: &Espeak, text: &str) -> Result<Synthesis, TtsError> {
        let sample_rate = self.config.audio.sample_rate;
        let phonemes = crate::native::nfd(&espeak.phonemize(&self.config.espeak.voice, text)?);
        let encoded = encode(
            &phonemes,
            &self.config.phoneme_id_map,
            &self.config.vowel_clusters,
        );
        if encoded.groups.is_empty() {
            return Ok(Synthesis {
                samples: Vec::new(),
                sample_rate,
                words: Vec::new(),
            });
        }
        let length = encoded.ids.len();
        let Inference {
            noise_scale,
            length_scale,
            noise_w,
        } = self.config.inference;
        let input = Tensor::from_array(([1usize, length], encoded.ids.clone())).map_err(engine)?;
        let lengths = Tensor::from_array(([1usize], vec![length as i64])).map_err(engine)?;
        let scales = Tensor::from_array(([3usize], vec![noise_scale, length_scale, noise_w]))
            .map_err(engine)?;
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        let outputs = if self.config.num_speakers > 1 {
            let speaker = Tensor::from_array(([1usize], vec![self.speaker])).map_err(engine)?;
            session.run(ort::inputs![
                "input" => input,
                "input_lengths" => lengths,
                "scales" => scales,
                "sid" => speaker,
            ])
        } else {
            session.run(ort::inputs![
                "input" => input,
                "input_lengths" => lengths,
                "scales" => scales,
            ])
        }
        .map_err(engine)?;
        let samples: Vec<f32> = outputs
            .get(&self.audio_output)
            .ok_or_else(|| engine("the voice gave no sound"))?
            .try_extract_tensor::<f32>()
            .map_err(engine)?
            .1
            .iter()
            .map(|sample| sample.clamp(-1.0, 1.0))
            .collect();
        let durations: Option<Vec<f32>> = self
            .durations_output
            .as_ref()
            .and_then(|name| outputs.get(name))
            .and_then(|value| value.try_extract_tensor::<f32>().ok())
            .map(|(_, durations)| durations.to_vec());
        let hop = self.config.hop_length.unwrap_or(DURATIONS_OUTPUT_HOP);
        let words = match durations {
            Some(durations) if durations.len() == length => {
                align(text, &encoded.groups, &durations, hop, samples.len())
            }
            _ => Vec::new(),
        };
        Ok(Synthesis {
            samples,
            sample_rate,
            words,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, i64)]) -> PhonemeIdMap {
        pairs
            .iter()
            .map(|(key, id)| ((*key).to_owned(), vec![*id]))
            .collect()
    }

    #[test]
    fn phoneme_ids_wrap_and_pad() {
        let map = map(&[("^", 1), ("$", 2), ("_", 0), ("a", 5), ("b", 6)]);
        assert_eq!(phoneme_ids("ab", &map), vec![1, 0, 5, 0, 6, 0, 2]);
    }

    #[test]
    fn unknown_phonemes_are_skipped() {
        let map = map(&[("^", 1), ("$", 2), ("_", 0), ("a", 5)]);
        assert_eq!(phoneme_ids("aZa", &map), vec![1, 0, 5, 0, 5, 0, 2]);
    }

    #[test]
    fn words_are_the_groups_between_spaces() {
        let map = map(&[
            ("^", 1),
            ("$", 2),
            ("_", 0),
            ("a", 5),
            ("b", 6),
            (" ", 3),
            (".", 4),
        ]);
        let encoded = encode("ab a.", &map, &[]);
        assert_eq!(encoded.ids, vec![1, 0, 5, 0, 6, 0, 3, 0, 5, 0, 4, 0, 2]);
        assert_eq!(encoded.groups, vec![vec![2, 3, 4, 5], vec![8, 9]]);
    }

    #[test]
    fn a_vowel_cluster_is_one_phoneme() {
        let mut ids = map(&[("^", 1), ("$", 2), ("_", 0), ("a", 5), ("ɪ", 6)]);
        ids.insert("aɪ".into(), vec![9]);
        let clusters = vec![vec!["a".to_owned(), "ɪ".to_owned()]];
        assert_eq!(encode("aɪ", &ids, &clusters).ids, vec![1, 0, 9, 0, 2]);
        assert_eq!(encode("aɪ", &ids, &[]).ids, vec![1, 0, 5, 0, 6, 0, 2]);
    }

    #[test]
    fn align_maps_each_word_to_its_samples() {
        let spans = align(
            "uno due",
            &[vec![0, 1], vec![2, 3]],
            &[1.0, 2.0, 1.0, 3.0],
            256,
            1792,
        );
        assert_eq!(
            spans,
            vec![
                WordSpan {
                    start: 0,
                    end: 3,
                    from: 0,
                    to: 768
                },
                WordSpan {
                    start: 4,
                    end: 7,
                    from: 768,
                    to: 1792
                },
            ]
        );
    }

    #[test]
    fn align_gives_up_when_counts_differ() {
        let groups = vec![vec![0], vec![1], vec![2], vec![3]];
        assert!(align("In 1999", &groups, &[1.0, 1.0, 1.0, 1.0], 256, 1024).is_empty());
    }

    #[test]
    fn align_gives_up_when_the_lengths_do_not_add_up() {
        assert!(align(
            "uno due",
            &[vec![0, 1], vec![2, 3]],
            &[1.0, 2.0, 1.0, 3.0],
            256,
            4000
        )
        .is_empty());
    }

    #[test]
    fn align_counts_utf16_units() {
        let text = "città è 🙂ok";
        let spans = align(
            text,
            &[vec![0], vec![1], vec![2]],
            &[1.0, 1.0, 1.0],
            256,
            768,
        );
        let units: Vec<u16> = text.encode_utf16().collect();
        let said: Vec<String> = spans
            .iter()
            .map(|span| String::from_utf16(&units[span.start as usize..span.end as usize]).unwrap())
            .collect();
        assert_eq!(said, ["città", "è", "ok"]);
        assert_eq!(spans[2].start, 10);
    }
}
