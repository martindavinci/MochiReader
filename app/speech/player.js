// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Walks the blocks of a document sentence by sentence and drives a SpeechEngine.
 *
 * SpeechEngine:
 *   voices(): Promise<{id, name, lang}[]>   local voices only
 *   speak(text, {voiceId, rate, lang}): Promise<'end'|'stopped'|'error'>
 *   stop(): void
 *
 * Callbacks:
 *   onSentence({block, sentence}, sentence)  a sentence starts, or the position moved while silent
 *   onState(state)                           'idle'|'playing'|'paused'|'ended'
 *   onError(code)                            ERROR_ENGINE or ERROR_NOTHING_TO_READ
 * A callback that throws is logged: it stops neither the reading nor whoever moved the position.
 *
 * Players can share an engine. It says one thing at a time, so a player that starts first stops the one
 * reading, which goes idle at once: from then on it has nothing to stop and nothing to say.
 */

export const HEADING_PAUSE_MS = 600;
export const ITEM_PAUSE_MS = 300;
export const ROW_PAUSE_MS = 250;

/** The speeds Windows really has: between these, a rate changes nothing. */
export const RATE_LEVELS = Object.freeze([0.5, 0.6, 0.7, 0.8, 1.0, 1.3, 1.5, 1.7, 1.9, 2.0, 2.2, 2.5, 2.7, 2.9, 3.0]);
export const MIN_RATE = RATE_LEVELS[0];
export const MAX_RATE = RATE_LEVELS.at(-1);
const DEFAULT_RATE = 1;

/** Time granted to any sentence, on top of the time that depends on its length. */
export const SPEAK_WATCHDOG_MS = 10000;
/** About three times what a voice needs per character at normal speed. */
const WATCHDOG_MS_PER_CHAR = 200;

export const ERROR_ENGINE = 'engine-error';
export const ERROR_NOTHING_TO_READ = 'nothing-to-read';

export function speakWatchdogMs(text, rate) {
  return SPEAK_WATCHDOG_MS + (text.length * WATCHDOG_MS_PER_CHAR) / rate;
}

/** Infinity counts: it means "as far as it goes". */
const isRate = (rate) => typeof rate === 'number' && !Number.isNaN(rate);

/** The level after this rate, for the + key. The last level stays where it is, and what is no rate gets the normal speed. */
export function nextRate(rate) {
  if (!isRate(rate)) return DEFAULT_RATE;
  return RATE_LEVELS.find((level) => level > rate) ?? MAX_RATE;
}

