// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLang, t } from '../app/core/i18n.js';
import { bookError } from '../app/readers/pdf-open.js';
import { PdfError } from '../app/readers/pdf-source.js';

test('a locked PDF and a scanned one say what they are, anything else is the book error', async () => {
  await loadLang('en');
  assert.deepEqual(bookError(new PdfError('password'), 'a.pdf', t), {
    title: 'This PDF is locked',
    text: 'a.pdf has a password. MochiReader can open only PDFs without one.',
  });
  assert.deepEqual(bookError(new PdfError('no-text'), 'b.pdf', t), {
    title: 'This PDF has no text',
    text: 'b.pdf holds only pictures of pages (a scan). MochiReader reads PDFs that have their text.',
  });
  assert.deepEqual(bookError(new Error('broken'), 'c.epub', t), { title: t('epub.errorTitle'), text: t('epub.error', { name: 'c.epub' }) });
});

test('opening a PDF loads the book view too, as an EPUB does', async () => {
  const { pdfFoliate } = await import('../app/readers/pdf-open.js');
  const asked = [];
  const load = async (url) => {
    asked.push(String(url));
    if (String(url).endsWith('pdf.min.mjs')) return { GlobalWorkerOptions: {} };
    if (String(url).endsWith('foliate/epub.js')) return { EPUB: class {} };
    if (String(url).endsWith('pdf-book.js')) return { makePdfBook: async () => ({}) };
    return {};
  };
  const { makeBook } = await pdfFoliate({ hash: async () => 'h', notesTitle: 'Notes', name: 'a.pdf', document: null }, load)();
  assert.equal(typeof makeBook, 'function');
  assert.ok(asked.some((url) => url.endsWith('vendor/foliate/view.js')), asked.join('\n'));
});
