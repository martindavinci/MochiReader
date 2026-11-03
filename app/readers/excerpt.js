// SPDX-License-Identifier: GPL-3.0-or-later

const EXCERPT_CHARS = 160;
// The first half of a character the cut went through. The excerpt goes to the app as JSON, which refuses it.
const CUT_CHARACTER = /[\uD800-\uDBFF]$/;

/** @param {string} text @returns {string} The start of `text`, short enough for a list of bookmarks. */
export function excerptOf(text) {
  return text.trim().slice(0, EXCERPT_CHARS).replace(CUT_CHARACTER, '');
}
