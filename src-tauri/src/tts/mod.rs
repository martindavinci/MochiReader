// SPDX-License-Identifier: GPL-3.0-or-later
//! Voices the app says itself: it makes the sound of a sentence at its own speed, keeps it, stretches it to the speed
//! asked, shapes it in the style the reader chose, and hands it to the page as samples. The page plays them with Web
//! Audio.

pub mod cache;
pub mod catalog;
pub mod download;
pub mod engine_pack;
pub mod espeak;
pub mod kokoro;
pub mod manager;
pub mod onnx_patch;
pub mod paths;
pub mod piper;
mod router;
pub mod sound;
pub mod stretch;
#[cfg(any(test, feature = "smoke"))]
pub mod tone;

use cache::{Cache, CacheKey, CACHE_SENTENCES};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use sound::Style;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

pub use router::Router;

pub const MIN_RATE: f32 = 0.5;
pub const MAX_RATE: f32 = 4.0;
pub const PIPER_PREFIX: &str = "piper:";
pub const EDGE_PREFIX: &str = "edge:";

/// What went wrong, as the page reads it: `{ kind, message }`.
#[derive(Debug, Clone, PartialEq)]
pub enum TtsError {
    /// The engine pack is missing, broken or would not load.
    Engine(String),
    /// The voice is unknown, not installed, or its files are damaged.
    Voice(String),
    Network(String),
    /// Asked for something the app does not do now: Edge while it is off, a sentence no longer kept.
    Refused(String),
    Canceled,
}

impl TtsError {
    fn kind(&self) -> &'static str {
        match self {
            Self::Engine(_) => "engine",
            Self::Voice(_) => "voice",
            Self::Network(_) => "network",
            Self::Refused(_) => "refused",
            Self::Canceled => "canceled",
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::Engine(message)
            | Self::Voice(message)
            | Self::Network(message)
            | Self::Refused(message) => message,
            Self::Canceled => "",
        }
    }
}

impl fmt::Display for TtsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind(), self.message())
    }
}

impl std::error::Error for TtsError {}

impl Serialize for TtsError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_struct("TtsError", 2)?;
        out.serialize_field("kind", self.kind())?;
        out.serialize_field("message", self.message())?;
        out.end()
    }
}

/// Where a word is: `start`/`end` in UTF-16 units of the sentence, as the page indexes text; `from`/`to` in samples of
/// the sound at its own speed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct WordSpan {
    pub start: u32,
    pub end: u32,
    pub from: usize,
    pub to: usize,
}

/// The sound of one sentence at its own speed, mono, from -1 to 1. `words` is empty when their times are not known.
#[derive(Debug, Clone, PartialEq)]
pub struct Synthesis {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub words: Vec<WordSpan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub lang: String,
}

/// Something that turns the text of a sentence into its sound: Piper, Edge, or the tone of the tests.
pub trait Synthesizer: Send + Sync {
    fn synthesize(&self, voice: &str, text: &str) -> Result<Synthesis, TtsError>;

