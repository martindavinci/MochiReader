// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { extractBlocks } from '../app/speech/extract.js';
import { createHighlighter, HIGHLIGHT_NAME } from '../app/speech/highlight.js';
import { lineOfPlace, placeOfLine, sentenceAt, sentenceFrom, sentenceRange } from '../app/speech/place.js';
import { withHighlights } from './speech-fakes.js';

const blocksOf = (html, opts = {}) => {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  withHighlights(document);
  return { document, blocks: extractBlocks(document.body, { sourceMode: 'skip', lang: 'en', ...opts }) };
};

const TWO_PARAGRAPHS = '<p data-sourcepos="1:1-1:9">One is here. Two is here.</p><p data-sourcepos="3:1-3:9">Three is here.</p>';

test('a sentence becomes a range over what it covers', () => {
  const { blocks } = blocksOf(TWO_PARAGRAPHS);
  assert.equal(sentenceRange(blocks[0].sentences[1]).toString(), 'Two is here.');
});

test('a sentence the app added has no range', () => {
  assert.equal(sentenceRange({ text: 'Fonte: x', start: null, end: null }), null);
});

test('the sentence at a point is the one around it', () => {
  const { blocks, document } = blocksOf(TWO_PARAGRAPHS);
  const [first, second] = document.querySelectorAll('p');
  assert.deepEqual(sentenceAt(blocks, first.firstChild, 2), { block: 0, sentence: 0 });
  assert.deepEqual(sentenceAt(blocks, first.firstChild, 15), { block: 0, sentence: 1 });
  assert.deepEqual(sentenceAt(blocks, second.firstChild, 0), { block: 1, sentence: 0 });
});

test('a point between sentences belongs to the next one, and past the last to nothing', () => {
  const { blocks, document } = blocksOf('<h1>Title</h1><pre>code</pre><p>One is here.</p><pre>more</pre>');
  const code = document.querySelector('pre').firstChild;
  assert.deepEqual(sentenceAt(blocks, code, 1), { block: 1, sentence: 0 });
  assert.equal(sentenceAt(blocks, document.querySelectorAll('pre')[1].firstChild, 1), null);
});

test('a point on an element counts as the child it names', () => {
  const { blocks, document } = blocksOf(TWO_PARAGRAPHS);
  assert.deepEqual(sentenceAt(blocks, document.body, 1), { block: 1, sentence: 0 });
  assert.equal(sentenceAt(blocks, document.body, 2), null);
});

test('reading from a point starts at the first sentence that starts there or later', () => {
  const { blocks, document } = blocksOf(TWO_PARAGRAPHS);
  const [first] = document.querySelectorAll('p');
  assert.deepEqual(sentenceFrom(blocks, first.firstChild, 0), { block: 0, sentence: 0 });
  assert.deepEqual(sentenceFrom(blocks, first.firstChild, 2), { block: 0, sentence: 1 });
  assert.deepEqual(sentenceFrom(blocks, first.firstChild, 13), { block: 0, sentence: 1 });
  assert.deepEqual(sentenceFrom(blocks, first.firstChild, 14), { block: 1, sentence: 0 });
});

test('reading from a point inside the last sentence stays on it', () => {
  const { blocks, document } = blocksOf(TWO_PARAGRAPHS);
  const second = document.querySelectorAll('p')[1];
  assert.deepEqual(sentenceFrom(blocks, second.firstChild, 3), { block: 1, sentence: 0 });
});

test('a place says its line and the number of its sentence on that line', () => {
  const { blocks } = blocksOf(TWO_PARAGRAPHS);
  assert.deepEqual(lineOfPlace(blocks, { block: 0, sentence: 1 }), { line: 1, sentence: 1 });
  assert.deepEqual(lineOfPlace(blocks, { block: 1, sentence: 0 }), { line: 3, sentence: 0 });
});

test('blocks of one line, as the cells of a row, share the count of their sentences', () => {
  const { blocks } = blocksOf('<table><tr data-sourcepos="4:1-4:9"><td>One is here. Two is.</td><td>Three is here.</td></tr></table>');
  assert.deepEqual(lineOfPlace(blocks, { block: 1, sentence: 0 }), { line: 4, sentence: 2 });
  assert.deepEqual(placeOfLine(blocks, { line: 4, sentence: 2 }), { block: 1, sentence: 0 });
});

test('a block with no line takes the line of the block before it', () => {
  const blocks = [
    { line: 7, sentences: [{}, {}] },
    { line: null, sentences: [{}] },
  ];
  assert.deepEqual(lineOfPlace(blocks, { block: 1, sentence: 0 }), { line: 7, sentence: 0 });
  assert.deepEqual(lineOfPlace([{ line: null, sentences: [{}] }], { block: 0, sentence: 0 }), { line: null, sentence: 0 });
});

test('a line goes to the block closest to it, in a file that has changed', () => {
  const { blocks } = blocksOf(TWO_PARAGRAPHS);
  assert.deepEqual(placeOfLine(blocks, { line: 3, sentence: 0 }), { block: 1, sentence: 0 });
  assert.deepEqual(placeOfLine(blocks, { line: 90, sentence: 0 }), { block: 1, sentence: 0 });
  assert.deepEqual(placeOfLine(blocks, { line: 1, sentence: 1 }), { block: 0, sentence: 1 });
  assert.deepEqual(placeOfLine(blocks, { line: 1, sentence: 40 }), { block: 0, sentence: 1 });
  assert.deepEqual(placeOfLine([], { line: 1, sentence: 0 }), { block: 0, sentence: 0 });
});

test('a sentence is highlighted in the window of its own document', () => {
  const { blocks, document } = blocksOf(TWO_PARAGRAPHS);
  const highlighter = createHighlighter();
  const range = sentenceRange(blocks[0].sentences[0]);
  highlighter.show(range);
  const shown = document.defaultView.CSS.highlights.get(HIGHLIGHT_NAME);
  assert.ok(shown instanceof document.defaultView.Highlight);
  assert.deepEqual(shown.ranges, [range]);
  highlighter.clear();
  assert.equal(document.defaultView.CSS.highlights.has(HIGHLIGHT_NAME), false);
});

test('moving to another document takes the highlight from the one before', () => {
  const frame = () => {
    const window = { CSS: { highlights: new Map() }, Highlight: class {} };
    return { window, range: { startContainer: { ownerDocument: { defaultView: window } } } };
  };
  const one = frame();
  const two = frame();
  const highlighter = createHighlighter();
  highlighter.show(one.range);
  assert.equal(one.window.CSS.highlights.has(HIGHLIGHT_NAME), true);
  highlighter.show(two.range);
  assert.equal(one.window.CSS.highlights.has(HIGHLIGHT_NAME), false);
  assert.equal(two.window.CSS.highlights.has(HIGHLIGHT_NAME), true);
});

test('a document that left its frame has no window to clear, and asks nothing of it', () => {
  const highlighter = createHighlighter();
  const gone = { startContainer: { ownerDocument: { defaultView: null } } };
  assert.doesNotThrow(() => highlighter.show(gone));
  assert.doesNotThrow(() => highlighter.clear());
});

test('a frame closed under the highlight does not stop the reading', () => {
  const { blocks, document } = blocksOf(TWO_PARAGRAPHS);
  const highlighter = createHighlighter();
  const warn = console.warn;
  console.warn = () => {};
  highlighter.show(sentenceRange(blocks[0].sentences[0]));
  document.defaultView.CSS.highlights.delete = () => {
    throw new Error('the frame is gone');
  };
  assert.doesNotThrow(() => highlighter.clear());
  console.warn = warn;
});
