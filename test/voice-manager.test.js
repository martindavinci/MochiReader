// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { setLang } from '../app/core/i18n.js';
import en from '../app/lang/en.js';
import { PREVIEW_TEXT, progressText, renderVoiceManager, voiceIdOf } from '../app/ui/voice-manager.js';

const NAMES = { it: 'Italian', de: 'German', en: 'English', ja: 'Japanese' };
const voice = (id, lang, extra = {}) => ({
  id,
  name: id.split('-')[1],
  lang,
  quality: 'medium',
  bytes: 63_000_000,
  license: 'CC0-1.0',
  card: `https://example.invalid/${id}`,
  installed: false,
  busy: false,
  ...extra,
});

function catalog({ engine = 'ready', voices } = {}) {
  return {
    engine: { state: engine },
    used: 0,
    unavailable: ['ja', 'ko', 'zh'],
    voices: voices ?? [
      voice('it_IT-paola-medium', 'it-IT'),
      voice('de_DE-thorsten-medium', 'de-DE'),
      voice('en_US-john-medium', 'en-US'),
    ],
  };
}

function draw(view) {
  setLang('en');
  const { document } = parseHTML('<!doctype html><html><body><aside id="panel"></aside></body></html>');
  const host = document.getElementById('panel');
  const calls = [];
  const handlers = Object.fromEntries(['onDownload', 'onCancel', 'onDelete', 'onPreview', 'onCard']
    .map((name) => [name, (arg) => calls.push([name, arg])]));
  renderVoiceManager(host, {
    catalog: catalog(),
    progress: new Map(),
    languages: ['en'],
    inUse: new Set(),
    nameOf: (language) => NAMES[language] ?? language,
    ...view,
  }, handlers);
  return { host, calls, row: (id) => host.querySelector(`[data-voice="${id}"]`) };
}

const lastButton = (row) => [...row.querySelectorAll('button')].at(-1);

test('a voice not installed offers its download', () => {
  const { host, row, calls } = draw({});
  assert.equal(host.querySelector('.voice-engine'), null);
  const button = lastButton(row('it_IT-paola-medium'));
  assert.equal(button.textContent, en['voices.download']);
  button.click();
  assert.deepEqual(calls, [['onDownload', 'it_IT-paola-medium']]);
});

test('with the engine ready the button only says download', () => {
  const { row } = draw({ catalog: catalog({ engine: 'ready' }) });
  assert.equal(lastButton(row('it_IT-paola-medium')).textContent, en['voices.download']);
});

test('a download in progress shows its share and cancel', () => {
  const progress = new Map([['it_IT-paola-medium', { phase: 'voice', received: 25, total: 100 }]]);
  const { row, calls } = draw({ progress });
  const line = row('it_IT-paola-medium');
  assert.equal(line.querySelector('progress').getAttribute('value'), '25');
  assert.equal(line.querySelector('.voice-status').textContent, '25%');
  lastButton(line).click();
  assert.deepEqual(calls, [['onCancel', 'it_IT-paola-medium']]);
});

test('an installed voice can be deleted and says when it is in use', () => {
  const voices = [voice('it_IT-paola-medium', 'it-IT', { installed: true })];
  const { row, calls } = draw({ catalog: catalog({ engine: 'ready', voices }), inUse: new Set(['it_IT-paola-medium']) });
  const line = row('it_IT-paola-medium');
  assert.equal(line.querySelector('.voice-badge').textContent, en['voices.inUse']);
  lastButton(line).click();
  assert.deepEqual(calls, [['onDelete', 'it_IT-paola-medium']]);
});

test('languages of open documents come first', () => {
  const { host } = draw({ languages: ['de-DE', 'it', 'en'] });
  const sections = [...host.querySelectorAll('.voice-language')].map((part) => part.dataset.lang);
  assert.deepEqual(sections, ['de', 'it', 'en']);
});

test('voices of other languages are under all languages', () => {
  const { host } = draw({ languages: ['it'] });
  const titles = [...host.querySelectorAll('.voice-language h2')].map((title) => title.textContent);
  assert.deepEqual(titles, ['Italian', en['voices.allLanguages']]);
});

test('a language without voices to download is not named', () => {
  const { host } = draw({ languages: ['ja', 'en'] });
  assert.equal(host.querySelector('[data-lang="ja"]'), null);
  assert.equal(host.querySelector('.voice-language').dataset.lang, 'en');
  assert.ok(!host.textContent.includes('Japanese'));
});

test('a failed download says why on its row and offers to try again', () => {
  const progress = new Map([['it_IT-paola-medium', { phase: 'error', error: { kind: 'voice' } }]]);
  const { row } = draw({ progress });
  assert.equal(row('it_IT-paola-medium').querySelector('.voice-error').textContent, en['voices.hashError']);
  assert.equal(lastButton(row('it_IT-paola-medium')).textContent, en['voices.download']);
});

test('the license opens its card and the play button its sample', () => {
  const { row, calls } = draw({});
  row('it_IT-paola-medium').querySelector('.voice-license').click();
  row('it_IT-paola-medium').querySelector('.voice-preview').click();
  assert.deepEqual(calls[0], ['onCard', 'https://example.invalid/it_IT-paola-medium']);
  assert.equal(calls[1][0], 'onPreview');
  assert.equal(calls[1][1].id, 'it_IT-paola-medium');
});

