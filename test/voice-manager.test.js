// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { setLang } from '../app/core/i18n.js';
import en from '../app/lang/en.js';
import { renderVoiceManager } from '../app/ui/voice-manager.js';

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

function catalog({ engine = 'missing', voices } = {}) {
  return {
    engine: { state: engine, bytes: engine === 'ready' ? 25_000_000 : 0, download: 22_000_000 },
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

test('a voice not installed offers download with the engine size', () => {
  const { row, calls } = draw({});
  const button = lastButton(row('it_IT-paola-medium'));
  assert.equal(button.textContent, en['voices.withEngine'].replace('{size}', '22'));
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

test('japanese says no clean voice exists', () => {
  const { host } = draw({ languages: ['ja', 'en'] });
  const japanese = host.querySelector('[data-lang="ja"]');
  assert.equal(japanese.querySelector('.voice-none').textContent, en['voices.noCleanVoice'].replaceAll('{lang}', 'Japanese'));
});

test('a failed download says why on its row and offers to try again', () => {
  const progress = new Map([['it_IT-paola-medium', { phase: 'error', error: { kind: 'voice' } }]]);
  const { row } = draw({ progress });
  assert.equal(row('it_IT-paola-medium').querySelector('.voice-error').textContent, en['voices.hashError']);
  assert.equal(lastButton(row('it_IT-paola-medium')).textContent, en['voices.withEngine'].replace('{size}', '22'));
});

test('the license opens its card and the play button its sample', () => {
  const { row, calls } = draw({});
  row('it_IT-paola-medium').querySelector('.voice-license').click();
  row('it_IT-paola-medium').querySelector('.voice-preview').click();
  assert.deepEqual(calls[0], ['onCard', 'https://example.invalid/it_IT-paola-medium']);
  assert.equal(calls[1][0], 'onPreview');
  assert.equal(calls[1][1].id, 'it_IT-paola-medium');
});
