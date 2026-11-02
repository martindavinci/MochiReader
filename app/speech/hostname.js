// SPDX-License-Identifier: GPL-3.0-or-later
import { parseLangTag } from './lang.js';

const TWO_LEVEL_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'org.uk', 'me.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'co.nz', 'co.in', 'co.kr', 'co.za',
  'com.ar', 'com.cn', 'com.hk', 'com.mx', 'com.sg', 'com.tr', 'com.tw',
]);
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;
const WWW = 'www';

// A word followed by a dot is usually a name or a file, not a host. Alone it counts only with one
// of these suffixes, in lowercase: "Amazon.com" and "Node.js" in a sentence are names to read.
const BARE_HOST_SUFFIXES = 'com|org|net|edu|gov|info|biz|io|ai|app|dev|co|tv|xyz|it|eu|uk|de|fr|es|ch|nl|au|jp|br|ca';
// Abbreviations written like a lowercase host with one of those suffixes.
const NOT_BARE_HOSTS = 'p\\.es|ad\\.es|per\\.es|c\\.ca|co\\.co\\.co';
// Followed by a path a suffix of two letters is a host, except what names a file or an Italian title
// (Gent.mo/a), and so is one of these: any longer word would take a sentence with it (Va bene.noi/voi).
const LONG_HOST_SUFFIXES = 'com|org|net|edu|gov|mil|int|info|biz|name|pro|app|dev|xyz|icu|top|site|online|store|shop|tech|blog'
  + '|cloud|page|wiki|news|media|live|club|world|link|work|one|art|design|studio|space|website|agency|travel|museum';
const FILE_SUFFIXES = 'js|mjs|jsx|ts|tsx|json|html?|css|scss|xml|ya?ml|toml|ini|cfg|conf|txt|md|csv|log|pdf|epub|docx?|xlsx?|pptx?'
  + '|png|jpe?g|gif|svg|webp|zip|gz|tar|exe|dll|lock|py|rb|go|java|kt|swift|cpp|hpp|cs|php|sql|bat|lua|ipynb|vue';
const TITLE_ENDINGS = 'ssa|ra|na|mo|ma|mi|ri|re|le';
// Real domains (docs.rs/x, bun.sh/x, onet.pl/x), but an anchor after them points into a file.
const FILE_OR_HOST_SUFFIXES = 'rs|sh|pl|cc';
const OPAQUE_SCHEMES = 'mailto|tel|sms|magnet|urn';

const URL_TAIL = '[^\\s<>]*[^\\s<>.,;:!?)\\]\'"»]';
const NOT_AFTER_WORD = '(?<![\\p{L}\\p{N}])';
const NOT_INSIDE_NAME = '(?<![\\p{L}\\p{N}@._/-])';
const ANY_CASE_LABELS = '(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+';
const LOWERCASE_LABELS = '(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+';
const PORT = '(?::\\d+)?';

// The bound keeps a long hyphenated word from being rescanned at every hyphen.
export const SCHEME_URL = new RegExp(`${NOT_AFTER_WORD}(?:[a-z][a-z0-9+-]{0,31}://|www\\.|(?:${OPAQUE_SCHEMES}):)${URL_TAIL}`, 'giu');
const HOST_WITH_PATH = new RegExp(
  `${NOT_INSIDE_NAME}${ANY_CASE_LABELS}(?!(?:${FILE_SUFFIXES}|${TITLE_ENDINGS})\\b|(?:${FILE_OR_HOST_SUFFIXES})#)(?:[a-z]{2}|${LONG_HOST_SUFFIXES})${PORT}(?:/(?:${URL_TAIL})?|[?#]${URL_TAIL})`,
  'gu',
);
const BARE_HOST = new RegExp(
  `${NOT_INSIDE_NAME}(?!(?:${NOT_BARE_HOSTS})(?![\\p{L}\\p{N}]))${LOWERCASE_LABELS}(?:${BARE_HOST_SUFFIXES})${PORT}(?![\\p{L}\\p{N}@_-]|\\.[\\p{L}\\p{N}]|['’]\\p{L})`,
  'gu',
);

/** Text that is a URL by its shape alone, a guess that inline code is exempt from. To remove in this order. */
export const HOST_URLS = [HOST_WITH_PATH, BARE_HOST];

