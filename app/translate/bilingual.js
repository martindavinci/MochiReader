// SPDX-License-Identifier: GPL-3.0-or-later
// A chapter with its translation in it: each block keeps its original, wrapped, and gets its translation as its last
// child. The layouts are styles over that one page, and the main language only says which side is read aloud.
import { ORIG_ATTR, TR_ATTR } from './marks.js';

// A book may put its paragraphs in any of these: the innermost one holding text is the block.
const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, dt, dd, blockquote, figcaption, td, th, caption, '
  + 'div, section, article, aside, header, footer';
// Code, formulas and pictures are not prose.
const NOT_PROSE = 'pre, code, script, style, svg, math';
const READABLE = /[\p{L}\p{N}]/u;
const NOREAD = 'data-noread';
// A block of the book left in its language: not read when the translation is the main language.
const UNTRANSLATED = 'data-mochi-untranslated';
// Text of the book outside every block (beside the blocks of a div that holds others): wrapped like an original,
// so that it is read only in the book's language, and still shown.
const STRAY = 'data-mochi-stray';
const PENDING = 'data-mochi-pending';
const MAIN = 'data-mochi-main';
const LAYOUT = 'data-mochi-layout';
const STYLE = 'data-mochi-style';
const TEXT_NODE = 3;

const isOurs = (el) => Boolean(el.closest(`[${TR_ATTR}]`));
const originalOf = (block) => [...block.children].find((child) => child.hasAttribute(ORIG_ATTR)) ?? null;
const translationOf = (block) => [...block.children].find((child) => child.hasAttribute(TR_ATTR)) ?? null;

/**
 * @param {Element} body
 * @returns {Element[]} The innermost blocks of prose, in reading order: a block holding another is not one.
 */
export function translatableBlocks(body) {
  return [...body.querySelectorAll(BLOCKS)].filter((block) => !isOurs(block)
    && !block.closest(NOT_PROSE)
    && ![...block.querySelectorAll(BLOCKS)].some((inner) => !isOurs(inner))
    && READABLE.test((originalOf(block) ?? block).textContent));
}

/**
 * @param {Element[]} blocks From `translatableBlocks`.
 * @returns {string[]} The markup of each block in the book's language, for the engine's HTML mode.
 */
export function blockSources(blocks) {
  return blocks.map((block) => (originalOf(block) ?? block).innerHTML);
}

/**
 * Puts the translations into the page; a block already translated, or with `null`, is left as it is.
 * @param {Document} doc
 * @param {(string|null)[]} texts One per block of `translatableBlocks`.
 * @param {{lang: string}} options The language of the translation.
 */
export function applyTranslation(doc, texts, { lang }) {
  const blocks = translatableBlocks(doc.body);
  blocks.forEach((block, i) => {
    const text = texts[i];
    if (text == null || translationOf(block)) return;
    try {
      // Built in full before the original moves: a translation that cannot be put in leaves its block as it was.
      const tr = doc.createElement('span');
      tr.setAttribute(TR_ATTR, '');
      tr.setAttribute('lang', lang);
      tr.append(...htmlNodes(doc, text));
      // The translation was made from the book's file, whose pictures the page shows from addresses of its own.
      const shown = [...block.querySelectorAll('img')];
      [...tr.querySelectorAll('img')].forEach((img, k) => {
        if (shown[k]) img.setAttribute('src', shown[k].getAttribute('src'));
        else img.remove();
      });
      const orig = doc.createElement('span');
      orig.setAttribute(ORIG_ATTR, '');
      orig.append(...block.childNodes);
      block.append(orig, tr);
    } catch (error) {
      console.warn(error);
    }
  });
  wrapStrayText(doc, blocks);
}

/**
 * The engine writes HTML (`<br>` unclosed), and a chapter is often XHTML, whose own parser refuses it: the translation
 * is read as HTML and its nodes brought into the chapter.
 */
function htmlNodes(doc, text) {
  const Parser = globalThis.DOMParser ?? doc.defaultView?.DOMParser;
  const parsed = new Parser().parseFromString(`<!doctype html><html><body>${text}</body></html>`, 'text/html');
  return [...parsed.body.childNodes].map((node) => doc.importNode(node, true));
}

/** Readable text of the book that no block holds, wrapped so that the voice reads it only in the book's language. */
function wrapStrayText(doc, blocks) {
  const inBlock = (node) => blocks.some((block) => block.contains(node));
  const walker = doc.createTreeWalker(doc.body, 4);
  const stray = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (node.nodeType !== TEXT_NODE || !parent || !READABLE.test(node.nodeValue)) continue;
    if (parent.closest(`[${ORIG_ATTR}], [${TR_ATTR}], ${NOT_PROSE}`) || inBlock(node)) continue;
    stray.push(node);
  }
  stray.forEach((node) => {
    const wrapper = doc.createElement('span');
    wrapper.setAttribute(ORIG_ATTR, '');
    wrapper.setAttribute(STRAY, '');
    node.replaceWith(wrapper);
    wrapper.append(node);
  });
}

