// SPDX-License-Identifier: GPL-3.0-or-later
import { debounce, lineFromSourcepos, nearestBlock, SAVE_DEBOUNCE_MS } from '../core/position.js';

/** HTML from this size on keeps the layout of off-screen blocks out of the opening and of every scroll. */
export const LARGE_DOC_CHARS = 500_000;

const BLOCK_SELECTOR = '[data-sourcepos]';
const FIRST_SENTENCE = 0;
const NO_LINE = 0;
const EXCERPT_CHARS = 160;
// goTo puts a block at the top, but the scroll offset is rounded to a whole device pixel, so the block can land up
// to half a pixel lower. Without this margin it would not count as the top block, and each save would move back one.
const FOLD_MARGIN_PX = 1;

/**
 * @param {{rendered: {html: string, lang?: string|null, headings: {text: string, line: number}[]}}} doc
 * @param {HTMLElement} host The scrolling element of the tab.
 * @returns {import('./reader.js').Reader}
 */
export function openMarkdown(doc, host) {
  const { html, lang, headings } = doc.rendered;
  const article = host.ownerDocument.createElement('article');
  if (html.length >= LARGE_DOC_CHARS) article.classList.add('large');
  article.innerHTML = html;
  host.append(article);

  const moveCallbacks = [];
  const blocks = () => [...article.querySelectorAll(BLOCK_SELECTOR)];
  const lineOf = (block) => lineFromSourcepos(block.getAttribute('data-sourcepos'));

  // Tops only grow in document order, so a search finds the last block that starts above the fold.
  const topBlock = () => {
    const all = blocks();
    const fold = host.getBoundingClientRect().top + FOLD_MARGIN_PX;
    let low = 0;
    let high = all.length - 1;
    let found = all[0] ?? null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (all[middle].getBoundingClientRect().top <= fold) {
        found = all[middle];
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  };

  const position = () => {
    const block = topBlock();
    return { kind: 'md', line: block ? lineOf(block) : NO_LINE, sentence: FIRST_SENTENCE };
  };

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
    goTo: async (target) => {
      const all = blocks();
      const index = nearestBlock(all.map(lineOf), target.line);
      if (index >= 0) all[index].scrollIntoView({ block: 'start' });
    },
    speechRoots: async () => [{ root: article, section: null }],
    onMove: (callback) => moveCallbacks.push(callback),
    onInput: (callback) => article.addEventListener('click', callback),
    setStyle: () => {},
    nextSpeechSection: async () => false,
    excerpt: () => (topBlock()?.textContent ?? '').trim().slice(0, EXCERPT_CHARS),
    destroy: () => {
      notifyMove.cancel();
      host.removeEventListener('scroll', notifyMove);
      article.remove();
    },
  };
}
