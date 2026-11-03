// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIXTURES } from '../tools/make-fixture-epub.mjs';

const FIXTURES_DIR = new URL('fixtures/', import.meta.url);
const ENCRYPTION_FILE = 'META-INF/encryption.xml';
const XML_ENCRYPTION_NAMESPACE = 'xmlns="http://www.w3.org/2001/04/xmlenc#"';
const FONT_OBFUSCATION_ALGORITHMS = [
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
];
const ZIP_END_OF_DIRECTORY_SIZE = 22;
const ZIP_CENTRAL_HEADER_SIZE = 46;
const ZIP_LOCAL_HEADER_SIZE = 30;

// Reads a ZIP whose entries are all stored, as the generator writes them.
function storedEntries(bytes) {
  const end = bytes.length - ZIP_END_OF_DIRECTORY_SIZE;
  const entries = new Map();
  let position = bytes.readUInt32LE(end + 16);
  for (let left = bytes.readUInt16LE(end + 10); left > 0; left--) {
    const size = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const local = bytes.readUInt32LE(position + 42);
    const nameStart = position + ZIP_CENTRAL_HEADER_SIZE;
    const name = bytes.toString('utf8', nameStart, nameStart + nameLength);
    const dataStart = local + ZIP_LOCAL_HEADER_SIZE + bytes.readUInt16LE(local + 26);
    entries.set(name, bytes.toString('utf8', dataStart, dataStart + size));
    position = nameStart + nameLength;
  }
  return entries;
}

const committed = (name) => readFileSync(new URL(name, FIXTURES_DIR));

test('every fixture of the plan is generated', () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(), [
    'corrupt.epub',
    'drm.epub',
    'fixed-spread.epub',
    'fixed.epub',
    'no-id.epub',
    'obfuscated-font.epub',
    'plain.epub',
    'scripted.epub',
    'self-script.epub',
  ]);
});

test('the committed fixtures are what the generator writes', () => {
  for (const [name, bytes] of Object.entries(FIXTURES)) {
    assert.ok(committed(name).equals(bytes), name);
  }
});

test('drm.epub encrypts a chapter with an algorithm that is not font obfuscation', () => {
  const entries = storedEntries(committed('drm.epub'));
  const xml = entries.get(ENCRYPTION_FILE);
  assert.ok(xml.includes(XML_ENCRYPTION_NAMESPACE));
  const algorithms = [...xml.matchAll(/<EncryptionMethod Algorithm="([^"]+)"/g)].map(
    ([, uri]) => uri,
  );
  assert.ok(algorithms.length > 0);
  assert.ok(
    algorithms.every((uri) => !FONT_OBFUSCATION_ALGORITHMS.includes(uri)),
    algorithms.join(),
  );
  const references = [...xml.matchAll(/<CipherReference URI="([^"]+)"/g)].map(([, uri]) => uri);
  assert.deepEqual(references, ['OEBPS/chapter-1.xhtml']);
  assert.ok(entries.has(references[0]));
});

test('drm.epub is otherwise a whole book, so only the DRM check can refuse it', () => {
  const names = [...storedEntries(committed('drm.epub')).keys()];
  const plainNames = [...storedEntries(committed('plain.epub')).keys()];
  assert.deepEqual(
    names.filter((name) => name !== ENCRYPTION_FILE),
    plainNames,
  );
});

test('obfuscated-font.epub only encrypts with font obfuscation', () => {
  const xml = storedEntries(committed('obfuscated-font.epub')).get(ENCRYPTION_FILE);
  const algorithms = [...xml.matchAll(/<EncryptionMethod Algorithm="([^"]+)"/g)].map(([, uri]) => uri);
  assert.ok(algorithms.length > 0);
  assert.ok(algorithms.every((uri) => FONT_OBFUSCATION_ALGORITHMS.includes(uri)), algorithms.join());
});

test('fixed.epub is a book of pages, and the others are not', () => {
  const opfOf = (name) => storedEntries(committed(name)).get('OEBPS/content.opf');
  assert.match(opfOf('fixed.epub'), /<meta property="rendition:layout">pre-paginated<\/meta>/);
  assert.match(storedEntries(committed('fixed.epub')).get('OEBPS/chapter-1.xhtml'), /<meta name="viewport"/);
  assert.doesNotMatch(opfOf('plain.epub'), /rendition:layout/);
  assert.doesNotMatch(storedEntries(committed('plain.epub')).get('OEBPS/chapter-1.xhtml'), /viewport/);
});

test('the other readable fixtures have no encryption file', () => {
  for (const name of ['plain.epub', 'scripted.epub', 'no-id.epub']) {
    assert.ok(!storedEntries(committed(name)).has(ENCRYPTION_FILE), name);
  }
});
