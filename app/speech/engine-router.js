// SPDX-License-Identifier: GPL-3.0-or-later
import { AUDIO_RATES } from './engine-audio.js';
import { RATE_LEVELS } from './player.js';

/**
 * One SpeechEngine in front of two: the voices of Windows go to WebSpeechEngine, the voices the app says itself
 * (`piper:…`, `kokoro:…`, `edge:…`) to AudioEngine. Any id without one of these prefixes is a voice of Windows, as saved before 0.4.0.
 */

export const PIPER_PREFIX = 'piper:';
export const EDGE_PREFIX = 'edge:';
export const KOKORO_PREFIX = 'kokoro:';

/** @returns {'piper'|'kokoro'|'edge'|'sapi'} */
export function engineOf(voiceId) {
  if (typeof voiceId === 'string' && voiceId.startsWith(PIPER_PREFIX)) return 'piper';
  if (typeof voiceId === 'string' && voiceId.startsWith(KOKORO_PREFIX)) return 'kokoro';
  if (typeof voiceId === 'string' && voiceId.startsWith(EDGE_PREFIX)) return 'edge';
  return 'sapi';
}

/** A voice downloaded to this PC (Piper, Kokoro, or a mix of Kokoro voices): it may be gone since it was chosen. */
export const isDownloaded = (voiceId) => ['piper', 'kokoro'].includes(engineOf(voiceId));

/** Whether a new speed or volume reaches the sentence being said, instead of saying it again. */
export const isLive = (voiceId) => engineOf(voiceId) !== 'sapi';

/**
 * Every voice the app can read with, each marked `local` (Windows, Piper) or `online` (Edge, listed only while on).
 * @returns {Promise<{id: string, name: string, lang: string, group: 'local'|'online'}[]>}
 */
export async function listVoices({ web, invoke, edgeOn = false }) {
  const asked = (command) => invoke(command).then((voices) => voices ?? [], () => []);
  const [windows, piper, edge] = await Promise.all([
    web.voices().catch(() => []),
    asked('tts_voices'),
    edgeOn ? asked('tts_edge_voices') : [],
  ]);
  return [
    ...[...windows, ...piper].map((voice) => ({ ...voice, group: 'local' })),
    ...edge.map((voice) => ({ ...voice, group: 'online' })),
  ];
}

export class RoutedEngine {
  #web;
  #audio;
  #last = null;
  /**
   * Told when a voice of the app fails on a sentence, with the options of that sentence and why it failed. When it
   * answers true it has moved the reading to another voice, and this sentence is over for whoever asked.
   */
  onLiveError = null;

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

  async speak(text, options = {}) {
    const target = this.#of(options.voiceId);
    // Only the engine that spoke last can still be speaking.
    if (this.#last && this.#last !== target) this.#last.stop();
    this.#last = target;
    const outcome = await target.speak(text, options);
    if (outcome === 'error' && target === this.#audio && this.onLiveError?.(options, this.#audio.lastError)) {
      return 'stopped';
    }
    return outcome;
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

  /** The sound the reader chose, for the sentence being said by a voice of the app. Windows voices have their own. */
  resound() {
    this.#audio.resound();
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
