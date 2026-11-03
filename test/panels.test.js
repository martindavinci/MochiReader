// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createPanels, groupBookmarks, renderBookmarks, renderToc } from '../app/ui/panels.js';

const atLine = (line) => ({ kind: 'md', line, sentence: 0 });
const mark = (key, title, line, excerpt = `Brano ${line}`) => ({
  key,
  path: `C:\\x\\${title}`,
  title,
  position: atLine(line),
  excerpt,
  createdAt: line,
});
const BOOKMARK_LABELS = { title: 'Bookmarks', empty: 'None yet', remove: 'Remove' };
const TOC_LABELS = { title: 'Contents', empty: 'No contents' };

function page() {
  const { document, Event, HTMLElement } = parseHTML('<!doctype html><html><body><aside id="panel" hidden></aside></body></html>');
  const focused = [];
  HTMLElement.prototype.focus = function focus() {
    focused.push(this);
  };
  return { host: document.getElementById('panel'), focused, click: (element) => element.dispatchEvent(new Event('click')) };
}

function drawBookmarks(bookmarks) {
  const { host, click } = page();
  const opened = [];
  const removed = [];
  renderBookmarks(host, bookmarks, {
    labels: BOOKMARK_LABELS,
    dateOf: (ms) => `day ${ms}`,
    onOpen: (bookmark) => opened.push(bookmark),
    onRemove: (bookmark) => removed.push(bookmark),
  });
  return { host, click, opened, removed };
}

test('bookmarks group by document, in the order the documents first appear', () => {
  const groups = groupBookmarks([mark('k1', 'a.md', 1), mark('k2', 'b.md', 2), mark('k1', 'a.md', 3)]);
  assert.deepEqual(groups.map(({ title }) => title), ['a.md', 'b.md']);
  assert.deepEqual(groups[0].bookmarks.map(({ createdAt }) => createdAt), [1, 3]);
  assert.deepEqual(groups[1].bookmarks.map(({ createdAt }) => createdAt), [2]);
});

test('a book that moved stays one group, under the name it has now', () => {
  const moved = { ...mark('k1', 'nuovo.epub', 3), path: 'D:\\nuovo.epub' };
  const groups = groupBookmarks([mark('k1', 'vecchio.epub', 1), moved]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'nuovo.epub');
  assert.equal(groups[0].path, 'D:\\nuovo.epub');
});

test('with no bookmarks the panel says so', () => {
  const { host } = drawBookmarks([]);
  assert.ok(host.textContent.includes('Bookmarks'));
  assert.ok(host.textContent.includes('None yet'));
  assert.equal(host.querySelector('.bookmark'), null);
});

test('each bookmark shows its passage and date under its file', () => {
  const { host } = drawBookmarks([mark('k1', 'a.md', 1), mark('k2', 'b.md', 2)]);
  const groups = [...host.querySelectorAll('.bookmark-group')];
  assert.equal(groups.length, 2);
  assert.equal(groups[0].querySelector('.bookmark-file').textContent, 'a.md');
  assert.equal(groups[0].querySelector('.bookmark-file').getAttribute('title'), 'C:\\x\\a.md');
  assert.equal(groups[1].querySelector('.bookmark-excerpt').textContent, 'Brano 2');
  assert.equal(groups[1].querySelector('.bookmark-date').textContent, 'day 2');
});

test('a bookmark with no passage, as on an image, still has something to click', () => {
  const { host } = drawBookmarks([mark('k1', 'a.md', 1, '')]);
  assert.equal(host.querySelector('.bookmark-excerpt').textContent, 'a.md');
});

test('a click opens the bookmark, and its mark takes it away', () => {
  const bookmark = mark('k1', 'a.md', 1);
  const { host, click, opened, removed } = drawBookmarks([bookmark]);
  click(host.querySelector('.bookmark-open'));
  assert.ok(opened[0] === bookmark);
  assert.deepEqual(removed, []);
  click(host.querySelector('.bookmark-remove'));
  assert.ok(removed[0] === bookmark);
  assert.equal(host.querySelector('.bookmark-remove').getAttribute('aria-label'), 'Remove');
});

test('the contents list their entries and a click goes to the target', () => {
  const { host, click } = page();
  const gone = [];
  const entries = [{ label: 'Uno', target: atLine(1) }, { label: 'Due', target: atLine(9) }];
  renderToc(host, entries, { labels: TOC_LABELS, onGo: (target) => gone.push(target) });
  const items = [...host.querySelectorAll('.toc-entry')];
  assert.deepEqual(items.map((item) => item.textContent), ['Uno', 'Due']);
  click(items[1]);
  assert.deepEqual(gone, [atLine(9)]);
});

test('with no contents the panel says so', () => {
  const { host } = page();
  renderToc(host, [], { labels: TOC_LABELS, onGo: () => {} });
  assert.ok(host.textContent.includes('No contents'));
  assert.equal(host.querySelector('.toc-entry'), null);
});

test('a panel shows only while it is open and leaves nothing behind', () => {
  const { host } = page();
  const panels = createPanels(host);
  assert.equal(panels.current(), null);
  panels.show('toc');
  assert.equal(panels.current(), 'toc');
  assert.equal(host.hidden, false);
  host.append(host.ownerDocument.createElement('button'));
  panels.close();
  assert.equal(panels.current(), null);
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
});

test('a panel takes the focus: the first control, or itself with none', () => {
  const { host, focused } = page();
  const panels = createPanels(host);
  panels.show('toc');
  panels.focus();
  assert.ok(focused.at(-1) === host);
  const first = host.ownerDocument.createElement('button');
  host.append(first, host.ownerDocument.createElement('button'));
  panels.focus();
  assert.ok(focused.at(-1) === first);
});

test('showing a panel takes away what the last one drew', () => {
  const { host } = page();
  const panels = createPanels(host);
  panels.show('toc');
  host.append(host.ownerDocument.createElement('button'));
  panels.show('bookmarks');
  assert.equal(host.children.length, 0);
});
