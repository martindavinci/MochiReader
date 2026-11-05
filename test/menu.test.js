// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { openMenu } from '../app/ui/menu.js';

function setup() {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  const focused = [];
  window.HTMLElement.prototype.focus = function focus() {
    focused.push(this);
  };
  return { document, window, focused };
}

const item = (label, run = () => {}, more = {}) => ({ label, run, ...more });

test('a menu opens where it is told, with the focus on its first item, and choosing closes it', () => {
  const { document, window, focused } = setup();
  let chosen = 0;
  openMenu(document, { x: 40, y: 60 }, [item('Read', () => {
    chosen += 1;
  })]);
  const menu = document.querySelector('.text-menu');
  assert.equal(menu.style.left, '40px');
  assert.equal(menu.style.top, '60px');
  assert.ok(focused.at(-1) === menu.querySelector('button'));
  menu.querySelector('button').dispatchEvent(new window.Event('click'));
  assert.equal(chosen, 1);
  assert.equal(document.querySelector('.text-menu'), null);
});

test('one menu at a time, and leaving it closes it without choosing', () => {
  const { document, window } = setup();
  let chosen = 0;
  openMenu(document, { x: 1, y: 2 }, [item('First', () => {
    chosen += 1;
  })]);
  openMenu(document, { x: 3, y: 4 }, [item('Second')]);
  assert.equal(document.querySelectorAll('.text-menu').length, 1);
  document.querySelector('.text-menu').dispatchEvent(new window.Event('focusout'));
  assert.equal(document.querySelector('.text-menu'), null);
  assert.equal(chosen, 0);
});

// A browser takes the focus away during remove(), so the menu hears of leaving while it is leaving, and refuses the second one.
test('choosing is not lost to the menu leaving', () => {
  const { document, window } = setup();
  let chosen = 0;
  openMenu(document, { x: 1, y: 2 }, [item('Read', () => {
    chosen += 1;
  })]);
  const menu = document.querySelector('.text-menu');
  const remove = menu.remove.bind(menu);
  let leaving = false;
  menu.remove = () => {
    if (leaving) throw new Error('the node to be removed is no longer a child of this node');
    leaving = true;
    menu.dispatchEvent(new window.Event('focusout'));
    remove();
  };
  menu.querySelector('button').dispatchEvent(new window.Event('click'));
  assert.equal(chosen, 1);
});

test('the arrows walk the items that can be chosen, and the focus starts on the first of them', () => {
  const { document, window, focused } = setup();
  openMenu(document, { x: 1, y: 2 }, [
    item('Off', () => {}, { disabled: true }),
    item('One'),
    item('Also off', () => {}, { disabled: true }),
    item('Two'),
  ]);
  const buttons = [...document.querySelectorAll('.text-menu button')];
  assert.ok(focused.at(-1) === buttons[1]);
  const press = new window.Event('keydown', { bubbles: true, cancelable: true });
  press.key = 'ArrowDown';
  buttons[1].dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);
  assert.ok(focused.at(-1) === buttons[3]);
});

test('an item names its key, and one that cannot be chosen says so', () => {
  const { document } = setup();
  openMenu(document, { x: 1, y: 2 }, [item('Copy', () => {}, { keys: 'Ctrl+C', disabled: true, glyph: 'copy' })]);
  const button = document.querySelector('.text-menu button');
  assert.equal(button.querySelector('.menu-keys').textContent, 'Ctrl+C');
  assert.ok(button.hasAttribute('disabled'));
  assert.ok(button.querySelector('svg'));
});
