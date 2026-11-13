// SPDX-License-Identifier: GPL-3.0-or-later
import { AUDIO_RATES } from './engine-audio.js';
import { RATE_LEVELS } from './player.js';

/**
 * One SpeechEngine in front of two: the voices of Windows go to WebSpeechEngine, the voices the app says itself
 * (`piper:…`, `edge:…`) to AudioEngine. Any id without one of these prefixes is a voice of Windows, as saved before 0.4.0.
 */

export const PIPER_PREFIX = 'piper:';
export const EDGE_PREFIX = 'edge:';

/** @returns {'piper'|'edge'|'sapi'} */
export function engineOf(voiceId) {
  if (typeof voiceId === 'string' && voiceId.startsWith(PIPER_PREFIX)) return 'piper';
  if (typeof voiceId === 'string' && voiceId.startsWith(EDGE_PREFIX)) return 'edge';
  return 'sapi';
}

/** Whether a new speed or volume reaches the sentence being said, instead of saying it again. */
export const isLive = (voiceId) => engineOf(voiceId) !== 'sapi';

export class RoutedEngine {
  #web;
  #audio;

  constructor({ web, audio }) {
    this.#web = web;
    this.#audio = audio;
  }

  async voices() {
    const [windows, own] = await Promise.all([
      this.#web.voices().catch(() => []),
      this.#audio.voices().catch(() => []),
    ]);
    return [...windows, ...own];
  }

  speak(text, options = {}) {
    const target = this.#of(options.voiceId);
    const other = target === this.#web ? this.#audio : this.#web;
    other.stop();
    return target.speak(text, options);
  }

  stop() {
    this.#web.stop();
    this.#audio.stop();
  }

  prepare(text, options = {}) {
    if (isLive(options.voiceId)) this.#audio.prepare(text, options);
  }

  rates(voiceId) {
    return isLive(voiceId) ? AUDIO_RATES : RATE_LEVELS;
  }

  live(voiceId) {
    return isLive(voiceId);
  }

  /** A new speed or volume for the sentence being said by a voice of the app. */
  adjust({ rate, volume }) {
    this.#audio.setRate(rate);
    this.#audio.setVolume(volume);
  }

  /** How loud a test run speaks: both engines hear it. */
  get volume() {
    return this.#web.volume;
  }

  set volume(value) {
    this.#web.volume = value;
    this.#audio.volume = value;
  }

  get onTrace() {
    return this.#web.onTrace;
  }

  set onTrace(trace) {
    this.#web.onTrace = trace;
    this.#audio.onTrace = trace;
  }

  #of(voiceId) {
    return isLive(voiceId) ? this.#audio : this.#web;
  }
}
