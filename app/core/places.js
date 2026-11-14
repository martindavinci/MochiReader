// SPDX-License-Identifier: GPL-3.0-or-later
// Where places are in their document, one before the other: lines in a Markdown file, CFIs in a book.
import { compare as compareCfi } from '../vendor/foliate/epubcfi.js';

const KIND_EPUB = 'epub';

/**
 * @param {{kind: string, line?: number, cfi?: string, sentence?: number}} a
 * @param {{kind: string, line?: number, cfi?: string, sentence?: number}} b Of the same document as `a`.
 * @returns {number} Below zero when `a` comes first, zero for the same place.
 */
export function comparePlaces(a, b) {
  const where = a.kind === KIND_EPUB ? compareCfi(a.cfi, b.cfi) : (a.line ?? 0) - (b.line ?? 0);
  return where || (a.sentence ?? 0) - (b.sentence ?? 0);
}

/**
 * @template {{key: string, position: object}} B
 * @param {B[]} bookmarks
 * @param {string} key The document.
 * @returns {B[]} Its bookmarks, in the order of its text.
 */
export function bookmarksOf(bookmarks, key) {
  return bookmarks.filter((bookmark) => bookmark.key === key).sort((a, b) => comparePlaces(a.position, b.position));
}
