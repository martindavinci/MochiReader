// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderRecents } from '../app/ui/recents.js';

const LABELS = { hint: 'Hint', title: 'Recent', empty: 'None yet', missing: 'Not found', remove: 'Remove' };
const recent = (path, exists = true) => ({ path, kind: 'markdown', title: path.split('\\').at(-1), openedAt: 1, exists });

function draw(recents) {
  const { document, Event } = parseHTML('<!doctype html><html><body><section id="home"></section></body></html>');
  const host = document.getElementById('home');
  const opened = [];
  const removed = [];
  renderRecents(host, recents, {
    labels: LABELS,
    onOpen: (path) => opened.push(path),
    onRemove: (path) => removed.push(path),
  });
  const click = (element) => element.dispatchEvent(new Event('click'));
  return { host, opened, removed, click };
}

test('with no recent files it says so and still shows how to open one', () => {
  const { host } = draw([]);
  assert.ok(host.textContent.includes('Hint'));
  assert.ok(host.textContent.includes('None yet'));
  assert.equal(host.querySelector('.recents'), null);
});

test('the recents are listed in the order given, with their title and their folder', () => {
  const { host } = draw([recent('C:\\x\\a b.md'), recent('Y:\\y\\c.epub')]);
  const items = [...host.querySelectorAll('.recent')];
  assert.equal(items.length, 2);
  assert.equal(items[0].querySelector('.recent-name').textContent, 'a b.md');
  assert.equal(items[0].querySelector('.recent-folder').textContent, 'C:\\x');
  assert.equal(items[0].querySelector('.recent-open').getAttribute('title'), 'C:\\x\\a b.md');
  assert.equal(items[1].querySelector('.recent-name').textContent, 'c.epub');
  assert.ok(!host.textContent.includes('None yet'));
});

test('a file that exists opens, and has no command to take it away', () => {
  const { host, opened, click } = draw([recent('C:\\x\\a.md')]);
  assert.ok(!host.querySelector('.recent').classList.contains('missing'));
  assert.equal(host.querySelector('.recent-remove'), null);
  assert.ok(!host.textContent.includes('Not found'));
  click(host.querySelector('.recent-open'));
  assert.deepEqual(opened, ['C:\\x\\a.md']);
});

test('a missing file is marked, can still be tried, and can be taken away', () => {
  const { host, opened, removed, click } = draw([recent('C:\\x\\a.md', false)]);
  assert.ok(host.querySelector('.recent').classList.contains('missing'));
  assert.ok(host.textContent.includes('Not found'));
  const remove = host.querySelector('.recent-remove');
  assert.equal(remove.getAttribute('aria-label'), 'Remove');
  click(remove);
  assert.deepEqual(removed, ['C:\\x\\a.md']);
  assert.deepEqual(opened, []);
  click(host.querySelector('.recent-open'));
  assert.deepEqual(opened, ['C:\\x\\a.md']);
});

test('text from a file name stays text', () => {
  const { host } = draw([{ ...recent('C:\\x\\a.md'), title: '<img src=x>' }]);
  assert.equal(host.querySelector('img'), null);
  assert.equal(host.querySelector('.recent-name').textContent, '<img src=x>');
});

test('drawing again replaces the list', () => {
  const { host } = draw([recent('C:\\x\\a.md')]);
  renderRecents(host, [], { labels: LABELS, onOpen: () => {}, onRemove: () => {} });
  assert.equal(host.querySelectorAll('.recent').length, 0);
  assert.equal(host.querySelectorAll('h1').length, 1);
});

test('with no hint it shows only the list, as in the panel over a file', () => {
  const { document } = parseHTML('<!doctype html><html><body><aside id="panel"></aside></body></html>');
  const host = document.getElementById('panel');
  const { hint, ...labels } = LABELS;
  renderRecents(host, [], { labels, onOpen: () => {}, onRemove: () => {} });
  assert.equal(host.querySelector('.home-hint'), null);
  assert.ok(host.textContent.includes('Recent'));
});
