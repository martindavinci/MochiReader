// SPDX-License-Identifier: GPL-3.0-or-later
// How the shell opens a PDF: as an EPUB made from it, by openEpub's own path. pdf.js and foliate's EPUB load only
// when the first PDF opens.
import { PdfError } from './pdf-source.js';

const PDFJS_URL = new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url);
const WORKER_URL = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url);
const ERROR_TEXTS = {
  password: ['pdf.passwordTitle', 'pdf.password'],
  'no-text': ['pdf.noTextTitle', 'pdf.noText'],
};

async function loadPdfjs() {
  const pdfjs = await import(PDFJS_URL.href);
  pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL.href;
  return pdfjs;
}

/**
 * What openEpub takes as its `loadFoliate`, for a PDF.
 * @param {{hash: () => Promise<string>, notesTitle: string, name: string, document: Document}} opts
 * @returns {() => Promise<{makeBook: (file: File) => Promise<object>}>}
 */
export function pdfFoliate({ hash, notesTitle, name, document }) {
  return async () => {
    const [pdfjs, { EPUB }, { makePdfBook }] = await Promise.all([
      loadPdfjs(),
      import('../vendor/foliate/epub.js'),
      import('./pdf-book.js'),
    ]);
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
