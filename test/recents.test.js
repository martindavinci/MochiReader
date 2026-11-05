// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderRecents } from '../app/ui/recents.js';

const LABELS = { title: 'Recent', empty: 'None yet', missing: 'Not found', remove: 'Remove' };
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

test('with no recent files it says so', () => {
  const { host } = draw([]);
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

test('a title that is not the name of the file comes with the name, so two volumes of one series differ', () => {
  const volume = (name) => ({ ...recent(`C:\\books\\${name}`), kind: 'epub', title: 'Shadow Slave' });
  const { host } = draw([volume('slave-vol1.epub'), volume('slave-vol2.epub')]);
  const items = [...host.querySelectorAll('.recent')];
  assert.deepEqual(items.map((item) => item.querySelector('.recent-file').textContent), ['slave-vol1.epub', 'slave-vol2.epub']);
  assert.equal(items[0].querySelector('.recent-name').textContent, 'Shadow Slave');
  assert.equal(items[0].querySelector('.recent-folder').textContent, 'C:\\books');
  assert.notEqual(items[0].textContent, items[1].textContent);
});

test('a title that is the name of the file does not say it twice', () => {
  const { host } = draw([recent('C:\\x\\a.md')]);
  assert.equal(host.querySelector('.recent-file'), null);
});

test('a file that exists opens, and can be taken away too', () => {
  const { host, opened, removed, click } = draw([recent('C:\\x\\a.md')]);
  assert.ok(!host.querySelector('.recent').classList.contains('missing'));
  assert.ok(!host.textContent.includes('Not found'));
  click(host.querySelector('.recent-open'));
  assert.deepEqual(opened, ['C:\\x\\a.md']);
  click(host.querySelector('.recent-remove'));
  assert.deepEqual(removed, ['C:\\x\\a.md']);
});

test('a book says which chapter it was left at', () => {
  const { host } = draw([{ ...recent('C:\\x\\a.epub'), kind: 'epub', chapter: 2, chapters: 3 }]);
  assert.ok(host.querySelector('.recent-progress').textContent.includes('2'));
  assert.equal(host.querySelector('.recent-open').getAttribute('data-kind'), 'epub');
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

