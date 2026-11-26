// SPDX-License-Identifier: GPL-3.0-or-later
// What the app puts into a page of a book to translate it. Places in the book (app/vendor/foliate/epubcfi.js) do not
// see either: the original's wrapper is transparent and the translation is not there at all.

/** Around the original content of a translated block. */
export const ORIG_ATTR = 'data-mochi-orig';
/** The translation of a block, its last child; also the note shown while a chapter is being translated. */
export const TR_ATTR = 'data-mochi-tr';
