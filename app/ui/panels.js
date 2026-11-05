// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../core/i18n.js';
import { icon } from './icons.js';
import { elementIn, panelEmpty, panelFoot, panelHead } from './panel-parts.js';
import { fileBesideTitle } from './recents.js';

const REMOVE_MARK = '×';
const FIRST_CONTROL = 'button, select';
const ROW = 'li';
const CLOSE_BUTTON = '.panel-close';
const PANEL_ATTRIBUTE = 'data-panel';
// What the arrows walk: the first control of each row. The other controls of a row are for the Tab key.
const ROW_CONTROL = 'li > button:first-child, li > .row-open';
const CURRENT_ROW = '[aria-current]';
const STEP_KEYS = { ArrowDown: 1, ArrowUp: -1 };
// Windows takes two clicks this close together for a double click, unless told otherwise.
const DOUBLE_CLICK_MS = 500;

/**
 * The one place panels show, over the text. Only one is open at a time, and none at the start.
 * @param {HTMLElement} host
 * @param {{onClose?: () => void}} [handlers] What the button in the head of a panel does.
 */
export function createPanels(host, { onClose } = {}) {
  let current = null;
  host.addEventListener('click', ({ target }) => {
    if (target.closest?.(CLOSE_BUTTON)) onClose?.();
  });
  host.addEventListener('keydown', (event) => {
    const step = STEP_KEYS[event.key];
    if (!step || event.target.closest?.('select, input')) return;
    const rows = [...host.querySelectorAll(ROW_CONTROL)];
    if (rows.length === 0) return;
    event.preventDefault();
    const at = rows.indexOf(event.target);
    const start = host.querySelector(CURRENT_ROW);
    const next = at >= 0 ? rows[at + step] : start ?? rows[step > 0 ? 0 : rows.length - 1];
    next?.focus();
  });
  return {
    /** @returns {string|null} The name of the open panel. */
    current: () => current,
    /** @param {string} name Opens it empty: what it shows is drawn in `host`. */
    show(name) {
      current = name;
      host.replaceChildren();
      host.setAttribute(PANEL_ATTRIBUTE, name);
      host.hidden = false;
    },
    close() {
      current = null;
      host.replaceChildren();
      host.removeAttribute(PANEL_ATTRIBUTE);
      host.hidden = true;
    },
    /** The keys then work in the panel, and not on the text behind it. No row gets a ring before an arrow is pressed. */
    focus() {
      host.setAttribute('aria-label', host.querySelector('.panel-title')?.textContent ?? '');
      host.focus();
    },
  };
}

/**
 * For a list drawn again over itself, which keeps its scroll. Call it before drawing, and what it returns after.
 * @param {HTMLElement} host
 * @param {Element|null} [row] The row the focus belongs to, even one about to leave. By default the one that has it.
 * @returns {() => void} Puts the focus on the row now in that place, or on the host with no rows left. A row that
 *   leaves is at the place the pointer is, so nothing has to scroll for this.
 */
export function keepFocus(host, row = host.ownerDocument.activeElement?.closest?.(ROW)) {
  const at = [...host.querySelectorAll(ROW)].indexOf(row);
  return () => {
    if (at < 0) return;
    const rows = host.querySelectorAll(ROW);
    const target = rows[Math.min(at, rows.length - 1)]?.querySelector(FIRST_CONTROL) ?? host;
    target.focus({ preventScroll: true });
  };
}

/**
 * Taking a row away puts the next one under the pointer, and nothing brings a removed row back. So the second click
 * of a double click, on what the first one left there, must not reach anything.
 * @param {number} [ms] How long clicks stay away once the list has been drawn again.
 * @returns {{open: <A extends any[]>(action: (...args: A) => *) => (...args: A) => *,
 *   remove: <A extends any[]>(action: (...args: A) => Promise<*>) => (...args: A) => Promise<void>}} What the controls
 *   of a list should do: each does nothing while a removal is under way and for `ms` after it.
 */
export function createRowGuard(ms = DOUBLE_CLICK_MS) {
  let settling = false;
  return {
    open: (action) => (...args) => (settling ? undefined : action(...args)),
    remove: (action) => async (...args) => {
      if (settling) return;
      settling = true;
      try {
        await action(...args);
        await new Promise((resolve) => {
          setTimeout(resolve, ms);
        });
      } finally {
        settling = false;
      }
    },
  };
}

/**
 * A row that opens something takes its list away, and the second click of a double click lands on what was behind it,
 * which can be a link. In a book that is inside a frame, where no listener here hears it: only lying on top stops it.
 * @param {HTMLElement} parent Where the shield lives.
 * @param {number} [ms] How long it stays up.
 * @returns {{raise: () => void}}
 */
export function createClickShield(parent, ms = DOUBLE_CLICK_MS) {
  const shield = parent.ownerDocument.createElement('div');
  shield.className = 'click-shield';
  shield.hidden = true;
  // A press would take the focus away from the text, and the keys with it.
  shield.addEventListener('mousedown', (event) => event.preventDefault());
  parent.append(shield);
  let timer = null;
  return {
    raise() {
      shield.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        shield.hidden = true;
      }, ms);
    },
  };
}

