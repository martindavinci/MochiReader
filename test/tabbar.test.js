// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderTabBar } from '../app/ui/tabbar.js';

const TABS = [{ id: 1, path: 'C:\\x\\a.md' }, { id: 2, path: 'C:\\x\\b è, c.epub' }];

function setup(tabs, activeId = 1) {
  const { document, Event } = parseHTML('<!doctype html><html><body><nav id="bar"></nav></body></html>');
  const bar = document.getElementById('bar');
  const calls = [];
  renderTabBar(bar, tabs, activeId, {
    closeLabel: 'Close tab',
    onActivate: (id) => calls.push(['activate', id]),
    onClose: (id) => calls.push(['close', id]),
  });
  return { bar, calls, Event };
}

test('the tab of the file in front is the one stop for the Tab key, and the one selected', () => {
  const { bar } = setup(TABS, 2);
  const names = [...bar.querySelectorAll('.tab-name')];
  assert.deepEqual(names.map((name) => name.getAttribute('tabindex')), ['-1', '0']);
  assert.deepEqual(names.map((name) => name.getAttribute('aria-selected')), ['false', 'true']);
  assert.ok(names.every((name) => name.getAttribute('role') === 'tab'));
});

test('Delete closes the tab that has the focus, and the arrows go along them', () => {
  const { bar, calls, Event } = setup(TABS);
  const names = [...bar.querySelectorAll('.tab-name')];
  let focused = null;
  names[1].focus = () => {
    focused = names[1];
  };
  const press = (name, key) => {
    const event = new Event('keydown');
    event.key = key;
    name.dispatchEvent(event);
  };
  press(names[0], 'ArrowRight');
  assert.ok(focused === names[1]);
  press(names[1], 'Delete');
  assert.deepEqual(calls, [['close', 2]]);
});

test('each tab shows its file name, with the active one marked', () => {
  const { bar } = setup(TABS, 2);
  const tabs = [...bar.querySelectorAll('.tab')];
  assert.deepEqual(tabs.map((tab) => tab.querySelector('.tab-name').textContent), ['a.md', 'b è, c.epub']);
  assert.deepEqual(tabs.map((tab) => tab.classList.contains('active')), [false, true]);
  assert.equal(tabs[1].getAttribute('title'), 'C:\\x\\b è, c.epub');
});

test('a click activates, and the close button closes without activating', () => {
  const { bar, calls, Event } = setup(TABS);
  const [, second] = bar.querySelectorAll('.tab');
  second.querySelector('.tab-name').dispatchEvent(new Event('click', { bubbles: true }));
  second.querySelector('.tab-close').dispatchEvent(new Event('click', { bubbles: true }));
  assert.deepEqual(calls, [['activate', 2], ['close', 2]]);
});

test('the close button has a translated name', () => {
  const { bar } = setup(TABS);
  assert.equal(bar.querySelector('.tab-close').getAttribute('aria-label'), 'Close tab');
});
