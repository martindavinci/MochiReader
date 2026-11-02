// SPDX-License-Identifier: GPL-3.0-or-later

const TWO_LEVEL_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'org.uk', 'me.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'co.nz', 'co.in', 'co.kr', 'co.za',
  'com.ar', 'com.cn', 'com.hk', 'com.mx', 'com.sg', 'com.tr', 'com.tw',
]);
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

// A word followed by a dot is usually a name or a file, not a host. Alone it counts only with one
// of these suffixes, in lowercase: "Amazon.com" and "Node.js" in a sentence are names to read.
const BARE_HOST_SUFFIXES = 'com|org|net|edu|gov|info|biz|io|ai|app|dev|co|tv|xyz|it|eu|uk|de|fr|es|ch|nl|au|jp|br|ca';
// Followed by a path almost any suffix is a host, except what names a file or an Italian title.
const NOT_HOST_SUFFIXES = 'js|jsx|ts|tsx|json|html?|css|xml|ya?ml|toml|txt|csv|log|pdf|png|jpe?g|exe|dll|lock|ssa|ra|na';
const OPAQUE_SCHEMES = 'mailto|tel|sms|magnet|urn';

const URL_TAIL = '[^\\s<>]*[^\\s<>.,;:!?)\\]\'"»]';
const NOT_AFTER_WORD = '(?<![\\p{L}\\p{N}])';
const NOT_INSIDE_NAME = '(?<![\\p{L}\\p{N}@._/-])';
const ANY_CASE_LABELS = '(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+';
const LOWERCASE_LABELS = '(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+';
const PORT = '(?::\\d+)?';

// The bound keeps a long hyphenated word from being rescanned at every hyphen.
const SCHEME_URL = new RegExp(`${NOT_AFTER_WORD}(?:[a-z][a-z0-9+-]{0,31}://|www\\.|(?:${OPAQUE_SCHEMES}):)${URL_TAIL}`, 'giu');
const HOST_WITH_PATH = new RegExp(
  `${NOT_INSIDE_NAME}${ANY_CASE_LABELS}(?!(?:${NOT_HOST_SUFFIXES})\\b)[a-z]{2,}${PORT}(?:/(?:${URL_TAIL})?|[?#]${URL_TAIL})`,
  'gu',
);
const BARE_HOST = new RegExp(
  `${NOT_INSIDE_NAME}${LOWERCASE_LABELS}(?:${BARE_HOST_SUFFIXES})${PORT}(?![\\p{L}\\p{N}@_-]|\\.[\\p{L}\\p{N}])`,
  'gu',
);

/** Everything in running text that is a URL, to remove in this order. */
export const BARE_URLS = [SCHEME_URL, HOST_WITH_PATH, BARE_HOST];

const WHOLE_URLS = BARE_URLS.map(({ source, flags }) => new RegExp(`^(?:${source})$`, flags.replace('g', '')));

const ADDRESS_SCHEME = /^(?:https?:\/\/|ftp:\/\/|mailto:)/i;
const LEADING_WWW = /^www\./;
const TRAILING_SLASH = /\/$/;
const PATH_START = /[/?#]/;

/**
 * Whether the whole of a text is a URL.
 * @param {string} text
 * @returns {boolean}
 */
export function isUrlText(text) {
  return WHOLE_URLS.some((url) => url.test(text));
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
  const suffixLength = TWO_LEVEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 2 : 1;
  const name = labels.at(-suffixLength - 1);
  return (name ?? host).replaceAll('-', ' ');
}
