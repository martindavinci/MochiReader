// SPDX-License-Identifier: GPL-3.0-or-later
import { decodePcm } from './pcm.js';

/**
 * SpeechEngine for the voices the app says itself (Piper, Edge). Rust makes the sound of a sentence and stretches it to
 * the speed asked; this plays it with Web Audio. A new speed or volume reaches the sound being played: the sentence
 * goes on from where it is.
 *
 * Besides voices/speak/stop of every engine:
 *   prepare(text, {voiceId})   makes the sound of the next sentence while this one is said
 *   setRate(rate), setVolume(volume)
 *   resound()                  the sound the reader chose reaches the sentence being said
 *   rates()                    the speeds it has
 *   speak(..., {onWord})       onWord({start, end}) as each word begins, in UTF-16 units of the text; onWord(null) at the end
 */

/** 0.5 to 4 by tenths, built from whole numbers so that none drifts. */
export const AUDIO_RATES = Object.freeze(Array.from({ length: 36 }, (_, i) => (i + 5) / 10));

const NATURAL = 'natural';

const defaultTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (timer) => clearTimeout(timer),
};

export class AudioEngine {
  #invoke;
  #AudioContext;
  #timers;
  #sound;
  #context = null;
  #gain = null;
  #volume = 1;
  /** The sentence being said: what it is, the source playing it and how to settle it. */
  #play = null;
  /** How loud a test run speaks, whatever the reader chose. Nothing else ever sets it. */
  volume = null;
  /** Called with 'start', 'end' or 'error:<kind>' and the text, in a test run that logs what it hears. */
  onTrace = null;
  /** Why the last sentence failed, as Rust says it (`{kind, message}`), until the next one begins. */
  lastError = null;

  /**
   * @param {{invoke: Function, AudioContext?: Function, timers?: object, sound?: () => string}} parts `sound` names the
   *   style Rust shapes each sentence in, asked again for every sentence.
   */
  constructor({ invoke, AudioContext = globalThis.AudioContext, timers = defaultTimers, sound = () => NATURAL } = {}) {
    this.#invoke = invoke;
    this.#sound = sound;
    this.#AudioContext = AudioContext;
    this.#timers = timers;
  }

