// SPDX-License-Identifier: GPL-3.0-or-later
// How the shell opens a PDF: as an EPUB made from it, by openEpub's own path. pdf.js and foliate's EPUB load only
// when the first PDF opens.
import { PdfError } from './pdf-source.js';

const PDFJS_URL = new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url);
// The book view registers <foliate-view>, which openEpub makes: a PDF opened before any EPUB needs it loaded too.
const VIEW_URL = new URL('../vendor/foliate/view.js', import.meta.url);
const EPUB_URL = new URL('../vendor/foliate/epub.js', import.meta.url);
const BOOK_URL = new URL('./pdf-book.js', import.meta.url);
const WORKER_URL = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url);
const ERROR_TEXTS = {
  password: ['pdf.passwordTitle', 'pdf.password'],
  'no-text': ['pdf.noTextTitle', 'pdf.noText'],
};

const importModule = (url) => import(url);

/**
 * What openEpub takes as its `loadFoliate`, for a PDF.
 * @param {{hash: () => Promise<string>, notesTitle: string, name: string, document: Document}} opts
 * @param {(url: string) => Promise<object>} [load] How a module is loaded.
 * @returns {() => Promise<{makeBook: (file: File) => Promise<object>}>}
 */
export function pdfFoliate({ hash, notesTitle, name, document }, load = importModule) {
  return async () => {
    const [pdfjs, , { EPUB }, { makePdfBook }] = await Promise.all([
      load(PDFJS_URL.href),
      load(VIEW_URL.href),
      load(EPUB_URL.href),
      load(BOOK_URL.href),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL.href;
    return { makeBook: (file) => makePdfBook(file, { pdfjs, EPUB, hash, notesTitle, name, document }) };
  };
}

/**
 * The message for a book that did not open.
 * @param {unknown} error
 * @param {string} name The file's name.
 * @param {(key: string, vars?: object) => string} t
 * @returns {{title: string, text: string}}
 */
export function bookError(error, name, t) {
  const [title, text] = (error instanceof PdfError && ERROR_TEXTS[error.code]) || ['epub.errorTitle', 'epub.error'];
  return { title: t(title), text: t(text, { name }) };
}
