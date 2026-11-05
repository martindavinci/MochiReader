// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bookStyle,
  HIGHLIGHT_RULE,
  relativeDocumentSizes,
  relativeSizes,
} from '../app/readers/epub-style.js';

test('the style of a book names its color scheme, its text size and the highlight', () => {
  const dark = bookStyle({ theme: 'dark', textSize: 20 }, false);
  assert.match(dark, /html \{[^}]*color-scheme: dark;/);
  assert.match(dark, /font-size: 20px/);
  assert.match(dark, /::highlight\(mochi-tts\) \{ background-color: #5a4819; color: #f6f1e4; \}/);
  assert.match(bookStyle({ theme: 'light', textSize: 20 }, true), /::highlight\(mochi-tts\) \{ background-color: #fde6a6; color: #24231f; \}/);
  assert.match(HIGHLIGHT_RULE, /::highlight\(mochi-tts\)/);
});

test('a book has the face of the house for its text and its headings, and keeps the rest of its own style', () => {
  const style = bookStyle({ theme: 'light', textSize: 18 }, false);
  assert.match(style, /body \{ font-family: "Sitka Text"[^}]*!important/);
  assert.match(style, /h1, h2, h3, h4, h5, h6 \{ font-family: "Segoe UI Variable Display"[^}]*!important/);
  // Weighing nothing, these lose to any rule of the book.
  assert.match(style, /:where\(p\) \{/);
  assert.match(style, /:where\(blockquote\) \{/);
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

test('a dark page takes every text and background of the book, so none can be dark on dark', () => {
  const dark = bookStyle({ theme: 'dark', textSize: 17 }, false);
  assert.match(dark, /html, body \{[^}]*background: none !important;[^}]*color: #[0-9a-f]+ !important;/);
  assert.match(dark, /body \* \{[^}]*color: inherit !important;/);
  assert.match(dark, /body \* \{[^}]*background-color: transparent !important;/);
  assert.match(dark, /body a \{[^}]*color: #[0-9a-f]+ !important;/);
});

test('with the theme of Windows the colours of a dark Windows apply too', () => {
  assert.match(bookStyle({ theme: 'system', textSize: 17 }, true), /color: inherit !important/);
});

test('a light page leaves the book its colours', () => {
  assert.doesNotMatch(bookStyle({ theme: 'light', textSize: 17 }, false), /color: inherit|background: none/);
  assert.doesNotMatch(bookStyle({ theme: 'system', textSize: 17 }, false), /color: inherit|background: none/);
});

test('the text size wins over a size the book sets on its root', () => {
  assert.match(bookStyle({ theme: 'light', textSize: 24 }, false), /html \{[^}]*font-size: 24px !important;/);
});

test('absolute sizes of a book become sizes relative to the root, at the same size by default', () => {
  assert.equal(relativeSizes('p{font-size:12pt}'), 'p{font-size:1rem}');
  assert.equal(relativeSizes('p { font-size: 24px; color: red }'), 'p { font-size: 1.5rem; color: red }');
  assert.equal(relativeSizes('p{font-size:1pc}'), 'p{font-size:1rem}');
  assert.equal(relativeSizes('p{font-size:0.5in}'), 'p{font-size:3rem}');
  assert.equal(relativeSizes('p{font-size:10.5pt !important}'), 'p{font-size:0.875rem !important}');
  assert.equal(relativeSizes('P{FONT-SIZE: 12PT}'), 'P{FONT-SIZE: 1rem}');
});

test('size keywords are absolute too, and the relative ones stay', () => {
  assert.equal(relativeSizes('p{font-size:medium}'), 'p{font-size:1rem}');
  assert.equal(relativeSizes('p{font-size:x-large}'), 'p{font-size:1.5rem}');
  assert.equal(relativeSizes('p{font-size:small}'), 'p{font-size:0.8125rem}');
  assert.equal(relativeSizes('p{font-size:smaller}'), 'p{font-size:smaller}');
  assert.equal(relativeSizes('p{font-size:larger}'), 'p{font-size:larger}');
});

test('sizes that already follow the text stay as they are', () => {
  const css = 'p{font-size:1.2em} h1{font-size:150%} h2{font-size:2rem} h3{line-height:1.4}';
  assert.equal(relativeSizes(css), css);
});

test('an absolute line height grows with the text, or the lines would run into each other', () => {
  assert.equal(relativeSizes('p{line-height:18pt}'), 'p{line-height:1.5rem}');
});

test('the font shorthand gives its size and line height, and nothing else', () => {
  assert.equal(
    relativeSizes('p{font: italic bold 12pt/18pt "Font 10pt", serif}'),
    'p{font: italic bold 1rem/1.5rem "Font 10pt", serif}',
  );
  assert.equal(relativeSizes('p{font: small-caps 12pt serif}'), 'p{font: small-caps 1rem serif}');
  assert.equal(relativeSizes('p{font: large serif}'), 'p{font: 1.125rem serif}');
  assert.equal(relativeSizes('p{font: 1.2em serif}'), 'p{font: 1.2em serif}');
});

test('other lengths and other names are left alone', () => {
  const css = 'p{margin:12pt;width:100px} .font-size:hover{color:red} @media (min-width:600px){a{b:c}} p{letter-spacing:1px}';
  assert.equal(relativeSizes(css), css);
});

test('in a document only its styles change, never its text', () => {
  const page = '<p style="color: red; font-size: 12pt">font-size: 12pt</p><style>a{font-size:24px}</style><code>font-size: 12pt</code>';
  assert.equal(
    relativeDocumentSizes(page),
    '<p style="color: red; font-size: 1rem">font-size: 12pt</p><style>a{font-size:1.5rem}</style><code>font-size: 12pt</code>',
  );
});
