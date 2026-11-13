// SPDX-License-Identifier: GPL-3.0-or-later
//! Changes the speed of speech without changing its pitch, with Sonic (vendor/sonic, Apache-2.0).

use std::os::raw::{c_float, c_int};

#[repr(C)]
struct SonicStreamStruct {
    _private: [u8; 0],
}

type SonicStream = *mut SonicStreamStruct;

extern "C" {
    fn sonicCreateStream(sample_rate: c_int, num_channels: c_int) -> SonicStream;
    fn sonicDestroyStream(stream: SonicStream);
    fn sonicSetSpeed(stream: SonicStream, speed: c_float);
    fn sonicWriteFloatToStream(stream: SonicStream, samples: *const c_float, count: c_int)
        -> c_int;
    fn sonicFlushStream(stream: SonicStream) -> c_int;
    fn sonicReadFloatFromStream(stream: SonicStream, samples: *mut c_float, max: c_int) -> c_int;
}

/// Sonic is fed this much at a time, so what it holds stays small whatever the length of the sentence.
const CHUNK: usize = 4096;
/// A speed this close to 1 is 1: the samples go through as they are.
const SAME_SPEED: f32 = 1e-3;

/// Frees the stream however the stretching ends.
struct Stream(SonicStream);

impl Drop for Stream {
    fn drop(&mut self) {
        unsafe { sonicDestroyStream(self.0) };
    }
}

impl Stream {
    fn drain(&self, out: &mut Vec<f32>) {
        let mut buffer = [0f32; CHUNK];
        loop {
            let read =
                unsafe { sonicReadFloatFromStream(self.0, buffer.as_mut_ptr(), CHUNK as c_int) };
            let Ok(read) = usize::try_from(read) else {
                return;
            };
            if read == 0 {
                return;
            }
            out.extend_from_slice(&buffer[..read.min(CHUNK)]);
        }
    }
}

/// Mono samples from -1 to 1, said `speed` times faster (0.5 is twice as slow). An empty answer if Sonic has no memory.
pub fn stretch(samples: &[f32], sample_rate: u32, speed: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    if (speed - 1.0).abs() < SAME_SPEED || !speed.is_finite() || speed <= 0.0 {
        return samples.to_vec();
    }
    let Ok(rate) = c_int::try_from(sample_rate) else {
        return Vec::new();
    };
    let raw = unsafe { sonicCreateStream(rate, 1) };
    if raw.is_null() {
        return Vec::new();
    }
    let stream = Stream(raw);
    unsafe { sonicSetSpeed(stream.0, speed) };
    let mut out = Vec::with_capacity((samples.len() as f32 / speed) as usize + CHUNK);
    let mut chunk = Vec::with_capacity(CHUNK);
    for part in samples.chunks(CHUNK) {
        chunk.clear();
        chunk.extend(part.iter().map(|sample| sample.clamp(-1.0, 1.0)));
        let written =
            unsafe { sonicWriteFloatToStream(stream.0, chunk.as_ptr(), chunk.len() as c_int) };
        if written == 0 {
            return Vec::new();
        }
        stream.drain(&mut out);
    }
    if unsafe { sonicFlushStream(stream.0) } == 0 {
        return Vec::new();
    }
    stream.drain(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::stretch;

    const RATE: u32 = 22050;

    fn tone(seconds: f32) -> Vec<f32> {
        let count = (RATE as f32 * seconds) as usize;
        (0..count)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / RATE as f32).sin())
            .collect()
    }

    fn near(actual: usize, expected: f32, share: f32) -> bool {
        (actual as f32 - expected).abs() <= expected * share
    }

    fn crossings_per_second(samples: &[f32]) -> f32 {
        let crossings = samples
            .windows(2)
            .filter(|pair| (pair[0] < 0.0) != (pair[1] < 0.0))
            .count();
        crossings as f32 / (samples.len() as f32 / RATE as f32)
    }

    #[test]
    fn stretch_at_one_keeps_the_length() {
        assert!(near(stretch(&tone(1.0), RATE, 1.0).len(), 22050.0, 0.01));
    }

    #[test]
    fn stretch_at_four_quarters_the_length() {
        let out = stretch(&tone(1.0), RATE, 4.0);
        assert!(near(out.len(), 5512.0, 0.02), "{}", out.len());
    }

    #[test]
    fn stretch_at_half_doubles_the_length() {
        let out = stretch(&tone(1.0), RATE, 0.5);
        assert!(near(out.len(), 44100.0, 0.02), "{}", out.len());
    }

    #[test]
    fn stretch_keeps_the_pitch() {
        let input = tone(1.0);
        let out = stretch(&input, RATE, 2.0);
        let before = crossings_per_second(&input);
        let after = crossings_per_second(&out);
        assert!((after - before).abs() <= before * 0.03, "{before} {after}");
    }

    #[test]
    fn stretch_of_nothing_is_nothing() {
        assert!(stretch(&[], RATE, 2.0).is_empty());
    }
}