test('under all languages each language has its name over its voices', () => {
  const { host } = draw({ languages: ['it'] });
  const names = [...host.querySelectorAll('.voice-sublanguage h3')].map((title) => title.textContent);
  assert.deepEqual(names, ['English', 'German']);
  assert.ok(host.querySelector('.voice-sublanguage[data-lang="de"] [data-voice="de_DE-thorsten-medium"]'));
});

test('the sample playing turns its play button into stop', () => {
  const { row, calls } = draw({ previewing: 'it_IT-paola-medium' });
  const playing = row('it_IT-paola-medium').querySelector('.voice-preview');
  assert.equal(playing.getAttribute('aria-label'), en['voices.stopPreview']);
  assert.equal(playing.getAttribute('aria-pressed'), 'true');
  assert.equal(row('de_DE-thorsten-medium').querySelector('.voice-preview').getAttribute('aria-label'), en['voices.preview']);
  playing.click();
  assert.equal(calls[0][0], 'onPreview');
});

for (const [state, key] of [['missing', 'voices.noEngine'], ['broken', 'voices.engineBroken']]) {
  test(`with the engine ${state} no voice can be downloaded, and the panel says why`, () => {
    const { host, row } = draw({ catalog: catalog({ engine: state }) });
    const button = lastButton(row('it_IT-paola-medium'));
    assert.equal(button.textContent, en['voices.unavailable']);
    assert.ok(button.hasAttribute('disabled'));
    assert.equal(host.querySelector('.voice-engine').textContent, en[key]);
    assert.ok(row('it_IT-paola-medium').querySelector('.voice-preview'));
  });
}

test('a download under way says its share', () => {
  assert.equal(progressText({ phase: 'queued' }), en['voices.waiting']);
  assert.equal(progressText({ phase: 'voice', received: 1, total: 2 }), '50%');
});

const MODEL_BYTES = 92_361_116;
const sara = (extra = {}) => voice('if_sara', 'it-IT', {
  name: 'Sara', quality: 'kokoro', engine: 'kokoro', grade: 'C', license: 'Apache-2.0', bytes: 522_240 + MODEL_BYTES, ...extra,
});
const kokoroCatalog = (voices, installed = false) => ({
  ...catalog({ voices }), kokoroModel: { bytes: MODEL_BYTES, installed },
});

test('a kokoro voice says its engine and grade, and what downloading it costs before it can be heard', () => {
  const { row } = draw({ catalog: kokoroCatalog([sara()]), languages: ['it'] });
  const line = row('if_sara');
  assert.match(line.textContent, new RegExp(en['voices.quality.kokoro']));
  assert.match(line.textContent, new RegExp(en['voices.grade'].replace('{grade}', 'C')));
  assert.equal(lastButton(line).textContent, en['voices.download']);
  const preview = line.querySelector('.voice-preview');
  assert.equal(preview.hasAttribute('disabled'), true);
  assert.equal(preview.getAttribute('title'), en['voices.kokoroPreviewAfter'].replace('{size}', '93'));
});

test('an installed kokoro voice can be heard', () => {
  const { row, calls } = draw({ catalog: kokoroCatalog([sara({ installed: true, bytes: 522_240 })], true), languages: ['it'] });
  const preview = row('if_sara').querySelector('.voice-preview');
  assert.equal(preview.hasAttribute('disabled'), false);
  preview.click();
  assert.equal(calls[0][0], 'onPreview');
});

test('the kokoro model is told once, with its size', () => {
  const { host } = draw({ catalog: kokoroCatalog([sara(), sara({ id: 'im_nicola', name: 'Nicola' })]), languages: ['it'] });
  const told = [...host.querySelectorAll('.voice-kokoro-model')];
  assert.equal(told.length, 1);
  assert.equal(told[0].textContent, en['voices.kokoroModel'].replace('{size}', '92'));
  assert.equal(draw({}).host.querySelector('.voice-kokoro-model'), null, 'no Kokoro voice, nothing said');
});

test('the id of a voice carries its engine', () => {
  assert.equal(voiceIdOf({ engine: 'kokoro', id: 'if_sara' }), 'kokoro:if_sara');
  assert.equal(voiceIdOf({ engine: 'piper', id: 'x' }), 'piper:x');
  assert.equal(voiceIdOf({ id: 'x' }), 'piper:x');
  assert.ok(PREVIEW_TEXT.hi);
});

test('with the mixes given, the manager ends with your voices; with a draft, its form', () => {
  const both = [sara({ installed: true, bytes: 522_240 }), sara({ id: 'af_heart', name: 'Heart', lang: 'en-US', installed: true, bytes: 522_240 })];
  const { host } = draw({ catalog: kokoroCatalog(both, true), languages: ['it'], mixes: [] });
  const last = [...host.querySelectorAll('.voice-mixes')].at(-1);
  assert.ok(last);
  assert.ok(last.querySelector('.mix-create'));
  const editing = draw({
    catalog: kokoroCatalog(both, true),
    languages: ['it'],
    mixes: [],
    draft: { id: '', name: '', lang: 'it-IT', parts: [{ voice: 'if_sara', weight: 50 }, { voice: 'af_heart', weight: 50 }] },
  });
  assert.equal(editing.host.querySelectorAll('.voice-mixes .mix-part').length, 2);
  assert.equal(draw({}).host.querySelector('.voice-mixes'), null, 'no mixes given, no section');
});
