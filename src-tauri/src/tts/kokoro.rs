// SPDX-License-Identifier: GPL-3.0-or-later
//! Kokoro voices: the phonemes of eSpeak become the tokens of the one Kokoro model, the style of the voice (a row of
//! its 510×256 matrix) says how they sound, and the length the model gives each token says where each word is.

use super::espeak::Espeak;
use super::onnx_patch::KOKORO_DURATIONS;
use super::piper::align;
use super::{Synthesis, TtsError};
use ort::session::Session;
use ort::value::Tensor;
use std::collections::HashMap;
use std::ops::Range;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

pub const SAMPLE_RATE: u32 = 24_000;
/// Samples per frame of the length the model gives each token.
pub const HOP: usize = 600;
/// Tokens the model takes at once, without the padding around them.
pub const MAX_TOKENS: usize = 510;
pub const STYLE_ROWS: usize = 510;
pub const STYLE_WIDTH: usize = 256;
pub const STYLE_BYTES: usize = STYLE_ROWS * STYLE_WIDTH * 4;
/// The token put before and after the tokens of a sentence.
const PAD: i64 = 0;
const SPACE: char = ' ';
/// What ends a word, as eSpeak writes the end of a clause.
const PUNCTUATION: [char; 6] = ['.', ',', ';', ':', '?', '!'];

/// The eSpeak voice that makes the phonemes of a Kokoro language; none for a language the app does not offer.
pub fn espeak_voice(lang: &str) -> Option<&'static str> {
    Some(match lang {
        "en-US" => "en-us",
        "en-GB" => "en-gb",
        "it-IT" => "it",
        "es-ES" => "es",
        "fr-FR" => "fr-fr",
        "pt-BR" => "pt-br",
        "hi-IN" => "hi",
        _ => return None,
    })
}

/// The tokens of a sentence, and for each word the indices of its tokens.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Tokens {
    pub ids: Vec<i64>,
    pub groups: Vec<Vec<usize>>,
}

/// Each phoneme its token; one the vocabulary does not know is left out. A space or a mark ends a word and is a token
/// of its own when the vocabulary has it.
pub fn tokenize(phonemes: &str, vocab: &HashMap<String, i64>) -> Tokens {
    let mut out = Tokens::default();
    let mut word: Vec<usize> = Vec::new();
    let mut key = String::with_capacity(4);
    for ch in phonemes.chars() {
        key.clear();
        key.push(ch);
        let id = vocab.get(&key).copied();
        if ch == SPACE || PUNCTUATION.contains(&ch) {
            if !word.is_empty() {
                out.groups.push(std::mem::take(&mut word));
            }
        } else if id.is_some() {
            word.push(out.ids.len());
        }
        if let Some(id) = id {
            out.ids.push(id);
        }
    }
    if !word.is_empty() {
        out.groups.push(word);
    }
    out
}

/// The tokens in runs of at most `MAX_TOKENS`, each cut right after a space or a mark; a word longer than that is cut
/// where the run is full.
pub fn chunks(tokens: &Tokens) -> Vec<Range<usize>> {
    let mut in_word = vec![false; tokens.ids.len()];
    for index in tokens.groups.iter().flatten() {
        in_word[*index] = true;
    }
    let mut out = Vec::new();
    let mut start = 0;
    while start < tokens.ids.len() {
        let limit = (start + MAX_TOKENS).min(tokens.ids.len());
        let end = if limit == tokens.ids.len() {
            limit
        } else {
            (start + 1..=limit)
                .rev()
                .find(|end| !in_word[end - 1])
                .unwrap_or(limit)
        };
        out.push(start..end);
        start = end;
    }
    out
}

/// The length of each token of a run, in frames, from what the model gave for `[PAD, run…, PAD]`: the frames of the
/// pads go to the token beside each, so the lengths still add up to the whole sound.
pub fn spread_pads(frames: &[i64]) -> Vec<f32> {
    if frames.len() < 3 {
        return Vec::new();
    }
    let mut out: Vec<f32> = frames[1..frames.len() - 1]
        .iter()
        .map(|frames| (*frames).max(0) as f32)
        .collect();
    out[0] += frames[0].max(0) as f32;
    let last = out.len() - 1;
    out[last] += frames[frames.len() - 1].max(0) as f32;
    out
}

/// The style of a voice: 510 rows of 256, one row for each length of the tokens.
#[derive(Debug, Clone, PartialEq)]
pub struct Style(Vec<f32>);

impl Style {
    pub fn from_bytes(bytes: &[u8]) -> Result<Style, TtsError> {
        if bytes.len() != STYLE_BYTES {
            return Err(TtsError::Voice(format!(
                "a Kokoro voice is {STYLE_BYTES} bytes, not {}",
                bytes.len()
            )));
        }
        Ok(Style(
            bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|four| f32::from_le_bytes(*four))
                .collect(),
        ))
    }

    /// The row for `tokens` tokens: row n - 1, the last one past 510.
    pub fn row(&self, tokens: usize) -> &[f32] {
        let row = tokens.clamp(1, STYLE_ROWS) - 1;
        &self.0[row * STYLE_WIDTH..(row + 1) * STYLE_WIDTH]
    }

    /// The sum of the styles, each times its weight.
    pub fn mix(parts: &[(&Style, f32)]) -> Style {
        let mut out = vec![0.0f32; STYLE_ROWS * STYLE_WIDTH];
        for (style, weight) in parts {
            for (sum, value) in out.iter_mut().zip(&style.0) {
                *sum += value * weight;
            }
        }
        Style(out)
    }
}