    /// The voices it can say now.
    fn voices(&self) -> Vec<VoiceInfo> {
        Vec::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Piper,
    Edge,
    Other,
}

pub fn engine_of(voice: &str) -> Engine {
    if voice.starts_with(PIPER_PREFIX) {
        Engine::Piper
    } else if voice.starts_with(EDGE_PREFIX) {
        Engine::Edge
    } else {
        Engine::Other
    }
}

/// The words of a sentence as UTF-16 ranges: runs between spaces that hold a letter or a digit, without the
/// punctuation around them.
pub fn utf16_words(text: &str) -> Vec<(u32, u32)> {
    let mut words = Vec::new();
    let mut unit = 0u32;
    let mut current: Option<(u32, u32)> = None;
    for ch in text.chars() {
        let width = ch.len_utf16() as u32;
        if ch.is_whitespace() {
            words.extend(current.take());
        } else if ch.is_alphanumeric() {
            current = Some(match current {
                Some((start, _)) => (start, unit + width),
                None => (unit, unit + width),
            });
        }
        // Punctuation leaves the word as it is: inside one (l'acqua) the next letter takes the end past it, at its end
        // it stays out.
        unit += width;
    }
    words.extend(current);
    words
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A speed the engines can give: 0.5 to 4. What is not a number is the normal speed.
pub fn clamp_rate(rate: f32) -> f32 {
    if rate.is_nan() {
        1.0
    } else {
        rate.clamp(MIN_RATE, MAX_RATE)
    }
}

/// The answer the page decodes in `app/speech/pcm.js`: `[u32 LE header length][header JSON][0-3 zero bytes][f32 LE samples]`.
pub fn pack(id: u64, synthesis: &Synthesis, from: usize, rate: f32, samples: &[f32]) -> Vec<u8> {
    let header = serde_json::json!({
        "id": id.to_string(),
        "sampleRate": synthesis.sample_rate,
        "from": from,
        "rate": rate,
        "words": synthesis.words,
    })
    .to_string()
    .into_bytes();
    let mut out = Vec::with_capacity(4 + header.len() + 3 + samples.len() * 4);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

pub struct Service {
    synth: Arc<dyn Synthesizer>,
    cache: Mutex<Cache>,
    /// One sentence is made at a time: a sentence asked while it is being prepared waits and finds it made.
    working: Mutex<()>,
}

impl Service {
    pub fn with(synth: Arc<dyn Synthesizer>) -> Self {
        Self {
            synth,
            cache: Mutex::new(Cache::new(CACHE_SENTENCES)),
            working: Mutex::new(()),
        }
    }

    fn sound(&self, voice: &str, text: &str) -> Result<(u64, Arc<Synthesis>), TtsError> {
        let key = CacheKey {
            voice: voice.to_owned(),
            text: text.to_owned(),
        };
        if let Some(found) = lock(&self.cache).find(&key) {
            return Ok(found);
        }
        let _turn = lock(&self.working);
        if let Some(found) = lock(&self.cache).find(&key) {
            return Ok(found);
        }
        let synthesis = Arc::new(self.synth.synthesize(voice, text)?);
        let id = lock(&self.cache).insert(key, Arc::clone(&synthesis));
        Ok((id, synthesis))
    }

    pub fn speak(
        &self,
        voice: &str,
        text: &str,
        rate: f32,
        style: Style,
    ) -> Result<Vec<u8>, TtsError> {
        let (id, synthesis) = self.sound(voice, text)?;
        let rate = clamp_rate(rate);
        let samples = stretch::stretch(&synthesis.samples, synthesis.sample_rate, rate);
        let samples = sound::shape(&synthesis.samples, &samples, synthesis.sample_rate, style);
        Ok(pack(id, &synthesis, 0, rate, &samples))
    }

    pub fn prepare(&self, voice: &str, text: &str) -> Result<(), TtsError> {
        self.sound(voice, text).map(|_| ())
    }

    /// The rest of a sentence still kept, from the sample `from` of its own sound, at a new speed or in a new style.
    pub fn restretch(
        &self,
        id: u64,
        from: usize,
        rate: f32,
        style: Style,
    ) -> Result<Vec<u8>, TtsError> {
        let synthesis = lock(&self.cache)
            .get(id)
            .ok_or_else(|| TtsError::Refused("the sentence is no longer kept".into()))?;
        let rate = clamp_rate(rate);
        let from = from.min(synthesis.samples.len());
        let samples = stretch::stretch(&synthesis.samples[from..], synthesis.sample_rate, rate);
        let samples = sound::shape(&synthesis.samples, &samples, synthesis.sample_rate, style);
        Ok(pack(id, &synthesis, from, rate, &samples))
    }

    pub fn voices(&self) -> Vec<VoiceInfo> {
        self.synth.voices()
    }
}

async fn off_the_workers<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, TtsError> + Send + 'static,
) -> Result<T, TtsError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| TtsError::Engine(error.to_string()))?
}

