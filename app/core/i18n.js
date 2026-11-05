// SPDX-License-Identifier: GPL-3.0-or-later
import en from '../lang/en.js';
import it from '../lang/it.js';

export const DEFAULT_LANG = 'en';

// The file of each language. English and Italian are in the first frame; the others load when they are chosen.
const FILES = {
  en: 'en',
  it: 'it',
  de: 'de',
  es: 'es',
  fr: 'fr',
  pt: 'pt-BR',
  ja: 'ja',
  ko: 'ko',
  zh: 'zh-CN',
};
const TABLES = { en, it };
const PLACEHOLDER = /\{(\w+)\}/g;

/** The languages of the interface, as `pickLang` names them. */
export const LANGS = Object.keys(FILES);

let current = DEFAULT_LANG;

/**
 * @param {string|null|undefined} tag A language tag such as `it-IT`, from the options or the system.
 * @returns {string} The matching interface language, or the default one.
 */
export function pickLang(tag) {
  const base = String(tag ?? '').split('-')[0].toLowerCase();
  return Object.hasOwn(FILES, base) ? base : DEFAULT_LANG;
}

/** Until its table has loaded, a language speaks English. @param {string|null|undefined} tag */
export function setLang(tag) {
  current = pickLang(tag);
}

/**
 * Loads the table of a language, then makes it the one of the interface.
 * @param {string|null|undefined} tag
 */
export async function loadLang(tag) {
  const lang = pickLang(tag);
  if (!TABLES[lang]) TABLES[lang] = (await import(`../lang/${FILES[lang]}.js`)).default;
  setLang(lang);
}

export function getLang() {
  return current;
}

/** @returns {string} The tag of the language with its region where the table is for one: what `lang` attributes take. */
export function getLocale() {
  return FILES[current];
}

/**
 * @param {string} key
 * @param {Record<string, string|number>} [params] Values for the `{name}` placeholders of the message.
 * @returns {string} The message in the current language; in English if that one lacks it; the key if none has it.
 */
export function t(key, params = {}) {
  const text = TABLES[current]?.[key] ?? TABLES[DEFAULT_LANG][key] ?? key;
  return text.replace(PLACEHOLDER, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));
}
