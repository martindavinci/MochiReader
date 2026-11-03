// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import {
  createClickShield, createPanels, createRowGuard, groupBookmarks, keepFocus, renderBookmarks, renderToc,
} from '../app/ui/panels.js';

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
  HTMLElement.prototype.focus = function focus(options) {
    focused.push(this);
    this.focusedWith = options;
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

test('two volumes of one title are told apart by the name of their file', () => {
  const volume = (key, name) => ({ ...mark(key, 'Shadow Slave', 1), path: `C:\\books\\${name}` });
  const { host } = drawBookmarks([volume('k1', 'slave-vol1.epub'), volume('k2', 'slave-vol2.epub')]);
  const [first, second] = host.querySelectorAll('.bookmark-file');
  assert.ok(first.textContent.includes('Shadow Slave'));
  assert.equal(first.querySelector('.bookmark-file-name').textContent, 'slave-vol1.epub');
  assert.equal(second.querySelector('.bookmark-file-name').textContent, 'slave-vol2.epub');
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

test('the mark says which row it was pressed in', () => {
  const { host, click } = page();
  const rows = [];
  renderBookmarks(host, [mark('k1', 'a.md', 1), mark('k1', 'a.md', 2)], {
    labels: BOOKMARK_LABELS,
    dateOf: String,
    onOpen: () => {},
    onRemove: (bookmark, row) => rows.push(row),
  });
  click(host.querySelectorAll('.bookmark-remove')[1]);
  assert.ok(rows[0] === host.querySelectorAll('.bookmark')[1]);
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

function listOf(host, count) {
  const document = host.ownerDocument;
  const rows = Array.from({ length: count }, () => {
    const row = document.createElement('li');
    row.append(document.createElement('button'), document.createElement('button'));
    return row;
  });
  host.replaceChildren(...rows);
  return rows;
}

test('a row that left hands the focus to the row now in its place, and nothing scrolls for it', () => {
  const { host, focused } = page();
  const [, second] = listOf(host, 3);
  const refocus = keepFocus(host, second);
  const [, now] = listOf(host, 2);
  refocus();
  assert.ok(focused.at(-1) === now.querySelector('button'));
  assert.deepEqual(focused.at(-1).focusedWith, { preventScroll: true });
});

test('the last row that left hands the focus to the one before it', () => {
  const { host, focused } = page();
  const rows = listOf(host, 3);
  const refocus = keepFocus(host, rows[2]);
  const now = listOf(host, 2);
  refocus();
  assert.ok(focused.at(-1) === now[1].querySelector('button'));
});

test('the only row that left hands the focus to the panel', () => {
  const { host, focused } = page();
  const [only] = listOf(host, 1);
  const refocus = keepFocus(host, only);
  host.replaceChildren();
  refocus();
  assert.ok(focused.at(-1) === host);
});

test('a list drawn again keeps the focus on the row that had it', () => {
  const { host, focused } = page();
  const rows = listOf(host, 3);
  host.ownerDocument.activeElement = rows[1].querySelectorAll('button')[1];
  const refocus = keepFocus(host);
  const now = listOf(host, 3);
  refocus();
  assert.ok(focused.at(-1) === now[1].querySelector('button'));
});

test('a list drawn again leaves the focus alone if no row had it', () => {
  const { host, focused } = page();
  listOf(host, 2);
  const refocus = keepFocus(host);
  listOf(host, 2);
  refocus();
  assert.deepEqual(focused, []);
});

const SETTLE_MS = 20;
const untilSettled = () => new Promise((resolve) => {
  setTimeout(resolve, SETTLE_MS * 3);
});

test('after a removal nothing in the list reacts until a double click would be over', async () => {
  const guard = createRowGuard(SETTLE_MS);
  const did = [];
  const remove = guard.remove(async (what) => did.push(`remove ${what}`));
  const open = guard.open((what) => did.push(`open ${what}`));

  open('a');
  const removing = remove('b');
  remove('c');
  open('d');
  assert.deepEqual(did, ['open a', 'remove b']);

  await removing;
  open('e');
  await remove('f');
  assert.deepEqual(did, ['open a', 'remove b', 'open e', 'remove f']);
});

test('a second click while the removal is still under way cannot undo it', async () => {
  const guard = createRowGuard(SETTLE_MS);
  let answer;
  let calls = 0;
  const remove = guard.remove(() => {
    calls += 1;
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const first = remove();
  remove();
  await untilSettled();
  remove();
  assert.equal(calls, 1, 'the time counts from the end of the removal');
  answer();
  remove();
  assert.equal(calls, 1);
  await first;
  remove();
  assert.equal(calls, 2);
  answer();
});

test('a removal that fails does not leave the list deaf', async () => {
  const guard = createRowGuard(SETTLE_MS);
  let calls = 0;
  const remove = guard.remove(async () => {
    calls += 1;
    throw new Error('refused');
  });
  await assert.rejects(remove());
  await remove().catch(() => {});
  assert.equal(calls, 2);
});

test('a shield over the window comes up for as long as a double click takes, and comes up once', async () => {
  const { host } = page();
  const { body } = host.ownerDocument;
  const shield = createClickShield(body, SETTLE_MS);
  const element = body.querySelector('.click-shield');
  assert.equal(element.hidden, true);
  shield.raise();
  shield.raise();
  assert.equal(body.querySelectorAll('.click-shield').length, 1);
  assert.equal(element.hidden, false);
  await untilSettled();
  assert.equal(element.hidden, true);
});

test('pressing on the shield leaves the focus where it is, or the keys would stop reaching the text', () => {
  const { host } = page();
  const { body, defaultView } = host.ownerDocument;
  createClickShield(body, SETTLE_MS).raise();
  const press = new (defaultView.Event)('mousedown', { cancelable: true, bubbles: true });
  body.querySelector('.click-shield').dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);
});
