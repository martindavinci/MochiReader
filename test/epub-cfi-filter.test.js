// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { fromRange, toRange, parse } from '../app/vendor/foliate/epubcfi.js';
import { ORIG_ATTR, TR_ATTR } from '../app/translate/marks.js';

// The browser has these; linkedom does not.
globalThis.NodeFilter ??= { FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };

const PAGE = '<html><head></head><body><h1>Chapter <i>One</i></h1>'
  + '<p>The <em>first</em> paragraph of the book.</p><p>The second one, and its end.</p></body></html>';

/** linkedom's ranges cannot be placed: a plain one is enough for CFIs. */
function plainRange() {
  return {
    setStart(node, offset) { Object.assign(this, { startContainer: node, startOffset: offset }); },
    setEnd(node, offset) { Object.assign(this, { endContainer: node, endOffset: offset }); },
    setStartBefore(node) { this.setStart(node.parentNode, [...node.parentNode.childNodes].indexOf(node)); },
    setStartAfter(node) { this.setStart(node.parentNode, [...node.parentNode.childNodes].indexOf(node) + 1); },
    setEndBefore(node) { this.setEnd(node.parentNode, [...node.parentNode.childNodes].indexOf(node)); },
    setEndAfter(node) { this.setEnd(node.parentNode, [...node.parentNode.childNodes].indexOf(node) + 1); },
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; },
  };
}

const page = () => {
  const { document } = parseHTML(PAGE);
  document.createRange = plainRange;
  return document;
};

/** Puts a translation into every block the way the app does. */
function translate(document) {
  for (const block of document.querySelectorAll('h1, p')) {
    const orig = document.createElement('span');
    orig.setAttribute(ORIG_ATTR, '');
    orig.append(...block.childNodes);
    const tr = document.createElement('span');
    tr.setAttribute(TR_ATTR, '');
    tr.innerHTML = `Tradotto <b>qui</b>: ${orig.textContent}`;
    block.append(orig, tr);
  }
  return document;
}

/** A collapsed range at `offset` in the text node holding `text`. */
function at(document, text, offset) {
  const walker = document.createTreeWalker(document.body, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.includes(text) && !node.parentElement.closest(`[${TR_ATTR}]`)) {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset);
      return range;
    }
  }
  throw new Error(`no ${text}`);
}

const cfi = (range) => fromRange(range);
const resolve = (document, value) => toRange(document, parse(value));

test('a CFI inside a block is the same with and without its translation', () => {
  for (const [text, offset] of [['second', 4], [' paragraph', 3], ['One', 1], ['Chapter', 0]]) {
    assert.equal(cfi(at(translate(page()), text, offset)), cfi(at(page(), text, offset)), text);
  }
});

test('a CFI saved without translations resolves to the same text with them', () => {
  const plain = page();
  const saved = cfi(at(plain, 'second', 4));
  const range = resolve(translate(page()), saved);
  assert.equal(range.startContainer.nodeValue, 'The second one, and its end.');
  assert.equal(range.startOffset, 4);
  assert.ok(range.startContainer.parentElement.hasAttribute(ORIG_ATTR));
});

test('a CFI made in Tradotto mode (a range inside the original of a hidden block) opens on the same paragraph in a plain doc', () => {
  const translated = translate(page());
  const saved = cfi(at(translated, ' paragraph', 0));
  const range = resolve(page(), saved);
  assert.equal(range.startContainer.nodeValue, ' paragraph of the book.');
});
