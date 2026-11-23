// SPDX-License-Identifier: GPL-3.0-or-later

import { getLang, t } from '../core/i18n.js';
import { parseLangTag, regionsInOrder } from './lang.js';

/** SpeechEngine on top of speechSynthesis. Only local voices are listed or used: no network. */

/** The voice list can arrive after the page loads, and on some systems it never does. */
export const VOICES_WAIT_MS = 2000;

const CANCEL_ERRORS = new Set(['canceled', 'interrupted']);
/** A word from where a voice says it starts, when the voice does not say how long it is. */
const WORD_AT = /^[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*/u;

/** @returns {{start: number, end: number}|null} The word a `boundary` event points at, in UTF-16 units of `text`. */
export function boundaryWord(text, charIndex, charLength) {
  if (!Number.isInteger(charIndex) || charIndex < 0 || charIndex >= text.length) return null;
  const length = charLength > 0 ? charLength : (WORD_AT.exec(text.slice(charIndex))?.[0].length ?? 0);
  return length > 0 ? { start: charIndex, end: Math.min(charIndex + length, text.length) } : null;
}

/** The name of a language, for the interface. The app has its own for two, and the browser knows the others. */
export function languageName(language) {
  const key = `lang.${language}`;
  const named = t(key);
  if (named !== key) return named;
  return new Intl.DisplayNames([getLang()], { type: 'language' }).of(language) ?? language;
}

/**
 * @param {{lang: string}[]} voices
 * @param {string|null} lang
 * @returns {object|undefined} The voice closest to a language: of its region if there is one.
 */
export function closestVoice(voices, lang) {
  const wanted = parseLangTag(lang);
  const sameLanguage = voices.filter((voice) => parseLangTag(voice.lang).language === wanted.language);
  const ofRegion = (region) => sameLanguage.find((voice) => parseLangTag(voice.lang).region === region);
  return regionsInOrder(wanted).map(ofRegion).find(Boolean) ?? sameLanguage[0];
}

/**
 * @param {{id: string, lang: string}[]} voices
 * @param {Record<string, string>} saved The last voice of each language, as the state keeps them.
 * @returns {{lang: string, voices: object[], selected: string}[]} The voices of each language, the languages in order.
 */
export function voiceGroups(voices, saved) {
  const languages = [...new Set(voices.map((voice) => parseLangTag(voice.lang).language))].sort();
  return languages.map((lang) => {
    const ofLang = voices.filter((voice) => parseLangTag(voice.lang).language === lang);
    const known = ofLang.some((voice) => voice.id === saved[lang]);
    return { lang, voices: ofLang, selected: known ? saved[lang] : closestVoice(ofLang, lang).id };
  });
}

export class WebSpeechEngine {
  #synth;
  #Utterance;
  /** Kept until settled: an utterance nobody references can lose its events to the GC. */
  #utterance = null;
  #settle = null;
  /** How loud a test run speaks, whatever the reader chose. Nothing else ever sets it. */
  volume = null;
  /** Called with 'start', 'end' or 'error:<kind>' and the text, in a test run that logs what it hears. */
  onTrace = null;

  constructor({ synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance } = {}) {
    this.#synth = synth;
    this.#Utterance = Utterance;
  }

  async voices() {
    if (!this.#synth) return [];
    if (this.#synth.getVoices().length === 0) await this.#voicesChanged();
    return this.#localVoices().map((voice) => ({ id: voice.voiceURI, name: voice.name, lang: voice.lang }));
  }

  speak(text, { voiceId = null, rate = 1, volume = 1, lang = null, onWord = null } = {}) {
    if (this.#settle) this.stop();

    return new Promise((resolve) => {
      let toldWord = false;
      const settle = (outcome) => {
        if (this.#settle !== settle) return;
        this.#utterance = null;
        this.#settle = null;
        if (toldWord) onWord?.(null);
        resolve(outcome);
      };
      this.#settle = settle;
      const say = () => {
        if (this.#settle !== settle) return;
        const voice = this.#pickVoice(voiceId, lang);
        if (!voice) {
          settle('error');
          return;
        }
        const utterance = new this.#Utterance(text);
        utterance.voice = voice;
        utterance.rate = rate;
        // a voice of another language speaks its own: told the text's, Windows would read with the wrong rules
        const sameLanguage = parseLangTag(voice.lang).language === parseLangTag(lang).language;
        utterance.lang = sameLanguage ? parseLangTag(lang).canonical || voice.lang : voice.lang;
        utterance.volume = this.volume ?? volume;
        const trace = this.onTrace;
        if (trace) utterance.onstart = () => trace('start', text);
        // Only some voices of Windows tell their words: the others leave the sentence tinted, as before.
        if (onWord) {
          utterance.onboundary = (event) => {
            if (this.#settle !== settle || event.name !== 'word') return;
            const word = boundaryWord(text, event.charIndex, event.charLength);
            if (!word) return;
            toldWord = true;
            onWord(word);
          };
        }
        utterance.onend = () => {
          trace?.('end', text);
          settle('end');
        };
        utterance.onerror = (event) => {
          trace?.(`error:${event.error}`, text);
          settle(CANCEL_ERRORS.has(event.error) ? 'stopped' : 'error');
        };
        this.#utterance = utterance;
        try {
          this.#synth.speak(utterance);
        } catch {
          settle('error');
        }
      };
      if (this.#synth.getVoices().length === 0) this.#voicesChanged().then(say);
      else say();
    });
  }

  stop() {
    this.#synth.cancel();
    if (this.#settle) this.#settle('stopped');
  }

  #localVoices() {
    return this.#synth.getVoices().filter((voice) => voice.localService);
  }

  #pickVoice(voiceId, lang) {
    const local = this.#localVoices();
    if (voiceId) return local.find((voice) => voice.voiceURI === voiceId);
    if (!parseLangTag(lang).language) return local[0];
    return closestVoice(local, lang);
  }

  #voicesChanged() {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#synth.removeEventListener('voiceschanged', done);
        resolve();
      };
      const timer = setTimeout(done, VOICES_WAIT_MS);
      this.#synth.addEventListener('voiceschanged', done);
    });
  }
}
