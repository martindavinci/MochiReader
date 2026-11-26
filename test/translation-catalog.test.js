// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCatalog } from '../tools/translation-catalog.mjs';

const CDN = 'https://firefox-settings-attachments.cdn.mozilla.net/';
const { data } = JSON.parse(readFileSync(new URL('./fixtures/rs-translations-models.json', import.meta.url), 'utf8'));
const catalog = buildCatalog(data, { cdn: CDN });
const pair = (id) => catalog.pairs.find(({ from, to }) => `${from}-${to}` === id);

test('buildCatalog keeps the newest version of each pair', () => {
  assert.equal(pair('en-fr').version, '2.0');
  assert.equal(pair('en-it').version, '2.1');
});

test("a file's url is the CDN plus its attachment location, with its hash and size", () => {
  const { model } = pair('en-it').files;
  assert.match(model.url, /^https:\/\/firefox-settings-attachments\.cdn\.mozilla\.net\/main-workspace\/translations-models\/.+\.bin$/);
  assert.equal(model.sha256, '248f47568788ecc351da7e5e07064d4153b4f71e011364ae2c931ffeec4d1cc2');
  assert.equal(model.bytes, 31561787);
});

test('a pair missing its model or lex file is left out', () => {
  assert.equal(pair('en-ca'), undefined);
});

test('a pair with separate vocabularies keeps both and has no vocab', () => {
  const { files } = pair('en-ja');
  assert.ok(files.srcvocab && files.trgvocab);
  assert.equal(files.vocab, undefined);
});

test('versions only some Firefox channels get, and pre-releases, are left out', () => {
  assert.equal(pair('en-ja').version, '2.3');
  assert.equal(pair('en-ru'), undefined);
  assert.equal(pair('en-nb'), undefined);
});

test('files of kinds the engine does not read are left out', () => {
  assert.deepEqual(Object.keys(pair('en-it').files).sort(), ['lex', 'model', 'vocab']);
});

test('pairs are sorted and the catalog has a version', () => {
  assert.equal(catalog.version, 1);
  const ids = catalog.pairs.map(({ from, to }) => `${from}-${to}`);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(ids, ['en-fr', 'en-it', 'en-ja', 'it-en']);
});
