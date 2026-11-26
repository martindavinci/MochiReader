// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { CancelledError, createBookTranslation } from '../app/translate/book.js';

const docOf = (html) => parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`).document;
// Section 2 is a cover picture: nothing to translate.
const SECTIONS = ['<p>Zero.</p>', '<h1>One</h1><p>One text.</p>', '<img src="c.jpg">', '<p>Three.</p>', '<p>Four.</p>'];

function fakes({ cached = {}, hold = false } = {}) {
  const store = new Map(Object.entries(cached).map(([k, v]) => [Number(k), v]));
  const translated = [];
  const releases = [];
  const engine = {
    closed: false,
    async translate(from, to, htmls) {
      translated.push(htmls.join('|'));
      if (hold) await new Promise((resolve) => { releases.push(resolve); });
      return htmls.map((h) => `${to}:${h}`);
    },
    async close() { this.closed = true; },
  };
  const invoke = async (command, args) => {
    if (command === 'tr_cache_get') return store.get(args.section) ?? null;
    if (command === 'tr_cache_put') { store.set(args.section, args.texts); return null; }
    if (command === 'tr_cache_sections') return [...store.keys()].sort((a, b) => a - b);
    throw new Error(`unexpected ${command}`);
  };
  const book = createBookTranslation({
    key: 'epub:k', from: 'en', to: 'it', version: '2.1', sections: SECTIONS.length,
    sourceOf: async (index) => docOf(SECTIONS[index]), engine, invoke,
  });
  const release = () => releases.shift()?.();
  return { book, engine, store, translated, release, releases };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

test('ready of a cached section does not call the engine', async () => {
  const { book, translated } = fakes({ cached: { 3: ['it:Three.'] } });
  assert.deepEqual(await book.ready(3), ['it:Three.']);
  assert.deepEqual(translated, []);
});

test('ready of a new section translates it and stores it', async () => {
  const { book, store } = fakes();
  assert.deepEqual(await book.ready(1), ['it:One', 'it:One text.']);
  assert.deepEqual(store.get(1), ['it:One', 'it:One text.']);
  assert.deepEqual(await book.cached(1), ['it:One', 'it:One text.']);
});

test('ready of a new section translates it before the background order', async () => {
  const { book, translated, release } = fakes({ hold: true });
  book.start();
  await settle();
  const four = book.ready(4);
  while (translated.length < 2) { release(); await settle(); }
  release();
  assert.deepEqual(await four, ['it:Four.']);
  assert.deepEqual(translated.slice(0, 2), ['Zero.', 'Four.']);
  book.close();
});

test('want puts a section before the rest of the book', async () => {
  const { book, translated, release } = fakes({ hold: true });
  book.start();
  await settle();
  book.want(3);
  for (let i = 0; i < 3; i += 1) { release(); await settle(); }
  assert.deepEqual(translated.slice(0, 2), ['Zero.', 'Three.']);
  book.close();
});

test('the loop skips sections already cached and resumes where it was', async () => {
  const { book, translated } = fakes({ cached: { 0: ['x'], 1: ['y', 'z'] } });
  const done = new Promise((resolve) => { book.onProgress(({ done: n, total }) => { if (n === total) resolve(); }); });
  book.start();
  await done;
  assert.deepEqual(translated, ['Three.', 'Four.']);
});

test('a section with no text is ready at once', async () => {
  const { book, translated, store } = fakes();
  assert.deepEqual(await book.ready(2), []);
  assert.deepEqual(translated, []);
  assert.deepEqual(store.get(2), []);
});

test('close stops the loop and the engine gets no more requests', async () => {
  const { book, engine, translated, release } = fakes({ hold: true });
  book.start();
  await settle();
  const pending = book.ready(4);
  book.close();
  release();
  await assert.rejects(pending, CancelledError);
  await settle();
  assert.equal(translated.length, 1);
  assert.equal(engine.closed, true);
});

test('progress counts cached sections', async () => {
  const { book } = fakes({ cached: { 0: ['x'], 3: ['y'] } });
  await book.start();
  assert.deepEqual(book.progress(), { done: 2, total: 5 });
});
