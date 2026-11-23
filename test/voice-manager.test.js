// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { setLang } from '../app/core/i18n.js';
import en from '../app/lang/en.js';
import { downloadRedraw, PREVIEW_TEXT, progressText, renderVoiceManager, voiceIdOf } from '../app/ui/voice-manager.js';

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

test('voices of other languages come after in the column, and all languages shows each one', () => {
  const { host } = draw({ languages: ['it'] });
  assert.deepEqual([...host.querySelectorAll('.voice-langs [data-lang]')].map((item) => item.dataset.lang), ['it', 'en', 'de', '*']);
  const titles = [...host.querySelectorAll('.voice-content .voice-language h2')].map((title) => title.textContent);
  assert.deepEqual(titles, ['Italian', 'English', 'German']);
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
  const german = host.querySelector('.voice-content .voice-language[data-lang="de"]');
  assert.equal(german.querySelector('h2').textContent, 'German');
  assert.ok(german.querySelector('[data-voice="de_DE-thorsten-medium"]'));
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

// The Voices panel: a column of languages, and the chosen language's voice, voices on this PC and to download.
const ELSA_W = { id: 'elsa', name: 'Microsoft Elsa - Italian (Italy)', lang: 'it-IT', engine: 'windows' };
const ZIRA_W = { id: 'zira', name: 'Microsoft Zira - English (United States)', lang: 'en-US', engine: 'windows' };
const ISABELLA_O = { id: 'edge:isabella', name: 'Microsoft Isabella Online', lang: 'it-IT', engine: 'online' };
const panelHandlers = (calls) => Object.fromEntries(['onSelect', 'onDefault', 'onEverywhere']
  .map((name) => [name, (...args) => calls.push([name, ...args])]));
function drawPanel(view, calls = []) {
  setLang('en');
  const { document } = parseHTML('<!doctype html><html><body><aside id="panel"></aside></body></html>');
  const host = document.getElementById('panel');
  renderVoiceManager(host, {
    catalog: catalog(),
    progress: new Map(),
    languages: ['it'],
    inUse: new Set(),
    nameOf: (language) => NAMES[language] ?? language,
    local: [ELSA_W, ZIRA_W],
    defaults: {},
    everywhere: [],
    ...view,
  }, { ...Object.fromEntries(['onDownload', 'onCancel', 'onDelete', 'onPreview', 'onCard'].map((name) => [name, () => {}])), ...panelHandlers(calls) });
  return { host, calls };
}

test('the column lists the languages with their counts and marks the selected one', () => {
  const { host, calls } = drawPanel({ selected: 'it' });
  const items = [...host.querySelectorAll('.voice-langs [data-lang]')];
  assert.deepEqual(items.map((item) => item.dataset.lang), ['it', 'en', 'de', '*']);
  assert.match(items[0].textContent, /Italian/);
  assert.match(items[0].textContent, /2/);
  assert.equal(items[0].getAttribute('aria-current'), 'true');
  assert.equal(items[1].hasAttribute('aria-current'), false);
  items[1].click();
  assert.deepEqual(calls[0], ['onSelect', 'en']);
});

test('a language says which voice reads it, and choosing one sets the default', () => {
  const { host, calls } = drawPanel({ selected: 'it', everywhere: ['zira'] });
  const select = host.querySelector('.voice-default');
  assert.match(select.closest('label').textContent, new RegExp(en['voices.readsLang'].replace('{language}', 'Italian')));
  assert.deepEqual([...select.querySelectorAll('option')].map((option) => option.getAttribute('value')), ['', 'elsa', 'zira']);
  select.querySelectorAll('option').forEach((option) => option.toggleAttribute('selected', option.getAttribute('value') === 'elsa'));
  select.dispatchEvent(new select.ownerDocument.defaultView.Event('change'));
  assert.deepEqual(calls.at(-1), ['onDefault', 'it', 'elsa']);
});

test('each voice on this pc can be ticked to show in other texts', () => {
  const { host, calls } = drawPanel({ selected: 'it', everywhere: ['elsa'] });
  const box = host.querySelector('[data-voice="elsa"] .voice-everywhere input');
  assert.equal(box.checked, true);
  assert.match(box.closest('label').textContent, new RegExp(en['voices.everywhere']));
  box.checked = false;
  box.dispatchEvent(new box.ownerDocument.defaultView.Event('change'));
  assert.deepEqual(calls.at(-1), ['onEverywhere', 'elsa', false]);
});

test('windows and online voices have no delete, and the online ones come under their own heading', () => {
  const { host } = drawPanel({ selected: 'it', local: [ELSA_W, ISABELLA_O] });
  for (const id of ['elsa', 'edge:isabella']) {
    const row = host.querySelector(`[data-voice="${id}"]`);
    assert.ok(row, id);
    assert.equal([...row.querySelectorAll('button')].some((button) => button.textContent === en['voices.delete']), false, id);
  }
  assert.ok([...host.querySelectorAll('.voice-content h3')].some((heading) => heading.textContent === en['voices.online']));
});

test('the default of another language says for which', () => {
  const paola = voice('it_IT-paola-medium', 'it-IT', { installed: true, engine: 'piper' });
  const { host } = drawPanel({
    selected: 'it',
    catalog: catalog({ voices: [paola] }),
    local: [ELSA_W, { id: 'piper:it_IT-paola-medium', name: 'paola', lang: 'it-IT', engine: 'piper' }],
    defaults: { it: 'elsa', en: 'piper:it_IT-paola-medium' },
    everywhere: ['piper:it_IT-paola-medium'],
  });
  assert.match(host.querySelector('[data-voice="elsa"]').textContent, new RegExp(en['voices.default']));
  assert.match(host.querySelector('[data-voice="it_IT-paola-medium"]').textContent, new RegExp(en['voices.defaultFor'].replace('{language}', 'English')));
});

test('all languages shows every language; your voices shows the mixer', () => {
  const all = drawPanel({ selected: '*' });
  assert.deepEqual([...all.host.querySelectorAll('.voice-content > [data-lang]')].map((part) => part.dataset.lang), ['it', 'en', 'de']);
  const mine = drawPanel({ selected: 'mine', mixes: [] });
  assert.ok(mine.host.querySelector('.voice-content .voice-mixes'));
  assert.equal(mine.host.querySelector('.voice-content [data-lang="it"]'), null);
  assert.equal([...mine.host.querySelectorAll('.voice-langs [data-lang]')].at(-1).dataset.lang, 'mine');
});

test('a language with no voice says so, and stays in the column', () => {
  const { host } = drawPanel({ selected: 'ja', languages: ['ja', 'it'] });
  assert.equal(host.querySelector('.voice-langs [data-lang]').dataset.lang, 'ja');
  assert.match(host.querySelector('.voice-content').textContent, new RegExp(en['voices.noneForLang']));
});

test('what had the focus gets it back once the panel is drawn again', () => {
  setLang('en');
  const { document, HTMLElement } = parseHTML('<!doctype html><html><body><aside id="panel"></aside></body></html>');
  const focused = [];
  HTMLElement.prototype.focus = function focus() { focused.push(this.dataset.focus); };
  const host = document.getElementById('panel');
  const view = {
    catalog: catalog(), progress: new Map(), languages: ['it'], inUse: new Set(), nameOf: (language) => NAMES[language] ?? language,
    local: [ELSA_W, ZIRA_W], defaults: {}, everywhere: [], selected: 'it',
  };
  renderVoiceManager(host, { ...view, focus: 'tick:elsa' }, {});
  renderVoiceManager(host, { ...view, focus: 'default:it' }, {});
  renderVoiceManager(host, { ...view, focus: 'lang:en' }, {});
  assert.deepEqual(focused, ['tick:elsa', 'default:it', 'lang:en']);
  assert.ok(host.querySelector('[data-focus="tick:elsa"]').matches('input[type="checkbox"]'));
});

test('a download redraws the panel only when it ends, or when its row has no bar yet', () => {
  const doc = parseHTML('<!doctype html><html><body><ul><li id="a"><progress></progress></li><li id="b"></li></ul></body></html>').document;
  assert.equal(downloadRedraw('voice', null), false, 'its row is not on screen: nothing to draw');
  assert.equal(downloadRedraw('voice', doc.getElementById('a')), false, 'its bar moves by itself');
  assert.equal(downloadRedraw('voice', doc.getElementById('b')), true);
  for (const phase of ['done', 'error', 'canceled']) assert.equal(downloadRedraw(phase, null), true, phase);
});

test('a language with no voice of its own can be read by a ticked one, and is in the column', () => {
  const { host } = drawPanel({ selected: 'la', languages: ['it'], everywhere: ['elsa'] });
  assert.ok(host.querySelector('.voice-langs [data-lang="la"]'));
  const select = host.querySelector('.voice-default');
  assert.ok(select);
  assert.deepEqual([...select.querySelectorAll('option')].map((option) => option.getAttribute('value')), ['', 'elsa']);
  assert.match(host.querySelector('.voice-content').textContent, new RegExp(en['voices.noneForLang']));
});

test('a language whose name cannot be told is shown by its code', () => {
  const nameOf = (language) => {
    if (!/^[a-z]{2,3}$/.test(language)) throw new RangeError('invalid_argument');
    return NAMES[language] ?? language;
  };
  assert.doesNotThrow(() => drawPanel({ selected: 'en_us', nameOf }));
});
