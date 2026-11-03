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

const LIST_LINES = 3000;
const ALL_ITEMS = LIST_LINES + 1;
const sourcepos = (line) => `${line}:1-${line}:40`;

function longList() {
  const lines = Array.from({ length: LIST_LINES }, (_, index) => (
    `<li data-sourcepos="${sourcepos(index + 1)}">Voce ${index + 1} con <strong>testo</strong> da leggere</li>\n`
  ));
  return `<ul data-sourcepos="1:1-${LIST_LINES}:40">\n${lines.join('')}<li>${'x'.repeat(LARGE_DOC_CHARS)}</li></ul>\n`;
}

test('a small document goes in whole, with nothing around it', () => {
  const article = setup().host.querySelector('article');
  assert.ok(!article.querySelector('.part'));
  assert.equal(article.firstElementChild.localName, 'h1');
});

test('a large document shows its start at once and leaves the rest for later turns of the page', async () => {
  const { host, reader } = setup({ html: longList() });
  const atOnce = host.querySelectorAll('li').length;
  assert.ok(atOnce > 0, 'the start is there as soon as the reader is');
  assert.ok(atOnce < ALL_ITEMS, 'one long list must not go in all at once');
  await reader.speechRoots();
  assert.equal(host.querySelectorAll('li').length, ALL_ITEMS);
});

test('every part of a large document sits directly in the text and has an expected height', async () => {
  const { host, reader } = setup({ html: longList() });
  await reader.speechRoots();
  const article = host.querySelector('article');
  assert.ok(article.children.length > 1);
  for (const part of article.children) {
    assert.equal(part.className, 'part');
    assert.match(part.getAttribute('style'), /contain-intrinsic-size:\s*auto [\d.]+em/);
  }
});

test('the speech roots of a large document hold all of it', async () => {
  const { reader } = setup({ html: longList() });
  const [{ root }] = await reader.speechRoots();
  assert.equal(root.querySelectorAll('li').length, ALL_ITEMS);
});

test('going to a line of a large document waits for that line', async () => {
  const { document, host, reader } = setup({ html: longList() });
  const scrolled = [];
  document.defaultView.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    scrolled.push(this.getAttribute('data-sourcepos'));
  };
  const line = LIST_LINES - 1;
  assert.ok(!host.querySelector(`[data-sourcepos="${sourcepos(line)}"]`), 'not there yet');
  await reader.goTo({ kind: 'md', line, sentence: 0 });
  assert.deepEqual(scrolled, [sourcepos(line)]);
});

test('closing the tab of a large document stops filling it', async () => {
  const { host, reader } = setup({ html: longList() });
  const article = host.querySelector('article');
  reader.destroy();
  const atClose = article.querySelectorAll('li').length;
  assert.ok(atClose < ALL_ITEMS);
  await reader.speechRoots();
  await reader.goTo({ kind: 'md', line: 1, sentence: 0 });
  assert.equal(article.querySelectorAll('li').length, atClose);
});

// Off screen, a part keeps its expected height while its blocks are laid out at their real ones, past its end.
test('the position of a large document only compares blocks within the part at the top of the screen', async () => {
  const { host, reader } = setup({ html: longList() });
  await reader.speechRoots();
  const parts = [...host.querySelector('article').children];
  assert.ok(parts.length > 1);
  const expectedHeight = 1000;
  const realBlockHeight = 100;
  const lines = [];
  parts.forEach((part, at) => {
    part.getBoundingClientRect = () => ({ top: at * expectedHeight - host.scrollTop });
    [...part.querySelectorAll('li[data-sourcepos]')].forEach((block, index) => {
      block.getBoundingClientRect = () => ({ top: at * expectedHeight + index * realBlockHeight - host.scrollTop });
      if (at === 1 && index === 2) lines.push(Number.parseInt(block.getAttribute('data-sourcepos'), 10));
    });
    part.querySelector('ul').getBoundingClientRect = () => ({ top: at * expectedHeight - host.scrollTop });
  });
  host.scrollTop = expectedHeight + 2 * realBlockHeight;
  assert.equal(reader.position().line, lines[0]);
});
