// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { setLang } from '../app/core/i18n.js';
import en from '../app/lang/en.js';
import { relevantPairs, renderTranslationModels } from '../app/ui/translation-models.js';
import { chooseMain } from '../app/translate/choose.js';
import { MissingModelsError } from '../app/translate/models.js';

const MB = 1024 * 1024;
const PAIRS = [
  { id: 'de-en', from: 'de', to: 'en', bytes: 20 * MB, installed: '2.0', update: false },
  { id: 'en-de', from: 'en', to: 'de', bytes: 20 * MB, installed: null, update: false },
  { id: 'en-it', from: 'en', to: 'it', bytes: 37 * MB, installed: '2.0', update: true },
  { id: 'fr-en', from: 'fr', to: 'en', bytes: 21 * MB, installed: null, update: false },
  { id: 'it-en', from: 'it', to: 'en', bytes: 30 * MB, installed: null, update: false },
];

test('the list shows the pairs to and from the language translated into, and every one installed', () => {
  assert.deepEqual(relevantPairs(PAIRS, 'it').map(({ id }) => id), ['en-it', 'it-en', 'de-en']);
});

function draw(view) {
  setLang('en');
  const { document } = parseHTML('<!doctype html><html><body><section class="translation-models"></section></body></html>');
  const host = document.querySelector('section');
  const asked = [];
  renderTranslationModels(host, view, {
    onDownload: (id) => asked.push(['download', id]),
    onCancel: (id) => asked.push(['cancel', id]),
    onRemove: (id) => asked.push(['remove', id]),
  });
  const row = (id) => host.querySelector(`[data-pair="${id}"]`);
  return { host, asked, row };
}

test('the model list shows update for an older installed version, and remove', () => {
  const { asked, row } = draw({ pairs: PAIRS, target: 'it', downloads: {} });
  const buttons = [...row('en-it').querySelectorAll('button')].map((button) => button.textContent);
  assert.deepEqual(buttons, [en['translate.update'], en['translate.remove']]);
  const { Event } = row('en-it').ownerDocument.defaultView;
  row('en-it').querySelector('button').dispatchEvent(new Event('click'));
  assert.deepEqual(asked, [['download', 'en-it']]);
  assert.match(row('en-it').textContent, /37 MB/);
});

test('a model not downloaded offers the download, and one downloading its progress and a way to stop', () => {
  const { row } = draw({ pairs: PAIRS, target: 'it', downloads: { 'it-en': 40 } });
  assert.deepEqual([...row('it-en').querySelectorAll('button')].map((b) => b.textContent), [en['translate.cancel']]);
  assert.match(row('it-en').textContent, /40%/);
  const { row: other } = draw({ pairs: PAIRS, target: 'de', downloads: {} });
  assert.deepEqual([...other('en-de').querySelectorAll('button')].map((b) => b.textContent), [en['translate.get']]);
});

test('first Tradotto with the model missing offers its download and does not translate', async () => {
  const offered = [];
  const translation = { main: () => null, setMain: async () => { throw new MissingModelsError(['en-it']); } };
  const chosen = await chooseMain(translation, 'translated', { offerModels: (missing) => offered.push(missing) });
  assert.equal(chosen, false);
  assert.deepEqual(offered, [['en-it']]);
});

test('first Tradotto with the model saves the main language and starts the book', async () => {
  const set = [];
  const translation = { setMain: async (main) => { set.push(main); } };
  assert.equal(await chooseMain(translation, 'translated', { offerModels: () => assert.fail('nothing to offer') }), true);
  assert.deepEqual(set, ['translated']);
});

test('a failure other than a missing model is told, not swallowed', async () => {
  const translation = { setMain: async () => { throw new Error('engine broke'); } };
  await assert.rejects(chooseMain(translation, 'translated', { offerModels: () => {} }), /engine broke/);
});
