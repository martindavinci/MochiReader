// SPDX-License-Identifier: GPL-3.0-or-later
import { debounce, lineFromSourcepos, nearestBlock, SAVE_DEBOUNCE_MS, SCROLL_KEYS } from '../core/position.js';
import { excerptOf } from './excerpt.js';
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
// goTo puts a block at the top, but the scroll offset is rounded to a whole device pixel, so the block can land up
// to half a pixel lower. Without this margin it would not count as the top block, and each save would move back one.
const FOLD_MARGIN_PX = 1;
// What the reader does to move on from where goTo put them. Not `scroll`: the page also scrolls when its layout changes.
const MOVE_INPUTS = ['wheel', 'keydown', 'pointerdown'];
// Pressed on its own on the way to a shortcut, which is no reason to leave a point: Ctrl+D saves that very point.
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta']);
// How far down the pane a sentence lands when the voice takes the text to it: what comes next is what stays in view.
const TEXT_NODE = 3;
const FILE_NAME = /\.\w{2,5}$/;
const CODE_LANGUAGE = /language-(\S+)/;
const FOLLOW_ROOM_SHARE = 0.25;

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
/**
 * What the text can have around it. A caption comes from the alternative text of an image alone in its paragraph, unless
 * that is only the name of a file. Hidden from the voice and from assistive software, which read it from the image.
 */
function dressText(root) {
  const document = root.ownerDocument;
  for (const image of root.querySelectorAll('p > img[alt]')) {
    const alt = image.getAttribute('alt').trim();
    const paragraph = image.parentElement;
    if (!alt || FILE_NAME.test(alt) || paragraph.children.length !== 1 || paragraph.textContent.trim()) continue;
    const caption = document.createElement('span');
    caption.className = 'image-caption';
    caption.setAttribute('aria-hidden', 'true');
    caption.textContent = alt;
    paragraph.append(caption);
  }
  for (const code of root.querySelectorAll('pre > code[class*="language-"]')) {
    const [, language] = CODE_LANGUAGE.exec(code.className) ?? [];
    if (language) code.parentElement.setAttribute('data-lang', language);
  }
}