#[tauri::command]
pub async fn tts_speak(
    voice_id: String,
    text: String,
    rate: f32,
    sound: Option<String>,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<tauri::ipc::Response, TtsError> {
    let service = Arc::clone(&service);
    let style = Style::named(sound.as_deref().unwrap_or_default());
    let bytes = off_the_workers(move || service.speak(&voice_id, &text, rate, style)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn tts_prepare(
    voice_id: String,
    text: String,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<(), TtsError> {
    let service = Arc::clone(&service);
    off_the_workers(move || service.prepare(&voice_id, &text)).await
}

#[tauri::command]
pub async fn tts_restretch(
    id: String,
    from: usize,
    rate: f32,
    sound: Option<String>,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<tauri::ipc::Response, TtsError> {
    let style = Style::named(sound.as_deref().unwrap_or_default());
    let id: u64 = id
        .parse()
        .map_err(|_| TtsError::Refused("no such sentence".into()))?;
    let service = Arc::clone(&service);
    let bytes = off_the_workers(move || service.restretch(id, from, rate, style)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn tts_voices(
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Vec<VoiceInfo>, TtsError> {
    let service = Arc::clone(&service);
    off_the_workers(move || Ok(service.voices())).await
}

/// The catalog as the voice manager shows it. Reads the disk only: no request leaves the computer.
#[tauri::command]
pub async fn tts_catalog(
    voices: tauri::State<'_, Arc<manager::Voices>>,
) -> Result<manager::CatalogView, TtsError> {
    let voices = Arc::clone(&voices);
    off_the_workers(move || Ok(voices.view())).await
}

#[tauri::command]
pub async fn tts_download(
    voice_id: String,
    voices: tauri::State<'_, Arc<manager::Voices>>,
) -> Result<(), TtsError> {
    let voices = Arc::clone(&voices);
    off_the_workers(move || voices.download(&voice_id)).await
}

#[tauri::command]
pub async fn tts_cancel(
    voice_id: String,
    voices: tauri::State<'_, Arc<manager::Voices>>,
) -> Result<(), TtsError> {
    voices.cancel(&voice_id);
    Ok(())
}

#[tauri::command]
pub async fn tts_delete(
    voice_id: String,
    voices: tauri::State<'_, Arc<manager::Voices>>,
) -> Result<(), TtsError> {
    let voices = Arc::clone(&voices);
    off_the_workers(move || voices.delete(&voice_id)).await
}

/// The published sample of a voice not installed, as MP3 bytes. Asked only when the reader presses its play button.
#[tauri::command]
pub async fn tts_sample(
    voice_id: String,
    voices: tauri::State<'_, Arc<manager::Voices>>,
) -> Result<tauri::ipc::Response, TtsError> {
    let voices = Arc::clone(&voices);
    let bytes = off_the_workers(move || voices.sample(&voice_id)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Counting {
        calls: AtomicUsize,
    }

    impl Synthesizer for Counting {
        fn synthesize(&self, voice: &str, text: &str) -> Result<Synthesis, TtsError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tone::Tone.synthesize(voice, text)
        }
    }

    fn unpack(bytes: &[u8]) -> (serde_json::Value, Vec<f32>) {
        let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&bytes[4..4 + length]).unwrap();
        let start = (4 + length).div_ceil(4) * 4;
        assert!(bytes[4 + length..start].iter().all(|byte| *byte == 0));
        let samples = bytes[start..]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| f32::from_le_bytes(*chunk))
            .collect();
        (header, samples)
    }

    fn one_second() -> Synthesis {
        Synthesis {
            samples: (0..22050)
                .map(|i| ((i % 100) as f32 / 100.0) - 0.5)
                .collect(),
            sample_rate: 22050,
            words: vec![WordSpan {
                start: 0,
                end: 3,
                from: 0,
                to: 22050,
            }],
        }
    }

    struct Fixed;

    impl Synthesizer for Fixed {
        fn synthesize(&self, _voice: &str, _text: &str) -> Result<Synthesis, TtsError> {
            Ok(one_second())
        }
    }

    #[test]
    fn pack_lays_out_header_padding_and_samples() {
        let sound = one_second();
        let bytes = pack(7, &sound, 10, 1.5, &[0.25, -0.5]);
        let (header, samples) = unpack(&bytes);
        assert_eq!(header["id"], "7");
        assert_eq!(header["sampleRate"], 22050);
        assert_eq!(header["from"], 10);
        assert_eq!(header["rate"], 1.5);
        assert_eq!(header["words"][0]["to"], 22050);
        assert_eq!(samples, vec![0.25, -0.5]);
    }

    #[test]
    fn speak_twice_synthesizes_once() {
        let counting = Arc::new(Counting {
            calls: AtomicUsize::new(0),
        });
        let service = Service::with(counting.clone());
        service
            .speak("piper:x", "Ciao a tutti.", 1.0, Style::Natural)
            .unwrap();
        service
            .speak("piper:x", "Ciao a tutti.", 2.0, Style::Natural)
            .unwrap();
        assert_eq!(counting.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn restretch_from_the_middle_returns_the_rest() {
        let service = Service::with(Arc::new(Fixed));
        let (header, _) = unpack(
            &service
                .speak("piper:x", "one", 1.0, Style::Natural)
                .unwrap(),
        );
        let id: u64 = header["id"].as_str().unwrap().parse().unwrap();
        let (header, samples) = unpack(&service.restretch(id, 11025, 1.0, Style::Natural).unwrap());
        assert_eq!(header["from"], 11025);
        assert_eq!(samples.len(), 11025);
    }

    #[test]
    fn the_sound_comes_in_the_style_asked_under_its_ceiling() {
        let service = Service::with(Arc::new(Counting {
            calls: AtomicUsize::new(0),
        }));
        let (header, natural) = unpack(
            &service
                .speak("piper:x", "one", 1.0, Style::Natural)
                .unwrap(),
        );
        let (_, radio) = unpack(&service.speak("piper:x", "one", 1.0, Style::Radio).unwrap());
        assert_ne!(natural, radio);
        assert!(natural.iter().all(|sample| sample.abs() <= 0.892));
        let id: u64 = header["id"].as_str().unwrap().parse().unwrap();
        let (_, rest) = unpack(&service.restretch(id, 0, 1.0, Style::Radio).unwrap());
        assert_eq!(rest, radio);
    }

    #[test]
    fn restretch_of_a_forgotten_sentence_is_refused() {
        let service = Service::with(Arc::new(Fixed));
        let (header, _) = unpack(
            &service
                .speak("piper:x", "first", 1.0, Style::Natural)
                .unwrap(),
        );
        let id: u64 = header["id"].as_str().unwrap().parse().unwrap();
        for i in 0..CACHE_SENTENCES + 1 {
            service.prepare("piper:x", &format!("other {i}")).unwrap();
        }
        assert!(matches!(
            service.restretch(id, 0, 1.0, Style::Natural),
            Err(TtsError::Refused(_))
        ));
    }

    #[test]
    fn rate_is_kept_between_half_and_four() {
        let service = Service::with(Arc::new(Fixed));
        let (header, fast) = unpack(&service.speak("piper:x", "a", 9.0, Style::Natural).unwrap());
        assert_eq!(header["rate"], 4.0);
        let (_, four) = unpack(&service.speak("piper:x", "a", 4.0, Style::Natural).unwrap());
        assert_eq!(fast.len(), four.len());
        let (header, _) = unpack(&service.speak("piper:x", "a", 0.1, Style::Natural).unwrap());
        assert_eq!(header["rate"], 0.5);
    }

    #[test]
    fn errors_reach_the_page_as_kind_and_message() {
        let json = serde_json::to_value(TtsError::Refused("off".into())).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "refused", "message": "off" })
        );
    }

    #[test]
    fn words_are_runs_with_a_letter_or_a_digit() {
        let text = "«Città», disse — 1999 l'acqua!";
        let words: Vec<String> = utf16_words(text)
            .into_iter()
            .map(|(start, end)| {
                String::from_utf16(
                    &text.encode_utf16().collect::<Vec<_>>()[start as usize..end as usize],
                )
                .unwrap()
            })
            .collect();
        assert_eq!(words, ["Città", "disse", "1999", "l'acqua"]);
    }
}
