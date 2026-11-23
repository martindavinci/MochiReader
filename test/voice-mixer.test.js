// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { setLang } from '../app/core/i18n.js';
import en from '../app/lang/en.js';
import { draftOf, draftProblem, duplicateOf, newDraft, renderMixer, renderMixes, repairDraft, withLang } from '../app/ui/voice-mixer.js';

const NAMES = { it: 'Italian', en: 'English' };
const nameOf = (language) => NAMES[language] ?? language;
const SARA = { id: 'if_sara', name: 'Sara', lang: 'it-IT' };
const HEART = { id: 'af_heart', name: 'Heart', lang: 'en-US' };
const NICOLA = { id: 'im_nicola', name: 'Nicola', lang: 'it-IT' };
const KOKORO = [SARA, HEART, NICOLA];

function host() {
  setLang('en');
  const { document } = parseHTML('<!doctype html><html><body><div id="h"></div></body></html>');
  return document.getElementById('h');
}

function handlers() {
  const calls = [];
  const made = Object.fromEntries(['onCreate', 'onEdit', 'onDuplicate', 'onDeleteMix', 'onChange', 'onPreviewMix', 'onSave', 'onCancel']
    .map((name) => [name, (arg) => calls.push([name, arg])]));
  return { calls, made };
}

const kept = (extra = {}) => ({
  mix: { id: '0a1b2c3d', name: 'Sara e Heart', lang: 'it-IT', parts: [{ voice: 'if_sara', weight: 0.7 }, { voice: 'af_heart', weight: 0.3 }] },
  missing: [],
  ...extra,
});

test('fewer than two kokoro voices: no mix can be made, and the section says why', () => {
  const where = host();
  const { made } = handlers();
  renderMixes(where, { mixes: [], kokoroVoices: [SARA], nameOf }, made);
  assert.match(where.textContent, new RegExp(en['voices.mix.needVoices']));
  assert.equal([...where.querySelectorAll('button')].some((b) => b.textContent === en['voices.mix.create']), false);
});

test('create asks for a new mix', () => {
  const where = host();
  const { calls, made } = handlers();
  renderMixes(where, { mixes: [], kokoroVoices: KOKORO, nameOf }, made);
  [...where.querySelectorAll('button')].find((b) => b.textContent === en['voices.mix.create']).click();
  assert.equal(calls[0][0], 'onCreate');
});

test('a new draft has two voices at 50 and the language of the first', () => {
  const draft = newDraft(KOKORO);
  assert.deepEqual(draft, { id: '', name: '', lang: 'it-IT', parts: [{ voice: 'if_sara', weight: 50 }, { voice: 'af_heart', weight: 50 }] });
  const where = host();
  const { calls, made } = handlers();
  renderMixer(where, { draft, kokoroVoices: KOKORO, nameOf }, made);
  const rows = where.querySelectorAll('.mix-part');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('select').value, 'if_sara');
  assert.equal(rows[0].querySelector('input[type="range"]').getAttribute('max'), '100');
  assert.equal(rows[0].querySelector('input[type="range"]').value, '50');
  where.querySelector('.mix-add').click();
  assert.equal(calls.at(-1)[0], 'onChange');
  assert.equal(calls.at(-1)[1].parts.length, 3);
});

test('with three voices there is no room for a fourth', () => {
  const where = host();
  const { made } = handlers();
  const draft = { ...newDraft(KOKORO), parts: [{ voice: 'if_sara', weight: 50 }, { voice: 'af_heart', weight: 50 }, { voice: 'im_nicola', weight: 10 }] };
  renderMixer(where, { draft, kokoroVoices: KOKORO, nameOf }, made);
  assert.equal(where.querySelectorAll('.mix-part').length, 3);
  assert.equal(where.querySelector('.mix-add'), null);
});

test('the language is one of the voices, and follows the first when it no longer fits', () => {
  const where = host();
  const { made } = handlers();
  renderMixer(where, { draft: newDraft(KOKORO), kokoroVoices: KOKORO, nameOf }, made);
  const offered = [...where.querySelectorAll('.mix-lang option')].map((option) => option.value);
  assert.deepEqual(offered, ['it-IT', 'en-US']);
  const english = { ...newDraft(KOKORO), lang: 'it-IT', parts: [{ voice: 'af_heart', weight: 50 }, { voice: 'af_heart', weight: 50 }] };
  assert.equal(withLang(english, KOKORO).lang, 'en-US');
  assert.equal(withLang(newDraft(KOKORO), KOKORO).lang, 'it-IT');
});

