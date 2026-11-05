// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../core/i18n.js';
import { icon, named } from './icons.js';
import { elementIn } from './panel-parts.js';
import { recentList } from './recents.js';

// Already in the app, and asked for only here: opening a file never waits for it.
const MASCOT = 'assets/mochi-256.png';
const BRAND_PX = 24;
const WELCOME_PX = 112;
const OPEN_KEY = 'Ctrl+O';
// The three keys worth knowing, on the first page.
const KEYS = [['F5', 'home.keyRead'], ['Ctrl+D', 'home.keyBookmark'], ['← →', 'home.keyPage']];

/**
 * @param {Document} doc
 * @param {number} size
 * @returns {HTMLImageElement} Decorative: nothing is lost without it.
 */
export function mascot(doc, size) {
  const image = doc.createElement('img');
  image.setAttribute('src', MASCOT);
  image.setAttribute('alt', '');
  image.setAttribute('width', String(size));
  image.setAttribute('height', String(size));
  image.setAttribute('decoding', 'async');
  return image;
}

/**
 * The page with no file open: a welcome until there are recent files, then those files.
 * @param {HTMLElement} host
 * @param {object[]} recents As the state keeps them, the newest first.
 * @param {{labels: {title: string, missing: string, remove: string}, onOpen: (path: string) => void,
 *   onRemove: (path: string, row: HTMLElement) => void, onOpenFile: () => void, onBookmarks: (opener: Element) => void,
 *   onOptions: (opener: Element) => void, onClear: () => void}} options
 */
export function renderHome(host, recents, { labels, onOpen, onRemove, onOpenFile, onBookmarks, onOptions, onClear }) {
  const doc = host.ownerDocument;
  const element = elementIn(host);

  const tool = (glyph, text, keys, action) => {
    const button = element('button', 'tool');
    named(button, text, keys);
    button.append(icon(doc, glyph), element('span', 'label', text));
    button.addEventListener('click', () => action(button));
    return button;
  };

  const openButton = (className) => {
    const button = element('button', `btn btn-primary ${className}`);
    named(button, t('home.open'), OPEN_KEY);
    button.append(icon(doc, 'folder'), element('span', undefined, t('home.open')), element('span', 'kbd', OPEN_KEY));
    button.addEventListener('click', () => onOpenFile());
    return button;
  };

  const head = element('header', 'home-head');
  const brand = element('div', 'home-brand');
  brand.append(mascot(doc, BRAND_PX), element('span', undefined, 'MochiReader'));
  const tools = element('div', 'home-tools');
  tools.append(
    tool('bookmark', t('tools.bookmarks'), 'Ctrl+B', onBookmarks),
    tool('sliders', t('tools.options'), 'Ctrl+,', onOptions),
  );
  head.append(brand, tools);

  const welcome = () => {
    const page = element('div', 'welcome');
    const body = element('div', 'welcome-body');
    const keys = element('div', 'keys');
    keys.append(...KEYS.map(([key, what]) => {
      const row = element('span');
      row.append(element('span', 'kbd', key), element('span', undefined, t(what)));
      return row;
    }));
    body.append(
      mascot(doc, WELCOME_PX),
      element('h1', undefined, t('home.welcome')),
      element('p', undefined, t('home.intro')),
      openButton('btn-large'),
      element('p', 'welcome-drop', t('home.drop')),
      keys,
    );
    page.append(body);
    return page;
  };

  const list = () => {
    const page = element('div', 'home-column');
    const title = element('div', 'home-title');
    const words = element('div');
    words.append(element('h1', 'recents-title', labels.title), element('p', 'home-hint', t('home.hint')));
    title.append(words, openButton('home-open'));
    const clear = element('button', 'link-button recents-clear', t('recents.clear'));
    clear.addEventListener('click', () => onClear());
    page.append(title, recentList(host, recents, { labels, onOpen, onRemove }), clear);
    return page;
  };

  host.replaceChildren(head, recents.length > 0 ? list() : welcome());
}
