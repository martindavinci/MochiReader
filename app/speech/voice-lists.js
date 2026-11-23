// SPDX-License-Identifier: GPL-3.0-or-later
import { parseLangTag } from './lang.js';

/**
 * Which voices the reading bar offers: the ones of the text's language, then the ones the reader ticked "also in other
 * texts" in the Voices panel. Ids are as the reader uses them (`piper:…`, `kokoro:…`, `edge:…`, Windows voiceURI).
 * @typedef {{id: string, name: string, lang: string, group?: string}} Voice
 */

const languageOf = (tag) => parseLangTag(tag).language;

/**
 * @param {Voice[]} voices every voice there is now
 * @param {string} textLang the language of the text
 * @param {string[]} everywhere the ticked ids
 * @returns {{own: Voice[], others: Voice[]}} `others`: the ticked voices of other languages; a tick of a voice that is
 *   gone, or of the text's language, adds nothing.
 */
export function barVoices(voices, textLang, everywhere) {
  const language = languageOf(textLang);
  const ticked = new Set(everywhere);
  return {
    own: voices.filter((voice) => languageOf(voice.lang) === language),
    others: voices.filter((voice) => ticked.has(voice.id) && languageOf(voice.lang) !== language),
  };
}

/** Whether a saved voice can still read a text of `textLang`: it is offered in the bar for it. */
export function usableVoice(id, voices, textLang, everywhere) {
  if (!id) return false;
  const { own, others } = barVoices(voices, textLang, everywhere);
  return own.some((voice) => voice.id === id) || others.some((voice) => voice.id === id);
}

/** @returns {string[]} the ticks with `voiceId` among them, once. */
export function afterTick(voiceId, everywhere) {
  return everywhere.includes(voiceId) ? [...everywhere] : [...everywhere, voiceId];
}

/**
 * A tick taken off: the voice can no longer be the voice of another language, so the languages that had chosen it go
 * back to choosing by themselves.
 * @param {Record<string, string>} saved the voice saved for each language
 * @returns {{everywhere: string[], clear: string[]}} the ticks without it, and the languages to clear
 */
export function afterUntick(voiceId, voiceLang, everywhere, saved) {
  const own = languageOf(voiceLang);
  return {
    everywhere: everywhere.filter((id) => id !== voiceId),
    clear: Object.entries(saved ?? {})
      .filter(([language, id]) => id === voiceId && language !== own)
      .map(([language]) => language),
  };
}

/**
 * Saves a tick, or its removal and what follows from it: the languages that had chosen the voice choose by themselves
 * again (an empty voice clears a language).
 * @param {(command: string, args: object) => Promise<*>} invoke
 * @returns {Promise<string[]>} the ticks now
 */
export async function saveTick(invoke, { voiceId, voiceLang, on, everywhere, saved }) {
  if (on) {
    const now = afterTick(voiceId, everywhere);
    await invoke('state_set_option', { name: 'voicesEverywhere', value: now });
    return now;
  }
  const { everywhere: now, clear } = afterUntick(voiceId, voiceLang, everywhere, saved);
  await invoke('state_set_option', { name: 'voicesEverywhere', value: now });
  for (const lang of clear) await invoke('state_set_voice', { lang, voiceId: '' });
  return now;
}

/**
 * The language the Voices panel opens on: the base language of `tag`, however it is written ("en_US", "EN"), else of
 * `fallback` (a document may say nothing, or something that is no language).
 */
export function panelLanguage(tag, fallback) {
  return parseLangTag(tag).language || parseLangTag(fallback).language;
}
