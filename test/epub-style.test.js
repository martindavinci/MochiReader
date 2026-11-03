// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookStyle, HIGHLIGHT_RULE } from '../app/readers/epub-style.js';

test('the style of a book names its color scheme, its text size and the highlight', () => {
  const dark = bookStyle({ theme: 'dark', textSize: 20 }, false);
  assert.match(dark, /html \{[^}]*color-scheme: dark;/);
  assert.match(dark, /font-size: 20px/);
  assert.ok(dark.includes(HIGHLIGHT_RULE));
  assert.match(HIGHLIGHT_RULE, /::highlight\(mochi-tts\)/);
});

test('a chosen theme does not depend on the one of Windows', () => {
  assert.match(bookStyle({ theme: 'light', textSize: 17 }, true), /color-scheme: light;/);
  assert.match(bookStyle({ theme: 'dark', textSize: 17 }, false), /color-scheme: dark;/);
});

test('with the theme of Windows the style of a book takes the one Windows has now', () => {
  assert.match(bookStyle({ theme: 'system', textSize: 17 }, true), /color-scheme: dark;/);
  assert.match(bookStyle({ theme: 'system', textSize: 17 }, false), /color-scheme: light;/);
});

test('the text size wins over a size the book sets on its body', () => {
  assert.match(bookStyle({ theme: 'light', textSize: 24 }, false), /body \{[^}]*font-size: 1rem !important;/);
});
