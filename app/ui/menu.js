// SPDX-License-Identifier: GPL-3.0-or-later
// Loads with the first menu, never with the first frame.
import { icon } from './icons.js';

const MENU_CLASS = 'text-menu';
const STEP_KEYS = { ArrowDown: 1, ArrowUp: -1 };
const EDGE_PX = 8;

/**
 * A short menu. It leaves with the focus, which a click anywhere takes, even in the frame of a book where no event of
 * the page can see it.
 * @param {Document} page
 * @param {{x: number, y: number, fromRight?: boolean}} at In the window of `page`. `fromRight`: `x` is its right edge.
 * @param {{label: string, glyph?: string, keys?: string, disabled?: boolean, run: () => void}[]} items
 * @returns {HTMLElement}
 */
export function openMenu(page, { x, y, fromRight = false }, items) {
  page.querySelector(`.${MENU_CLASS}`)?.remove();
  const menu = page.createElement('div');
  menu.className = MENU_CLASS;
  menu.setAttribute('role', 'menu');
  const window = page.defaultView;

  const leave = () => {
    menu.removeEventListener('focusout', onFocusOut);
    menu.remove();
  };
  // Removing it takes the focus from it, which would ask for the same again while it is leaving.
  function onFocusOut({ relatedTarget }) {
    if (!relatedTarget || !menu.contains(relatedTarget)) leave();
  }

  const buttons = items.map(({ label, glyph, keys, disabled, run }) => {
    const button = page.createElement('button');
    button.setAttribute('role', 'menuitem');
    if (disabled) button.setAttribute('disabled', '');
    if (glyph) button.append(icon(page, glyph));
    const name = page.createElement('span');
    name.className = 'menu-label';
    name.textContent = label;
    button.append(name);
    if (keys) {
      const hint = page.createElement('span');
      hint.className = 'menu-keys';
      hint.textContent = keys;
      button.append(hint);
    }
    button.addEventListener('click', () => {
      leave();
      run();
    });
    return button;
  });
  menu.addEventListener('keydown', (event) => {
    const step = STEP_KEYS[event.key];
    if (!step) return;
    event.preventDefault();
    const usable = buttons.filter((button) => !button.hasAttribute('disabled'));
    usable[usable.indexOf(event.target) + step]?.focus();
  });
  menu.addEventListener('focusout', onFocusOut);
  menu.append(...buttons);
  page.body.append(menu);

  // Laid out first, because it must stay on the window whatever its width in this language.
  const box = menu.getBoundingClientRect();
  const left = fromRight ? x - box.width : x;
  menu.style.left = `${Math.max(EDGE_PX, Math.min(left, (window?.innerWidth ?? Infinity) - box.width - EDGE_PX))}px`;
  menu.style.top = `${Math.max(EDGE_PX, Math.min(y, (window?.innerHeight ?? Infinity) - box.height - EDGE_PX))}px`;
  buttons.find((button) => !button.hasAttribute('disabled'))?.focus();
  return menu;
}
