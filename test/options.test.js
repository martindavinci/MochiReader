// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { setLang } from '../app/core/i18n.js';
import en from '../app/lang/en.js';
import it from '../app/lang/it.js';
import {
  applyOptions,
  DEFAULT_OPTIONS,
  interfaceLang,
  nextTextSize,
  readOptions,
  renderOptions,
  TEXT_SIZES,
} from '../app/ui/options.js';

function page() {
  const { document, Event } = parseHTML('<!doctype html><html><body><aside id="panel"></aside></body></html>');
  return { document, Event, host: document.getElementById('panel'), root: document.documentElement };
}

function draw(options = DEFAULT_OPTIONS) {
  const { host, Event } = page();
  const changes = [];
  renderOptions(host, options, { onChange: (name, value) => changes.push([name, value]) });
  const field = (name) => host.querySelector(`select[name="${name}"]`);
  const choose = (name, value) => {
    const select = field(name);
    // linkedom reads the value of a list from this attribute, and offers no other way to set it.
    select.querySelectorAll('option').forEach((option) => option.toggleAttribute('selected', option.getAttribute('value') === value));
    select.dispatchEvent(new Event('change'));
  };
  return { host, field, choose, changes };
}

const selected = (select) => select.querySelector('option[selected]').getAttribute('value');
const values = (select) => [...select.querySelectorAll('option')].map((option) => option.getAttribute('value'));

test('nothing saved means the defaults, which follow Windows', () => {
  assert.deepEqual(readOptions({}), DEFAULT_OPTIONS);
  assert.equal(DEFAULT_OPTIONS.theme, 'system');
  assert.equal(DEFAULT_OPTIONS.language, 'system');
  assert.equal(DEFAULT_OPTIONS.sourceMode, 'skip');
  assert.equal(DEFAULT_OPTIONS.epubView, 'paginated');
  assert.ok(TEXT_SIZES.includes(DEFAULT_OPTIONS.textSize));
});

test('saved options come back', () => {
  const saved = { theme: 'dark', textSize: 22, sourceMode: 'name', epubView: 'scrolled', language: 'it' };
  assert.deepEqual(readOptions(saved), saved);
});

test('a saved value the app does not know gives way to the default, and the others stay', () => {
  const options = readOptions({ theme: 'blue', textSize: 1000, language: 'it', other: 1 });
  assert.equal(options.theme, DEFAULT_OPTIONS.theme);
  assert.equal(options.textSize, DEFAULT_OPTIONS.textSize);
  assert.equal(options.language, 'it');
  assert.equal('other' in options, false);
});

test('the text size moves along its list and stops at the ends', () => {
  const at = TEXT_SIZES.indexOf(DEFAULT_OPTIONS.textSize);
  assert.equal(nextTextSize(DEFAULT_OPTIONS.textSize, 1), TEXT_SIZES[at + 1]);
  assert.equal(nextTextSize(DEFAULT_OPTIONS.textSize, -1), TEXT_SIZES[at - 1]);
  assert.equal(nextTextSize(TEXT_SIZES.at(-1), 1), TEXT_SIZES.at(-1));
  assert.equal(nextTextSize(TEXT_SIZES[0], -1), TEXT_SIZES[0]);
});

test('the theme of Windows leaves the page alone, and a chosen one marks it', () => {
  const { root } = page();
  applyOptions({ ...DEFAULT_OPTIONS, theme: 'dark' }, root);
  assert.equal(root.getAttribute('data-theme'), 'dark');
  applyOptions({ ...DEFAULT_OPTIONS, theme: 'light' }, root);
  assert.equal(root.getAttribute('data-theme'), 'light');
  applyOptions({ ...DEFAULT_OPTIONS, theme: 'system' }, root);
  assert.equal(root.hasAttribute('data-theme'), false);
});

test('the text size goes in the variable the style sheet reads', () => {
  const { root } = page();
  applyOptions({ ...DEFAULT_OPTIONS, textSize: 22 }, root);
  assert.equal(root.style.getPropertyValue('--text-size'), '22px');
});

test('the interface language is the chosen one, or the one of the system', () => {
  assert.equal(interfaceLang({ language: 'it' }, 'en-US'), 'it');
  assert.equal(interfaceLang({ language: 'en' }, 'it-IT'), 'en');
  assert.equal(interfaceLang({ language: 'system' }, 'it-IT'), 'it-IT');
});

test('the panel offers what the plan lists, in order, each showing its current value', () => {
  const options = { theme: 'dark', textSize: 22, sourceMode: 'name', epubView: 'scrolled', language: 'it' };
  const { host, field } = draw(options);
  assert.deepEqual(
    [...host.querySelectorAll('select')].map((select) => select.getAttribute('name')),
    ['theme', 'textSize', 'sourceMode', 'epubView', 'language'],
  );
  for (const [name, value] of Object.entries(options)) assert.equal(selected(field(name)), String(value), name);
  assert.deepEqual(values(field('theme')), ['system', 'light', 'dark']);
  assert.deepEqual(values(field('textSize')), TEXT_SIZES.map(String));
  assert.deepEqual(values(field('sourceMode')), ['skip', 'name']);
  assert.deepEqual(values(field('epubView')), ['paginated', 'scrolled']);
  assert.deepEqual(values(field('language')), ['system', 'it', 'en']);
});

for (const [lang, table] of Object.entries({ it, en })) {
  test(`the panel speaks ${lang}`, () => {
    setLang(lang);
    const { host, field } = draw();
    const keys = ['options.title', 'options.theme', 'options.textSize', 'options.source', 'options.epubView', 'options.language'];
    for (const key of keys) assert.ok(host.textContent.includes(table[key]), key);
    assert.equal(field('sourceMode').querySelector('option[value="name"]').textContent, table['options.sourceName']);
  });
}

test('a language is named in that language, whatever the interface speaks', () => {
  setLang('en');
  const { field } = draw();
  assert.equal(field('language').querySelector('option[value="it"]').textContent, 'Italiano');
  assert.equal(field('language').querySelector('option[value="en"]').textContent, 'English');
});

test('a change reports the value as the app stores it', () => {
  const { choose, changes } = draw();
  choose('theme', 'dark');
  choose('textSize', '22');
  assert.deepEqual(changes, [['theme', 'dark'], ['textSize', 22]]);
});
