// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../core/i18n.js';
import { icon, named } from './icons.js';

/** @returns {(tag: string, className?: string, text?: string) => HTMLElement} What makes elements for `host`. */
export const elementIn = (host) => (tag, className, text) => {
  const made = host.ownerDocument.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
};

/**
 * What every panel has at the top. Its close button is answered by `createPanels`.
 * @param {HTMLElement} host
 * @param {{glyph: string, title: string, count?: string|number}} head
 * @returns {HTMLElement}
 */
export function panelHead(host, { glyph, title, count }) {
  const element = elementIn(host);
  const head = element('header', 'panel-head');
  const name = element('h1', 'panel-title', title);
  const close = element('button', 'panel-close');
  named(close, t('panel.close'), 'Esc');
  close.append(icon(host.ownerDocument, 'close', 12));
  head.append(icon(host.ownerDocument, glyph), name);
  if (count !== undefined && count !== '') head.append(element('span', 'count', String(count)));
  head.append(close);
  return head;
}

/** @returns {HTMLElement} What a panel with nothing in it says, and how to get something in it. */
export function panelEmpty(host, { glyph, title, text }) {
  const element = elementIn(host);
  const empty = element('div', 'panel-empty');
  const mark = element('div', 'state-icon');
  mark.append(icon(host.ownerDocument, glyph, 22));
  empty.append(mark, element('p', 'panel-empty-title', title), element('p', 'panel-empty-text', text));
  return empty;
}

/** @returns {HTMLElement} The hints, or the action, at the foot of a panel. */
export function panelFoot(host, ...parts) {
  const foot = elementIn(host)('footer', 'panel-foot');
  foot.append(...parts);
  return foot;
}
