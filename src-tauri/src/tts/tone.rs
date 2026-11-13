// SPDX-License-Identifier: GPL-3.0-or-later
//! A voice that only beeps: what the tests and the smoke build play in place of a real one.

use super::{utf16_words, Synthesis, Synthesizer, TtsError, VoiceInfo, WordSpan};

pub const TONE_VOICE: &str = "piper:tone";
const RATE: u32 = 22050;
const HERTZ: f32 = 440.0;
const LOUDNESS: f32 = 0.2;
/// 60 ms for each UTF-16 unit of the text.
const SAMPLES_PER_UNIT: usize = RATE as usize * 60 / 1000;

pub struct Tone;

impl Synthesizer for Tone {
    fn synthesize(&self, _voice: &str, text: &str) -> Result<Synthesis, TtsError> {
        let units = text.encode_utf16().count();
        let count = units * SAMPLES_PER_UNIT;
        let samples = (0..count)
            .map(|i| LOUDNESS * (2.0 * std::f32::consts::PI * HERTZ * i as f32 / RATE as f32).sin())
            .collect();
        let mut words: Vec<WordSpan> = utf16_words(text)
            .into_iter()
            .map(|(start, end)| WordSpan {
                start,
                end,
                from: start as usize * SAMPLES_PER_UNIT,
                to: end as usize * SAMPLES_PER_UNIT,
            })
            .collect();
        if let Some(last) = words.last_mut() {
            last.to = count;
        }
        Ok(Synthesis {
            samples,
            sample_rate: RATE,
            words,
        })
    }

    fn voices(&self) -> Vec<VoiceInfo> {
        vec![VoiceInfo {
            id: TONE_VOICE.into(),
            name: "Tone".into(),
            lang: "en-US".into(),
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tone_words_cover_the_audio() {
        let sound = Tone.synthesize(TONE_VOICE, "one two three").unwrap();
        assert_eq!(sound.words.len(), 3);
        assert!(sound
            .words
            .windows(2)
            .all(|pair| pair[0].to <= pair[1].from && pair[0].start < pair[1].start));
        assert_eq!(sound.words.last().unwrap().to, sound.samples.len());
    }
}
