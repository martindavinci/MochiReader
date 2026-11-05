// SPDX-License-Identifier: GPL-3.0-or-later
import { mascot } from './home.js';
import { icon } from './icons.js';
import { elementIn } from './panel-parts.js';

const MASCOT_PX = 80;
const GLYPH_PX = 22;

/**
 * A page in place of the text that says what happened and what can be done now. Always in the face of the interface.
 * @param {HTMLElement} host Where it goes: what it makes is the caller's to place.
 * @param {{glyph?: string, title: string, text: string, path?: string,
 *   actions?: {label: string, primary?: boolean, run: () => void}[]}} state Without a glyph, the mascot.
 * @returns {HTMLElement}
 */
export function statePage(host, { glyph, title, text, path, actions = [] }) {
  const doc = host.ownerDocument;
  const element = elementIn(host);
  const body = element('div', 'state-body');
  if (glyph) {
    const mark = element('div', 'state-icon');
    mark.append(icon(doc, glyph, GLYPH_PX));
    body.append(mark);
  } else {
    body.append(mascot(doc, MASCOT_PX));
  }
  body.append(element('h1', 'state-title', title), element('p', 'state-text', text));
  if (path) {
    const shown = element('div', 'state-path', path);
    shown.setAttribute('title', path);
    body.append(shown);
  }
  if (actions.length > 0) {
    const row = element('div', 'state-actions');
    row.append(...actions.map(({ label, primary, run }) => {
      const button = element('button', `btn ${primary ? 'btn-neutral' : 'btn-secondary'}`, label);
      button.addEventListener('click', () => run());
      return button;
    }));
    body.append(row);
  }
  const page = element('div', 'state');
  page.append(body);
  return page;
}

/**
 * @param {HTMLElement} host
 * @param {string} text
 * @returns {HTMLElement} What shows until a slow file has opened.
 */
export function loadingPage(host, text) {
  const element = elementIn(host);
  const body = element('div', 'loading-body');
  body.append(element('div', undefined, text), element('div', 'loading-bar'));
  const page = element('div', 'loading');
  page.setAttribute('role', 'status');
  page.append(body);
  return page;
}