async function fillInParts(article, html, stopped) {
  let sliceEnd = 0;
  for (const part of htmlParts(html, PART_CHARS)) {
    if (stopped()) return;
    appendPart(article, part);
    dressText(article.lastElementChild);
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
    dressText(article);
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

  // A message can stick over the top of the pane. What it covers is not on screen, and goTo lands below it.
  const coveredAtTop = () => parseFloat(getComputedStyle(host).scrollPaddingTop) || 0;

  const topBlock = () => {
    const fold = host.getBoundingClientRect().top + coveredAtTop() + FOLD_MARGIN_PX;
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
  let heldSentence = FIRST_SENTENCE;
  // The sentence the voice is on. While it reads this is the position, wherever the reader has scrolled to.
  let spoken = null;

  const letGo = () => {
    held = null;
    heldSentence = FIRST_SENTENCE;
    heldLayout?.disconnect();
    heldLayout = null;
    MOVE_INPUTS.forEach((type) => host.removeEventListener(type, onMoveInput));
  };

  const onMoveInput = ({ key }) => {
    if (!MODIFIER_KEYS.has(key)) letGo();
  };

  const waitForMove = () => MOVE_INPUTS.forEach((type) => host.addEventListener(type, onMoveInput, { passive: true }));

  const hold = (block, sentence = FIRST_SENTENCE) => {
    letGo();
    held = block;
    heldSentence = sentence;
    heldLayout = new ResizeObserver(() => block.scrollIntoView({ block: 'start' }));
    heldLayout.observe(article);
    waitForMove();
  };

  const currentBlock = () => held ?? topBlock();

  const moveTo = (block, sentence) => {
    block.scrollIntoView({ block: 'start' });
    hold(block, sentence);
  };

  /** A sentence on screen stays where it is, and a closed `details` or a tab behind has no place to bring it to. */
  const bringIntoView = (range) => {
    const box = range.getBoundingClientRect();
    if (!box.width && !box.height) return;
    const pane = host.getBoundingClientRect();
    const top = pane.top + coveredAtTop();
    if (box.top >= top && box.bottom <= pane.bottom) return;
    host.scrollTop += box.top - top - (pane.bottom - top) * FOLLOW_ROOM_SHARE;
  };

  const handCallbacks = [];
  const handMoved = () => handCallbacks.forEach((callback) => callback());
  const onHandKey = ({ key }) => {
    if (SCROLL_KEYS.has(key)) handMoved();
  };
  // On the pane itself means on its scrollbar: the text is what covers the rest of it.
  const onHandPress = ({ target }) => {
    if (target === host) handMoved();
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

  const position = () => ({
    kind: 'md',
    line: spoken?.line ?? lineOrNone(currentBlock()),
    sentence: spoken?.sentence ?? heldSentence,
  });

  const notifyMove = debounce(() => {
    const at = position();
    moveCallbacks.forEach((callback) => callback(at));
  }, SAVE_DEBOUNCE_MS);
  host.addEventListener('scroll', notifyMove, { passive: true });

  return {
    kind: 'markdown',
    lang: lang ?? null,
    toc: () => headings.map(({ text, line, level }) => ({
      label: text,
      level,
      target: { kind: 'md', line, sentence: FIRST_SENTENCE },
    })),
    currentToc: () => {
      const { line } = position();
      return headings.findLastIndex((heading) => heading.line <= line);
    },
    position,
    placeAt: (node) => {
      const block = (node.nodeType === TEXT_NODE ? node.parentElement : node).closest('[data-sourcepos]');
      if (!block) return null;
      return { position: { kind: 'md', line: lineOf(block), sentence: FIRST_SENTENCE }, excerpt: excerptOf(block.textContent) };
    },
    // Not in the contract: only the report of the tabs asks, to check the screen and not what the reader says.
    screenLine: () => lineOrNone(topBlock()),
    goTo: async (target) => {
      await filled;
      if (destroyed) return;
      const all = blocks();
      const index = nearestBlock(all.map(lineOf), target.line);
      if (index < 0) return;
      spoken = null;
      moveTo(all[index], target.sentence);
    },
    speechRoots: async () => {
      await filled;
      const isLarge = article.classList.contains('large');
      return (isLarge ? [...article.children] : [article]).map((root) => ({ root, section: null }));
    },
    onMove: (callback) => moveCallbacks.push(callback),
    onInput: (callback) => {
      article.addEventListener('click', callback);
      article.addEventListener('contextmenu', callback);
    },
    setStyle: () => {},
    nextSpeechSection: async () => false,
    prevSpeechSection: async () => false,
    speechStart: () => {
      const { line, sentence } = position();
      return { line, sentence };
    },
    speakAt: ({ range, line, sentence, follow }) => {
      letGo();
      spoken = { line, sentence };
      if (follow && range) bringIntoView(range);
    },
    // Nothing scrolls for this: the sentence is on screen, or the reader went away from it and knows.
    speechStopped: () => {
      if (!spoken) return;
      const { line, sentence } = spoken;
      spoken = null;
      if (line === null) return;
      const all = blocks();
      held = all[nearestBlock(all.map(lineOf), line)] ?? null;
      heldSentence = sentence;
      waitForMove();
    },
    onHandMove: (callback) => {
      if (handCallbacks.length === 0) {
        host.addEventListener('wheel', handMoved, { passive: true });
        host.addEventListener('keydown', onHandKey, { passive: true });
        host.addEventListener('pointerdown', onHandPress, { passive: true });
      }
      handCallbacks.push(callback);
    },
    excerpt: () => excerptOf(currentBlock()?.textContent ?? ''),
    moveBlock: (delta) => step(landingBlocks, delta),
    moveSection: (delta) => step(headingBlocks, delta),
    destroy: () => {
      destroyed = true;
      letGo();
      notifyMove.cancel();
      host.removeEventListener('scroll', notifyMove);
      host.removeEventListener('wheel', handMoved);
      host.removeEventListener('keydown', onHandKey);
      host.removeEventListener('pointerdown', onHandPress);
      article.remove();
    },
  };
}
