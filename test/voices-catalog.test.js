// SPDX-License-Identifier: GPL-3.0-or-later
// The voices the app offers to download: what the catalog promises about each, checked before it ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE_PENDING } from '../tools/check-tag.mjs';

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
  const { engine } = catalog;
  assert.match(engine.url, /^https:\/\/github\.com\/martindavinci\/MochiReader\/releases\/download\/engine-\d+\//);
  // Until the engine pack is published its hash is the marker that tools/check-tag.mjs refuses to release.
  if (engine.sha256 !== ENGINE_PENDING) {
    assert.match(engine.sha256, SHA256);
    assert.ok(engine.bytes > 0);
  }
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