const whole = ({ source, flags }) => new RegExp(`^(?:${source})$`, flags.replace('g', ''));
const WHOLE_SCHEME_URL = whole(SCHEME_URL);
const WHOLE_HOST_URLS = HOST_URLS.map(whole);

// Suffixes that are everyday words of a language, or of no language in particular: a sentence can start
// with them, and a space lost after the full stop then looks like a host. Reading a host aloud costs
// little, losing a word costs the sentence, so in doubt it stays. Any other language gets the whole list,
// but for "com", too common a host to give up for a word of one language, and for what is a word in English
// alone. Those of two letters that no bare host has only matter before a slash (Va bene.tu/lei).
const WORDS_IN_EVERY_LANGUAGE = ['app', 'dev', 'info', 'net', 'tv', 'ca', 'tu', 'si', 'se', 'no', 'la', 'lo', 'ti', 'te', 'ne'];
const SUFFIX_WORDS = new Map(Object.entries({
  it: ['io', 'ai'],
  en: ['it', 'de', 'ai', 'io', 'au', 'es', 'org', 'gov'],
  pt: ['com', 'de', 'eu', 'ai'],
}).map(([language, words]) => [language, new Set([...words, ...WORDS_IN_EVERY_LANGUAGE])]));
const SUFFIX_WORDS_OF_ANY_LANGUAGE = new Set(['io', 'ai', 'it', 'au', 'de', 'es', 'eu', ...WORDS_IN_EVERY_LANGUAGE]);
// A word, a compound or a number, after any dotted initials (p.m., a.k.a.), then at most one short word
// joined by a slash or a question mark (noi/voi): a longer one is the path of a URL.
const TWO_PLAIN_WORDS = /^(?:[a-z]\.)*(?:[a-z-]+|\d+)\.([a-z]+)(?:[/?]\p{L}{1,3})?$/u;

/**
 * Whether what looks like a host may be two words of a sentence with the space lost between them
 * ("stanco.io no"). Only a suffix that is a word counts, after a word: with a name in several labels,
 * a word and digits together, a port or a long path it was never prose.
 * @param {string} host
 * @param {string|null} lang
 * @returns {boolean}
 */
export function mayBeTwoWords(host, lang) {
  const suffix = TWO_PLAIN_WORDS.exec(host)?.[1];
  const words = SUFFIX_WORDS.get(parseLangTag(lang).language) ?? SUFFIX_WORDS_OF_ANY_LANGUAGE;
  return words.has(suffix);
}

const ADDRESS_SCHEME = /^(?:https?:\/\/|ftp:\/\/|mailto:)/i;
const LEADING_WWW = /^www\./;
const TRAILING_SLASH = /\/$/;
const PATH_START = /[/?#]/;

/**
 * Whether the whole of a text is a URL with a scheme or www.
 * @param {string} text
 * @returns {boolean}
 */
export function isSchemeUrlText(text) {
  return WHOLE_SCHEME_URL.test(text);
}

/**
 * Whether the whole of a text is a URL.
 * @param {string} text
 * @returns {boolean}
 */
export function isUrlText(text) {
  return isSchemeUrlText(text) || WHOLE_HOST_URLS.some((url) => url.test(text));
}

const plainAddress = (value) => value.toLowerCase()
  .replace(ADDRESS_SCHEME, '').replace(LEADING_WWW, '').replace(TRAILING_SLASH, '');

/**
 * Whether a link's text only repeats the address it points to, or its host.
 * A relative target is never an address: a link to "note" can read "note".
 * @param {string} text
 * @param {string} href
 * @returns {boolean}
 */
export function namesAddress(text, href) {
  if (text === '' || !ADDRESS_SCHEME.test(href)) return false;
  const name = plainAddress(text);
  const address = plainAddress(href);
  return name === address || name === address.split(PATH_START)[0];
}

/**
 * The name a voice can say for a URL: the host without www, subdomains and
 * domain suffix. Empty when the URL has no host.
 * @param {string} url
 * @returns {string}
 */
export function hostName(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (IPV4.test(host) || host.startsWith('[')) return host;

  const labels = host.split('.');
  if (labels.length < 2) return host;
  if (labels.length > 2 && labels[0] === WWW) labels.shift();
  const suffixLength = TWO_LEVEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 2 : 1;
  // A suffix that is the whole host, like gov.uk, names itself by its first label.
  const name = labels.at(-suffixLength - 1) ?? labels[0];
  return name.replaceAll('-', ' ');
}
