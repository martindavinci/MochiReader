// SPDX-License-Identifier: GPL-3.0-or-later
//! The sound of a voice of the app as the reader chose it: a style shapes it with filters and a compressor, every
//! sentence is brought to the same loudness (ITU-R BS.1770), and a limiter keeps its peaks under a ceiling. The values
//! of the styles are starting points for speech, to be tuned by ear.

use std::f64::consts::PI;

/// A sentence quieter or louder than its target by more than this is left that much away from it.
const MAX_GAIN_DB: f64 = 20.0;
/// The loudness of a sentence shorter than this is measured on the sentence said again until it is this long: the
/// measure needs blocks of 400 ms.
const SHORTEST_MEASURE_S: f64 = 1.0;
/// A filter this close to half the sample rate does nothing the voice has: it is left out.
const HIGHEST_FILTER: f64 = 0.45;
/// How far ahead the limiter looks for a peak, and how fast it lets go after it.
const LIMITER_LOOKAHEAD_S: f64 = 0.0015;
const LIMITER_RELEASE_S: f64 = 0.05;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Style {
    Natural,
    Warm,
    Clear,
    Soft,
    Radio,
    Night,
}

impl Style {
    /// The style the page names; any other name is the natural one.
    pub fn named(name: &str) -> Self {
        match name {
            "warm" => Self::Warm,
            "clear" => Self::Clear,
            "soft" => Self::Soft,
            "radio" => Self::Radio,
            "night" => Self::Night,
            _ => Self::Natural,
        }
    }

