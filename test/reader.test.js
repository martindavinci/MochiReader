// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../app/readers/reader.js', import.meta.url), 'utf8');

/** Maps each `@property {type} name` of the Reader typedef to its type text. */
function readerProperties() {
  const block = source.split('@typedef {Object} Reader')[1].split('*/')[0];
  const properties = new Map();
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/@property \{(.+)\} (\w+)/);
    if (match) properties.set(match[2], match[1]);
  }
  return properties;
}

test('the contract declares how input reaches the shell', () => {
  assert.equal(
    readerProperties().get('onInput'),
    '(cb: (e: KeyboardEvent|MouseEvent) => void) => void',
  );
});

test('the contract declares how theme and text size reach the book', () => {
  assert.equal(readerProperties().get('setStyle'), '(css: string) => void');
});

test('the contract declares how the end of reading is detected', () => {
  assert.equal(readerProperties().get('nextSpeechSection'), '() => Promise<boolean>');
});

test('the contract keeps its original members', () => {
  const properties = readerProperties();
  for (const name of ['kind', 'lang', 'toc', 'position', 'goTo', 'speechRoots', 'onMove', 'excerpt', 'destroy']) {
    assert.ok(properties.has(name), `missing ${name}`);
  }
});