/**
 * @template {{key: string, path: string, title: string}} B
 * @param {B[]} bookmarks
 * @returns {{key: string, path: string, title: string, bookmarks: B[]}[]} One group per document, in order of first
 *   appearance. A book found by its identifier can have moved: the group goes by its newest bookmark.
 */
export function groupBookmarks(bookmarks) {
  const groups = new Map();
  for (const bookmark of bookmarks) {
    const { key, path, title } = bookmark;
    const group = groups.get(key) ?? { bookmarks: [] };
    groups.set(key, { key, path, title, bookmarks: [...group.bookmarks, bookmark] });
  }
  return [...groups.values()];
}

/**
 * @param {HTMLElement} host
 * @param {object[]} bookmarks As the state keeps them.
 * @param {{labels: {title: string, empty: string, remove: string}, dateOf: (ms: number) => string,
 *   onOpen: (bookmark: object) => void, onRemove: (bookmark: object, row: HTMLElement) => void}} options
 */
export function renderBookmarks(host, bookmarks, { labels, dateOf, onOpen, onRemove }) {
  const element = elementIn(host);

  const item = (bookmark) => {
    const open = element('button', 'bookmark-open');
    open.addEventListener('click', () => onOpen(bookmark));
    open.append(
      element('span', 'bookmark-excerpt', bookmark.excerpt || bookmark.title),
      element('span', 'bookmark-date', dateOf(bookmark.createdAt)),
    );
    const remove = element('button', 'bookmark-remove', REMOVE_MARK);
    remove.setAttribute('aria-label', labels.remove);
    remove.setAttribute('title', labels.remove);
    const row = element('li', 'bookmark');
    remove.addEventListener('click', () => onRemove(bookmark, row));
    row.append(open, remove);
    return row;
  };

  const group = ({ path, title, bookmarks: inGroup }) => {
    const file = element('h2', 'bookmark-file', title);
    file.setAttribute('title', path);
    file.append(...fileBesideTitle(title, path).map((name) => element('span', 'bookmark-file-name', name)));
    const list = element('ul', 'panel-list');
    list.append(...inGroup.map(item));
    const section = element('section', 'bookmark-group');
    section.append(file, list);
    return section;
  };

  const groups = groupBookmarks(bookmarks).map(group);
  const parts = groups.length > 0
    ? [element('div', 'panel-body'), panelFoot(host, element('span', undefined, t('panel.hintOpen')))]
    : [panelEmpty(host, { glyph: 'bookmark', title: labels.empty, text: t('bookmarks.emptyText') })];
  if (groups.length > 0) parts[0].append(...groups);
  host.replaceChildren(panelHead(host, {
    glyph: 'bookmark',
    title: labels.title,
    count: bookmarks.length || '',
  }), ...parts);
}

/**
 * @param {HTMLElement} host
 * @param {string} text The licenses, kept as they are written.
 * @param {{title: string, notice?: string, sourceLabel?: string, sourceUrl?: string, backLabel?: string,
 *   onBack?: () => void, onSource?: () => void}} labels
 */
export function renderLicenses(host, text, { title, notice, sourceLabel, sourceUrl, backLabel, onBack, onSource }) {
  const element = elementIn(host);
  const body = element('div', 'panel-body');
  if (onBack) {
    const back = element('button', 'panel-back');
    back.append(icon(host.ownerDocument, 'back', 14), element('span', undefined, backLabel));
    back.addEventListener('click', () => onBack());
    body.append(back);
  }
  if (notice) body.append(element('p', 'panel-message', notice));
  if (sourceUrl) {
    const source = element('button', 'licenses-source');
    source.append(element('span', 'licenses-source-label', sourceLabel), element('span', 'licenses-source-url', sourceUrl));
    source.addEventListener('click', () => onSource());
    body.append(source);
  }
  body.append(element('pre', 'licenses-text', text));
  host.replaceChildren(panelHead(host, { glyph: 'doc', title }), body);
}

/**
 * @param {HTMLElement} host
 * @param {import('../readers/reader.js').TocEntry[]} entries
 * @param {{labels: {title: string, empty: string, count?: string, here?: string}, current?: number, numbered?: boolean,
 *   onGo: (target: *) => void}} options
 */
export function renderToc(host, entries, { labels, current = -1, numbered = false, onGo }) {
  const element = elementIn(host);
  const list = element('ul', 'panel-list');
  let chapter = 0;
  list.append(...entries.map(({ label, target, level = 1 }, index) => {
    const go = element('button', 'toc-entry');
    go.setAttribute('data-level', String(level));
    if (numbered && level === 1) {
      chapter += 1;
      go.append(element('span', 'toc-number', String(chapter)));
    }
    go.append(element('span', 'toc-label', label));
    if (index === current) {
      go.setAttribute('aria-current', 'location');
      if (labels.here) go.append(element('span', 'toc-here', labels.here));
    }
    go.addEventListener('click', () => onGo(target));
    const row = element('li');
    row.append(go);
    return row;
  }));
  const body = element('div', 'panel-body');
  body.append(list);
  host.replaceChildren(
    panelHead(host, { glyph: 'contents', title: labels.title, count: entries.length > 0 ? labels.count : '' }),
    ...(entries.length > 0
      ? [body, panelFoot(host, element('span', undefined, t('panel.hintGo')))]
      : [panelEmpty(host, { glyph: 'contents', title: labels.empty, text: t('toc.emptyText') })]),
  );
  // The place in the book is what the panel is for, however long the list.
  host.querySelector('[aria-current]')?.scrollIntoView?.({ block: 'center' });
}

