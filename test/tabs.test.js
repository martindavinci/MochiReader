// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tabs } from '../app/core/tabs.js';

const paths = (t) => t.all().map((x) => x.path);

test('a new path creates a tab and activates it', () => {
  const t = new Tabs();
  const a = t.open('C:\\x\\a.md');
  const b = t.open('C:\\x\\b.md');
  assert.equal(a.created, true);
  assert.equal(b.created, true);
  assert.notEqual(a.id, b.id);
  assert.equal(t.active().id, b.id);
  assert.deepEqual(paths(t), ['C:\\x\\a.md', 'C:\\x\\b.md']);
});

test('same path twice activates the existing tab', () => {
  const t = new Tabs();
  const a = t.open('C:\\x\\A.md');
  t.open('C:\\x\\other.md');
  const b = t.open('c:\\x\\a.md');
  assert.equal(b.id, a.id);
  assert.equal(b.created, false);
  assert.equal(t.all().length, 2);
  assert.equal(t.active().id, a.id);
});

test('the comparison handles accents, spaces and commas', () => {
  const t = new Tabs();
  const a = t.open('Y:\\Report\\Lunaris Essentials_ È, vale.md');
  const b = t.open('y:\\report\\lunaris essentials_ è, vale.md');
  assert.equal(b.id, a.id);
  assert.equal(b.created, false);
});

for (const [name, spelling] of [
  ['forward slashes', 'C:/x/a.md'],
  ['mixed slashes', 'C:\\x/a.md'],
  ['a parent segment', 'C:\\x\\sub\\..\\a.md'],
  ['a current segment', 'C:\\x\\.\\a.md'],
  ['a doubled separator', 'C:\\x\\\\a.md'],
  ['the verbatim prefix of fs::canonicalize', '\\\\?\\C:\\x\\a.md'],
  ['a parent segment past the drive root', 'C:\\..\\x\\a.md'],
]) {
  test(`${name} name the file already open`, () => {
    const t = new Tabs();
    const a = t.open('C:\\x\\a.md');
    t.open('C:\\x\\other.md');
    const again = t.open(spelling);
    assert.equal(again.id, a.id);
    assert.equal(again.created, false);
    assert.equal(t.all().length, 2);
    assert.equal(t.active().id, a.id);
  });
}

for (const [name, first, second] of [
  ['the verbatim UNC prefix', '\\\\server\\share\\a.md', '\\\\?\\UNC\\server\\share\\a.md'],
  ['a parent segment on a network share', '\\\\server\\share\\a.md', '\\\\server\\share\\sub\\..\\a.md'],
  ['a parent segment past the share root', '\\\\server\\share\\a.md', '\\\\server\\share\\..\\a.md'],
  ['forward slashes on a network share', '\\\\server\\share\\a.md', '//server/share/a.md'],
]) {
  test(`${name} name the file already open`, () => {
    const t = new Tabs();
    const a = t.open(first);
    const again = t.open(second);
    assert.equal(again.id, a.id);
    assert.equal(again.created, false);
  });
}

for (const [name, first, second] of [
  ['the same name in two folders', 'C:\\x\\a.md', 'C:\\y\\a.md'],
  ['a parent segment that leaves the folder', 'C:\\x\\a.md', 'C:\\x\\..\\a.md'],
  ['the same folders on two drives', 'C:\\x\\a.md', 'D:\\x\\a.md'],
  ['the same path on two shares', '\\\\server\\one\\a.md', '\\\\server\\two\\a.md'],
  ['a drive path and a network path', 'C:\\x\\a.md', '\\\\C:\\x\\a.md'],
  ['a name made of dots', 'C:\\x\\..a.md', 'C:\\x\\a.md'],
]) {
  test(`${name} stay two tabs`, () => {
    const t = new Tabs();
    t.open(first);
    assert.equal(t.open(second).created, true);
    assert.equal(t.all().length, 2);
  });
}

test('a tab keeps the path it was first opened with', () => {
  const t = new Tabs();
  t.open('C:\\x\\a.md');
  t.open('C:/x/sub/../a.md');
  assert.deepEqual(paths(t), ['C:\\x\\a.md']);
});

test('many files opened in one burst each become a tab', () => {
  const t = new Tabs();
  const opened = ['a', 'b', 'c', 'd', 'e'].map((n) => t.open(`C:\\x\\${n}.md`));
  assert.equal(new Set(opened.map((o) => o.id)).size, 5);
  assert.equal(t.all().length, 5);
});

test('a closed tab can be opened again and gets a new id', () => {
  const t = new Tabs();
  const a = t.open('C:\\x\\a.md');
  t.close(a.id);
  const b = t.open('C:\\x\\a.md');
  assert.equal(b.created, true);
  assert.notEqual(b.id, a.id);
});

test('closing the active tab activates its neighbour', () => {
  const t = new Tabs();
  const a = t.open('C:\\x\\a.md');
  const b = t.open('C:\\x\\b.md');
  const c = t.open('C:\\x\\c.md');
  t.activate(b.id);
  t.close(b.id);
  assert.equal(t.active().id, c.id);
  t.close(c.id);
  assert.equal(t.active().id, a.id);
  t.close(a.id);
  assert.equal(t.active(), null);
  assert.deepEqual(t.all(), []);
});

test('closing another tab keeps the active one', () => {
  const t = new Tabs();
  const a = t.open('C:\\x\\a.md');
  const b = t.open('C:\\x\\b.md');
  t.close(a.id);
  assert.equal(t.active().id, b.id);
});

test('next cycles through the tabs and wraps', () => {
  const t = new Tabs();
  const a = t.open('C:\\x\\a.md');
  const b = t.open('C:\\x\\b.md');
  t.activate(a.id);
  assert.equal(t.next().id, b.id);
  assert.equal(t.next().id, a.id);
  assert.equal(t.active().id, a.id);
});

test('next with no tabs is null', () => {
  assert.equal(new Tabs().next(), null);
});

test('unknown ids change nothing', () => {
  const t = new Tabs();
  const a = t.open('C:\\x\\a.md');
  t.activate(999);
  t.close(999);
  assert.equal(t.active().id, a.id);
  assert.equal(t.all().length, 1);
});

test('the list from all cannot change the tabs', () => {
  const t = new Tabs();
  t.open('C:\\x\\a.md');
  t.all().pop();
  assert.equal(t.all().length, 1);
});
