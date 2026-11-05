// SPDX-License-Identifier: GPL-3.0-or-later
// Around the frame of a book, never in it: the frame is the book's. Loads with the first book.
import { t } from '../core/i18n.js';
import { icon, named } from './icons.js';
import { elementIn } from './panel-parts.js';
import { statePage } from './states.js';

const BOOK = 'foliate-view, .book-stage';

/**
 * @param {HTMLElement} pane Holds the view of the book.
 * @param {import('../readers/reader.js').Reader} reader
 * @param {{title: string, onChapter: (chapter: number, chapters: number) => void}} options
 * @returns {{destroy: () => void}}
 */
export function mountBookChrome(pane, reader, { title, onChapter }) {
  const doc = pane.ownerDocument;
  const element = elementIn(pane);

  const turn = (className, glyph, label, keys, action) => {
    const button = element('button', `book-turn ${className}`);
    named(button, label, keys);
    button.append(icon(doc, glyph, 14));
    // The keys stay with the page, however the page was turned.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => action());
    return button;
  };

  const head = element('div', 'book-head', title);
  head.setAttribute('title', title);
  const prev = turn('prev', 'back', t('book.prevPage'), '←', () => reader.goLeft());
  const next = turn('next', 'forward', t('book.nextPage'), '→', () => reader.goRight());
  const bar = element('div', 'book-progress');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-label', t('book.progress'));
  const where = element('span', 'book-where');
  const page = element('span', 'book-page');
  const upNext = element('button', 'book-next');
  upNext.hidden = true;
  upNext.addEventListener('mousedown', (event) => event.preventDefault());
  upNext.addEventListener('click', () => reader.moveSection(1));
  const meta = element('div', 'meta');
  meta.append(where, upNext, page);
  const foot = element('div', 'book-foot');
  foot.append(bar, meta);
  const damaged = element('div', 'book-damaged');
  damaged.hidden = true;
  damaged.append(statePage(pane, {
    glyph: 'doc',
    title: t('book.damagedTitle'),
    text: t('book.damagedText'),
    actions: [
      { label: t('book.prevChapter'), run: () => reader.moveSection(-1) },
      { label: t('book.nextChapter'), primary: true, run: () => reader.moveSection(1) },
    ],
  }));

  pane.querySelector(BOOK).before(head);
  pane.append(prev, next, foot, damaged);

  let chapterShown = null;
  const draw = () => {
    const progress = reader.progress();
    const { chapter, chapters, label, page: at, pages, percent, parts, next: following, atStart, atEnd, scrolled } = progress;
    pane.classList.toggle('book-scrolled', scrolled);
    prev.disabled = atStart;
    next.disabled = atEnd;
    bar.setAttribute('aria-valuenow', String(percent));
    if (bar.childElementCount !== parts.length) bar.replaceChildren(...parts.map(() => element('span')));
    [...bar.children].forEach((part, index) => {
      part.style.setProperty('--weight', String(parts[index].weight));
      part.style.setProperty('--done', `${parts[index].done}%`);
    });
    const number = t('book.chapter', { n: chapter, total: chapters });
    where.textContent = label ? `${number} · ${label}` : number;
    page.textContent = progress.damaged
      ? t('book.unavailable')
      : [at ? t('book.page', { n: at, total: pages }) : null, `${percent}%`].filter(Boolean).join(' · ');
    upNext.hidden = !following || progress.damaged;
    upNext.textContent = following ? `${t('book.next')} ${following} →` : '';
    damaged.hidden = !progress.damaged;
    head.textContent = progress.damaged && label ? `${title} · ${label}` : title;
    if (chapter !== chapterShown) {
      chapterShown = chapter;
      onChapter(chapter, chapters);
    }
  };

  reader.onProgress(draw);
  draw();
  return {
    destroy() {
      [head, prev, next, foot, damaged].forEach((part) => part.remove());
    },
  };
}
