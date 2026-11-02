// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { epubKey } from '../app/readers/epub-key.js';

const noHash = () => assert.fail('the hash must not be computed');

test('epub key uses identifier and title', async () => {
  assert.equal(await epubKey({ identifier: 'x', title: 'T' }, () => 'h'), 'epub:x|T');
});

test('epub key without identifier uses the hash', async () => {
  assert.equal(await epubKey({ title: 'T' }, async () => 'h'), 'sha256:h');
});

test('epub key does not hash a book that has an identifier', async () => {
  assert.equal(await epubKey({ identifier: 'x', title: 'T' }, noHash), 'epub:x|T');
});

test('epub key treats an empty identifier as missing', async () => {
  assert.equal(await epubKey({ identifier: '', title: 'T' }, async () => 'h'), 'sha256:h');
});

test('epub key uses the main title of a language map', async () => {
  const title = { it: 'Il titolo', ja: 'Daimei' };
  assert.equal(await epubKey({ identifier: 'x', title }, noHash), 'epub:x|Il titolo');
});

test('epub key accepts a book without a title', async () => {
  assert.equal(await epubKey({ identifier: 'x', title: null }, noHash), 'epub:x|');
});

test('epub key tells apart volumes that share an identifier and a title', async () => {
  const metadata = { identifier: 'https://example.test/novel', title: 'Shadow Slave' };
  assert.equal(
    await epubKey(metadata, noHash, 99),
    'epub:https://example.test/novel|Shadow Slave|99',
  );
  assert.equal(
    await epubKey(metadata, noHash, 259),
    'epub:https://example.test/novel|Shadow Slave|259',
  );
});

test('epub key without identifier ignores the section count', async () => {
  assert.equal(await epubKey({ title: 'T' }, async () => 'h', 99), 'sha256:h');
});
