// SPDX-License-Identifier: GPL-3.0-or-later

const LANG_SAMPLE_CHARS = 20000;
const MIN_WORDS = 4;
const MIN_COMMON_WORDS = 2;

// Words shared by both languages ("a", "in", "come", "no") would only blur the count.
const COMMON_WORDS = {
  it: new Set(`il lo la le gli l un una uno di del dello della dell dei degli delle da dal dallo dalla
    dai dalle nel nello nella nell nei negli nelle sul sullo sulla sull sui sugli sulle al allo alla ai
    agli alle e ed è che chi per con tra fra non più ma anche sono questo questa questi queste quello
    quella quelli quelle ha hanno si cui ogni`.split(/\s+/)),
  en: new Set(`the of and to that this these those is are was were be been with for from by on at as it
    its an not but or which you he she they we have has had will would can could there their what when
    if about into than does do`.split(/\s+/)),
};

/**
 * Tells Italian from English by counting common words.
 * @param {string} text
 * @returns {'it'|'en'|null} null with too little text, a tie or another language
 */
export function detectLang(text) {
  const words = text.slice(0, LANG_SAMPLE_CHARS).toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < MIN_WORDS) return null;

  const count = (common) => words.filter((word) => common.has(word)).length;
  const it = count(COMMON_WORDS.it);
  const en = count(COMMON_WORDS.en);
  if (it === en || Math.max(it, en) < MIN_COMMON_WORDS) return null;
  return it > en ? 'it' : 'en';
}
