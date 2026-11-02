// SPDX-License-Identifier: GPL-3.0-or-later
import en from '../lang/en.js';
import it from '../lang/it.js';

export const DEFAULT_LANG = 'en';

const TABLES = { en, it };
const PLACEHOLDER = /\{(\w+)\}/g;

let current = DEFAULT_LANG;

/**
 * @param {string|null|undefined} tag A language tag such as `it-IT`, from the options or the system.
 * @returns {'it'|'en'} The matching interface language, or the default one.
 */
export function pickLang(tag) {
  const base = String(tag ?? '').split('-')[0].toLowerCase();
  return Object.hasOwn(TABLES, base) ? base : DEFAULT_LANG;
}

/** @param {string|null|undefined} tag */
export function setLang(tag) {
  current = pickLang(tag);
}

export function getLang() {
  return current;
}

/**
 * @param {string} key
 * @param {Record<string, string|number>} [params] Values for the `{name}` placeholders of the message.
 * @returns {string} The message in the current language; the key itself if it does not exist.
 */
export function t(key, params = {}) {
  const text = TABLES[current][key] ?? key;
  return text.replace(PLACEHOLDER, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));
}
