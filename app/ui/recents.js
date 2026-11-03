// SPDX-License-Identifier: GPL-3.0-or-later
import { fileName } from '../core/paths.js';

const REMOVE_MARK = '×';

/**
 * A book goes by the title it declares, and the volumes of a series can all declare the same one.
 * @param {string} title
 * @param {string} path
 * @returns {string[]} The name of the file, unless that is what the title says already.
 */
export function fileBesideTitle(title, path) {
  const name = fileName(path);
  return name === title ? [] : [name];
}

/**
 * Draws the recent files again, under how to open a file if there is a `hint`.
 * @param {HTMLElement} host
 * @param {{path: string, title: string, exists: boolean}[]} recents The newest first.
 * @param {{labels: {hint?: string, title: string, empty: string, missing: string, remove: string},
 *   onOpen: (path: string) => void, onRemove: (path: string, row: HTMLElement) => void}} options
 */
export function renderRecents(host, recents, { labels, onOpen, onRemove }) {
  const document = host.ownerDocument;
  const element = (tag, className, text) => {
    const made = document.createElement(tag);
    if (className) made.className = className;
    if (text !== undefined) made.textContent = text;
    return made;
  };

  const item = ({ path, title, exists }) => {
    const open = element('button', 'recent-open');
    open.setAttribute('title', path);
    open.addEventListener('click', () => onOpen(path));
    const folder = path.slice(0, -fileName(path).length - 1);
    open.append(
      element('span', 'recent-name', title),
      ...fileBesideTitle(title, path).map((name) => element('span', 'recent-file', name)),
      element('span', 'recent-folder', folder),
    );

    const row = element('li', exists ? 'recent' : 'recent missing');
    row.append(open);
    if (!exists) {
      const remove = element('button', 'recent-remove', REMOVE_MARK);
      remove.setAttribute('aria-label', labels.remove);
      remove.setAttribute('title', labels.remove);
      remove.addEventListener('click', () => onRemove(path, row));
      open.append(element('span', 'recent-missing', labels.missing));
      row.append(remove);
    }
    return row;
  };

  const list = recents.length > 0 ? element('ul', 'recents') : element('p', 'recents-empty', labels.empty);
  if (recents.length > 0) list.append(...recents.map(item));
  const hint = labels.hint ? [element('p', 'home-hint', labels.hint)] : [];
  host.replaceChildren(...hint, element('h1', 'recents-title', labels.title), list);
}
