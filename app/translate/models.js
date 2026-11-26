// SPDX-License-Identifier: GPL-3.0-or-later
// Which models a language pair needs: its own, or two through English, as Firefox Translations does.
import { parseLangTag } from '../speech/lang.js';

const PIVOT = 'en';
const CHINESE = 'zh';
// Where Chinese is written in its traditional script; elsewhere it is the simplified one.
const TRADITIONAL_REGIONS = new Set(['TW', 'HK', 'MO']);

/**
 * @param {string|null|undefined} tag As a book names its language (`eng`, `English`, `it-IT`, `zh-CN`) or the options do.
 * @returns {string|null} The language as the models name it (`en`, `it`, `zh-Hans`), or null for none.
 */
export function catalogLanguage(tag) {
  const { language, region } = parseLangTag(tag);
  if (!language) return null;
  if (language !== CHINESE) return language;
  return TRADITIONAL_REGIONS.has(region) ? 'zh-Hant' : 'zh-Hans';
}

/** Translating needs models that are not downloaded. */
export class MissingModelsError extends Error {
  /** @param {string[]} missing Pair ids, e.g. `en-it`. */
  constructor(missing) {
    super(`missing translation models: ${missing.join(', ')}`);
    this.missing = missing;
  }
}

/**
 * @param {string} from
 * @param {string} to
 * @param {{id: string}[]} pairs The catalog.
 * @returns {string[]|null} The pair ids needed, or null if the catalog cannot translate between them.
 */
export function modelsFor(from, to, pairs) {
  const has = (id) => pairs.some((pair) => pair.id === id);
  if (has(`${from}-${to}`)) return [`${from}-${to}`];
  if (from === PIVOT || to === PIVOT) return null;
  const halves = [`${from}-${PIVOT}`, `${PIVOT}-${to}`];
  return halves.every(has) ? halves : null;
}

/**
 * @param {string[]} ids From `modelsFor`.
 * @param {{id: string, installed: string|null}[]} pairs The catalog.
 * @returns {string} The versions on disk, joined by `+`: the name of the translations they make.
 * @throws {MissingModelsError} If one is not downloaded.
 */
export function versionFor(ids, pairs) {
  const versions = ids.map((id) => pairs.find((pair) => pair.id === id)?.installed ?? null);
  const missing = ids.filter((_, i) => !versions[i]);
  if (missing.length > 0) throw new MissingModelsError(missing);
  return versions.join('+');
}