test('what keeps a draft from being saved', () => {
  const named = { ...newDraft(KOKORO), name: 'Mia' };
  assert.equal(draftProblem({ ...named, name: '  ' }, KOKORO), 'voices.mix.needName');
  assert.equal(draftProblem({ ...named, parts: [named.parts[0]] }, KOKORO), 'voices.mix.needTwo');
  assert.equal(draftProblem({ ...named, parts: [{ voice: 'if_sara', weight: 0 }, { voice: 'af_heart', weight: 0 }] }, KOKORO), 'voices.mix.needWeight');
  assert.equal(draftProblem(named, KOKORO), null);
  const where = host();
  const { made } = handlers();
  renderMixer(where, { draft: { ...named, name: '' }, kokoroVoices: KOKORO, nameOf }, made);
  assert.equal(where.querySelector('.mix-save').hasAttribute('disabled'), true);
  assert.equal(where.querySelector('.mix-problem').textContent, en['voices.mix.needName']);
});

test('a mix missing a voice is shown disabled, says which, and can still be deleted', () => {
  const where = host();
  const { calls, made } = handlers();
  renderMixes(where, { mixes: [kept({ missing: ['Sara'] })], kokoroVoices: [HEART, NICOLA], nameOf }, made);
  const row = where.querySelector('[data-mix="0a1b2c3d"]');
  assert.ok(row.classList.contains('is-disabled'));
  assert.match(row.textContent, new RegExp(en['voices.mix.missing'].replace('{names}', 'Sara')));
  const buttons = [...row.querySelectorAll('button')];
  assert.equal(buttons.some((b) => b.textContent === en['voices.mix.edit']), false);
  buttons.find((b) => b.textContent === en['voices.delete']).click();
  assert.deepEqual(calls[0], ['onDeleteMix', '0a1b2c3d']);
});

test('a mix shows its voices and weights, and can be edited or duplicated', () => {
  const where = host();
  const { calls, made } = handlers();
  renderMixes(where, { mixes: [kept()], kokoroVoices: KOKORO, nameOf }, made);
  const row = where.querySelector('[data-mix="0a1b2c3d"]');
  assert.match(row.textContent, /Sara 70% · Heart 30%/);
  [...row.querySelectorAll('button')].find((b) => b.textContent === en['voices.mix.edit']).click();
  [...row.querySelectorAll('button')].find((b) => b.textContent === en['voices.mix.duplicate']).click();
  assert.deepEqual(calls.map(([name]) => name), ['onEdit', 'onDuplicate']);
});

test('editing and duplicating make drafts on the 0–100 scale', () => {
  assert.deepEqual(draftOf(kept().mix), {
    id: '0a1b2c3d', name: 'Sara e Heart', lang: 'it-IT', parts: [{ voice: 'if_sara', weight: 70 }, { voice: 'af_heart', weight: 30 }],
  });
  const copy = duplicateOf(kept().mix);
  assert.equal(copy.id, '');
  assert.equal(copy.name, 'Sara e Heart 2');
});

test('save keeps what was typed and slid, even before the field is left', () => {
  const where = host();
  const { calls, made } = handlers();
  renderMixer(where, { draft: newDraft(KOKORO), kokoroVoices: KOKORO, nameOf }, made);
  const save = where.querySelector('.mix-save');
  assert.equal(save.hasAttribute('disabled'), true);
  const name = where.querySelector('.mix-name');
  name.value = 'Mia';
  name.dispatchEvent(new name.ownerDocument.defaultView.Event('input'));
  const weight = where.querySelector('.mix-weight');
  weight.value = '80';
  weight.dispatchEvent(new weight.ownerDocument.defaultView.Event('input'));
  assert.equal(save.hasAttribute('disabled'), false, 'a name typed is enough');
  assert.equal(where.querySelector('.mix-problem'), null);
  save.click();
  const [name0, saved] = calls.at(-1);
  assert.equal(name0, 'onSave');
  assert.equal(saved.name, 'Mia');
  assert.equal(saved.parts[0].weight, 80);
});

test('a draft is mended when its voices are gone', () => {
  const draft = { id: '', name: 'Mia', lang: 'it-IT', parts: [{ voice: 'if_sara', weight: 70 }, { voice: 'af_heart', weight: 30 }] };
  assert.equal(repairDraft(draft, [HEART]), null, 'fewer than two voices: no draft');
  const mended = repairDraft(draft, [HEART, NICOLA]);
  assert.deepEqual(mended.parts.map(({ voice }) => voice), ['af_heart', 'im_nicola']);
  assert.equal(mended.parts[0].weight, 30);
  assert.equal(mended.lang, 'it-IT', 'Nicola still speaks it');
  assert.equal(repairDraft({ ...draft, parts: [{ voice: 'if_sara', weight: 50 }, { voice: 'im_nicola', weight: 50 }] }, [HEART, { id: 'bf_emma', name: 'Emma', lang: 'en-GB' }]).lang, 'en-US');
  assert.equal(repairDraft(draft, KOKORO), draft, 'nothing gone, the same draft');
});
