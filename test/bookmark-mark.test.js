// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { MARK_GAP, MARK_HEIGHT, MARK_WIDTH, drawBookmarkMark, markPlace } from '../app/readers/bookmark-mark.js';

const COLUMNS = [
  { left: 100, right: 400, top: 50, bottom: 600 },
  { left: 450, right: 750, top: 50, bottom: 600 },
];

test('a mark stands at the left edge of the column its point is in, on its line', () => {
  assert.deepEqual(markPlace({ left: 130, top: 200, height: 20 }, COLUMNS), { x: 100, y: 200, height: 20 });
  assert.deepEqual(markPlace({ left: 480, top: 90, height: 20 }, COLUMNS), { x: 450, y: 90, height: 20 });
});

test('a point outside every piece of its paragraph keeps its own left edge', () => {
  assert.deepEqual(markPlace({ left: 820, top: 90, height: 20 }, COLUMNS), { x: 820, y: 90, height: 20 });
  assert.deepEqual(markPlace({ left: 820, top: 90, height: 20 }, []), { x: 820, y: 90, height: 20 });
});

test('the mark is a small ribbon in the margin, beside the line, in the accent colour', () => {
  const { document } = parseHTML('<html><body><p id="p">Some text in a paragraph.</p></body></html>');
  const paragraph = document.getElementById('p');
  paragraph.getClientRects = () => [{ left: 100, right: 400, top: 200, bottom: 260, height: 60 }];
  const range = {
    startContainer: paragraph.firstChild,
    startOffset: 5,
    getClientRects: () => [{ left: 140, right: 140, top: 220, bottom: 240, height: 20 }],
  };
  const mark = drawBookmarkMark(range, document);
  assert.equal(mark.localName, 'polygon');
  assert.match(mark.getAttribute('style'), /fill: var\(--accent\)/);
  const xs = mark.getAttribute('points').trim().split(/\s+/).map((pair) => Number(pair.split(',')[0]));
  const ys = mark.getAttribute('points').trim().split(/\s+/).map((pair) => Number(pair.split(',')[1]));
  assert.equal(Math.max(...xs), 100 - MARK_GAP);
  assert.equal(Math.max(...xs) - Math.min(...xs), MARK_WIDTH);
  assert.equal(Math.min(...ys), 220 + (20 - MARK_HEIGHT) / 2);
});

test('a point with no box of its own is marked beside the element it is in', () => {
  const { document } = parseHTML('<html><body><p id="p"><img id="i"></p></body></html>');
  const paragraph = document.getElementById('p');
  paragraph.getClientRects = () => [{ left: 100, right: 400, top: 300, bottom: 360, height: 60 }];
  document.getElementById('i').getClientRects = () => [{ left: 100, right: 200, top: 300, bottom: 360, height: 60 }];
  const range = { startContainer: paragraph, startOffset: 0, getClientRects: () => [] };
  const mark = drawBookmarkMark(range, document);
  assert.ok(mark.getAttribute('points').includes(`${100 - MARK_GAP},`));
});
