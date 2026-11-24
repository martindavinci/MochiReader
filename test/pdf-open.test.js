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
