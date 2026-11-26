// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../app/translate/engine.js';

const CATALOG = {
  pairs: [
    { id: 'en-it', from: 'en', to: 'it', installed: '2.1', kinds: ['lex', 'model', 'vocab'] },
    { id: 'en-ja', from: 'en', to: 'ja', installed: '2.3', kinds: ['lex', 'model', 'srcvocab', 'trgvocab'] },
    { id: 'en-fr', from: 'en', to: 'fr', installed: null, kinds: ['lex', 'model', 'vocab'] },
  ],
};

/** The engine's two classes, recording what the app asks of them. */
function fakeBergamot() {
  const made = { requests: [], deleted: false, options: null, backing: null };
  class TranslatorBacking {
    constructor(options) {
      this.options = options;
      this.registry = this.loadModelRegistery();
    }
  }
  class BatchTranslator {
    constructor(options, backing) {
      made.options = options;
      made.backing = backing;
    }

    async translate(request) {
      made.requests.push(request);
      return { target: { text: `${request.to}:${request.text}` } };
    }

    async delete() {
      made.deleted = true;
    }
  }
  return { made, load: async () => ({ BatchTranslator, TranslatorBacking }) };
}

function fakeInvoke() {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'tr_catalog') return CATALOG;
    if (command === 'tr_model_file') return new TextEncoder().encode(`${args.pair}/${args.kind}`).buffer;
    throw new Error(`unexpected ${command}`);
  };
  return { calls, invoke };
}

const text = (buffer) => new TextDecoder().decode(buffer);

test('the registry lists only installed pairs', async () => {
  const { made, load } = fakeBergamot();
  const { invoke } = fakeInvoke();
  const engine = createEngine({ invoke, load });
  await engine.translate('en', 'it', ['x']);
  const registry = await made.backing.registry;
  assert.deepEqual(registry.map(({ from, to }) => `${from}-${to}`), ['en-it', 'en-ja']);
  assert.deepEqual(await engine.installed(), ['en-it', 'en-ja']);
});

test("a model is loaded from the app's files, with both vocabularies when the pair has two", async () => {
  const { made, load } = fakeBergamot();
  const { invoke } = fakeInvoke();
  await createEngine({ invoke, load }).translate('en', 'it', ['x']);
  const it = await made.backing.loadTranslationModel({ from: 'en', to: 'it' });
  assert.equal(text(it.model), 'en-it/model');
  assert.equal(text(it.shortlist), 'en-it/lex');
  assert.deepEqual(it.vocabs.map(text), ['en-it/vocab']);
  const ja = await made.backing.loadTranslationModel({ from: 'en', to: 'ja' });
  assert.deepEqual(ja.vocabs.map(text), ['en-ja/srcvocab', 'en-ja/trgvocab']);
  assert.deepEqual(ja.config, {});
});

test('translate sends html requests and returns texts in order', async () => {
  const { made, load } = fakeBergamot();
  const { invoke } = fakeInvoke();
  const engine = createEngine({ invoke, load, workers: 3 });
  assert.deepEqual(await engine.translate('en', 'it', ['<i>a</i>', 'b']), ['it:<i>a</i>', 'it:b']);
  assert.deepEqual(made.requests.map(({ html, qualityScores, from }) => [html, qualityScores, from]),
    [[true, false, 'en'], [true, false, 'en']]);
  assert.equal(made.options.workers, 3);
  assert.equal(made.backing.options.pivotLanguage, 'en');
});

test('the engine loads once, however many translations it does', async () => {
  let loads = 0;
  const { load } = fakeBergamot();
  const { invoke } = fakeInvoke();
  const engine = createEngine({ invoke, load: () => { loads += 1; return load(); } });
  await Promise.all([engine.translate('en', 'it', ['a']), engine.translate('en', 'it', ['b'])]);
  assert.equal(loads, 1);
});

test('close deletes the translator', async () => {
  const { made, load } = fakeBergamot();
  const { invoke } = fakeInvoke();
  const engine = createEngine({ invoke, load });
  await engine.translate('en', 'it', ['x']);
  await engine.close();
  assert.equal(made.deleted, true);
});

test('close before anything was translated loads nothing', async () => {
  let loads = 0;
  const { load } = fakeBergamot();
  const { invoke } = fakeInvoke();
  await createEngine({ invoke, load: () => { loads += 1; return load(); } }).close();
  assert.equal(loads, 0);
});
