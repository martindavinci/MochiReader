// SPDX-License-Identifier: GPL-3.0-or-later

const TWO_LEVEL_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'org.uk', 'me.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'co.nz', 'co.in', 'co.kr', 'co.za',
  'com.ar', 'com.cn', 'com.hk', 'com.mx', 'com.sg', 'com.tr', 'com.tw',
]);
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

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
