// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LANG, getLang, pickLang, setLang, t } from '../app/core/i18n.js';
import it from '../app/lang/it.js';
import en from '../app/lang/en.js';

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// One key per user-visible message named by the spec, plus the plan's OpenError codes.
const REQUIRED_KEYS = [
  'app.unsupported',
  'open.error.not_found', 'open.error.unreadable', 'open.error.unsupported', 'open.error.timeout',
  'file.deleted', 'epub.error',
  'tabs.close',
  'recents.title', 'recents.empty', 'recents.missing', 'recents.remove',
  'bookmarks.title', 'bookmarks.empty', 'bookmarks.added', 'bookmarks.removed', 'bookmarks.missingFile',
  'toc.title', 'toc.empty',
  'options.title', 'options.theme', 'options.themeSystem', 'options.themeLight', 'options.themeDark',
  'options.textSize', 'options.voice', 'options.source', 'options.sourceSkip', 'options.sourceName',
  'options.epubView', 'options.epubPaginated', 'options.epubScrolled', 'options.language',
  'speech.readFromHere', 'speech.follow', 'speech.reading', 'speech.play', 'speech.pause', 'speech.resume',
  'speech.stop', 'speech.rate', 'speech.voice', 'speech.nothingToRead', 'speech.error',
  'speech.noVoice', 'speech.hiddenVoice', 'speech.sourceLabel',
  'lang.it', 'lang.en',
];

test('it and en have the same keys', () => assert.deepEqual(Object.keys(it).sort(), Object.keys(en).sort()));

test('every message the spec lists has a key', () => {
  for (const key of REQUIRED_KEYS) assert.ok(key in en, key);
});

test('no message is empty', () => {
  for (const [lang, table] of Object.entries({ it, en })) {
    for (const [key, text] of Object.entries(table)) {
      assert.ok(typeof text === 'string' && text.trim().length > 0, `${lang}: ${key}`);
    }
  }
});

test('both languages use the same placeholders', () => {
  for (const key of Object.keys(en)) assert.deepEqual(placeholders(it[key]), placeholders(en[key]), key);
});

// The labels of the Windows 10 Settings app: the message is useful only if its path can be followed.
test('the missing voice message names real Windows settings pages', () => {
  assert.ok(it['speech.voicePath'].includes('Data/ora e lingua > Riconoscimento vocale > Aggiungi voci'));
  assert.ok(en['speech.voicePath'].includes('Time & Language > Speech > Add voices'));
});

test('the language decides the text', () => {
  setLang('it');
  assert.equal(getLang(), 'it');
  assert.equal(t('recents.title'), it['recents.title']);
  setLang('en');
  assert.equal(getLang(), 'en');
  assert.equal(t('recents.title'), en['recents.title']);
});

test('placeholders are filled and unknown ones stay visible', () => {
  setLang('en');
  assert.ok(t('app.unsupported', { name: 'a.txt' }).includes('a.txt'));
  assert.ok(t('app.unsupported').includes('{name}'));
});

test('a value is inserted as is, even with special replacement characters', () => {
  setLang('en');
  assert.ok(t('app.unsupported', { name: "$&$'.txt" }).includes("$&$'.txt"));
});

test('a value of zero is still inserted', () => {
  setLang('en');
  assert.ok(t('speech.rate', { rate: 0 }).includes('0'));
});

test('an unknown key returns the key', () => {
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('pickLang reads the base language and falls back', () => {
  assert.equal(pickLang('it-IT'), 'it');
  assert.equal(pickLang('IT'), 'it');
  assert.equal(pickLang('en-GB'), 'en');
  assert.equal(pickLang('fr-FR'), DEFAULT_LANG);
  assert.equal(pickLang(undefined), DEFAULT_LANG);
});

test('setLang refuses an unknown language', () => {
  setLang('it');
  setLang('fr');
  assert.equal(getLang(), DEFAULT_LANG);
});
