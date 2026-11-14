// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookmarksOf, comparePlaces } from '../app/core/places.js';

const md = (line, sentence = 0) => ({ kind: 'md', line, sentence });
const epub = (cfi, sentence = 0) => ({ kind: 'epub', cfi, sentence });
const mark = (key, position) => ({ key, position });

test('in a Markdown file the line comes first, then the sentence', () => {
  assert.ok(comparePlaces(md(3), md(12)) < 0);
  assert.ok(comparePlaces(md(12), md(3)) > 0);
  assert.ok(comparePlaces(md(5, 2), md(5, 1)) > 0);
  assert.equal(comparePlaces(md(5, 1), md(5, 1)), 0);
});

test('in a book the CFI says the order, not its text', () => {
  const early = 'epubcfi(/6/4!/4/2/1:0)';
  const late = 'epubcfi(/6/12!/4/2/1:0)';
  assert.ok(comparePlaces(epub(early), epub(late)) < 0);
  assert.ok(comparePlaces(epub(late), epub(early)) > 0);
  assert.ok(comparePlaces(epub(early, 3), epub(early, 1)) > 0);
});

test('the bookmarks of a document come in the order of its text, without the others', () => {
  const all = [mark('a', md(40)), mark('b', md(1)), mark('a', md(2)), mark('a', md(40, 1))];
  assert.deepEqual(bookmarksOf(all, 'a').map(({ position }) => [position.line, position.sentence]), [[2, 0], [40, 0], [40, 1]]);
  assert.deepEqual(bookmarksOf(all, 'none'), []);
  assert.equal(all[0].position.line, 40);
});