fn engine(error: impl std::fmt::Display) -> TtsError {
    TtsError::Engine(error.to_string())
}

/// The one Kokoro model, loaded once and shared by every Kokoro voice.
pub struct KokoroModel {
    session: Mutex<Session>,
    audio_output: String,
    durations_output: Option<String>,
}

impl KokoroModel {
    pub fn load(
        environment: &ort::environment::Environment,
        onnx: &Path,
    ) -> Result<Self, TtsError> {
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
            .iter()
            .find(|name| name.as_str() != KOKORO_DURATIONS)
            .cloned()
            .ok_or_else(|| engine("the Kokoro model gives no sound"))?;
        let durations_output = outputs
            .iter()
            .find(|name| name.as_str() == KOKORO_DURATIONS)
            .cloned();
        Ok(Self {
            session: Mutex::new(session),
            audio_output,
            durations_output,
        })
    }

    /// Says `text` in `lang` with `style`, at its own speed (the reader's speed is applied after, as for Piper).
    pub fn synthesize(
        &self,
        espeak: &Espeak,
        vocab: &HashMap<String, i64>,
        lang: &str,
        style: &Style,
        text: &str,
    ) -> Result<Synthesis, TtsError> {
        let voice = espeak_voice(lang)
            .ok_or_else(|| TtsError::Voice(format!("Kokoro does not speak {lang}")))?;
        let tokens = tokenize(&espeak.phonemize(voice, text)?, vocab);
        let mut samples = Vec::new();
        let mut durations: Option<Vec<f32>> = Some(Vec::with_capacity(tokens.ids.len()));
        for range in chunks(&tokens) {
            let count = range.len();
            let mut ids = Vec::with_capacity(count + 2);
            ids.push(PAD);
            ids.extend_from_slice(&tokens.ids[range]);
            ids.push(PAD);
            let input = Tensor::from_array(([1usize, count + 2], ids)).map_err(engine)?;
            let row = Tensor::from_array(([1usize, STYLE_WIDTH], style.row(count).to_vec()))
                .map_err(engine)?;
            let speed = Tensor::from_array(([1usize], vec![1.0f32])).map_err(engine)?;
            let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
            let outputs = session
                .run(ort::inputs![
                    "input_ids" => input,
                    "style" => row,
                    "speed" => speed,
                ])
                .map_err(engine)?;
            samples.extend(
                outputs
                    .get(&self.audio_output)
                    .ok_or_else(|| engine("the Kokoro model gave no sound"))?
                    .try_extract_tensor::<f32>()
                    .map_err(engine)?
                    .1
                    .iter()
                    .map(|sample| sample.clamp(-1.0, 1.0)),
            );
            let frames = self
                .durations_output
                .as_ref()
                .and_then(|name| outputs.get(name))
                .and_then(|value| value.try_extract_tensor::<i64>().ok())
                .map(|(_, frames)| spread_pads(frames));
            durations = match (durations, frames) {
                (Some(mut all), Some(frames)) if frames.len() == count => {
                    all.extend(frames);
                    Some(all)
                }
                _ => None,
            };
        }
        let words = match durations {
            Some(durations) if !samples.is_empty() && durations.len() == tokens.ids.len() => {
                align(text, &tokens.groups, &durations, HOP, samples.len())
            }
            _ => Vec::new(),
        };
        Ok(Synthesis {
            samples,
            sample_rate: SAMPLE_RATE,
            words,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab(pairs: &[(&str, i64)]) -> HashMap<String, i64> {
        pairs
            .iter()
            .map(|(key, id)| ((*key).to_owned(), *id))
            .collect()
    }

    fn style_of(value: f32) -> Style {
        let bytes: Vec<u8> = std::iter::repeat_n(value.to_le_bytes(), STYLE_ROWS * STYLE_WIDTH)
            .flatten()
            .collect();
        Style::from_bytes(&bytes).unwrap()
    }

    #[test]
    fn tokens_skip_unknown_symbols_and_group_words() {
        let vocab = vocab(&[("a", 43), ("b", 44), (" ", 16), (".", 4)]);
        let tokens = tokenize("ab x. b", &vocab);
        assert_eq!(tokens.ids, vec![43, 44, 16, 4, 16, 44]);
        // "x" has no token: no group
        assert_eq!(tokens.groups, vec![vec![0, 1], vec![5]]);
    }

    #[test]
    fn nothing_known_is_no_tokens() {
        let tokens = tokenize("☺☺", &vocab(&[("a", 1)]));
        assert!(tokens.ids.is_empty());
        assert!(tokens.groups.is_empty());
    }

    #[test]
    fn chunks_cut_after_a_word() {
        let vocab = vocab(&[("a", 1), (" ", 2)]);
        let tokens = tokenize(&"aaaa ".repeat(120), &vocab);
        assert_eq!(tokens.ids.len(), 600);
        let ranges = chunks(&tokens);
        assert!(ranges.len() >= 2);
        assert_eq!(ranges.first().unwrap().start, 0);
        assert_eq!(ranges.last().unwrap().end, 600);
        for pair in ranges.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        for range in &ranges {
            assert!(range.len() <= MAX_TOKENS);
            assert_eq!(tokens.ids[range.end - 1], 2, "cut after a space");
        }
    }

    #[test]
    fn a_word_longer_than_the_limit_is_cut_at_the_limit() {
        let tokens = tokenize(&"a".repeat(700), &vocab(&[("a", 1)]));
        let ranges = chunks(&tokens);
        assert_eq!(ranges, vec![0..MAX_TOKENS, MAX_TOKENS..700]);
    }

    #[test]
    fn style_row_follows_the_token_count() {
        let mut bytes = Vec::with_capacity(STYLE_BYTES);
        for row in 0..STYLE_ROWS {
            for _ in 0..STYLE_WIDTH {
                bytes.extend_from_slice(&(row as f32).to_le_bytes());
            }
        }
        let style = Style::from_bytes(&bytes).unwrap();
        assert_eq!(style.row(0)[0], 0.0);
        assert_eq!(style.row(1)[0], 0.0);
        assert_eq!(style.row(34)[0], 33.0);
        assert_eq!(style.row(900)[0], 509.0);
        assert_eq!(style.row(34).len(), STYLE_WIDTH);
    }

    #[test]
    fn a_style_needs_its_exact_size() {
        assert!(Style::from_bytes(&[0u8; 100]).is_err());
        assert!(Style::from_bytes(&vec![0u8; STYLE_BYTES + 4]).is_err());
    }

    #[test]
    fn mix_is_the_weighted_sum() {
        let (one, three) = (style_of(1.0), style_of(3.0));
        let mixed = Style::mix(&[(&one, 0.75), (&three, 0.25)]);
        assert!(mixed.row(10).iter().all(|value| (value - 1.5).abs() < 1e-6));
    }

    #[test]
    fn the_pads_frames_go_to_the_tokens_beside_them() {
        assert_eq!(spread_pads(&[2, 3, 4, 5]), vec![5.0, 9.0]);
        assert_eq!(spread_pads(&[2, 3, 4]), vec![9.0]);
        assert!(spread_pads(&[2, 3]).is_empty());
    }

    #[test]
    fn espeak_voices() {
        assert_eq!(espeak_voice("it-IT"), Some("it"));
        assert_eq!(espeak_voice("pt-BR"), Some("pt-br"));
        assert_eq!(espeak_voice("en-GB"), Some("en-gb"));
        assert_eq!(espeak_voice("ja-JP"), None);
    }

    /// The real engine and model: `MOCHIREADER_ENGINE_DIR` (the engine pack) and `MOCHIREADER_KOKORO_DIR` (a folder with
    /// `model_quantized.onnx` and `if_sara.bin` as onnx-community publishes them).
    #[test]
    #[ignore]
    fn engine_kokoro_says_a_sentence_and_its_words() {
        let engine_dir = std::path::PathBuf::from(
            std::env::var_os("MOCHIREADER_ENGINE_DIR").expect("the engine"),
        )
        .canonicalize()
        .unwrap();
        let kokoro = std::path::PathBuf::from(
            std::env::var_os("MOCHIREADER_KOKORO_DIR").expect("the model"),
        );
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("model.onnx");
        std::fs::copy(kokoro.join("model_quantized.onnx"), &model).unwrap();
        assert!(super::super::onnx_patch::patch_kokoro_file(&model));
        let style = Style::from_bytes(&std::fs::read(kokoro.join("if_sara.bin")).unwrap()).unwrap();
        let catalog = super::super::catalog::Catalog::embedded().unwrap();
        let loaded = super::super::engine_pack::load(&engine_dir).unwrap();
        let voice = KokoroModel::load(&loaded.environment, &model).unwrap();
        let sound = voice
            .synthesize(
                &loaded.espeak,
                &catalog.kokoro.unwrap().vocab,
                "it-IT",
                &style,
                "Ciao a tutti, come state?",
            )
            .unwrap();
        assert_eq!(sound.sample_rate, 24_000);
        assert!(sound.samples.len() > 24_000 / 2);
        assert_eq!(sound.words.len(), 5, "{:?}", sound.words);
        assert_eq!(sound.words.last().unwrap().end, 24);
        let spans: Vec<(usize, usize)> = sound
            .words
            .iter()
            .map(|word| (word.from, word.to))
            .collect();
        assert!(
            spans.windows(2).all(|pair| pair[0].1 <= pair[1].0 + HOP),
            "{spans:?}"
        );
    }
}
