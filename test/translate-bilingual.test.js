// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { extractBlocks } from '../app/speech/extract.js';
import { applyTranslation, BILINGUAL_CSS, blockSources, markPending, originalPoint, setMain, translatableBlocks } from '../app/translate/bilingual.js';
import { ORIG_ATTR, TR_ATTR } from '../app/translate/marks.js';

const docOf = (html) => parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`).document;
const said = (doc) => extractBlocks(doc.body, { sourceMode: 'skip', lang: 'it' }).flatMap((b) => b.sentences.map((s) => s.text));

const CHAPTER = '<h2>Chapter One</h2><div><p>The door was <i>locked</i>.</p><ul><li>First item.</li></ul></div>'
  + '<pre><code>let x = 1;</code></pre><p> </p><blockquote><p>A quote.</p></blockquote>';
const ITALIAN = ['Capitolo uno', 'La porta era <i>chiusa</i>.', 'Primo elemento.', 'Una citazione.'];

test('translatableBlocks takes the innermost blocks and skips code', () => {
  const doc = docOf(CHAPTER);
  const names = translatableBlocks(doc.body).map((block) => `${block.tagName.toLowerCase()}:${block.textContent}`);
  assert.deepEqual(names, ['h2:Chapter One', 'p:The door was locked.', 'li:First item.', 'p:A quote.']);
});

test('blockSources gives the markup of each block, the original once it is translated', () => {
  const doc = docOf(CHAPTER);
  assert.equal(blockSources(translatableBlocks(doc.body))[1], 'The door was <i>locked</i>.');
  applyTranslation(doc, ITALIAN, { lang: 'it' });
  assert.equal(blockSources(translatableBlocks(doc.body))[1], 'The door was <i>locked</i>.');
});

test('applyTranslation wraps the original and adds the translation as the last child', () => {
  const doc = docOf(CHAPTER);
  applyTranslation(doc, ITALIAN, { lang: 'it' });
  const p = translatableBlocks(doc.body)[1];
  assert.equal(p.children.length, 2);
  assert.ok(p.firstElementChild.hasAttribute(ORIG_ATTR));
  assert.ok(p.lastElementChild.hasAttribute(TR_ATTR));
  assert.equal(p.lastElementChild.getAttribute('lang'), 'it');
  assert.equal(p.lastElementChild.innerHTML, 'La porta era <i>chiusa</i>.');
});

test('applyTranslation twice changes nothing more', () => {
  const doc = docOf(CHAPTER);
  applyTranslation(doc, ITALIAN, { lang: 'it' });
  const once = doc.body.innerHTML;
  applyTranslation(doc, ITALIAN, { lang: 'it' });
  assert.equal(doc.body.innerHTML, once);
});

test('setMain translated marks every original data-noread and no translation', () => {
  const doc = docOf(CHAPTER);
  applyTranslation(doc, ITALIAN, { lang: 'it' });
  setMain(doc, 'translated', 'single');
  assert.ok([...doc.querySelectorAll(`[${ORIG_ATTR}]`)].every((el) => el.hasAttribute('data-noread')));
  assert.ok([...doc.body.querySelectorAll(`[${TR_ATTR}]`)].every((el) => !el.hasAttribute('data-noread')));
  assert.equal(doc.documentElement.getAttribute('data-mochi-main'), 'translated');
  assert.equal(doc.documentElement.getAttribute('data-mochi-layout'), 'single');
  setMain(doc, 'original', 'columns');
  assert.ok([...doc.querySelectorAll(`[${ORIG_ATTR}]`)].every((el) => !el.hasAttribute('data-noread')));
  assert.ok([...doc.body.querySelectorAll(`[${TR_ATTR}]`)].every((el) => el.hasAttribute('data-noread')));
});

test('a block left untranslated is not read in Tradotto', () => {
  const doc = docOf(CHAPTER);
  applyTranslation(doc, ['Capitolo uno', null, 'Primo elemento.', 'Una citazione.'], { lang: 'it' });
  setMain(doc, 'translated', 'single');
  assert.deepEqual(said(doc), ['Capitolo uno', 'Primo elemento.', 'Una citazione.']);
  setMain(doc, 'original', 'single');
  assert.deepEqual(said(doc), ['Chapter One', 'The door was locked.', 'First item.', 'A quote.']);
});

test('extractBlocks reads only Italian in Tradotto and only English in Originale, in every layout', () => {
  for (const layout of ['single', 'columns', 'interleaved']) {
    const doc = docOf(CHAPTER);
    applyTranslation(doc, ITALIAN, { lang: 'it' });
    setMain(doc, 'translated', layout);
    assert.deepEqual(said(doc), ['Capitolo uno', 'La porta era chiusa.', 'Primo elemento.', 'Una citazione.'], layout);
    setMain(doc, 'original', layout);
    assert.deepEqual(said(doc), ['Chapter One', 'The door was locked.', 'First item.', 'A quote.'], layout);
  }
});

test('a note reference inside a translated block is still skipped by extractBlocks and its link kept', () => {
  const doc = docOf('<p>He left.<a class="footnote-ref" href="#n1">1</a></p>');
  applyTranslation(doc, ['Se ne andò.<a class="footnote-ref" href="#n1">1</a>'], { lang: 'it' });
  setMain(doc, 'translated', 'single');
  assert.deepEqual(said(doc), ['Se ne andò.']);
  assert.equal(doc.querySelector(`[${TR_ATTR}] a`).getAttribute('href'), '#n1');
});

test('markPending shows a note at the top that is never read and goes away', () => {
  const doc = docOf(CHAPTER);
  markPending(doc, 'Traduzione in corso…');
  markPending(doc, 'Traduzione in corso…');
  const notes = doc.querySelectorAll('[data-mochi-pending]');
  assert.equal(notes.length, 1);
  assert.equal(doc.body.firstElementChild, notes[0]);
  assert.ok(notes[0].hasAttribute(TR_ATTR));
  setMain(doc, 'translated', 'single');
  assert.ok(!said(doc).includes('Traduzione in corso…'));
  markPending(doc, null);
  assert.equal(doc.querySelectorAll('[data-mochi-pending]').length, 0);
});

test('the blocks found do not change once the page is translated', () => {
  const doc = docOf(CHAPTER);
  const before = translatableBlocks(doc.body);
  applyTranslation(doc, ITALIAN, { lang: 'it' });
  markPending(doc, 'x');
  assert.deepEqual(translatableBlocks(doc.body), before);
});

test('a place in a translation is the start of the original of its block', () => {
  const doc = docOf(CHAPTER);
  applyTranslation(doc, ITALIAN, { lang: 'it' });
  const tr = translatableBlocks(doc.body)[1].lastElementChild;
  const point = originalPoint(tr.firstChild, 3);
  assert.ok(point.node.hasAttribute(ORIG_ATTR));
  assert.equal(point.offset, 0);
  const text = doc.querySelector('i').firstChild;
  assert.deepEqual(originalPoint(text, 2), { node: text, offset: 2 });
});

test('in one language the hidden original keeps a place on the page, so a place in the book can be scrolled to', () => {
  const rule = BILINGUAL_CSS.split('}').find((part) => part.includes('[data-mochi-main="translated"] body [data-mochi-orig]')
    && part.includes('"single"'));
  assert.ok(rule, 'a rule hides the original in one language');
  assert.doesNotMatch(rule, /display: none/);
  assert.match(rule, /height: 0/);
  assert.match(rule, /overflow: hidden/);
});

test('setMain puts the style of the layouts into the page once, apart from the translations', () => {
  const doc = docOf(CHAPTER);
  setMain(doc, 'translated', 'single');
  setMain(doc, 'original', 'columns');
  const styles = doc.head.querySelectorAll('style');
  assert.equal(styles.length, 1);
  assert.ok(!styles[0].hasAttribute(TR_ATTR), 'the head holds no translation, and no layout rule reaches it');
  assert.match(styles[0].textContent, /data-mochi-layout/);
});

test('the layout rules reach only the translated blocks of the body, never the head or the note of a pending chapter', () => {
  const rules = BILINGUAL_CSS.split('}').map((rule) => rule.split('{')[0]).filter((selector) => selector.includes(':has('));
  assert.ok(rules.length > 0);
  for (const selector of rules) {
    for (const one of selector.split(',')) {
      assert.match(one, /\bbody :has\(> \[data-mochi-tr\]:not\(\[data-mochi-pending\]\)\)/, one);
    }
  }
});

test('a translation is put in as HTML, even in an XHTML chapter whose own parser refuses it, and the original stays', () => {
  const doc = docOf('<p>He left.<br>Then came back.</p>');
  // Chromium's XML parser throws on an unclosed <br>, which Bergamot writes; linkedom does not.
  const make = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const element = make(tag);
    Object.defineProperty(element, 'innerHTML', { set() { throw new Error('invalid XML'); }, get() { return ''; } });
    return element;
  };
  applyTranslation(doc, ['Se ne andò.<br>Poi tornò.'], { lang: 'it' });
  const p = doc.body.querySelector('p');
  assert.equal(p.querySelector(`[${ORIG_ATTR}]`).textContent, 'He left.Then came back.');
  const tr = p.querySelector(`[${TR_ATTR}]`);
  assert.equal(tr.textContent, 'Se ne andò.Poi tornò.');
  assert.equal(tr.querySelectorAll('br').length, 1);
});

test('a block whose translation cannot be put in keeps its original, and the blocks after it are translated', () => {
  const doc = docOf(CHAPTER);
  const importNode = doc.importNode.bind(doc);
  doc.importNode = (node, deep) => {
    if (String(node.textContent).includes('BAD')) throw new Error('cannot');
    return importNode(node, deep);
  };
  applyTranslation(doc, ['Capitolo uno', 'BAD', 'Primo elemento.', 'Una citazione.'], { lang: 'it' });
  const blocks = translatableBlocks(doc.body);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[1].textContent, 'The door was locked.');
  assert.equal(blocks[1].querySelector(`[${TR_ATTR}]`), null);
  assert.equal(blocks[3].querySelector(`[${TR_ATTR}]`).textContent, 'Una citazione.');
});

test('a picture in a translated block shows the picture of the page, not the address of the book', () => {
  const doc = docOf('<p>See <img src="blob:page-1" alt="a"> here.</p>');
  applyTranslation(doc, ['Vedi <img src="images/a.png" alt="a"> qui.'], { lang: 'it' });
  assert.equal(doc.body.querySelector(`[${TR_ATTR}] img`).getAttribute('src'), 'blob:page-1');
});

test('text in a div, or loose in a block that holds others, is translated or left unread in Tradotto', () => {
  const doc = docOf('<div>A plain div.</div><div>Loose words<p>A paragraph.</p></div>');
  assert.deepEqual(translatableBlocks(doc.body).map((block) => block.textContent), ['A plain div.', 'A paragraph.']);
  applyTranslation(doc, ['Un div semplice.', 'Un paragrafo.'], { lang: 'it' });
  setMain(doc, 'translated', 'single');
  assert.deepEqual(said(doc), ['Un div semplice.', 'Un paragrafo.']);
  setMain(doc, 'original', 'single');
  assert.deepEqual(said(doc), ['A plain div.', 'Loose words', 'A paragraph.']);
});
