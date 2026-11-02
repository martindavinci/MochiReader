// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveKey } from '../app/core/keys.js';

const IDLE_MD = { speaking: false, kind: 'markdown' };
const IDLE_EPUB = { speaking: false, kind: 'epub' };
const SPEAKING_MD = { speaking: true, kind: 'markdown' };
const SPEAKING_EPUB = { speaking: true, kind: 'epub' };
const CONTEXTS = [IDLE_MD, IDLE_EPUB, SPEAKING_MD, SPEAKING_EPUB];

const inEveryContext = (event, action) => {
  for (const ctx of CONTEXTS) assert.equal(resolveKey(event, ctx), action, JSON.stringify(ctx));
};

test('ctrl+o, ctrl+w and ctrl+tab open, close and cycle tabs', () => {
  inEveryContext({ key: 'o', ctrl: true }, 'file.open');
  inEveryContext({ key: 'w', ctrl: true }, 'tab.close');
  inEveryContext({ key: 'Tab', ctrl: true }, 'tab.next');
});

test('ctrl+r, ctrl+b and ctrl+t open recents, bookmarks and the table of contents', () => {
  inEveryContext({ key: 'r', ctrl: true }, 'panel.recents');
  inEveryContext({ key: 'b', ctrl: true }, 'panel.bookmarks');
  inEveryContext({ key: 't', ctrl: true }, 'panel.toc');
});

test('ctrl+d toggles a bookmark', () => {
  inEveryContext({ key: 'd', ctrl: true }, 'bookmark.toggle');
});

test('caps lock does not change a ctrl shortcut', () => {
  assert.equal(resolveKey({ key: 'D', ctrl: true }, IDLE_MD), 'bookmark.toggle');
});

test('f5 and ctrl+shift+s start speech', () => {
  inEveryContext({ key: 'F5' }, 'speech.start');
  inEveryContext({ key: 'S', ctrl: true, shift: true }, 'speech.start');
  inEveryContext({ key: 's', ctrl: true, shift: true }, 'speech.start');
});

test('ctrl+s alone does nothing', () => {
  assert.equal(resolveKey({ key: 's', ctrl: true }, IDLE_MD), null);
});

test('space pauses only while speaking', () => {
  assert.equal(resolveKey({ key: ' ' }, SPEAKING_MD), 'speech.toggle');
  assert.equal(resolveKey({ key: ' ' }, SPEAKING_EPUB), 'speech.toggle');
  assert.equal(resolveKey({ key: ' ' }, IDLE_MD), 'scroll.page');
  assert.equal(resolveKey({ key: ' ' }, IDLE_EPUB), 'scroll.page');
});

test('arrows depend on speech', () => {
  assert.equal(resolveKey({ key: 'ArrowRight' }, { speaking: true, kind: 'epub' }), 'speech.nextSentence');
  assert.equal(resolveKey({ key: 'ArrowRight' }, { speaking: false, kind: 'epub' }), 'page.next');
  assert.equal(resolveKey({ key: 'ArrowRight' }, { speaking: false, kind: 'markdown' }), null);
  assert.equal(resolveKey({ key: 'ArrowRight' }, SPEAKING_MD), 'speech.nextSentence');
  assert.equal(resolveKey({ key: 'ArrowLeft' }, SPEAKING_EPUB), 'speech.prevSentence');
  assert.equal(resolveKey({ key: 'ArrowLeft' }, SPEAKING_MD), 'speech.prevSentence');
  assert.equal(resolveKey({ key: 'ArrowLeft' }, IDLE_EPUB), 'page.prev');
  assert.equal(resolveKey({ key: 'ArrowLeft' }, IDLE_MD), null);
});

test('shift+arrows move by item or paragraph', () => {
  assert.equal(resolveKey({ key: 'ArrowRight', shift: true }, SPEAKING_MD), 'speech.nextBlock');
  assert.equal(resolveKey({ key: 'ArrowLeft', shift: true }, SPEAKING_EPUB), 'speech.prevBlock');
  assert.equal(resolveKey({ key: 'ArrowRight', shift: true }, IDLE_MD), 'block.next');
  assert.equal(resolveKey({ key: 'ArrowLeft', shift: true }, IDLE_EPUB), 'block.prev');
});