  /** The installed voices the app says itself. */
  async voices() {
    try {
      return (await this.#invoke('tts_voices')) ?? [];
    } catch {
      return [];
    }
  }

  rates() {
    return AUDIO_RATES;
  }

  speak(text, { voiceId = null, rate = 1, volume = 1, onWord = null } = {}) {
    if (this.#play) this.stop();
    this.lastError = null;
    this.setVolume(volume);
    return new Promise((resolve) => {
      const play = {
        text,
        rate,
        onWord,
        id: null,
        sampleRate: 0,
        words: [],
        source: null,
        word: -1,
        timer: null,
        stretches: 0,
        settle: null,
      };
      play.settle = (outcome) => {
        if (this.#play !== play) return;
        this.#play = null;
        this.#timers.clear(play.timer);
        const { source } = play;
        play.source = null;
        if (source) this.#silence(source.node);
        if (play.word >= 0 || outcome !== 'end') this.#tellWord(play, null);
        this.onTrace?.(outcome === 'error' ? 'error:audio' : outcome, text);
        resolve(outcome);
      };
      this.#play = play;
      this.#invoke('tts_speak', { voiceId, text, rate, sound: this.#sound() })
        .then((data) => {
          if (this.#play !== play) return;
          const sound = decodePcm(data);
          play.id = sound.id;
          play.sampleRate = sound.sampleRate;
          play.words = sound.words;
          if (sound.rate !== play.rate) this.#restretch(play, 0);
          else this.#begin(play, sound, 0);
        })
        .catch((error) => {
          if (this.#play === play) this.lastError = error;
          play.settle('error');
        });
    });
  }

  stop() {
    this.#play?.settle('stopped');
  }

  /** Makes the sound of a sentence ahead of time. A failure here is found again, and told, when it is said. */
  prepare(text, { voiceId = null } = {}) {
    this.#invoke('tts_prepare', { voiceId, text }).catch(() => {});
  }

  setRate(rate) {
    const play = this.#play;
    if (!play || play.rate === rate) return;
    play.rate = rate;
    if (play.id === null) return;
    this.#restretch(play, this.#rawPosition(play));
  }

  resound() {
    const play = this.#play;
    if (play?.id == null) return;
    this.#restretch(play, this.#rawPosition(play));
  }

  setVolume(volume) {
    if (typeof volume === 'number' && !Number.isNaN(volume)) this.#volume = volume;
    if (this.#gain) this.#gain.gain.value = this.volume ?? this.#volume;
  }

  #ensureContext() {
    if (!this.#context) {
      this.#context = new this.#AudioContext();
      this.#gain = this.#context.createGain();
      this.#gain.connect(this.#context.destination);
      this.setVolume(this.#volume);
    }
    if (this.#context.state === 'suspended') this.#context.resume?.().catch?.(() => {});
    return this.#context;
  }

  /** Where the sentence is now, in samples of its sound at its own speed. */
  #rawPosition(play) {
    const { source } = play;
    if (!source) return 0;
    const elapsed = Math.max(0, this.#context.currentTime - source.startedAt);
    return Math.round(source.from + elapsed * play.sampleRate * source.rate);
  }

  /** Asks for the rest of the sentence at the speed wanted now. Only the answer to the last request is played. */
  #restretch(play, from) {
    play.stretches += 1;
    const token = play.stretches;
    this.#invoke('tts_restretch', { id: play.id, from, rate: play.rate, sound: this.#sound() })
      .then((data) => {
        if (this.#play !== play || play.stretches !== token) return;
        this.#begin(play, decodePcm(data), this.#rawPosition(play));
      })
      .catch(() => {
        // The sentence went on at the speed it had; only one never begun has nothing to go on with.
        if (this.#play === play && play.stretches === token && !play.source) play.settle('error');
      });
  }

  /** Plays `sound` from the raw sample `at`, in place of what was playing. */
  #begin(play, sound, at) {
    const context = this.#ensureContext();
    const old = play.source;
    if (sound.samples.length === 0) {
      if (!old) play.settle('end');
      return;
    }
    const buffer = context.createBuffer(1, sound.samples.length, sound.sampleRate);
    buffer.copyToChannel(sound.samples, 0);
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.#gain);
    const offset = Math.max(0, (at - sound.from) / (sound.sampleRate * sound.rate));
    const source = { node, from: sound.from, rate: sound.rate, startedAt: context.currentTime - offset };
    node.onended = () => {
      if (play.source === source) play.settle('end');
    };
    play.source = source;
    if (old) this.#silence(old.node);
    else this.onTrace?.('start', play.text);
    node.start(0, offset);
    this.#scheduleWords(play);
  }

  #silence(node) {
    node.onended = null;
    try {
      node.stop();
    } catch {
      // Already stopped.
    }
  }

  #tellWord(play, word) {
    try {
      play.onWord?.(word);
    } catch (error) {
      console.error(error);
    }
  }

  /** Tells the word being said, and waits for the next one against the clock of the audio. */
  #scheduleWords(play) {
    this.#timers.clear(play.timer);
    play.timer = null;
    if (this.#play !== play || !play.source || play.words.length === 0) return;
    const now = this.#rawPosition(play);
    const current = play.words.findLastIndex((word) => word.from <= now);
    if (current !== play.word && current >= 0) {
      play.word = current;
      const { start, end } = play.words[current];
      this.#tellWord(play, { start, end });
    }
    const next = play.words[current + 1];
    if (!next) return;
    const seconds = (next.from - now) / (play.sampleRate * play.source.rate);
    play.timer = this.#timers.set(() => this.#scheduleWords(play), Math.max(0, seconds * 1000));
  }
}
