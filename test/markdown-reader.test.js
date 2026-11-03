// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { openMarkdown, LARGE_DOC_CHARS } from '../app/readers/markdown.js';
import { SAVE_DEBOUNCE_MS } from '../app/core/position.js';

const HTML = [
  '<h1 data-sourcepos="1:1-1:6">Titolo</h1>',
  '<p data-sourcepos="3:1-3:11">Primo brano</p>',
  '<p data-sourcepos="5:1-5:12">Secondo brano</p>',
  '<p data-sourcepos="9:1-9:10">Terzo brano</p>',
].join('');

const HEADINGS = [{ level: 1, text: 'Titolo', line: 1 }];

// linkedom has no layout, so the geometry is given here: each block is this tall, in document order.
const BLOCK_HEIGHT = 100;

// Nor has it a ResizeObserver: here the test says when the layout changed.
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }

  observe() {
    observers.add(this);
  }

  disconnect() {
    observers.delete(this);
  }
};
const layoutChanged = () => [...observers].forEach((observer) => observer.callback([]));

// What covers the top of the pane, as the page says it through `scroll-padding-top`.
let scrollPaddingTop = 'auto';
globalThis.getComputedStyle = () => ({ scrollPaddingTop });

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

test('with a message over the top of the pane, the block at the top of the screen is the one below it', () => {
  scrollPaddingTop = '60px';
  try {
    const { reader } = setup({ scrollTop: 250 });
    assert.deepEqual(reader.position(), { kind: 'md', line: 9, sentence: 0 });
    assert.equal(reader.screenLine(), 9);
    assert.equal(reader.excerpt(), 'Terzo brano');
  } finally {
    scrollPaddingTop = 'auto';
  }
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

// The app takes the excerpt as JSON, and half a character there fails the whole call that saves the bookmark.
const EXCERPT_LIMIT = 160;
const emojiAfter = (letters) => '<p data-sourcepos="1:1-1:9">' + 'a'.repeat(letters) + '\u{1F389} resto del paragrafo.</p>';

test('the excerpt never ends with half a character', () => {
  const excerpt = setup({ html: emojiAfter(EXCERPT_LIMIT - 1) }).reader.excerpt();
  assert.equal(excerpt, 'a'.repeat(EXCERPT_LIMIT - 1));
  assert.ok(excerpt.isWellFormed());
});

test('the excerpt keeps a whole character that fits, and stops at its limit', () => {
  assert.equal(setup({ html: emojiAfter(EXCERPT_LIMIT - 2) }).reader.excerpt(), 'a'.repeat(EXCERPT_LIMIT - 2) + '\u{1F389}');
  assert.equal(setup({ html: emojiAfter(EXCERPT_LIMIT) }).reader.excerpt(), 'a'.repeat(EXCERPT_LIMIT));
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
  const roots = await reader.speechRoots();
  assert.equal(roots.reduce((items, { root }) => items + root.querySelectorAll('li').length, 0), ALL_ITEMS);
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

// A closed `details` is on the page but not on screen. A browser gives such a block a rectangle with no height, at a
// place that says nothing about where the reader is, and scrolling to it does nothing.
const COLLAPSED = [
  '<h2 data-sourcepos="1:1-1:10">Domanda</h2>',
  '<p data-sourcepos="3:1-3:10">Domanda lunga</p>',
  '<details><summary>Risposta</summary><p data-sourcepos="7:1-7:10">Risposta nascosta</p></details>',
  '<h2 data-sourcepos="11:1-11:10">Altra domanda</h2>',
  '<p data-sourcepos="13:1-13:10">Altra domanda lunga</p>',
].join('');

function setupCollapsed({ html = COLLAPSED, scrollTop = 0 } = {}) {
  const parts = setup({ html, headings: [] });
  const { host, blocks } = parts;
  host.scrollTop = scrollTop;
  let placed = 0;
  blocks.forEach((block) => {
    if (block.closest('details:not([open])') && !block.closest('summary')) {
      block.getBoundingClientRect = () => ({ top: 0, bottom: 0 });
    } else {
      const at = placed;
      placed += 1;
      block.getBoundingClientRect = () => {
        const top = at * BLOCK_HEIGHT - host.scrollTop;
        return { top, bottom: top + BLOCK_HEIGHT };
      };
    }
  });
  // As lines and not as elements: the diff of two linkedom elements in a failed assertion takes minutes.
  return { ...parts, scrolledLines: () => parts.scrolled.map((block) => Number.parseInt(block.getAttribute('data-sourcepos'), 10)) };
}

test('a block in a closed details is never the position or the excerpt', () => {
  const { reader } = setupCollapsed({ scrollTop: 100 });
  assert.deepEqual(reader.position(), { kind: 'md', line: 3, sentence: 0 });
  assert.equal(reader.excerpt(), 'Domanda lunga');
});

test('the position after a closed details is the block on screen', () => {
  const { reader } = setupCollapsed({ scrollTop: 200 });
  assert.deepEqual(reader.position(), { kind: 'md', line: 11, sentence: 0 });
});

test('going to a line in a closed details goes to the nearest block on screen', async () => {
  const { reader, scrolledLines } = setupCollapsed();
  await reader.goTo({ kind: 'md', line: 7, sentence: 0 });
  assert.deepEqual(scrolledLines(), [3]);
});

test('a block in an open details can be the position and can be gone to', async () => {
  const html = COLLAPSED.replace('<details>', '<details open>');
  const { reader, scrolledLines } = setupCollapsed({ html, scrollTop: 200 });
  assert.deepEqual(reader.position(), { kind: 'md', line: 7, sentence: 0 });
  await reader.goTo({ kind: 'md', line: 7, sentence: 0 });
  assert.deepEqual(scrolledLines(), [7]);
});

test('a details opened or closed while reading counts as it is now', async () => {
  const { host, reader, scrolledLines } = setupCollapsed();
  const details = host.querySelector('details');
  details.setAttribute('open', '');
  await reader.goTo({ kind: 'md', line: 7, sentence: 0 });
  details.removeAttribute('open');
  await reader.goTo({ kind: 'md', line: 7, sentence: 0 });
  assert.deepEqual(scrolledLines(), [7, 3]);
});

test('a block in the summary of a closed details is on screen', async () => {
  const html = '<p data-sourcepos="1:1-1:5">Prima</p><details><summary><p data-sourcepos="9:1-9:5">Titolo</p></summary>'
    + '<p data-sourcepos="20:1-20:5">Nascosta</p></details>';
  const { reader, scrolledLines } = setupCollapsed({ html });
  await reader.goTo({ kind: 'md', line: 9, sentence: 0 });
  assert.deepEqual(scrolledLines(), [9]);
});

test('a details inside a closed details stays hidden even when open', async () => {
  const html = '<p data-sourcepos="1:1-1:5">Prima</p><details><summary>T</summary><details open>'
    + '<p data-sourcepos="5:1-5:5">Dentro</p></details></details><p data-sourcepos="7:1-7:5">Dopo</p>';
  const { reader, scrolledLines } = setupCollapsed({ html });
  await reader.goTo({ kind: 'md', line: 5, sentence: 0 });
  assert.deepEqual(scrolledLines(), [7]);
});

test('a document with only closed details has no position and goes nowhere', async () => {
  const html = '<details><summary>T</summary><p data-sourcepos="3:1-3:5">Nascosta</p></details>';
  const { reader, scrolledLines } = setupCollapsed({ html });
  assert.deepEqual(reader.position(), { kind: 'md', line: 0, sentence: 0 });
  await reader.goTo({ kind: 'md', line: 3, sentence: 0 });
  assert.deepEqual(scrolledLines(), []);
});

test('a large document with closed details leaves them out of its position and of going to a line', async () => {
  const hidden = '<details><summary>T</summary><p data-sourcepos="5:1-5:9">Nascosta</p></details>';
  const html = `<p data-sourcepos="1:1-1:9">Prima</p>${hidden}<p data-sourcepos="8:1-8:9">${'x'.repeat(LARGE_DOC_CHARS)}</p>`;
  const { host, reader, scrolledLines } = setupCollapsed({ html, scrollTop: BLOCK_HEIGHT / 2 });
  await reader.speechRoots();
  host.querySelector('.part').getBoundingClientRect = () => ({ top: -host.scrollTop });
  assert.equal(reader.position().line, 1);
  await reader.goTo({ kind: 'md', line: 5, sentence: 0 });
  assert.deepEqual(scrolledLines(), [8]);
});

// A note of images and captions with a real page around it: a scroll stops at the end of the text, as in a browser,
// and an image takes up no room until it has loaded.
const SCREEN_HEIGHT = 500;
const IMAGE_HEIGHT = 400;
const CAPTION_HEIGHT = 50;
const ILLUSTRATED = Array.from({ length: 6 }, (_, at) => {
  const line = at * 4 + 1;
  return `<p data-sourcepos="${line}:1-${line}:9"><img src="x.png"></p>`
    + `<p data-sourcepos="${line + 2}:1-${line + 2}:9">Didascalia ${at + 1}</p>`;
}).join('');
const LAST_CAPTION_LINE = 23;
const INPUTS = ['wheel', 'keydown', 'pointerdown'];

function setupIllustrated() {
  observers.clear();
  const { document, host, reader, blocks } = setup({ html: ILLUSTRATED, headings: [] });
  let imageHeight = 0;
  const heightOf = (block) => (block.querySelector('img') ? imageHeight : CAPTION_HEIGHT);
  const topOf = (block) => {
    let top = 0;
    for (const other of blocks) {
      if (other === block) return top;
      top += heightOf(other);
    }
    return top;
  };
  const moveTo = (scrollTop) => {
    const end = Math.max(0, topOf(blocks.at(-1)) + heightOf(blocks.at(-1)) - SCREEN_HEIGHT);
    host.scrollTop = Math.min(scrollTop, end);
  };
  blocks.forEach((block) => {
    block.getBoundingClientRect = () => ({ top: topOf(block) - host.scrollTop });
    block.scrollIntoView = () => moveTo(topOf(block));
  });
  const imagesLoaded = () => {
    imageHeight = IMAGE_HEIGHT;
    layoutChanged();
  };
  const fire = (type) => host.dispatchEvent(new document.defaultView.Event(type));
  return { host, reader, imagesLoaded, moveTo, fire };
}

const IMAGE_LINE = 13;
const CAPTION_LINE = 15;

test('a block gone to before the images loaded is at the top of the screen once they have', async () => {
  const { reader, imagesLoaded } = setupIllustrated();
  await reader.goTo({ kind: 'md', line: CAPTION_LINE, sentence: 0 });
  assert.notEqual(reader.screenLine(), CAPTION_LINE, 'the page is still too short to reach it');
  imagesLoaded();
  assert.equal(reader.screenLine(), CAPTION_LINE);
});

test('the position stays where goTo went while the images load, whatever is on screen', async () => {
  const { reader } = setupIllustrated();
  await reader.goTo({ kind: 'md', line: CAPTION_LINE, sentence: 0 });
  assert.notEqual(reader.screenLine(), CAPTION_LINE);
  assert.deepEqual(reader.position(), { kind: 'md', line: CAPTION_LINE, sentence: 0 });
});

test('a scroll that nobody asked for does not move the position away from where goTo went', async () => {
  const { reader, fire } = setupIllustrated();
  const moves = [];
  reader.onMove((position) => moves.push(position.line));
  await reader.goTo({ kind: 'md', line: IMAGE_LINE, sentence: 0 });
  fire('scroll');
  await new Promise((resolve) => {
    setTimeout(resolve, SAVE_DEBOUNCE_MS * 2);
  });
  assert.deepEqual(moves, [IMAGE_LINE]);
});

test('a block too close to the end to reach the top keeps its line, and the screen shows the end', async () => {
  const { reader, imagesLoaded } = setupIllustrated();
  await reader.goTo({ kind: 'md', line: LAST_CAPTION_LINE, sentence: 0 });
  imagesLoaded();
  assert.notEqual(reader.screenLine(), LAST_CAPTION_LINE);
  assert.equal(reader.position().line, LAST_CAPTION_LINE);
});

test('the excerpt comes from the block goTo went to, like the position', async () => {
  const { reader } = setupIllustrated();
  await reader.goTo({ kind: 'md', line: CAPTION_LINE, sentence: 0 });
  assert.equal(reader.excerpt(), 'Didascalia 4');
});

for (const input of INPUTS) {
  test(`${input} gives the screen back to the reader`, async () => {
    const { host, reader, imagesLoaded, moveTo, fire } = setupIllustrated();
    await reader.goTo({ kind: 'md', line: CAPTION_LINE, sentence: 0 });
    imagesLoaded();
    fire(input);
    moveTo(0);
    assert.equal(reader.position().line, 1, 'the position is on screen again');
    imagesLoaded();
    assert.equal(host.scrollTop, 0, 'a later change of layout does not pull the screen back');
    assert.equal(observers.size, 0);
  });
}

test('going somewhere else leaves the previous block behind', async () => {
  const { reader, imagesLoaded } = setupIllustrated();
  await reader.goTo({ kind: 'md', line: CAPTION_LINE, sentence: 0 });
  await reader.goTo({ kind: 'md', line: IMAGE_LINE, sentence: 0 });
  assert.equal(observers.size, 1);
  imagesLoaded();
  assert.equal(reader.screenLine(), IMAGE_LINE);
});

test('a reader that was never sent anywhere watches no layout and reports what is on screen', () => {
  const { host, reader, imagesLoaded, moveTo } = setupIllustrated();
  assert.equal(observers.size, 0);
  imagesLoaded();
  moveTo(IMAGE_HEIGHT);
  assert.equal(host.scrollTop, IMAGE_HEIGHT);
  assert.equal(reader.position().line, 3);
});

test('closing the tab stops watching the layout, also for a goTo still waiting for the text', async () => {
  const { reader } = setupIllustrated();
  await reader.goTo({ kind: 'md', line: CAPTION_LINE, sentence: 0 });
  reader.destroy();
  assert.equal(observers.size, 0);

  const large = setup({ html: longList() });
  const going = large.reader.goTo({ kind: 'md', line: LIST_LINES, sentence: 0 });
  large.reader.destroy();
  await going;
  assert.equal(observers.size, 0);
});

const line = (reader) => reader.position().line;

const NESTED = [
  '<ul data-sourcepos="1:1-2:5"><li data-sourcepos="1:1-1:5"><p data-sourcepos="1:3-1:5">Uno</p></li>',
  '<li data-sourcepos="2:1-2:5">Due</li></ul>',
  '<p data-sourcepos="4:1-4:5">Tre</p>',
].join('');

test('moving by block goes one block on and one block back', async () => {
  const { reader, blocks, scrolled } = setup();
  await reader.moveBlock(1);
  assert.ok(scrolled.at(-1) === blocks[1]);
  assert.equal(line(reader), 3);
  await reader.moveBlock(1);
  assert.equal(line(reader), 5);
  await reader.moveBlock(-1);
  assert.ok(scrolled.at(-1) === blocks[1]);
  assert.equal(line(reader), 3);
});

test('moving by block stops at the first and at the last', async () => {
  const { reader, scrolled } = setup();
  await reader.moveBlock(-1);
  assert.deepEqual(scrolled, []);
  await reader.goTo({ kind: 'md', line: 9, sentence: 0 });
  const before = scrolled.length;
  await reader.moveBlock(1);
  assert.equal(scrolled.length, before);
  assert.equal(line(reader), 9);
});

test('moving by block lands on items, not on the list that holds them', async () => {
  const { reader } = setup({ html: NESTED });
  await reader.moveBlock(1);
  assert.equal(line(reader), 2);
  await reader.moveBlock(1);
  assert.equal(line(reader), 4);
  await reader.moveBlock(-1);
  await reader.moveBlock(-1);
  assert.equal(line(reader), 1);
});

// As comrak writes them: the text of an item in a tight list sits directly in the li, next to its sublist.
const SUBLISTS = [
  '<h2 data-sourcepos="1:1-1:8">Lista</h2>\n',
  '<ul data-sourcepos="3:1-7:12">\n<li data-sourcepos="3:1-5:12">Genitore A\n',
  '<ul data-sourcepos="4:3-5:12">\n',
  '<li data-sourcepos="4:3-4:12">Figlio A1</li>\n',
  '<li data-sourcepos="5:3-5:12">Figlio A2</li>\n',
  '</ul>\n</li>\n',
  '<li data-sourcepos="6:1-7:12"><strong>Genitore</strong> B\n',
  '<ul data-sourcepos="7:3-7:12">\n<li data-sourcepos="7:3-7:12">Figlio B1</li>\n</ul>\n</li>\n</ul>\n',
  '<p data-sourcepos="9:1-9:4">Fine</p>\n',
].join('');

const walk = async (reader, delta, presses) => {
  const lines = [];
  for (let press = 0; press < presses; press += 1) {
    await reader.moveBlock(delta);
    lines.push(line(reader));
  }
  return lines;
};

test('moving by block stops on an item that has a sublist, in both directions', async () => {
  const { reader } = setup({ html: SUBLISTS });
  assert.deepEqual(await walk(reader, 1, 6), [3, 4, 5, 6, 7, 9]);
  assert.deepEqual(await walk(reader, -1, 6), [7, 6, 5, 4, 3, 1]);
});

test('moving by block to an item with a sublist puts the item itself at the top', async () => {
  const { reader, scrolled } = setup({ html: SUBLISTS });
  await reader.moveBlock(1);
  assert.equal(scrolled.at(-1).localName, 'li');
  assert.ok(scrolled.at(-1).textContent.startsWith('Genitore A'));
});

test('moving by block stops on the paragraph of an item that has one, not on the item around it', async () => {
  const html = '<ul data-sourcepos="1:1-3:9"><li data-sourcepos="1:1-3:9"><p data-sourcepos="1:3-1:9">Sciolta</p>'
    + '<ul data-sourcepos="3:3-3:9"><li data-sourcepos="3:3-3:9">Figlio</li></ul></li></ul>'
    + '<p data-sourcepos="5:1-5:4">Fine</p>';
  const { reader, scrolled } = setup({ html });
  assert.deepEqual(await walk(reader, 1, 2), [3, 5]);
  assert.deepEqual(await walk(reader, -1, 2), [3, 1]);
  assert.equal(scrolled.at(-1).localName, 'p');
});

test('moving by block goes to the inner item when two items start on one line', async () => {
  const html = '<ul data-sourcepos="1:1-2:5"><li data-sourcepos="1:1-1:5"><ul data-sourcepos="1:3-1:5">'
    + '<li data-sourcepos="1:3-1:5">Uno</li></ul></li><li data-sourcepos="2:1-2:5">Due</li></ul>';
  const { reader, scrolled } = setup({ html });
  await reader.moveBlock(1);
  await reader.moveBlock(-1);
  assert.equal(line(reader), 1);
  assert.equal(scrolled.at(-1).getAttribute('data-sourcepos'), '1:3-1:5');
});

test('moving by block skips what a closed details hides', async () => {
  const html = '<p data-sourcepos="1:1-1:5">Uno</p>'
    + '<details><summary>Altro</summary><p data-sourcepos="3:1-3:5">Nascosto</p></details>'
    + '<p data-sourcepos="5:1-5:5">Tre</p>';
  const { reader } = setup({ html });
  await reader.moveBlock(1);
  assert.equal(line(reader), 5);
});

const SECTIONS = [
  '<h1 data-sourcepos="1:1-1:5">Uno</h1>',
  '<p data-sourcepos="3:1-3:5">Testo</p>',
  '<h2 data-sourcepos="5:1-5:5">Due</h2>',
  '<p data-sourcepos="7:1-7:5">Testo</p>',
  '<details><summary>Altro</summary><h2 data-sourcepos="9:1-9:5">Nascosto</h2></details>',
  '<h2 data-sourcepos="11:1-11:5">Tre</h2>',
].join('');

test('moving by section goes from heading to heading', async () => {
  const { reader } = setup({ html: SECTIONS });
  await reader.moveSection(1);
  assert.equal(line(reader), 5);
  await reader.moveSection(1);
  assert.equal(line(reader), 11);
  await reader.moveSection(-1);
  assert.equal(line(reader), 5);
});

test('moving back from inside a section goes to its own heading', async () => {
  const { reader } = setup({ html: SECTIONS });
  await reader.goTo({ kind: 'md', line: 7, sentence: 0 });
  await reader.moveSection(-1);
  assert.equal(line(reader), 5);
});

test('moving by section stops where there are no more headings', async () => {
  const { reader, scrolled } = setup({ html: SECTIONS });
  await reader.moveSection(-1);
  assert.deepEqual(scrolled, []);
  await reader.goTo({ kind: 'md', line: 11, sentence: 0 });
  await reader.moveSection(1);
  assert.equal(line(reader), 11);
});

test('a move holds the place like goTo, until the reader moves on', async () => {
  const { reader, host, document } = setup({ scrollTop: 0 });
  await reader.moveBlock(1);
  assert.equal(line(reader), 3);
  host.dispatchEvent(new document.defaultView.Event('wheel'));
  assert.equal(line(reader), 1);
});

test('a move after the reader is gone does nothing', async () => {
  const { reader, scrolled } = setup();
  reader.destroy();
  await reader.moveBlock(1);
  await reader.moveSection(1);
  assert.deepEqual(scrolled, []);
});

test('a modifier pressed on the way to a shortcut keeps the place, and a key that moves lets it go', async () => {
  const { reader, host, document } = setup({ scrollTop: 0 });
  await reader.goTo({ kind: 'md', line: 5, sentence: 0 });
  const press = (key) => {
    const event = new document.defaultView.Event('keydown');
    event.key = key;
    host.dispatchEvent(event);
  };
  for (const key of ['Control', 'Shift', 'Alt', 'AltGraph', 'Meta']) {
    press(key);
    assert.equal(line(reader), 5, key);
  }
  press('PageDown');
  assert.equal(line(reader), 1);
});

/** A range the voice is on, somewhere on the page. */
const rangeAt = (top, height = 20) => ({ getBoundingClientRect: () => ({ top, bottom: top + height, width: 300, height }) });

const inputOn = (document, target, type, fields = {}) => {
  const event = new document.defaultView.Event(type, { bubbles: true });
  Object.assign(event, fields);
  target.dispatchEvent(event);
};

test('the sentence being read is the position, wherever the reader has scrolled to', () => {
  const { reader, host, document } = setup();
  reader.speakAt({ range: null, line: 5, sentence: 2, follow: false });
  assert.deepEqual(reader.position(), { kind: 'md', line: 5, sentence: 2 });
  host.scrollTop = 250;
  inputOn(document, host, 'wheel');
  assert.deepEqual(reader.position(), { kind: 'md', line: 5, sentence: 2 });
});

test('a sentence with no line of its own leaves the line where it is', () => {
  const { reader } = setup();
  reader.speakAt({ range: null, line: null, sentence: 0, follow: false });
  assert.deepEqual(reader.position(), { kind: 'md', line: 1, sentence: 0 });
});

test('following brings a sentence on screen, with room above it', () => {
  const { reader, host } = setup({ scrollTop: 100 });
  reader.speakAt({ range: rangeAt(800), line: 5, sentence: 0, follow: true });
  assert.equal(host.scrollTop, 100 + 800 - 500 * 0.25);
  host.scrollTop = 100;
  reader.speakAt({ range: rangeAt(-40), line: 5, sentence: 0, follow: true });
  assert.equal(host.scrollTop, 100 - 40 - 500 * 0.25);
});

test('a sentence already on screen moves nothing', () => {
  const { reader, host } = setup({ scrollTop: 100 });
  reader.speakAt({ range: rangeAt(200), line: 5, sentence: 0, follow: true });
  assert.equal(host.scrollTop, 100);
});

test('what covers the top of the pane does not count as on screen', () => {
  scrollPaddingTop = '60px';
  try {
    const { reader, host } = setup({ scrollTop: 100 });
    reader.speakAt({ range: rangeAt(30), line: 5, sentence: 0, follow: true });
    assert.equal(host.scrollTop, 100 + 30 - 60 - (500 - 60) * 0.25);
  } finally {
    scrollPaddingTop = 'auto';
  }
});

test('not following, or with the sentence nowhere on the page, nothing scrolls', () => {
  const { reader, host } = setup({ scrollTop: 100 });
  reader.speakAt({ range: rangeAt(800), line: 5, sentence: 0, follow: false });
  assert.equal(host.scrollTop, 100);
  const unseen = { getBoundingClientRect: () => ({ top: 0, bottom: 0, width: 0, height: 0 }) };
  reader.speakAt({ range: unseen, line: 5, sentence: 0, follow: true });
  assert.equal(host.scrollTop, 100);
});

test('when the voice stops, its sentence stays the position until the reader moves, and nothing scrolls', () => {
  const { reader, host, document, scrolled } = setup();
  reader.speakAt({ range: null, line: 5, sentence: 2, follow: false });
  reader.speechStopped();
  assert.deepEqual(reader.position(), { kind: 'md', line: 5, sentence: 2 });
  layoutChanged();
  assert.deepEqual(scrolled, []);
  host.scrollTop = 250;
  inputOn(document, host, 'wheel');
  assert.deepEqual(reader.position(), { kind: 'md', line: 5, sentence: 0 });
});

test('stopping with no sentence read keeps nothing', () => {
  const { reader, host } = setup({ scrollTop: 250 });
  reader.speechStopped();
  host.scrollTop = 0;
  assert.deepEqual(reader.position(), { kind: 'md', line: 1, sentence: 0 });
});

test('going to a saved place keeps the number of its sentence until the reader moves', async () => {
  const { reader, host, document } = setup();
  await reader.goTo({ kind: 'md', line: 5, sentence: 3 });
  assert.deepEqual(reader.position(), { kind: 'md', line: 5, sentence: 3 });
  assert.deepEqual(reader.speechStart(), { line: 5, sentence: 3 });
  inputOn(document, host, 'wheel');
  assert.equal(reader.position().sentence, 0);
});

test('going somewhere while the voice reads takes the position there', async () => {
  const { reader } = setup();
  reader.speakAt({ range: null, line: 5, sentence: 2, follow: false });
  await reader.goTo({ kind: 'md', line: 9, sentence: 0 });
  assert.deepEqual(reader.position(), { kind: 'md', line: 9, sentence: 0 });
});

test('the wheel, the scrolling keys and the scrollbar count as moving by hand', () => {
  const { reader, host, document, blocks } = setup();
  let moves = 0;
  reader.onHandMove(() => {
    moves += 1;
  });
  inputOn(document, host, 'wheel');
  assert.equal(moves, 1);
  for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']) {
    moves = 0;
    inputOn(document, host, 'keydown', { key });
    assert.equal(moves, 1, key);
  }
  moves = 0;
  inputOn(document, host, 'keydown', { key: 'Enter' });
  inputOn(document, host, 'keydown', { key: 'Control' });
  assert.equal(moves, 0);
  inputOn(document, blocks[1], 'pointerdown');
  assert.equal(moves, 0, 'a press on the text is no scrolling');
  inputOn(document, host, 'pointerdown');
  assert.equal(moves, 1, 'a press on the pane itself is on its scrollbar');
});

test('a closed reader hears no more of the hand', () => {
  const { reader, host, document } = setup();
  let moves = 0;
  reader.onHandMove(() => {
    moves += 1;
  });
  reader.destroy();
  inputOn(document, host, 'wheel');
  assert.equal(moves, 0);
});

test('a right click in the text reaches onInput too', () => {
  const { reader, blocks, document } = setup();
  const seen = [];
  reader.onInput((event) => seen.push(event.type));
  blocks[1].dispatchEvent(new document.defaultView.Event('contextmenu', { bubbles: true }));
  assert.deepEqual(seen, ['contextmenu']);
});

test('a Markdown file has one section, so there is none before it either', async () => {
  assert.equal(await setup().reader.prevSpeechSection(), false);
});

test('a large document offers its parts one by one, so that reading can start without stopping the page', async () => {
  const html = '<p data-sourcepos="1:1-1:9">Testo del documento.</p>'.repeat(40_000);
  assert.ok(html.length >= LARGE_DOC_CHARS);
  const { reader, host } = setup({ html });
  const roots = await reader.speechRoots();
  assert.ok(roots.length > 1);
  assert.deepEqual(roots.map(({ root }) => root), [...host.querySelector('article').children]);
  reader.destroy();
});