test('ctrl+arrows move by section', () => {
  assert.equal(resolveKey({ key: 'ArrowRight', ctrl: true }, SPEAKING_EPUB), 'speech.nextSection');
  assert.equal(resolveKey({ key: 'ArrowLeft', ctrl: true }, SPEAKING_MD), 'speech.prevSection');
  assert.equal(resolveKey({ key: 'ArrowRight', ctrl: true }, IDLE_MD), 'section.next');
  assert.equal(resolveKey({ key: 'ArrowLeft', ctrl: true }, IDLE_EPUB), 'section.prev');
});

test('plus and minus are speed, ctrl plus and minus are zoom', () => {
  inEveryContext({ key: '+' }, 'speech.faster');
  inEveryContext({ key: '-' }, 'speech.slower');
  inEveryContext({ key: '+', ctrl: true }, 'text.bigger');
  inEveryContext({ key: '-', ctrl: true }, 'text.smaller');
});

test('plus works on layouts where it needs shift', () => {
  assert.equal(resolveKey({ key: '+', shift: true }, IDLE_MD), 'speech.faster');
  assert.equal(resolveKey({ key: '+', ctrl: true, shift: true }, IDLE_MD), 'text.bigger');
  assert.equal(resolveKey({ key: '=', ctrl: true }, IDLE_MD), 'text.bigger');
});

test('media play/pause toggles while speaking and starts otherwise', () => {
  assert.equal(resolveKey({ key: 'MediaPlayPause' }, SPEAKING_MD), 'speech.toggle');
  assert.equal(resolveKey({ key: 'MediaPlayPause' }, IDLE_EPUB), 'speech.start');
});

test('media previous and next move by sentence, only while speaking', () => {
  assert.equal(resolveKey({ key: 'MediaTrackNext' }, SPEAKING_EPUB), 'speech.nextSentence');
  assert.equal(resolveKey({ key: 'MediaTrackPrevious' }, SPEAKING_MD), 'speech.prevSentence');
  assert.equal(resolveKey({ key: 'MediaTrackNext' }, IDLE_MD), null);
  assert.equal(resolveKey({ key: 'MediaTrackPrevious' }, IDLE_EPUB), null);
});

test('ctrl+comma opens the options and escape closes a panel', () => {
  inEveryContext({ key: ',', ctrl: true }, 'panel.options');
  inEveryContext({ key: 'Escape' }, 'panel.close');
});

test('other keys and modifier combinations resolve to nothing', () => {
  assert.equal(resolveKey({ key: 'x' }, IDLE_MD), null);
  assert.equal(resolveKey({ key: 'o' }, IDLE_MD), null);
  assert.equal(resolveKey({ key: 'o', ctrl: true, shift: true }, IDLE_MD), null);
  assert.equal(resolveKey({ key: 'Tab' }, IDLE_MD), null);
  assert.equal(resolveKey({ key: 'Tab', ctrl: true, shift: true }, IDLE_MD), null);
  assert.equal(resolveKey({ key: 'F5', ctrl: true }, IDLE_MD), null);
  assert.equal(resolveKey({ key: ' ', shift: true }, SPEAKING_MD), null);
  assert.equal(resolveKey({ key: 'ArrowRight', ctrl: true, shift: true }, SPEAKING_MD), null);
});

test('alt, which altgr also sets, never triggers a shortcut', () => {
  assert.equal(resolveKey({ key: 'o', ctrl: true, alt: true }, IDLE_MD), null);
  assert.equal(resolveKey({ key: 'ArrowLeft', alt: true }, SPEAKING_MD), null);
  assert.equal(resolveKey({ key: '+', ctrl: true, alt: true }, IDLE_MD), null);
  assert.equal(resolveKey({ key: 'F5', alt: true }, IDLE_MD), null);
});
