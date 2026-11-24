// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDF_FIXTURES } from '../tools/make-fixture-pdf.mjs';
import { openFixture, pdfjs } from './pdf-helpers.js';

const IMAGE_OPS = () => new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);

async function textOf(doc, pageNumber) {
  const { items } = await (await doc.getPage(pageNumber)).getTextContent();
  return items.map(({ str }) => str).join(' ');
}

test('the committed PDFs are what the generator writes', () => {
  assert.deepEqual(Object.keys(PDF_FIXTURES).sort(), ['book.pdf', 'scanned.pdf']);
  for (const [name, bytes] of Object.entries(PDF_FIXTURES)) {
    assert.ok(readFileSync(new URL(`fixtures/${name}`, import.meta.url)).equals(bytes), name);
  }
});

test('the made-up book has four pages, an outline and its text', async () => {
  const doc = await openFixture('book.pdf');
  assert.equal(doc.numPages, 4);
  const outline = await doc.getOutline();
  const titles = [];
  const walk = (items) => items.forEach((item) => {
    titles.push(item.title);
    walk(item.items);
  });
  walk(outline);
  assert.deepEqual(titles, ['Chapter One', 'Chapter Two', 'Part Two Subtitle']);
  const first = await textOf(doc, 1);
  assert.match(first, /Chapter One/);
  assert.match(first, /contin-/);
  const { info } = await doc.getMetadata();
  assert.equal(info.Title, 'A Made-Up Book');
});

test('the second page paints a figure and a decoration', async () => {
  const doc = await openFixture('book.pdf');
  const { fnArray } = await (await doc.getPage(2)).getOperatorList();
  const images = IMAGE_OPS();
  assert.equal(fnArray.filter((fn) => images.has(fn)).length, 2);
});

test('the scanned PDF has no text', async () => {
  const doc = await openFixture('scanned.pdf');
  const { items } = await (await doc.getPage(1)).getTextContent();
  assert.equal(items.filter(({ str }) => str.trim()).length, 0);
});
