// SPDX-License-Identifier: GPL-3.0-or-later
//! Sends each voice to its engine.

use super::manager::Voices;
use super::{
    engine_of, Engine, Synthesis, Synthesizer, TtsError, VoiceInfo, KOKORO_PREFIX, PIPER_PREFIX,
};
use std::sync::Arc;

pub struct Router {
    voices: Arc<Voices>,
}

impl Router {
    pub fn new(voices: Arc<Voices>) -> Self {
        Self { voices }
    }
}

impl Synthesizer for Router {
    fn synthesize(&self, voice: &str, text: &str) -> Result<Synthesis, TtsError> {
        #[cfg(feature = "smoke")]
        if voice == super::tone::TONE_VOICE {
            return super::tone::Tone.synthesize(voice, text);
        }
        match engine_of(voice) {
            Engine::Piper => self.voices.synthesize(&voice[PIPER_PREFIX.len()..], text),
            Engine::Kokoro => self
                .voices
                .synthesize_kokoro(&voice[KOKORO_PREFIX.len()..], text),
            Engine::Edge | Engine::Other => Err(TtsError::Voice(format!("no voice {voice}"))),
        }
    }

    fn voices(&self) -> Vec<VoiceInfo> {
        #[allow(unused_mut)]
        let mut voices = self.voices.installed_voices();
        #[cfg(feature = "smoke")]
        voices.extend(super::tone::Tone.voices());
        voices
    }
}
