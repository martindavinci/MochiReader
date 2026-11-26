// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { setLang } from '../app/core/i18n.js';
import en from '../app/lang/en.js';
import { mountBookChrome } from '../app/ui/book-chrome.js';

const PROGRESS = {
  chapter: 1, chapters: 3, label: '', page: 0, pages: 0, percent: 10, parts: [{ weight: 1, done: 10 }],
  next: '', atStart: true, atEnd: false, scrolled: true, damaged: false,
};

function fakeTranslation(main = null) {
  const changes = [];
  const progress = [];
  return {
    current: main,
    shownProgress: null,
    main() { return this.current; },
    progress() { return this.shownProgress; },
    onChange: (callback) => changes.push(callback),
    onProgress: (callback) => progress.push(callback),
    change(next) { this.current = next; changes.forEach((callback) => callback(next)); },
    advance(value) { this.shownProgress = value; progress.forEach((callback) => callback(value)); },
  };
}

function mount(translation) {
  setLang('en');
  const { document, window } = parseHTML('<!doctype html><html><body><div class="pane"><foliate-view></foliate-view></div></body></html>');
  globalThis.document = document;
  const pane = document.querySelector('.pane');
  const reader = { translation, progress: () => PROGRESS, onProgress: () => {}, goLeft() {}, goRight() {}, moveSection() {} };
  const chosen = [];
  const chrome = mountBookChrome(pane, reader, { title: 'A book', onChapter: () => {}, onTranslate: (main) => chosen.push(main) });
  const click = (element) => element.dispatchEvent(new window.Event('click'));
  return { pane, chrome, chosen, click };
}

test('the switch is absent for a fixed layout', () => {
  const { pane } = mount(null);
  assert.equal(pane.querySelector('.book-translate'), null);
  assert.equal(pane.querySelector('.book-head').textContent, 'A book');
});

test('Originale and Tradotto say which is the main language and ask for the other', () => {
  const translation = fakeTranslation(null);
  const { pane, chosen, click } = mount(translation);
  const [original, translated] = pane.querySelectorAll('.book-translate button');
  assert.equal(original.textContent, en['translate.original']);
  assert.equal(translated.textContent, en['translate.translated']);
  assert.equal(original.getAttribute('aria-pressed'), 'true');
  assert.equal(translated.getAttribute('aria-pressed'), 'false');
  click(translated);
  assert.deepEqual(chosen, ['translated']);
  translation.change('translated');
  assert.equal(translated.getAttribute('aria-pressed'), 'true');
  assert.match(pane.querySelector('.book-head').textContent, /A book/);
});

test('while the book is being translated the head says how far it is', () => {
  const translation = fakeTranslation('translated');
  const { pane } = mount(translation);
  const status = pane.querySelector('.book-translate-status');
  assert.equal(status.hidden, true);
  translation.advance({ done: 3, total: 10 });
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, en['translate.progress'].replace('{done}', '3').replace('{total}', '10'));
  translation.advance({ done: 10, total: 10 });
  assert.equal(status.hidden, true);
});

test('the offer of a model download is answered once', () => {
  const { pane, chrome, click } = mount(fakeTranslation(null));
  let accepted = 0;
  chrome.offerDownload({ text: 'English → Italian, 37 MB', onAccept: () => { accepted += 1; } });
  const offer = pane.querySelector('.book-offer');
  assert.equal(offer.hidden, false);
  assert.match(offer.textContent, /37 MB/);
  const [later, download] = offer.querySelectorAll('button');
  assert.equal(later.textContent, en['translate.later']);
  click(download);
  assert.equal(accepted, 1);
  assert.equal(offer.hidden, true);
});

test('a status can be shown by hand, as a download goes', () => {
  const { pane, chrome } = mount(fakeTranslation(null));
  chrome.showStatus('Downloading 40%');
  const status = pane.querySelector('.book-translate-status');
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'Downloading 40%');
  chrome.showStatus(null);
  assert.equal(status.hidden, true);
});
