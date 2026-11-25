// SPDX-License-Identifier: GPL-3.0-or-later

const SEPARATORS = /[\\/]/;
/** What the app opens. */
export const OPENABLE_EXTENSIONS = ['md', 'markdown', 'epub', 'pdf', 'txt', 'docx', 'odt', 'rtf'];
const OPENABLE = new RegExp(`\\.(${OPENABLE_EXTENSIONS.join('|')})$`, 'i');
/** The kinds of document the book reader shows: a PDF is read as an EPUB made from it. */
export const BOOK_KINDS = new Set(['epub', 'pdf']);

/** @param {string|null|undefined} kind Whether a document of this kind is a book. */
export function isBook(kind) {
  return BOOK_KINDS.has(kind);
}

/** @param {string} path */
export function fileName(path) {
  return path.split(SEPARATORS).at(-1);
}

/** @param {string} path Whether the app can open the file in a tab. */
export function isSupported(path) {
  return OPENABLE.test(fileName(path));
}