/**
 * The note at the top of a chapter whose translation is on its way.
 * @param {Document} doc
 * @param {string|null} text What it says; `null` takes it away.
 */
export function markPending(doc, text) {
  doc.querySelectorAll(`[${PENDING}]`).forEach((note) => note.remove());
  if (text == null) return;
  const note = doc.createElement('div');
  note.setAttribute(TR_ATTR, '');
  note.setAttribute(PENDING, '');
  note.setAttribute(NOREAD, '');
  note.textContent = text;
  doc.body.prepend(note);
}

/**
 * @param {Document} doc
 * @param {'original'|'translated'} main The language read aloud, and shown alone in the single layout.
 * @param {'single'|'columns'|'interleaved'} layout
 */
export function setMain(doc, main, layout) {
  const root = doc.documentElement;
  if (doc.head && !doc.head.querySelector(`style[${STYLE}]`)) {
    const sheet = doc.createElement('style');
    sheet.setAttribute(STYLE, '');
    sheet.textContent = BILINGUAL_CSS;
    doc.head.append(sheet);
  }
  root.setAttribute(MAIN, main);
  root.setAttribute(LAYOUT, layout);
  const translated = main === 'translated';
  doc.querySelectorAll(`[${ORIG_ATTR}]`).forEach((el) => el.toggleAttribute(NOREAD, translated));
  doc.body.querySelectorAll(`[${TR_ATTR}]:not([${PENDING}])`).forEach((el) => el.toggleAttribute(NOREAD, !translated));
  doc.querySelectorAll(`[${UNTRANSLATED}]`).forEach((el) => {
    el.removeAttribute(UNTRANSLATED);
    el.removeAttribute(NOREAD);
  });
  if (!translated) return;
  translatableBlocks(doc.body).filter((block) => !translationOf(block)).forEach((block) => {
    if (block.hasAttribute(NOREAD)) return;
    block.setAttribute(UNTRANSLATED, '');
    block.setAttribute(NOREAD, '');
  });
}

/**
 * A place inside a translation is nowhere in the book: it stands for the start of its block.
 * @param {Node} node
 * @param {number} offset
 * @returns {{node: Node, offset: number}}
 */
export function originalPoint(node, offset) {
  const element = node.nodeType === 1 ? node : node.parentElement;
  const tr = element?.closest(`[${TR_ATTR}]`);
  if (!tr) return { node, offset };
  const block = tr.parentElement;
  return { node: (block && originalOf(block)) ?? block ?? tr, offset: 0 };
}

/**
 * Inside the frame of a chapter: how the layouts look. A place in the book is in the original, so an original hidden in
 * one language keeps its box, with no height: foliate can still scroll to it, and lands on its translation.
 */
const TRANSLATED_BLOCK = `body :has(> [${TR_ATTR}]:not([${PENDING}]))`;
const TRANSLATION = `body [${TR_ATTR}]:not([${PENDING}])`;
export const BILINGUAL_CSS = `
html[${LAYOUT}="single"][${MAIN}="translated"] body [${ORIG_ATTR}]:not([${STRAY}]) { display: block; height: 0; overflow: hidden; }
html[${LAYOUT}="single"][${MAIN}="original"] ${TRANSLATION} { display: none !important; }
html:not([${MAIN}="translated"]) [${PENDING}] { display: none !important; }
[${PENDING}] { font-style: italic; opacity: 0.7; margin-bottom: 1em; }
html[${LAYOUT}="interleaved"] ${TRANSLATION} { display: block; margin-top: 0.4em; }
html[${LAYOUT}="columns"] ${TRANSLATED_BLOCK} {
  display: grid; grid-template-columns: 1fr 1fr; column-gap: 1.5em; align-items: start;
}
html[${LAYOUT}="columns"] ${TRANSLATED_BLOCK} > * { min-width: 0; }
html:not([${LAYOUT}="single"])[${MAIN}="translated"] body [${ORIG_ATTR}],
html:not([${LAYOUT}="single"])[${MAIN}="original"] ${TRANSLATION} { opacity: 0.6; }
@media (max-width: 600px) {
  html[${LAYOUT}="columns"] ${TRANSLATED_BLOCK} { display: block; }
  html[${LAYOUT}="columns"] ${TRANSLATION} { display: block; margin-top: 0.4em; }
}
`;
