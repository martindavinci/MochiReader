// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../core/i18n.js';
import { fileName } from '../core/paths.js';
import { icon, named } from './icons.js';

const CLOSE_MARK = '×';
const STEP_KEYS = { ArrowRight: 1, ArrowLeft: -1 };
const CLOSE_KEY = 'Delete';
const TAB = '.tab-name';
const FADE_START = 'fade-start';
const FADE_END = 'fade-end';

/**
 * Draws the tabs again. Only the active one is a stop for the Tab key: the arrows go along them, and Delete closes one.
 * @param {HTMLElement} bar
 * @param {{id: number, path: string}[]} tabs
 * @param {number|undefined} activeId
 * @param {{closeLabel: string, onActivate: (id: number) => void, onClose: (id: number) => void, readingId?: number|null}} options
 */
export function renderTabBar(bar, tabs, activeId, { closeLabel, onActivate, onClose, readingId = null }) {
  const document = bar.ownerDocument;
  const button = (className, text, onClick) => {
    const element = document.createElement('button');
    element.className = className;
    element.textContent = text;
    element.addEventListener('click', onClick);
    return element;
  };

  bar.replaceChildren(...tabs.map(({ id, path }) => {
    const tab = document.createElement('div');
    tab.className = id === activeId ? 'tab active' : 'tab';
    if (id === readingId) tab.classList.add('reading');
    tab.setAttribute('title', path);
    tab.setAttribute('data-id', String(id));
    const close = button('tab-close', CLOSE_MARK, () => onClose(id));
    close.setAttribute('aria-label', closeLabel);
    close.setAttribute('tabindex', '-1');
    const name = button('tab-name', fileName(path), () => onActivate(id));
    name.setAttribute('role', 'tab');
    name.setAttribute('aria-selected', String(id === activeId));
    name.setAttribute('tabindex', id === activeId ? '0' : '-1');
    name.addEventListener('keydown', (event) => {
      if (event.key === CLOSE_KEY) {
        onClose(id);
        return;
      }
      const step = STEP_KEYS[event.key];
      if (!step || event.ctrlKey || event.shiftKey) return;
      const all = [...bar.querySelectorAll(TAB)];
      all[all.indexOf(name) + step]?.focus();
    });
    tab.append(name, close);
    return tab;
  }));
}

/**
 * The tabs do not fit: they scroll with the wheel, with no scrollbar to take up height, and fade where they are cut.
 * @param {HTMLElement} bar
 * @param {(overflowing: boolean) => void} onOverflow
 * @returns {{update: () => void, showActive: () => void}}
 */
export function watchTabOverflow(bar, onOverflow) {
  const update = () => {
    const { scrollLeft, scrollWidth, clientWidth } = bar;
    const overflowing = scrollWidth > clientWidth + 1;
    bar.classList.toggle(FADE_START, overflowing && scrollLeft > 1);
    bar.classList.toggle(FADE_END, overflowing && scrollLeft + clientWidth < scrollWidth - 1);
    onOverflow(overflowing);
  };
  bar.addEventListener('wheel', (event) => {
    if (bar.scrollWidth <= bar.clientWidth) return;
    event.preventDefault();
    bar.scrollLeft += event.deltaY + event.deltaX;
  }, { passive: false });
  bar.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(bar);
  return {
    update,
    showActive() {
      const tab = bar.querySelector('.tab.active');
      if (tab) {
        const { offsetLeft: left, offsetWidth: width } = tab;
        if (left < bar.scrollLeft) bar.scrollLeft = left;
        else if (left + width > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = left + width - bar.clientWidth;
      }
      update();
    },
  };
}

/**
 * What sits beside the tabs, always in the same place, so nothing has to be remembered as a key.
 * @param {HTMLElement} row Where the tabs are.
 * @param {{onOpen: () => void, onCount: (opener: Element) => void, onContents: (opener: Element) => void,
 *   onBookmark: () => void, onRead: () => void, onMore: (opener: Element) => void}} handlers
 * @returns {{setCount: (count: number|null) => void, setReading: (reading: boolean) => void}}
 */
export function createTabTools(row, { onOpen, onCount, onContents, onBookmark, onRead, onMore }) {
  const document = row.ownerDocument;
  const tool = (className, glyph, label, keys, action) => {
    const button = document.createElement('button');
    button.className = className;
    named(button, label, keys);
    if (glyph) button.append(icon(document, glyph));
    // The arrows and space stay with the text: a press with the mouse must not leave the focus on the button.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => action(button));
    return button;
  };
  const added = tool('tab-new', 'add', t('tools.open'), 'Ctrl+O', onOpen);
  const count = tool('tab-count', null, t('tabs.all'), null, onCount);
  count.hidden = true;
  const number = document.createElement('span');
  count.append(number, icon(document, 'chevron', 12));
  const read = tool('tool tool-read', 'speaker', t('tools.read'), 'F5', onRead);
  const readLabel = document.createElement('span');
  readLabel.className = 'label';
  readLabel.textContent = t('tools.read');
  read.append(readLabel);
  read.setAttribute('aria-pressed', 'false');
  const tools = document.createElement('div');
  tools.className = 'toolbar';
  tools.append(
    tool('tool optional', 'contents', t('tools.contents'), 'Ctrl+T', onContents),
    tool('tool optional', 'bookmark', t('tools.bookmark'), 'Ctrl+D', onBookmark),
    read,
    tool('tool', 'more', t('tools.more'), null, onMore),
  );
  row.append(added, count, tools);
  return {
    setCount(value) {
      count.hidden = value === null;
      if (value !== null) number.textContent = String(value);
    },
    setReading(reading) {
      read.setAttribute('aria-pressed', String(reading));
      readLabel.textContent = t(reading ? 'tools.reading' : 'tools.read');
      read.querySelector('svg').replaceWith(icon(document, reading ? 'speaking' : 'speaker'));
    },
  };
}
