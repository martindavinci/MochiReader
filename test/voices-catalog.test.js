// SPDX-License-Identifier: GPL-3.0-or-later
// The voices the app offers to download: what the catalog promises about each, checked before it ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../app/speech/voices.json', import.meta.url), 'utf8'));
const ALLOWED = new Set(['CC0-1.0', 'CC-BY-4.0', 'MIT', 'Apache-2.0', 'public-domain']);
const PINNED = /^https:\/\/huggingface\.co\/rhasspy\/piper-voices\/(resolve|blob)\/[0-9a-f]{40}\//;
const SHA256 = /^[0-9a-f]{64}$/;
const INTERFACE_LANGUAGES = ['en', 'it', 'de', 'es', 'fr', 'pt', 'ja', 'ko', 'zh'];

test('every voice has an allowed license', () => {
  for (const voice of catalog.voices) assert.ok(ALLOWED.has(voice.license), `${voice.id}: ${voice.license}`);
});

test('every url is pinned', () => {
  for (const voice of catalog.voices) {
    for (const url of [voice.model.url, voice.config.url, voice.sample, voice.card]) {
      assert.match(url, PINNED, voice.id);
    }
  }
});

test('every file has a hash and a size', () => {
  for (const voice of catalog.voices) {
    for (const file of [voice.model, voice.config]) {
      assert.match(file.sha256, SHA256, voice.id);
      assert.ok(file.bytes > 0, voice.id);
    }
  }
  // The engine comes with the app: the catalog has nothing to download for it.
  assert.equal('engine' in catalog, false);
});

test('quality is medium or high', () => {
  for (const voice of catalog.voices) assert.ok(['medium', 'high'].includes(voice.quality), voice.id);
});

test('every interface language has a voice or says why', () => {
  for (const language of INTERFACE_LANGUAGES) {
    const voiced = catalog.voices.some((voice) => voice.lang.split('-')[0] === language);
    assert.ok(voiced || catalog.unavailable.includes(language), language);
  }
});

test('ids are unique', () => {
  const ids = catalog.voices.map((voice) => voice.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('ids are safe as folder names', () => {
  for (const voice of catalog.voices) assert.match(voice.id, /^[A-Za-z0-9_-]+$/);
});

const KOKORO = /^https:\/\/huggingface\.co\/onnx-community\/Kokoro-82M-v1\.0-ONNX\/(resolve|blob)\/[0-9a-f]{40}\//;
const KOKORO_LANGS = new Set(['en-US', 'en-GB', 'it-IT', 'es-ES', 'fr-FR', 'pt-BR', 'hi-IN']);

test('kokoro: one q8 model, pinned, hashed', () => {
  const k = catalog.kokoro;
  assert.equal(k.license, 'Apache-2.0');
  assert.match(k.card, KOKORO);
  assert.match(k.model.url, KOKORO);
  assert.ok(k.model.url.endsWith('/onnx/model_quantized.onnx'));
  assert.equal(k.model.bytes, 92361116);
  assert.match(k.model.sha256, SHA256);
});

test('kokoro: every voice pinned, 522240 bytes, in an offered language, graded C or better (or ungraded)', () => {
  const ids = new Set();
  for (const voice of catalog.kokoro.voices) {
    assert.match(voice.file.url, KOKORO, voice.id);
    assert.equal(voice.file.bytes, 522240, voice.id);
    assert.match(voice.file.sha256, SHA256, voice.id);
    assert.ok(KOKORO_LANGS.has(voice.lang), voice.id);
    // Spanish and Brazilian Portuguese voices have no grade from their author
    if (['es-ES', 'pt-BR'].includes(voice.lang)) assert.equal(voice.grade, '', voice.id);
    else assert.match(voice.grade, /^(A|B|C)[+-]?$/, voice.id);
    assert.notEqual(voice.grade, 'C-', voice.id);
    assert.ok(!ids.has(voice.id), voice.id);
    ids.add(voice.id);
  }
  for (const tried of ['if_sara', 'im_nicola', 'af_heart', 'af_bella', 'bf_emma']) assert.ok(ids.has(tried), tried);
});

test('kokoro: the vocabulary maps symbols to ids', () => {
  const vocab = catalog.kokoro.vocab;
  assert.ok(Object.keys(vocab).length >= 100);
  for (const [symbol, id] of Object.entries(vocab)) {
    assert.equal([...symbol].length, 1, symbol);
    assert.ok(Number.isInteger(id) && id >= 0, symbol);
  }
  // the padding the model wants around the tokens
  assert.equal(vocab.$, 0);
});
