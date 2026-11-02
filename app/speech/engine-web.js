// SPDX-License-Identifier: GPL-3.0-or-later

/** SpeechEngine on top of speechSynthesis. Only local voices are listed or used: no network. */

/** The voice list can arrive after the page loads, and on some systems it never does. */
export const VOICES_WAIT_MS = 2000;

const CANCEL_ERRORS = new Set(['canceled', 'interrupted']);

const primaryLang = (tag) => tag.toLowerCase().split(/[-_]/)[0];

export class WebSpeechEngine {
  #synth;
  #Utterance;
  /** Kept until settled: an utterance nobody references can lose its events to the GC. */
  #utterance = null;
  #settle = null;

  constructor({ synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance } = {}) {
    this.#synth = synth;
    this.#Utterance = Utterance;
  }

  async voices() {
    if (this.#synth.getVoices().length === 0) await this.#voicesChanged();
    return this.#localVoices().map((voice) => ({ id: voice.voiceURI, name: voice.name, lang: voice.lang }));
  }

  speak(text, { voiceId = null, rate = 1, lang = null } = {}) {
    if (this.#settle) this.stop();

    return new Promise((resolve) => {
      const settle = (outcome) => {
        if (this.#settle !== settle) return;
        this.#utterance = null;
        this.#settle = null;
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
        utterance.lang = lang ?? voice.lang;
        utterance.onend = () => settle('end');
        utterance.onerror = (event) => settle(CANCEL_ERRORS.has(event.error) ? 'stopped' : 'error');
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
    if (!lang) return local[0];
    return local.find((voice) => primaryLang(voice.lang) === primaryLang(lang));
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
