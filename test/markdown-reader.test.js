// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { openMarkdown, LARGE_DOC_CHARS } from '../app/readers/markdown.js';

const HTML = [
  '<h1 data-sourcepos="1:1-1:6">Titolo</h1>',
  '<p data-sourcepos="3:1-3:11">Primo brano</p>',
  '<p data-sourcepos="5:1-5:12">Secondo brano</p>',
  '<p data-sourcepos="9:1-9:10">Terzo brano</p>',
].join('');

const HEADINGS = [{ level: 1, text: 'Titolo', line: 1 }];

// linkedom has no layout, so the geometry is given here: each block is this tall, in document order.
const BLOCK_HEIGHT = 100;

function setup({ html = HTML, lang = 'it', headings = HEADINGS, scrollTop = 0 } = {}) {
  const { document } = parseHTML('<!doctype html><html><body><main id="pane"></main></body></html>');
  const host = document.getElementById('pane');
  host.getBoundingClientRect = () => ({ top: 0, bottom: 500 });
  host.scrollTop = scrollTop;
  const doc = { path: 'C:\\x\\a.md', name: 'a.md', kind: 'markdown', rendered: { html, lang, headings } };
  const reader = openMarkdown(doc, host);
  const blocks = [...host.querySelectorAll('[data-sourcepos]')];
  const scrolled = [];
  blocks.forEach((block, index) => {
    block.getBoundingClientRect = () => {
      const top = index * BLOCK_HEIGHT - host.scrollTop;
      return { top, bottom: top + BLOCK_HEIGHT };
    };
    block.scrollIntoView = () => scrolled.push(block);
  });
  return { document, host, reader, blocks, scrolled };
}

test('it is the Markdown reader of the contract', async () => {
  const { reader } = setup();
  assert.equal(reader.kind, 'markdown');
  assert.equal(reader.lang, 'it');
  assert.equal(await reader.nextSpeechSection(), false);
  assert.doesNotThrow(() => reader.setStyle('p {}'));
});

test('a document with no language says so', () => {
  assert.equal(setup({ lang: null }).reader.lang, null);
});

test('the rendered text goes in the host and is the only speech root', async () => {
  const { host, reader } = setup();
  assert.ok(host.textContent.includes('Primo brano'));
  const roots = await reader.speechRoots();
  assert.equal(roots.length, 1);
  assert.ok(roots[0].root.textContent.includes('Terzo brano'));
});

test('the contents are the headings, each going to its line', () => {
  assert.deepEqual(setup().reader.toc(), [{ label: 'Titolo', target: { kind: 'md', line: 1, sentence: 0 } }]);
});

test('the position is the block at the top of the screen', () => {
  assert.deepEqual(setup({ scrollTop: 0 }).reader.position(), { kind: 'md', line: 1, sentence: 0 });
  assert.deepEqual(setup({ scrollTop: 250 }).reader.position(), { kind: 'md', line: 5, sentence: 0 });
});

// goTo puts a block at the top, but the scroll offset is rounded to whole pixels, so it can land a fraction lower.
test('a block a fraction of a pixel below the top of the screen is still the position', () => {
  assert.deepEqual(setup({ scrollTop: 99.562 }).reader.position(), { kind: 'md', line: 3, sentence: 0 });
  assert.equal(setup({ scrollTop: 99.562 }).reader.excerpt(), 'Primo brano');
});

test('a block clearly below the top of the screen is not the position', () => {
  assert.deepEqual(setup({ scrollTop: 98 }).reader.position(), { kind: 'md', line: 1, sentence: 0 });
});

test('the excerpt comes from the block at the top of the screen', () => {
  assert.equal(setup({ scrollTop: 100 }).reader.excerpt(), 'Primo brano');
});

test('going to a line that no longer exists goes to the nearest block', async () => {
  const { reader, blocks, scrolled } = setup();
  await reader.goTo({ kind: 'md', line: 100, sentence: 0 });
  assert.deepEqual(scrolled, [blocks[3]]);
});

test('an empty document has a position and an empty excerpt', async () => {
  const { reader } = setup({ html: '', headings: [] });
  assert.deepEqual(reader.position(), { kind: 'md', line: 0, sentence: 0 });
  assert.equal(reader.excerpt(), '');
  await reader.goTo({ kind: 'md', line: 3, sentence: 0 });
});

test('clicks in the text reach onInput', () => {
  const { document, reader, blocks } = setup();
  const seen = [];
  reader.onInput((event) => seen.push(event.type));
  blocks[1].dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  assert.deepEqual(seen, ['click']);
});

test('only a large document skips the layout of blocks off screen', () => {
  const small = setup().host.querySelector('article');
  assert.equal(small.classList.contains('large'), false);
  const html = `<p data-sourcepos="1:1-1:1">${'x'.repeat(LARGE_DOC_CHARS)}</p>`;
  assert.equal(setup({ html }).host.querySelector('article').classList.contains('large'), true);
});

test('destroy takes the text away', () => {
  const { host, reader } = setup();
  reader.destroy();
  assert.equal(host.querySelector('article'), null);
});