/**
 * @param {HTMLElement} host
 * @param {string} name The name of the language with no voice.
 * @param {{onSettings: () => void, onClose: () => void}} handlers
 */
export function renderVoiceHelp(host, name, { onSettings, onClose }) {
  const element = elementIn(host);
  const button = (className, text, action) => {
    const made = element('button', `btn ${className}`, text);
    made.addEventListener('click', () => action());
    return made;
  };
  const way = element('p', 'voice-way');
  t('speech.voicePath').split(' > ').forEach((step, index) => {
    if (index > 0) way.append(element('span', 'voice-way-next', '›'));
    way.append(element('span', 'kbd', step));
  });
  const actions = element('div', 'panel-actions');
  actions.append(button('btn-neutral', t('speech.openSettings'), onSettings), button('btn-secondary', t('speech.notNow'), onClose));
  const body = element('div', 'panel-body');
  body.append(
    element('p', 'panel-message', t('speech.noVoice', { lang: name })),
    way,
    actions,
    element('p', 'panel-message', t('speech.hiddenVoice', { lang: name })),
  );
  host.replaceChildren(panelHead(host, { glyph: 'mute', title: t('speech.noVoiceTitle', { lang: name }) }), body);
}

/**
 * @param {HTMLElement} host
 * @param {{id: number, name: string, path: string, active: boolean, reading: boolean}[]} tabs
 * @param {{onGo: (id: number) => void}} handlers
 */
export function renderTabList(host, tabs, { onGo }) {
  const element = elementIn(host);
  const list = element('ul', 'panel-list');
  list.append(...tabs.map(({ id, name, path, active, reading }) => {
    const go = element('button', 'toc-entry');
    go.setAttribute('title', path);
    if (active) go.setAttribute('aria-current', 'page');
    if (reading) go.append(icon(host.ownerDocument, 'speaking', 14));
    go.append(element('span', 'toc-label', name));
    go.addEventListener('click', () => onGo(id));
    const row = element('li');
    row.append(go);
    return row;
  }));
  const body = element('div', 'panel-body');
  body.append(list);
  host.replaceChildren(
    panelHead(host, { glyph: 'contents', title: t('tabs.title'), count: tabs.length }),
    body,
    panelFoot(host, element('span', undefined, t('panel.hintGo'))),
  );
}

// Every shortcut of `core/keys.js`, as people write it, in the order someone would look for it.
const SHORTCUTS = [
  ['shortcuts.files', [
    ['Ctrl+O', 'tools.open'],
    ['Ctrl+W', 'tools.closeTab'],
    ['Ctrl+Tab', 'shortcuts.nextTab'],
    ['Ctrl+R', 'tools.recents'],
    ['Ctrl+B', 'tools.bookmarks'],
    ['Ctrl+T', 'tools.contents'],
    ['Ctrl+,', 'tools.options'],
    ['F1', 'tools.shortcuts'],
    ['Esc', 'shortcuts.closePanel'],
  ]],
  ['shortcuts.reading', [
    ['Ctrl+D', 'tools.bookmark'],
    ['Ctrl++', 'shortcuts.bigger'],
    ['Ctrl+-', 'shortcuts.smaller'],
    ['← →', 'shortcuts.page'],
    ['Space', 'shortcuts.nextPage'],
    ['Shift+← →', 'shortcuts.block'],
    ['Ctrl+← →', 'shortcuts.section'],
  ]],
  ['shortcuts.speech', [
    ['F5', 'tools.read'],
    ['Ctrl+Shift+S', 'tools.read'],
    ['Space', 'shortcuts.pause'],
    ['← →', 'shortcuts.sentence'],
    ['Shift+← →', 'shortcuts.block'],
    ['Ctrl+← →', 'shortcuts.section'],
    ['+ −', 'shortcuts.speed'],
  ]],
];

/** @param {HTMLElement} host */
export function renderShortcuts(host) {
  const element = elementIn(host);
  const body = element('div', 'panel-body');
  body.append(...SHORTCUTS.flatMap(([group, rows]) => {
    const list = element('dl', 'shortcuts');
    list.append(...rows.flatMap(([keys, what]) => {
      const key = element('dt');
      key.append(element('span', 'kbd', keys));
      return [key, element('dd', undefined, t(what))];
    }));
    return [element('h2', 'option-group', t(group)), list];
  }));
  host.replaceChildren(panelHead(host, { glyph: 'keyboard', title: t('tools.shortcuts') }), body);
}
