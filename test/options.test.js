// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { setLang } from '../app/core/i18n.js';
import en from '../app/lang/en.js';
import it from '../app/lang/it.js';
import {
  applyOptions,
  renderVoiceOptions,
  COPYRIGHT_NOTICE,
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
  let asked = 0;
  renderOptions(host, options, {
    onChange: (name, value) => changes.push([name, value]),
    onLicenses: () => {
      asked += 1;
    },
  });
  const field = (name) => host.querySelector(`select[name="${name}"]`);
  const pick = (name, value) => host.querySelector(`input[name="${name}"][value="${value}"]`).dispatchEvent(new Event('change'));
  const choose = (name, value) => {
    const select = field(name);
    // linkedom reads the value of a list from this attribute, and offers no other way to set it.
    select.querySelectorAll('option').forEach((option) => option.toggleAttribute('selected', option.getAttribute('value') === value));
    select.dispatchEvent(new Event('change'));
  };
  const click = (element) => element.dispatchEvent(new Event('click'));
  return { host, field, pick, choose, changes, click, licensesAsked: () => asked };
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

const radios = (host, name) => [...host.querySelectorAll(`input[name="${name}"]`)];
const radioValues = (host, name) => radios(host, name).map((input) => input.getAttribute('value'));
const checked = (host, name) => radios(host, name).find((input) => input.hasAttribute('checked'))?.getAttribute('value');

test('the panel offers what the plan lists, in order, each showing its current value', () => {
  const options = { theme: 'dark', textSize: 22, sourceMode: 'name', epubView: 'scrolled', language: 'it' };
  const { host } = draw(options);
  assert.deepEqual(radioValues(host, 'theme'), ['system', 'light', 'dark']);
  assert.deepEqual(radioValues(host, 'sourceMode'), ['skip', 'name']);
  assert.deepEqual(radioValues(host, 'epubView'), ['paginated', 'scrolled']);
  assert.deepEqual(values(host.querySelector('select[name="language"]')), ['system', 'en', 'it', 'de', 'es', 'fr', 'pt-BR', 'ja', 'ko', 'zh-CN']);
  assert.equal(selected(host.querySelector('select[name="language"]')), 'it');
  for (const name of ['theme', 'sourceMode', 'epubView']) assert.equal(checked(host, name), options[name], name);
  assert.equal(host.querySelector('.stepper output').textContent, '22');
});

test('the size goes a step at a time, and stops at each end of the list', () => {
  const smallest = draw({ ...DEFAULT_OPTIONS, textSize: TEXT_SIZES[0] });
  const [down, up] = smallest.host.querySelectorAll('.stepper button');
  assert.ok(down.hasAttribute('disabled'));
  smallest.click(up);
  assert.deepEqual(smallest.changes, [['textSize', TEXT_SIZES[1]]]);
  assert.ok(draw({ ...DEFAULT_OPTIONS, textSize: TEXT_SIZES.at(-1) }).host.querySelectorAll('.stepper button')[1].hasAttribute('disabled'));
});

test('the panel gives the notices of the license and a way to read it', () => {
  setLang('en');
  const { host, click, licensesAsked } = draw();
  const about = host.querySelector('.about');
  assert.ok(about.textContent.includes(COPYRIGHT_NOTICE));
  assert.ok(about.textContent.includes(en['about.short']));
  const button = about.querySelector('button');
  assert.equal(button.textContent, en['about.licenses']);
  assert.equal(licensesAsked(), 0);
  click(button);
  assert.equal(licensesAsked(), 1);
});

test('the notice says what the license requires in both languages', () => {
  assert.match(en['about.notice'], /no warranty/i);
  assert.match(en['about.notice'], /GNU General Public License/);
  assert.match(it['about.notice'], /nessuna garanzia/i);
  assert.match(it['about.notice'], /GNU General Public License/);
  assert.match(en['about.short'], /no warranty/i);
  assert.match(it['about.short'], /nessuna garanzia/i);
});

for (const [lang, table] of Object.entries({ it, en })) {
  test(`the panel speaks ${lang}`, () => {
    setLang(lang);
    const { host } = draw();
    const keys = ['options.title', 'options.theme', 'options.textSize', 'options.source', 'options.epubView', 'options.language'];
    for (const key of keys) assert.ok(host.textContent.includes(table[key]), key);
    assert.equal(host.querySelector('input[name="sourceMode"][value="name"]').parentElement.textContent, table['options.sourceName']);
  });
}

test('a language is named in that language, whatever the interface speaks', () => {
  setLang('en');
  const { host } = draw();
  const name = (value) => host.querySelector(`select[name="language"] option[value="${value}"]`).textContent;
  assert.deepEqual(['it', 'en', 'de', 'ja', 'zh-CN'].map(name), ['Italiano', 'English', 'Deutsch', '日本語', '中文（简体）']);
});

test('a change reports the value as the app stores it', () => {
  const { host, pick, click, changes } = draw({ ...DEFAULT_OPTIONS, textSize: 20 });
  pick('theme', 'dark');
  click(host.querySelectorAll('.stepper button')[1]);
  assert.deepEqual(changes, [['theme', 'dark'], ['textSize', 22]]);
});

const GROUPS = [
  { lang: 'en', name: 'English', voices: [{ id: 'zira', name: 'Zira' }], selected: 'zira' },
  { lang: 'it', name: 'Italian', voices: [{ id: 'elsa', name: 'Elsa' }, { id: 'cosimo', name: 'Cosimo' }], selected: 'cosimo' },
];

test('each language with voices gets a list of them, with the last used selected', () => {
  setLang('en');
  const { host, field } = draw();
  renderVoiceOptions(host, GROUPS, () => {});
  assert.deepEqual(values(field('voice-it')), ['elsa', 'cosimo']);
  assert.equal(selected(field('voice-it')), 'cosimo');
  assert.equal(selected(field('voice-en')), 'zira');
  const label = field('voice-it').closest('label').querySelector('span').textContent;
  assert.ok(label.includes('Italian'), label);
});

test('the voices come before the notices at the bottom of the panel, and drawing them again replaces them', () => {
  const { host } = draw();
  renderVoiceOptions(host, GROUPS, () => {});
  renderVoiceOptions(host, GROUPS, () => {});
  assert.equal(host.querySelectorAll('select[name="voice-it"]').length, 1);
  assert.ok(host.querySelector('.about').previousElementSibling.closest('.panel-body') === host.querySelector('.voice-options').parentElement);
  const parts = [...host.querySelector('.panel-body').children];
  assert.ok(parts.indexOf(host.querySelector('.voice-options')) < parts.indexOf(host.querySelector('.about')));
});

test('choosing a voice says for which language', () => {
  const { host, choose } = draw();
  const chosen = [];
  renderVoiceOptions(host, GROUPS, (lang, id) => chosen.push([lang, id]));
  choose('voice-it', 'elsa');
  assert.deepEqual(chosen, [['it', 'elsa']]);
});