    fn preset(self) -> &'static Preset {
        match self {
            Self::Natural => &NATURAL,
            Self::Warm => &WARM,
            Self::Clear => &CLEAR,
            Self::Soft => &SOFT,
            Self::Radio => &RADIO,
            Self::Night => &NIGHT,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Kind {
    HighPass,
    LowPass,
    LowShelf,
    HighShelf,
    Peak,
}

/// One filter: `q` is the Q of a pass or a peak, and the slope of a shelf.
#[derive(Debug, Clone, Copy)]
struct Band {
    kind: Kind,
    hz: f64,
    db: f64,
    q: f64,
}

const fn band(kind: Kind, hz: f64, db: f64, q: f64) -> Band {
    Band { kind, hz, db, q }
}

/// A pass of 12 dB per octave.
const fn pass(kind: Kind, hz: f64) -> Band {
    band(kind, hz, 0.0, std::f64::consts::FRAC_1_SQRT_2)
}

/// The Q of the two filters of a Butterworth pass of 24 dB per octave.
const STEEP_Q: [f64; 2] = [0.541_196_1, 1.306_563];

#[derive(Debug, Clone, Copy)]
struct Compression {
    threshold_db: f64,
    ratio: f64,
    attack_s: f64,
    release_s: f64,
    knee_db: f64,
}

struct Preset {
    bands: &'static [Band],
    compression: Option<Compression>,
    /// Integrated loudness of every sentence, in LUFS.
    loudness: f64,
    /// The highest a sample may go, in dBFS.
    ceiling_db: f64,
}

const NATURAL: Preset = Preset {
    bands: &[],
    compression: None,
    loudness: -18.0,
    ceiling_db: -1.0,
};

const WARM: Preset = Preset {
    bands: &[
        pass(Kind::HighPass, 70.0),
        band(Kind::LowShelf, 200.0, 2.5, 0.7),
        band(Kind::Peak, 900.0, -1.5, 1.4),
        band(Kind::Peak, 7000.0, -3.0, 3.0),
        band(Kind::HighShelf, 8000.0, -3.0, 0.7),
    ],
    compression: Some(Compression {
        threshold_db: -22.0,
        ratio: 2.0,
        attack_s: 0.015,
        release_s: 0.18,
        knee_db: 6.0,
    }),
    loudness: -18.0,
    ceiling_db: -1.0,
};

const CLEAR: Preset = Preset {
    bands: &[
        pass(Kind::HighPass, 90.0),
        band(Kind::Peak, 350.0, -2.0, 1.0),
        band(Kind::Peak, 3000.0, 2.5, 1.0),
        band(Kind::Peak, 7000.0, -2.5, 3.0),
        band(Kind::HighShelf, 8000.0, -1.5, 0.7),
    ],
    compression: Some(Compression {
        threshold_db: -24.0,
        ratio: 2.5,
        attack_s: 0.01,
        release_s: 0.15,
        knee_db: 6.0,
    }),
    loudness: -17.0,
    ceiling_db: -1.0,
};

const SOFT: Preset = Preset {
    bands: &[
        pass(Kind::HighPass, 70.0),
        band(Kind::LowShelf, 220.0, 1.5, 0.7),
        band(Kind::Peak, 2800.0, -1.5, 0.9),
        band(Kind::HighShelf, 6000.0, -4.0, 0.7),
        band(Kind::LowPass, 8000.0, 0.0, STEEP_Q[0]),
        band(Kind::LowPass, 8000.0, 0.0, STEEP_Q[1]),
    ],
    compression: Some(Compression {
        threshold_db: -20.0,
        ratio: 1.5,
        attack_s: 0.025,
        release_s: 0.25,
        knee_db: 6.0,
    }),
    loudness: -20.0,
    ceiling_db: -1.5,
};

const RADIO: Preset = Preset {
    bands: &[
        band(Kind::HighPass, 120.0, 0.0, STEEP_Q[0]),
        band(Kind::HighPass, 120.0, 0.0, STEEP_Q[1]),
        band(Kind::Peak, 250.0, -3.0, 1.0),
        band(Kind::Peak, 1800.0, 4.0, 0.8),
        band(Kind::LowPass, 4000.0, 0.0, STEEP_Q[0]),
        band(Kind::LowPass, 4000.0, 0.0, STEEP_Q[1]),
    ],
    compression: Some(Compression {
        threshold_db: -26.0,
        ratio: 4.0,
        attack_s: 0.005,
        release_s: 0.1,
        knee_db: 6.0,
    }),
    loudness: -16.0,
    ceiling_db: -1.0,
};

const NIGHT: Preset = Preset {
    bands: &[
        pass(Kind::HighPass, 90.0),
        band(Kind::LowShelf, 200.0, -2.0, 0.7),
        band(Kind::Peak, 2500.0, 1.5, 1.0),
        band(Kind::Peak, 7000.0, -3.0, 3.0),
        band(Kind::HighShelf, 6000.0, -4.0, 0.7),
        pass(Kind::LowPass, 9000.0),
    ],
    compression: Some(Compression {
        threshold_db: -28.0,
        ratio: 3.0,
        attack_s: 0.01,
        release_s: 0.2,
        knee_db: 6.0,
    }),
    loudness: -22.0,
    ceiling_db: -2.0,
};

/// `part` of a sentence, as `style` wants it. The gains come from the whole sentence, `full`, so that every part of it
/// sounds the same, whatever speed it was stretched to.
pub fn shape(full: &[f32], part: &[f32], sample_rate: u32, style: Style) -> Vec<f32> {
    let preset = style.preset();
    let rate = f64::from(sample_rate);
    let mut whole = equalize(full, rate, preset.bands);
    let before = gain_to(preset.loudness, loudness(&whole, rate));
    let after = preset.compression.map_or(0.0, |compression| {
        scale(&mut whole, before);
        compress(&mut whole, rate, compression);
        gain_to(preset.loudness, loudness(&whole, rate))
    });
    let mut out = equalize(part, rate, preset.bands);
    scale(&mut out, before);
    if let Some(compression) = preset.compression {
        compress(&mut out, rate, compression);
        scale(&mut out, after);
    }
    limit(&mut out, rate, preset.ceiling_db);
    out
}

fn gain_to(target: f64, measured: Option<f64>) -> f64 {
    measured.map_or(0.0, |lufs| (target - lufs).clamp(-MAX_GAIN_DB, MAX_GAIN_DB))
}

fn scale(samples: &mut [f32], db: f64) {
    if db == 0.0 {
        return;
    }
    let factor = 10f64.powf(db / 20.0) as f32;
    samples.iter_mut().for_each(|sample| *sample *= factor);
}

/// The coefficients of a filter of the Audio EQ Cookbook (R. Bristow-Johnson), divided by `a0`.
#[derive(Debug, Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
}

impl Biquad {
    fn new(band: Band, rate: f64) -> Self {
        let w0 = 2.0 * PI * band.hz / rate;
        let (sin, cos) = w0.sin_cos();
        let gain = 10f64.powf(band.db / 40.0);
        let (b, a) = match band.kind {
            Kind::LowPass | Kind::HighPass | Kind::Peak => {
                let alpha = sin / (2.0 * band.q);
                match band.kind {
                    Kind::LowPass => {
                        let side = (1.0 - cos) / 2.0;
                        (
                            [side, 1.0 - cos, side],
                            [1.0 + alpha, -2.0 * cos, 1.0 - alpha],
                        )
                    }
                    Kind::HighPass => {
                        let side = (1.0 + cos) / 2.0;
                        (
                            [side, -(1.0 + cos), side],
                            [1.0 + alpha, -2.0 * cos, 1.0 - alpha],
                        )
                    }
                    _ => (
                        [1.0 + alpha * gain, -2.0 * cos, 1.0 - alpha * gain],
                        [1.0 + alpha / gain, -2.0 * cos, 1.0 - alpha / gain],
                    ),
                }
            }
            Kind::LowShelf | Kind::HighShelf => {
                let alpha = sin / 2.0 * ((gain + 1.0 / gain) * (1.0 / band.q - 1.0) + 2.0).sqrt();
                let root = 2.0 * gain.sqrt() * alpha;
                let (up, down) = (gain + 1.0, gain - 1.0);
                if let Kind::LowShelf = band.kind {
                    (
                        [
                            gain * (up - down * cos + root),
                            2.0 * gain * (down - up * cos),
                            gain * (up - down * cos - root),
                        ],
                        [
                            up + down * cos + root,
                            -2.0 * (down + up * cos),
                            up + down * cos - root,
                        ],
                    )
                } else {
                    (
                        [
                            gain * (up + down * cos + root),
                            -2.0 * gain * (down + up * cos),
                            gain * (up + down * cos - root),
                        ],
                        [
                            up - down * cos + root,
                            2.0 * (down - up * cos),
                            up - down * cos - root,
                        ],
                    )
                }
            }
        };
        Self {
            b: [b[0] / a[0], b[1] / a[0], b[2] / a[0]],
            a: [a[1] / a[0], a[2] / a[0]],
        }
    }

