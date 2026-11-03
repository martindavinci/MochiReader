// SPDX-License-Identifier: GPL-3.0-or-later
import { debounce, lineFromSourcepos, nearestBlock, SAVE_DEBOUNCE_MS } from '../core/position.js';
import { htmlParts } from './html-parts.js';

/** HTML from this size on goes in part by part, and the layout of parts off screen stays out of every scroll. */
export const LARGE_DOC_CHARS = 500_000;
const PART_CHARS = 64_000;
// The page parses for this long at a time. The rest of a turn is for clicks, other tabs and frames.
const FILL_SLICE_MS = 8;
// What a part off screen is expected to take up, so that the scrollbar stays close to the real length.
const COLUMN_CHARS = 70;
const LINE_HEIGHT_EM = 1.6;
const HEIGHT_DECIMALS = 1;

// A closed `details` keeps its text on the page but not on screen: no place to read it from, and no way to scroll to it.
// Read from the page and not from the layout, so that this stays cheap and works in a tab that is not in front.
const HIDDEN_BY_DETAILS = 'details:not([open]) > :not(summary)';
const BLOCK_SELECTOR = `[data-sourcepos]:not(${HIDDEN_BY_DETAILS}, ${HIDDEN_BY_DETAILS} *)`;
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const FIRST_SENTENCE = 0;
const NO_LINE = 0;
const EXCERPT_CHARS = 160;
// The first half of a character the cut went through. The excerpt goes to the app as JSON, which refuses it.
const CUT_CHARACTER = /[\uD800-\uDBFF]$/;
// goTo puts a block at the top, but the scroll offset is rounded to a whole device pixel, so the block can land up
// to half a pixel lower. Without this margin it would not count as the top block, and each save would move back one.
const FOLD_MARGIN_PX = 1;
// What the reader does to move on from where goTo put them. Not `scroll`: the page also scrolls when its layout changes.
const MOVE_INPUTS = ['wheel', 'keydown', 'pointerdown'];
// Pressed on its own on the way to a shortcut, which is no reason to leave a point: Ctrl+D saves that very point.
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta']);

const nextTurn = () => new Promise((resolve) => {
  setTimeout(resolve);
});

function appendPart(article, html) {
  const part = article.ownerDocument.createElement('div');
  part.className = 'part';
  part.innerHTML = html;
  const lines = Math.max(part.textContent.length / COLUMN_CHARS, part.querySelectorAll(BLOCK_SELECTOR).length);
  part.style.containIntrinsicSize = `auto ${(lines * LINE_HEIGHT_EM).toFixed(HEIGHT_DECIMALS)}em`;
  article.append(part);
}

/** Puts in the first part now and the others over the next turns of the page, until `stopped` says so. */
async function fillInParts(article, html, stopped) {
  let sliceEnd = 0;
  for (const part of htmlParts(html, PART_CHARS)) {
    if (stopped()) return;
    appendPart(article, part);
    if (performance.now() >= sliceEnd) {
      await nextTurn();
      sliceEnd = performance.now() + FILL_SLICE_MS;
    }
  }
}

/**
 * @param {{rendered: {html: string, lang?: string|null, headings: {text: string, line: number}[]}}} doc
 * @param {HTMLElement} host The scrolling element of the tab.
 * @returns {import('./reader.js').Reader}
 */
