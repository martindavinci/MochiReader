// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../core/i18n.js';
import { fileName } from '../core/paths.js';
import { elementIn, panelEmpty, panelFoot, panelHead } from './panel-parts.js';

const REMOVE_MARK = '×';
const SEP = /[\\/]/;
const EPUB = 'epub';
const KINDS = { [EPUB]: 'epub', markdown: 'md' };

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
 * @param {string} folder
 * @returns {[string, string]} Two parts of a path: when there is no room the first one gives way, so the end of the path,
 *   which is what tells two folders apart, stays.
 */
export function folderParts(folder) {
  const last = folder.split(SEP).at(-1);
  return [folder.slice(0, folder.length - last.length), last];
}

/**
 * @param {HTMLElement} host
 * @param {{path: string, title: string, kind?: string, exists: boolean, chapter?: number, chapters?: number}[]} recents
 *   The newest first.
 * @param {{labels: {missing: string, remove: string}, onOpen: (path: string) => void,
 *   onRemove: (path: string, row: HTMLElement) => void}} options
 * @returns {HTMLElement} The list.
 */
export function recentList(host, recents, { labels, onOpen, onRemove }) {
  const element = elementIn(host);

  const item = ({ path, title, kind, exists, chapter, chapters }) => {
    const open = element('button', 'recent-open');
    open.setAttribute('title', path);
    open.setAttribute('data-kind', KINDS[kind] ?? KINDS.markdown);
    open.addEventListener('click', () => onOpen(path));
    const [start, end] = folderParts(path.slice(0, -fileName(path).length - 1));
    const folder = element('span', 'recent-folder');
    folder.append(element('span', 'recent-folder-start', start), element('span', 'recent-folder-end', end));
    const about = element('span', 'recent-about');
    if (!exists) about.append(element('span', 'recent-missing', labels.missing));
    about.append(...fileBesideTitle(title, path).map((name) => element('span', 'recent-file', name)), folder);
    open.append(element('span', 'recent-name', title), about);
    if (exists && chapter && chapters) open.append(element('span', 'recent-progress', t('recents.chapter', { n: chapter, total: chapters })));

    const remove = element('button', 'recent-remove', REMOVE_MARK);
    remove.setAttribute('aria-label', labels.remove);
    remove.setAttribute('title', labels.remove);
    const row = element('li', exists ? 'recent' : 'recent missing');
    remove.addEventListener('click', () => onRemove(path, row));
    row.append(open, remove);
    return row;
  };

  const list = element('ul', 'recents');
  list.append(...recents.map(item));
  return list;
}

/**
 * The panel of the recent files.
 * @param {HTMLElement} host
 * @param {object[]} recents
 * @param {{labels: {title: string, empty: string, missing: string, remove: string}, onOpen: (path: string) => void,
 *   onRemove: (path: string, row: HTMLElement) => void, onOpenFile?: () => void, onClear?: () => void}} options
 */
export function renderRecents(host, recents, { labels, onOpen, onRemove, onOpenFile, onClear }) {
  const element = elementIn(host);
  const head = panelHead(host, { glyph: 'clock', title: labels.title, count: recents.length || '' });
  if (recents.length === 0) {
    host.replaceChildren(head, panelEmpty(host, { glyph: 'clock', title: labels.empty, text: t('recents.emptyText') }));
    return;
  }
  const body = element('div', 'panel-body');
  body.append(recentList(host, recents, { labels, onOpen, onRemove }));
  const foot = panelFoot(host);
  if (onClear) {
    const clear = element('button', 'link-button', t('recents.clear'));
    clear.addEventListener('click', () => onClear());
    foot.append(clear);
  }
  if (onOpenFile) {
    const open = element('button', 'btn btn-secondary', t('home.open'));
    open.addEventListener('click', () => onOpenFile());
    foot.append(open);
  }
  host.replaceChildren(head, body, foot);
}
