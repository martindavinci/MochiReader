// SPDX-License-Identifier: GPL-3.0-or-later

const DOC_SCHEME = 'mochi-doc:';
const ANCHOR_MARK = '#';
const EXTERNAL = /^(https?|mailto):/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The path a `mochi-doc:` link names: the UTF-8 bytes of the path in base64url, or null if it is damaged. */
function decodeDocPath(token) {
  if (!BASE64URL.test(token)) return null;
  try {
    const binary = atob(token.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeAnchor(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * What a click on a link in a document does.
 * @param {string|null|undefined} href The attribute as written.
 * @returns {{type: 'doc', path: string}|{type: 'external', url: string}|{type: 'anchor', id: string}|null}
 *   null means the link does nothing.
 */
export function linkAction(href) {
  if (!href) return null;
  if (href.startsWith(DOC_SCHEME)) {
    const path = decodeDocPath(href.slice(DOC_SCHEME.length));
    return path === null ? null : { type: 'doc', path };
  }
  if (EXTERNAL.test(href)) return { type: 'external', url: href };
  if (href.startsWith(ANCHOR_MARK) && href.length > ANCHOR_MARK.length) {
    return { type: 'anchor', id: decodeAnchor(href.slice(ANCHOR_MARK.length)) };
  }
  return null;
}