    fn run(&self, samples: &mut [f64]) {
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for sample in samples.iter_mut() {
            let x = *sample;
            let y =
                self.b[0] * x + self.b[1] * x1 + self.b[2] * x2 - self.a[0] * y1 - self.a[1] * y2;
            (x2, x1, y2, y1) = (x1, x, y1, y);
            *sample = y;
        }
    }
}

fn equalize(samples: &[f32], rate: f64, bands: &[Band]) -> Vec<f32> {
    let mut wide: Vec<f64> = samples.iter().map(|&sample| f64::from(sample)).collect();
    for band in bands.iter().filter(|band| band.hz < HIGHEST_FILTER * rate) {
        Biquad::new(*band, rate).run(&mut wide);
    }
    wide.into_iter().map(|sample| sample as f32).collect()
}

/// A feed-forward compressor with a soft knee, on the level of the samples followed with an attack and a release.
fn compress(samples: &mut [f32], rate: f64, c: Compression) {
    let attack = (-1.0 / (c.attack_s * rate)).exp();
    let release = (-1.0 / (c.release_s * rate)).exp();
    let slope = 1.0 / c.ratio - 1.0;
    let mut level = 0.0f64;
    for sample in samples.iter_mut() {
        let magnitude = f64::from(sample.abs());
        let coefficient = if magnitude > level { attack } else { release };
        level = coefficient * level + (1.0 - coefficient) * magnitude;
        let over = 20.0 * level.max(1e-9).log10() - c.threshold_db;
        let reduction = if 2.0 * over < -c.knee_db {
            0.0
        } else if 2.0 * over.abs() <= c.knee_db {
            slope * (over + c.knee_db / 2.0).powi(2) / (2.0 * c.knee_db)
        } else {
            slope * over
        };
        *sample *= 10f64.powf(reduction / 20.0) as f32;
    }
}

/// Keeps every sample under `ceiling_db`: the gain goes down a little before a peak and comes back after it.
fn limit(samples: &mut [f32], rate: f64, ceiling_db: f64) {
    let ceiling = 10f64.powf(ceiling_db / 20.0);
    let reach = (LIMITER_LOOKAHEAD_S * rate).round().max(1.0) as usize;
    let needed: Vec<f64> = samples
        .iter()
        .map(|&sample| (ceiling / f64::from(sample.abs()).max(1e-12)).min(1.0))
        .collect();
    let window =
        |values: &[f64], at: usize| at.saturating_sub(reach)..(at + reach + 1).min(values.len());
    // Each gain is the least any sample near it needs, and their mean is no more than what each sample needs.
    let least: Vec<f64> = (0..needed.len())
        .map(|at| {
            needed[window(&needed, at)]
                .iter()
                .copied()
                .fold(1.0, f64::min)
        })
        .collect();
    let back = 1.0 - (-1.0 / (LIMITER_RELEASE_S * rate)).exp();
    let mut gain = 1.0f64;
    for (at, sample) in samples.iter_mut().enumerate() {
        let near = &least[window(&least, at)];
        let smooth = near.iter().sum::<f64>() / near.len() as f64;
        gain = smooth.min(gain + (1.0 - gain) * back);
        *sample = ((f64::from(*sample) * gain) as f32).clamp(-1.0, 1.0);
    }
}

/// The K-weighting of BS.1770 at any sample rate, as libebur128 builds it.
fn k_weighting(rate: f64) -> [Biquad; 2] {
    let shelf = {
        let (hz, db, q) = (
            1_681.974_450_955_533,
            3.999_843_853_973_347,
            0.707_175_236_955_419_6,
        );
        let k = (PI * hz / rate).tan();
        let vh = 10f64.powf(db / 20.0);
        let vb = vh.powf(0.499_666_774_154_541_6);
        let a0 = 1.0 + k / q + k * k;
        Biquad {
            b: [
                (vh + vb * k / q + k * k) / a0,
                2.0 * (k * k - vh) / a0,
                (vh - vb * k / q + k * k) / a0,
            ],
            a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
        }
    };
    let high_pass = {
        let (hz, q) = (38.135_470_876_024_44, 0.500_327_037_323_877_3);
        let k = (PI * hz / rate).tan();
        let a0 = 1.0 + k / q + k * k;
        Biquad {
            b: [1.0, -2.0, 1.0],
            a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
        }
    };
    [shelf, high_pass]
}

/// The integrated loudness in LUFS (BS.1770-4: blocks of 400 ms every 100 ms, gated at -70 LUFS and 10 LU under their
/// mean). `None` for silence.
fn loudness(samples: &[f32], rate: f64) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let shortest = (SHORTEST_MEASURE_S * rate).ceil() as usize;
    let mut weighted: Vec<f64> = samples
        .iter()
        .cycle()
        .take(samples.len().max(shortest))
        .map(|&sample| f64::from(sample))
        .collect();
    for filter in k_weighting(rate) {
        filter.run(&mut weighted);
    }
    let block = (0.4 * rate).round() as usize;
    let step = (0.1 * rate).round() as usize;
    let powers: Vec<f64> = (0..=weighted.len() - block)
        .step_by(step)
        .map(|start| {
            weighted[start..start + block]
                .iter()
                .map(|x| x * x)
                .sum::<f64>()
                / block as f64
        })
        .collect();
    let lufs = |power: f64| -0.691 + 10.0 * power.log10();
    let mean = |powers: &[f64]| powers.iter().sum::<f64>() / powers.len() as f64;
    let heard: Vec<f64> = powers
        .into_iter()
        .filter(|&power| lufs(power) > -70.0)
        .collect();
    if heard.is_empty() {
        return None;
    }
    let gate = lufs(mean(&heard)) - 10.0;
    let kept: Vec<f64> = heard
        .into_iter()
        .filter(|&power| lufs(power) > gate)
        .collect();
    Some(lufs(mean(&kept)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 22_050;
    const STYLES: [Style; 6] = [
        Style::Natural,
        Style::Warm,
        Style::Clear,
        Style::Soft,
        Style::Radio,
        Style::Night,
    ];

    fn sine(hz: f64, amplitude: f64, seconds: f64) -> Vec<f32> {
        let count = (seconds * f64::from(RATE)) as usize;
        (0..count)
            .map(|i| (amplitude * (2.0 * PI * hz * i as f64 / f64::from(RATE)).sin()) as f32)
            .collect()
    }

    /// Something like speech: three tones that come and go four times a second, with gaps.
    fn speechlike(amplitude: f64, seconds: f64) -> Vec<f32> {
        let count = (seconds * f64::from(RATE)) as usize;
        (0..count)
            .map(|i| {
                let t = i as f64 / f64::from(RATE);
                let syllable = (2.0 * PI * 4.0 * t).sin().max(0.0);
                let tone = 0.5 * (2.0 * PI * 180.0 * t).sin()
                    + 0.3 * (2.0 * PI * 900.0 * t).sin()
                    + 0.2 * (2.0 * PI * 3200.0 * t).sin();
                (amplitude * syllable * tone) as f32
            })
            .collect()
    }

    fn rate() -> f64 {
        f64::from(RATE)
    }

    fn peak(samples: &[f32]) -> f32 {
        samples
            .iter()
            .fold(0.0, |most, sample| most.max(sample.abs()))
    }

    #[test]
    fn a_sine_measures_as_bs_1770_says() {
        // A tone of 1 kHz at -20 dBFS is about -23 LUFS: its power is 3 dB under its peak.
        let measured = loudness(&sine(1000.0, 0.1, 3.0), rate()).unwrap();
        assert!((measured - -23.0).abs() < 0.3, "{measured}");
    }

    #[test]
    fn silence_has_no_loudness() {
        assert_eq!(loudness(&[0.0; 30_000], rate()), None);
        assert_eq!(loudness(&[], rate()), None);
    }

    #[test]
    fn a_short_sentence_measures_as_a_long_one() {
        let short = loudness(&sine(1000.0, 0.1, 0.2), rate()).unwrap();
        let long = loudness(&sine(1000.0, 0.1, 3.0), rate()).unwrap();
        assert!((short - long).abs() < 0.5, "{short} {long}");
    }

    #[test]
    fn a_peak_filter_lifts_its_frequency() {
        let tone = sine(1000.0, 0.1, 1.0);
        let lifted = equalize(&tone, rate(), &[band(Kind::Peak, 1000.0, 6.0, 1.0)]);
        let gain = 20.0 * f64::from(peak(&lifted[11_025..]) / peak(&tone[11_025..])).log10();
        assert!((gain - 6.0).abs() < 0.3, "{gain}");
    }

    #[test]
    fn a_high_pass_takes_away_the_hum() {
        let hum = sine(30.0, 0.5, 1.0);
        let cleaned = equalize(&hum, rate(), &[pass(Kind::HighPass, 120.0)]);
        assert!(peak(&cleaned[11_025..]) < 0.05);
    }

    #[test]
    fn a_filter_near_half_the_rate_is_left_out() {
        let tone = sine(1000.0, 0.1, 0.5);
        assert_eq!(
            equalize(&tone, rate(), &[pass(Kind::LowPass, 10_500.0)]),
            tone
        );
    }

    #[test]
    fn every_style_brings_a_quiet_and_a_loud_sentence_to_its_loudness() {
        for style in STYLES {
            let target = style.preset().loudness;
            for amplitude in [0.1, 0.6] {
                let voice = speechlike(amplitude, 3.0);
                let shaped = shape(&voice, &voice, RATE, style);
                let measured = loudness(&shaped, rate()).unwrap();
                assert!(
                    (measured - target).abs() < 1.5,
                    "{style:?} {amplitude}: {measured}"
                );
            }
        }
    }

    #[test]
    fn no_style_lets_a_sample_past_its_ceiling() {
        for style in STYLES {
            let voice = speechlike(0.95, 2.0);
            let ceiling = 10f32.powf(style.preset().ceiling_db as f32 / 20.0);
            let shaped = shape(&voice, &voice, RATE, style);
            assert!(
                peak(&shaped) <= ceiling * 1.001,
                "{style:?}: {}",
                peak(&shaped)
            );
        }
    }

    #[test]
    fn a_part_takes_the_gain_of_its_whole_sentence() {
        let voice = speechlike(0.05, 3.0);
        let whole = shape(&voice, &voice, RATE, Style::Natural);
        let part = shape(&voice, &voice[33_075..], RATE, Style::Natural);
        assert_eq!(part, whole[33_075..]);
    }

    #[test]
    fn silence_stays_silent() {
        for style in STYLES {
            let quiet = vec![0.0f32; 10_000];
            assert!(shape(&quiet, &quiet, RATE, style)
                .iter()
                .all(|&sample| sample == 0.0));
        }
    }

    #[test]
    fn a_style_is_found_by_its_name_and_any_other_name_is_natural() {
        assert_eq!(Style::named("warm"), Style::Warm);
        assert_eq!(Style::named("night"), Style::Night);
        assert_eq!(Style::named(""), Style::Natural);
        assert_eq!(Style::named("loud"), Style::Natural);
    }
}