export function openMarkdown(doc, host) {
  const { html, lang, headings } = doc.rendered;
  const article = host.ownerDocument.createElement('article');
  let destroyed = false;
  let filled = Promise.resolve();
  if (html.length >= LARGE_DOC_CHARS) {
    article.classList.add('large');
    filled = fillInParts(article, html, () => destroyed);
  } else {
    article.innerHTML = html;
  }
  host.append(article);

  const moveCallbacks = [];
  const blocksIn = (scope) => [...scope.querySelectorAll(BLOCK_SELECTOR)];
  const blocks = () => blocksIn(article);
  const lineOf = (block) => lineFromSourcepos(block.getAttribute('data-sourcepos'));

  // Tops only grow in document order, so a search finds the last element that starts above the fold.
  const lastAbove = (elements, fold) => {
    let low = 0;
    let high = elements.length - 1;
    let found = elements[0] ?? null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (elements[middle].getBoundingClientRect().top <= fold) {
        found = elements[middle];
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  };

  const topBlock = () => {
    const fold = host.getBoundingClientRect().top + FOLD_MARGIN_PX;
    if (!article.classList.contains('large')) return lastAbove(blocks(), fold);
    // Off screen, a part keeps its expected height while its blocks are laid out at their real ones, so only the
    // part at the fold has tops to compare. Raw HTML can fill a part with no block: the last one before it counts.
    const parts = [...article.children];
    for (let at = parts.indexOf(lastAbove(parts, fold)); at >= 0; at -= 1) {
      const inPart = blocksIn(parts[at]);
      if (inPart.length > 0) return lastAbove(inPart, fold);
    }
    return null;
  };

  const lineOrNone = (block) => (block ? lineOf(block) : NO_LINE);

  // Where goTo went stays the position until the reader moves away. Images load after the text and push it down, and
  // a block near the end cannot reach the top at all: what is on screen says nothing about the point being held.
  let held = null;
  let heldLayout = null;

  const letGo = () => {
    held = null;
    heldLayout?.disconnect();
    heldLayout = null;
    MOVE_INPUTS.forEach((type) => host.removeEventListener(type, onMoveInput));
  };

  const onMoveInput = ({ key }) => {
    if (!MODIFIER_KEYS.has(key)) letGo();
  };

  const hold = (block) => {
    letGo();
    held = block;
    heldLayout = new ResizeObserver(() => block.scrollIntoView({ block: 'start' }));
    heldLayout.observe(article);
    MOVE_INPUTS.forEach((type) => host.addEventListener(type, onMoveInput, { passive: true }));
  };

  const currentBlock = () => held ?? topBlock();

  const moveTo = (block) => {
    block.scrollIntoView({ block: 'start' });
    hold(block);
  };

  /** To the first of `candidates` past the current line in the direction of `delta`, if there is one. */
  const step = async (candidates, delta) => {
    await filled;
    if (destroyed) return;
    const line = lineOrNone(currentBlock());
    const all = candidates();
    const target = delta > 0 ? all.find((block) => lineOf(block) > line) : all.findLast((block) => lineOf(block) < line);
    if (target) moveTo(target);
  };

  // A list starts on the line of its first item, and an item on the line of its paragraph: neither is a place to land
  // on. An item with a sublist has its own line before the first block inside it, and that is one.
  const landingBlocks = () => blocks().filter((block) => {
    const inner = block.querySelector('[data-sourcepos]');
    return !inner || lineOf(inner) > lineOf(block);
  });
  const headingBlocks = () => blocks().filter((block) => block.matches(HEADING_SELECTOR));

  const position = () => ({ kind: 'md', line: lineOrNone(currentBlock()), sentence: FIRST_SENTENCE });

  const notifyMove = debounce(() => {
    const at = position();
    moveCallbacks.forEach((callback) => callback(at));
  }, SAVE_DEBOUNCE_MS);
  host.addEventListener('scroll', notifyMove, { passive: true });

  return {
    kind: 'markdown',
    lang: lang ?? null,
    toc: () => headings.map(({ text, line }) => ({
      label: text,
      target: { kind: 'md', line, sentence: FIRST_SENTENCE },
    })),
    position,
    // Not in the contract: only the report of the tabs asks, to check the screen and not what the reader says.
    screenLine: () => lineOrNone(topBlock()),
    goTo: async (target) => {
      await filled;
      if (destroyed) return;
      const all = blocks();
      const index = nearestBlock(all.map(lineOf), target.line);
      if (index < 0) return;
      moveTo(all[index]);
    },
    speechRoots: async () => {
      await filled;
      return [{ root: article, section: null }];
    },
    onMove: (callback) => moveCallbacks.push(callback),
    onInput: (callback) => article.addEventListener('click', callback),
    setStyle: () => {},
    nextSpeechSection: async () => false,
    excerpt: () => (currentBlock()?.textContent ?? '').trim().slice(0, EXCERPT_CHARS).replace(CUT_CHARACTER, ''),
    moveBlock: (delta) => step(landingBlocks, delta),
    moveSection: (delta) => step(headingBlocks, delta),
    destroy: () => {
      destroyed = true;
      letGo();
      notifyMove.cancel();
      host.removeEventListener('scroll', notifyMove);
      article.remove();
    },
  };
}
