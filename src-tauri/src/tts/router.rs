// SPDX-License-Identifier: GPL-3.0-or-later
//! Sends each voice to its engine.

use super::{engine_of, Engine, Synthesis, Synthesizer, TtsError, VoiceInfo};

#[derive(Default)]
pub struct Router {}

impl Router {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Synthesizer for Router {
    fn synthesize(&self, voice: &str, text: &str) -> Result<Synthesis, TtsError> {
        #[cfg(feature = "smoke")]
        if voice == super::tone::TONE_VOICE {
            return super::tone::Tone.synthesize(voice, text);
        }
        let _ = text;
        match engine_of(voice) {
            Engine::Piper | Engine::Edge | Engine::Other => {
                Err(TtsError::Voice(format!("no voice {voice}")))
            }
        }
    }

    fn voices(&self) -> Vec<VoiceInfo> {
        #[cfg(feature = "smoke")]
        return super::tone::Tone.voices();
        #[cfg(not(feature = "smoke"))]
        Vec::new()
    }
}