/** The level before this rate, for the - key. The first level stays where it is, and what is no rate gets the normal speed. */
export function prevRate(rate) {
  if (!isRate(rate)) return DEFAULT_RATE;
  return RATE_LEVELS.findLast((level) => level < rate) ?? MIN_RATE;
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
/** A whole number to clamp, 0 for anything else. Infinity stays: it means "the last one". */
const toIndex = (value) => (typeof value === 'number' && !Number.isNaN(value) ? Math.trunc(value) : 0);

function pauseAfter(block) {
  if (block.kind === 'heading') return HEADING_PAUSE_MS;
  if (block.kind === 'cell') return block.rowEnd ? ROW_PAUSE_MS : 0;
  return ITEM_PAUSE_MS;
}

function nearestLevel(rate) {
  const distance = (level) => Math.abs(level - rate);
  return RATE_LEVELS.reduce((best, level) => (distance(level) < distance(best) ? level : best));
}

const isHeading = (block) => block.kind === 'heading';
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = () => {};

/** The player in the 'playing' state on each engine: there is one at most. */
const readers = new WeakMap();

export class SpeechPlayer {
  #engine;
  #sleep;
  #onSentence;
  #onState;
  #onError;
  #blocks = [];
  #position = { block: 0, sentence: 0 };
  #state = 'idle';
  #rate = DEFAULT_RATE;
  #voiceId = null;
  #lang = null;
  /** Bumped to cancel the reading loop in progress: a stale loop exits at its next check. */
  #run = 0;
  #watchdog = null;
  /**
   * Set during the gap between two blocks: the sentence that comes next, not announced yet.
   * Until then #position stays on the sentence just heard, so moving counts from there.
   */
  #upcoming = null;

  constructor({ engine, sleep = defaultSleep, onSentence = noop, onState = noop, onError = noop }) {
    this.#engine = engine;
    this.#sleep = sleep;
    this.#onSentence = onSentence;
    this.#onState = onState;
    this.#onError = onError;
  }

  get state() {
    return this.#state;
  }

  get current() {
    return { ...this.#position };
  }

  get rate() {
    return this.#rate;
  }

  load(blocks, at = { block: 0, sentence: 0 }) {
    this.#silence();
    this.#blocks = blocks;
    this.#position = this.#nearest(at);
    this.#setState('idle');
  }

  play() {
    if (this.#state === 'playing') return;
    if (!this.#hasText()) {
      this.#guarded(this.#onError, ERROR_NOTHING_TO_READ);
      return;
    }
    if (this.#state === 'ended') this.#position = this.#blockStart(this.#scan(0, 1));
    this.#start();
  }

  pause() {
    if (this.#state === 'playing') this.#halt('paused');
  }

  /** A document just loaded goes straight to a pause on its place, without a sound. */
  park() {
    if (this.#state !== 'idle' || !this.#hasText()) return;
    this.#setState('paused');
    this.#notifySentence();
  }

  resume() {
    if (this.#state === 'paused') this.#start();
  }

  stop() {
    this.#halt('idle');
  }

  nextSentence() {
    this.#navigate(() => this.#sentenceAfter());
  }

  prevSentence() {
    this.#navigate(() => {
      const { block, sentence } = this.#position;
      if (sentence > 0) return { block, sentence: sentence - 1 };
      const previous = this.#scan(block - 1, -1);
      if (previous < 0) return { block, sentence };
      return { block: previous, sentence: this.#blocks[previous].sentences.length - 1 };
    });
  }

  nextBlock() {
    this.#navigate(() => this.#blockStart(this.#scan(this.#position.block + 1, 1)));
  }

  prevBlock() {
    this.#navigate(() => {
      const { block } = this.#position;
      const previous = this.#scan(block - 1, -1);
      return this.#blockStart(previous < 0 ? block : previous);
    });
  }

  nextSection() {
    this.#navigate(() => {
      const { block } = this.#position;
      const own = this.#scan(block, -1, isHeading);
      const level = own < 0 ? Infinity : this.#blocks[own].level;
      const peer = this.#scan(block + 1, 1, (b) => isHeading(b) && b.level <= level);
      return this.#blockStart(peer >= 0 ? peer : this.#scan(block + 1, 1, isHeading));
    });
  }

  /** Inside a section goes back to its heading; on a heading, to the heading before it. */
  prevSection() {
    this.#navigate(() => {
      const { block, sentence } = this.#position;
      const own = this.#scan(block, -1, isHeading);
      if (own < 0) return this.#blockStart(this.#scan(0, 1));
      if (own < block || sentence > 0) return this.#blockStart(own);
      const { level } = this.#blocks[own];
      const previous = this.#scan(own - 1, -1, (b) => isHeading(b) && b.level <= level);
      return this.#blockStart(previous < 0 ? this.#scan(0, 1) : previous);
    });
  }

  jumpTo(at) {
    this.#navigate(() => this.#nearest(at));
  }

  setRate(rate) {
    if (!isRate(rate)) return;
    const next = nearestLevel(clamp(rate, MIN_RATE, MAX_RATE));
    if (next === this.#rate) return;
    this.#rate = next;
    this.#restartIfPlaying();
  }

  setVoice(voiceId) {
    if (voiceId === this.#voiceId) return;
    this.#voiceId = voiceId;
    this.#restartIfPlaying();
  }

  /** The language given to the engine, from the next sentence on. */
  setLang(lang) {
    this.#lang = lang;
  }

  #setState(state) {
    if (state === this.#state) return;
    this.#state = state;
    if (state !== 'playing' && readers.get(this.#engine) === this) readers.delete(this.#engine);
    this.#guarded(this.#onState, state);
  }

  #hasText() {
    return this.#scan(0, 1) >= 0;
  }

  /** Index of the first block with something to read, walking from `from`, or -1. */
  #scan(from, step, accept = () => true) {
    for (let i = from; i >= 0 && i < this.#blocks.length; i += step) {
      const block = this.#blocks[i];
      if (block.sentences.length > 0 && accept(block)) return i;
    }
    return -1;
  }

  /** The sentence that follows the current one, or null at the end of the document. */
  #sentenceAfter() {
    const { block, sentence } = this.#position;
    if (sentence + 1 < this.#blocks[block].sentences.length) return { block, sentence: sentence + 1 };
    return this.#blockStart(this.#scan(block + 1, 1));
  }

  #blockStart(block) {
    return block < 0 ? null : { block, sentence: 0 };
  }

  /** The readable position closest to `at`, which may come from an older version of the file. */
  #nearest(at) {
    const wanted = clamp(toIndex(at?.block), 0, this.#blocks.length - 1);
    const after = this.#scan(wanted, 1);
    const found = after >= 0 ? after : this.#scan(wanted, -1);
    if (found < 0) return { block: 0, sentence: 0 };
    const last = this.#blocks[found].sentences.length - 1;
    if (found > wanted) return { block: found, sentence: 0 };
    if (found < wanted) return { block: found, sentence: last };
    return { block: found, sentence: clamp(toIndex(at?.sentence), 0, last) };
  }

  /** Moves to the position computed by `target`; a null target means past the end. */
  #navigate(target) {
    if (!this.#hasText()) return;
    const position = target();
    if (!position) {
      this.#finish();
      return;
    }
    this.#position = position;
    if (this.#state === 'playing') {
      this.#silence();
      this.#start();
      return;
    }
    if (this.#state === 'ended') this.#setState('idle');
    this.#notifySentence();
  }

  #finish() {
    this.#silence();
    this.#position = this.#nearest({ block: this.#blocks.length - 1, sentence: Infinity });
    this.#setState('ended');
  }

  #notifySentence() {
    const { block, sentence } = this.#position;
    this.#guarded(this.#onSentence, { block, sentence }, this.#blocks[block].sentences[sentence]);
  }

  #guarded(call, ...args) {
    try {
      call(...args);
    } catch (error) {
      console.error(error);
    }
  }

  #cancelRun() {
    this.#run += 1;
    this.#upcoming = null;
    clearTimeout(this.#watchdog);
  }

  /** During a gap nothing is being spoken, and what the engine says by then is not this player's to cut. */
  #silence() {
    const speaking = this.#state === 'playing' && !this.#upcoming;
    this.#cancelRun();
    if (speaking) this.#guarded(() => this.#engine.stop());
  }

  /** Stops on purpose. A gap cut short counts as over, so the sentence just heard is not repeated. */
  #halt(state) {
    const upcoming = this.#upcoming;
    this.#silence();
    if (upcoming) this.#position = upcoming;
    this.#setState(state);
    if (upcoming) this.#notifySentence();
  }

  /** During a gap nothing is being spoken: the next sentence picks up the new settings by itself. */
  #restartIfPlaying() {
    if (this.#state !== 'playing' || this.#upcoming) return;
    this.#silence();
    this.#start();
  }

  #start() {
    this.#cancelRun();
    const run = this.#run;
    const reader = readers.get(this.#engine);
    if (reader !== this) {
      reader?.#halt('idle');
      // A callback of the player just halted may have stopped this one, or started another.
      if (run !== this.#run || readers.has(this.#engine)) return;
      readers.set(this.#engine, this);
    }
    this.#setState('playing');
    this.#read(run).catch((error) => {
      console.error(error);
      if (run === this.#run) this.#interrupt('error');
    });
  }

  async #read(run) {
    while (run === this.#run) {
      this.#notifySentence();
      if (run !== this.#run) return;
      const { block, sentence } = this.#position;
      const outcome = await this.#speak(this.#blocks[block].sentences[sentence].text);
      if (run !== this.#run) return;
      if (outcome !== 'end') {
        this.#interrupt(outcome);
        return;
      }
      const next = this.#sentenceAfter();
      if (!next) {
        this.#cancelRun();
        this.#setState('ended');
        return;
      }
      const pause = next.block === block ? 0 : pauseAfter(this.#blocks[block]);
      if (pause > 0) {
        this.#upcoming = next;
        await this.#sleep(pause);
        if (run !== this.#run) return;
        this.#upcoming = null;
      }
      this.#position = next;
    }
  }

  /** An engine that throws, rejects or never answers counts as an engine error. */
  async #speak(text) {
    let timer;
    const expired = new Promise((resolve) => {
      timer = setTimeout(resolve, speakWatchdogMs(text, this.#rate), 'error');
    });
    this.#watchdog = timer;
    const options = { voiceId: this.#voiceId, rate: this.#rate, lang: this.#lang };
    try {
      return await Promise.race([this.#engine.speak(text, options), expired]);
    } catch {
      return 'error';
    } finally {
      clearTimeout(timer);
    }
  }

  /** After 'stopped' the engine is done with this sentence: another stop would hit whatever it speaks now. */
  #interrupt(outcome) {
    if (outcome === 'stopped') this.#cancelRun();
    else this.#silence();
    this.#setState('idle');
    if (outcome === 'error') this.#guarded(this.#onError, ERROR_ENGINE);
  }
}
