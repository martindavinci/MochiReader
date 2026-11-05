// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { setLang } from '../app/core/i18n.js';
import en from '../app/lang/en.js';
import { renderHome } from '../app/ui/home.js';
import { shortVoiceName } from '../app/ui/voice-name.js';

const LABELS = { title: 'Recent', empty: 'None', missing: 'Not found', remove: 'Remove' };
const RECENT = { path: 'C:\\x\\a.md', kind: 'markdown', title: 'a.md', exists: true };

function draw(recents) {
  setLang('en');
  const { document, Event } = parseHTML('<!doctype html><html><body><section id="home"></section></body></html>');
  const host = document.getElementById('home');
  const asked = [];
  renderHome(host, recents, {
    labels: LABELS,
    onOpen: (path) => asked.push(['open', path]),
    onRemove: (path) => asked.push(['remove', path]),
    onOpenFile: () => asked.push(['openFile']),
    onBookmarks: () => asked.push(['bookmarks']),
    onOptions: () => asked.push(['options']),
    onClear: () => asked.push(['clear']),
  });
  return { host, asked, click: (element) => element.dispatchEvent(new Event('click')) };
}

test('with nothing opened yet the page welcomes, and offers to open a file and the keys worth knowing', () => {
  const { host, asked, click } = draw([]);
  assert.equal(host.querySelector('.welcome h1').textContent, en['home.welcome']);
  assert.equal(host.querySelector('.recents'), null);
  assert.deepEqual([...host.querySelectorAll('.keys .kbd')].map((key) => key.textContent), ['F5', 'Ctrl+D', '← →']);
  click(host.querySelector('.btn-primary'));
  assert.deepEqual(asked, [['openFile']]);
});

test('with recent files the page lists them instead, with the way to open another and to empty the list', () => {
  const { host, asked, click } = draw([RECENT]);
  assert.equal(host.querySelector('.welcome'), null);
  assert.equal(host.querySelector('.recents-title').textContent, 'Recent');
  click(host.querySelector('.recent-open'));
  click(host.querySelector('.recents-clear'));
  click(host.querySelector('.btn-primary'));
  assert.deepEqual(asked, [['open', 'C:\\x\\a.md'], ['clear'], ['openFile']]);
});

test('the head offers the bookmarks and the options, which have no other way in without a key', () => {
  const { host, asked, click } = draw([]);
  const [bookmarks, options] = host.querySelectorAll('.home-tools button');
  click(bookmarks);
  click(options);
  assert.deepEqual(asked, [['bookmarks'], ['options']]);
  assert.equal(bookmarks.getAttribute('aria-keyshortcuts'), 'Ctrl+B');
});

test('a Windows voice goes by the words that tell it from another', () => {
  assert.equal(shortVoiceName('Microsoft Mark - English (United States)'), 'Mark · English (US)');
  assert.equal(shortVoiceName('Microsoft Hazel Desktop - English (United Kingdom)'), 'Hazel · English (UK)');
  assert.equal(shortVoiceName('Microsoft Cosimo - Italian (Italy)'), 'Cosimo · Italian (Italy)');
  assert.equal(shortVoiceName('Some Other Voice'), 'Some Other Voice');
});
