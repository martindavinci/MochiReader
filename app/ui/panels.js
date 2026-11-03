// SPDX-License-Identifier: GPL-3.0-or-later

const REMOVE_MARK = '×';
const FIRST_CONTROL = 'button, select';
const ROW = 'li';
// Windows takes two clicks this close together for a double click, unless told otherwise.
const DOUBLE_CLICK_MS = 500;

const elementIn = (host) => (tag, className, text) => {
  const made = host.ownerDocument.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
};

/**
 * The one place panels show, over the text. Only one is open at a time, and none at the start.
 * @param {HTMLElement} host
 */
export function createPanels(host) {
  let current = null;
  return {
    /** @returns {string|null} The name of the open panel. */
    current: () => current,
    /** @param {string} name Opens it empty: what it shows is drawn in `host`. */
    show(name) {
      current = name;
      host.replaceChildren();
      host.hidden = false;
    },
    close() {
      current = null;
      host.replaceChildren();
      host.hidden = true;
    },
    /** The keys then work in the panel, and not on the text behind it. */
    focus() {
      (host.querySelector(FIRST_CONTROL) ?? host).focus();
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
    const list = element('ul', 'panel-list');
    list.append(...inGroup.map(item));
    const section = element('section', 'bookmark-group');
    section.append(file, list);
    return section;
  };

  const groups = groupBookmarks(bookmarks).map(group);
  host.replaceChildren(
    element('h1', 'panel-title', labels.title),
    ...(groups.length > 0 ? groups : [element('p', 'panel-empty', labels.empty)]),
  );
}

/**
 * @param {HTMLElement} host
 * @param {import('../readers/reader.js').TocEntry[]} entries
 * @param {{labels: {title: string, empty: string}, onGo: (target: *) => void}} options
 */
export function renderToc(host, entries, { labels, onGo }) {
  const element = elementIn(host);
  const list = element('ul', 'panel-list');
  list.append(...entries.map(({ label, target }) => {
    const go = element('button', 'toc-entry', label);
    go.addEventListener('click', () => onGo(target));
    const row = element('li');
    row.append(go);
    return row;
  }));
  host.replaceChildren(
    element('h1', 'panel-title', labels.title),
    entries.length > 0 ? list : element('p', 'panel-empty', labels.empty),
  );
}
