// SPDX-License-Identifier: GPL-3.0-or-later
import { fileName } from '../core/paths.js';

const MIN_TABS_FOR_BAR = 2;
const CLOSE_MARK = '×';

/**
 * Draws the tab bar again. It only shows with two or more files.
 * @param {HTMLElement} bar
 * @param {{id: number, path: string}[]} tabs
 * @param {number|undefined} activeId
 * @param {{closeLabel: string, onActivate: (id: number) => void, onClose: (id: number) => void}} options
 */
export function renderTabBar(bar, tabs, activeId, { closeLabel, onActivate, onClose }) {
  const document = bar.ownerDocument;
  const button = (className, text, onClick) => {
    const element = document.createElement('button');
    element.className = className;
    element.textContent = text;
    element.addEventListener('click', onClick);
    return element;
  };

  bar.hidden = tabs.length < MIN_TABS_FOR_BAR;
  bar.replaceChildren(...tabs.map(({ id, path }) => {
    const tab = document.createElement('div');
    tab.className = id === activeId ? 'tab active' : 'tab';
    tab.setAttribute('title', path);
    const close = button('tab-close', CLOSE_MARK, () => onClose(id));
    close.setAttribute('aria-label', closeLabel);
    tab.append(button('tab-name', fileName(path), () => onActivate(id)), close);
    return tab;
  }));
}
