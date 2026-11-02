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

test('the bar shows only with two or more files', () => {
  assert.equal(setup([]).bar.hidden, true);
  assert.equal(setup(TABS.slice(0, 1)).bar.hidden, true);
  assert.equal(setup(TABS).bar.hidden, false);
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
