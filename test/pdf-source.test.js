// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { cropOf, PdfError, readPdf } from '../app/readers/pdf-source.js';
import { fixtureBytes, pdfjs } from './pdf-helpers.js';

test('a PDF gives its pages, runs from the top, and its title', async () => {
  const { info, pages } = await readPdf(fixtureBytes('book.pdf'), pdfjs);
  assert.equal(pages.length, 4);
  assert.equal(info.title, 'A Made-Up Book');
  assert.equal(info.author, 'Nobody');
  assert.equal(pages[0].width, 612);
  assert.equal(pages[0].height, 792);
  const title = pages[0].runs.find(({ text }) => text === 'Chapter One');
  assert.ok(title);
  assert.ok(Math.abs(title.size - 24) < 0.5, String(title.size));
  assert.equal(title.bold, true);
  assert.ok(Math.abs(title.y - 110) < 1, String(title.y));
  assert.equal(pages[0].runs.find(({ text }) => text.startsWith('The first paragraph')).bold, false);
});

test('images are boxes from the top of the page', async () => {
  const { pages } = await readPdf(fixtureBytes('book.pdf'), pdfjs);
  const figure = pages[1].images.find(({ width }) => width === 300);
  assert.deepEqual(figure, { x: 156, y: 110, width: 300, height: 150 });
  assert.equal(pages[1].images.length, 2);
});

test('the outline becomes marks, in order, with their page', async () => {
  const { marks } = await readPdf(fixtureBytes('book.pdf'), pdfjs);
  assert.deepEqual(marks.map(({ title, page, depth }) => [title, page, depth]),
    [['Chapter One', 0, 0], ['Chapter Two', 2, 0], ['Part Two Subtitle', 2, 1]]);
  assert.ok(marks[2].y > marks[1].y);
  assert.equal(marks[1].y, 50);
});

test('a PDF with no text is refused', async () => {
  await assert.rejects(readPdf(fixtureBytes('scanned.pdf'), pdfjs), (error) => error instanceof PdfError && error.code === 'no-text');
});

/** pdf.js as far as readPdf uses it, with a document of one empty page and the outline given. */
function fakePdfjs({ fails, outline = [] } = {}) {
  const page = {
    view: [0, 0, 612, 792],
    getTextContent: async () => ({ items: [{ str: 'A line of text that is long enough to count as text.', transform: [12, 0, 0, 12, 72, 700], width: 300, fontName: 'f' }], styles: {} }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
  };
  const doc = {
    numPages: 1,
    getPage: async () => page,
    getMetadata: async () => ({ info: {} }),
    getOutline: async () => outline,
    getDestination: async () => null,
    getPageIndex: async () => 0,
  };
  return {
    OPS: pdfjs.OPS,
    getDocument: () => ({ promise: fails ? Promise.reject(fails) : Promise.resolve(doc) }),
  };
}

test('a PDF with a password is refused', async () => {
  const fake = fakePdfjs({ fails: Object.assign(new Error('No password given'), { name: 'PasswordException' }) });
  await assert.rejects(readPdf(new Uint8Array(1), fake), (error) => error instanceof PdfError && error.code === 'password');
});

test('an outline entry with no destination is skipped', async () => {
  const outline = [
    { title: 'x', dest: null, items: [] },
    { title: 'y', dest: [{ num: 1, gen: 0 }, { name: 'XYZ' }, 72, 700, null], items: [] },
  ];
  const { marks } = await readPdf(new Uint8Array(1), fakePdfjs({ outline }));
  assert.deepEqual(marks, [{ title: 'y', page: 0, y: 92, depth: 0 }]);
});

test('cropOf rounds outwards and stays on the page', () => {
  assert.deepEqual(cropOf({ x: 10.4, y: 0, width: 20.2, height: 5 }, 2), { x: 20, y: 0, width: 42, height: 10 });
  assert.deepEqual(cropOf({ x: -3, y: -1, width: 10, height: 10 }, 1), { x: 0, y: 0, width: 7, height: 9 });
});

test('a title with its brackets escaped twice reads plainly', async () => {
  const fake = fakePdfjs();
  const doc = await fake.getDocument().promise;
  doc.getMetadata = async () => ({ info: { Title: 'A book \\( site \\).pdf' } });
  const { info } = await readPdf(new Uint8Array(1), { ...fake, getDocument: () => ({ promise: Promise.resolve(doc) }) });
  assert.equal(info.title, 'A book ( site ).pdf');
});
