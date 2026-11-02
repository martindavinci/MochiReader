// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkAction } from '../app/core/links.js';

const token = (path) => Buffer.from(path, 'utf8').toString('base64url');

test('a document link opens a tab on the path it names', () => {
  const path = 'C:\\x\\Lunaris Essentials_ è, vale.md';
  assert.deepEqual(linkAction(`mochi-doc:${token(path)}`), { type: 'doc', path });
});

test('a damaged document link does nothing', () => {
  assert.equal(linkAction('mochi-doc:'), null);
  assert.equal(linkAction('mochi-doc:not base64!'), null);
  assert.equal(linkAction(`mochi-doc:${Buffer.from([0xff, 0xfe]).toString('base64url')}`), null);
});

test('web and mail links go to the system', () => {
  for (const url of ['http://e.org/x', 'https://e.org', 'HTTPS://E.ORG', 'mailto:a@e.org']) {
    assert.deepEqual(linkAction(url), { type: 'external', url });
  }
});

test('an anchor scrolls to its decoded id', () => {
  assert.deepEqual(linkAction('#fn-1'), { type: 'anchor', id: 'fn-1' });
  assert.deepEqual(linkAction('#caff%C3%A8'), { type: 'anchor', id: 'caffè' });
  assert.deepEqual(linkAction('#100%'), { type: 'anchor', id: '100%' });
});

test('everything else is ignored', () => {
  for (const href of ['javascript:x()', 'file:///C:/x.md', 'ftp://e.org', 'a/b.md', '#', '', null, undefined]) {
    assert.equal(linkAction(href), null, String(href));
  }
});
