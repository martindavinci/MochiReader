// SPDX-License-Identifier: GPL-3.0-or-later

const DARK = 'dark';
const LIGHT = 'light';
const SYSTEM = 'system';
// The dark colours of app.css, which a frame cannot read from the page.
const DARK_TEXT = '#dddbd4';
const DARK_LINK = '#8ab8ec';
// What 1rem is in a page that sets no size of its own, so a book that sets none of the sizes below looks the same.
const DEFAULT_ROOT_PX = 16;
const REM_DIGITS = 4;
const PX_PER_UNIT = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};
// The sizes these names stand for in the default style of the browser, which ignores the size of the root.
const PX_PER_KEYWORD = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48,
};
const ABSOLUTE_LENGTH = /(\d*\.?\d+)(px|pt|pc|in|cm|mm|q)\b/gi;
// Longest first, so that `x-large` is not read as `large`. `small-caps`, `smaller` and `larger` are not sizes here.
const SIZE_KEYWORD = /(?<![\w-])(xxx-large|xx-large|x-large|xx-small|x-small|small|medium|large)(?![\w-])/i;
const SIZE_DECLARATION = /(^|[;{\s"'])(font-size|line-height|font)(\s*:\s*)([^;}]*)/gi;
const QUOTE = /["']/;
const DIGIT = /\d/;
const LINE_HEIGHT = 'line-height';
// A style element, or a tag with a style attribute. The text between tags stays out of it: a book may be about CSS.
const STYLES_OF_DOCUMENT = /<style\b[^>]*>[\s\S]*?<\/style\s*>|<[^<>]*\sstyle\s*=\s*(?:"[^"]*"|'[^']*')[^<>]*>/gi;

/** The sentence being read aloud, in any section of a book. */
export const HIGHLIGHT_RULE = '::highlight(mochi-tts) { background-color: rgb(255 200 60 / 45%); }';

/**
 * A dark page cannot keep the colours of a book: it may set a dark text and no background, or a white page that would
 * then hold light text. So on a dark page all text has one colour and nothing behind it has one. The images stay.
 */
const DARK_COLORS = `html, body { background: none !important; color: ${DARK_TEXT} !important; }
body * { background-color: transparent !important; color: inherit !important; }
body a { color: ${DARK_LINK} !important; }`;

const toRem = (px) => `${Number((px / DEFAULT_ROOT_PX).toFixed(REM_DIGITS))}rem`;

function relativeValue(property, value) {
  // Whatever is quoted is the name of a font.
  const quote = value.search(QUOTE);
  const end = quote < 0 ? value.length : quote;
  const sizes = value.slice(0, end).replace(ABSOLUTE_LENGTH, (_, number, unit) => toRem(number * PX_PER_UNIT[unit.toLowerCase()]));
  const named = property.toLowerCase() === LINE_HEIGHT || DIGIT.test(sizes)
    ? sizes
    : sizes.replace(SIZE_KEYWORD, (keyword) => toRem(PX_PER_KEYWORD[keyword.toLowerCase()]));
  return named + value.slice(end);
}

/**
 * The text size of the app is the size of the root, and an absolute size in a book would not follow it.
 * @param {string} css A style sheet, or the value of a style attribute.
 * @returns {string} The same style, with its text sizes and line heights in `rem`.
 */
export function relativeSizes(css) {
  return css.replace(SIZE_DECLARATION, (_, before, property, colon, value) => (
    `${before}${property}${colon}${relativeValue(property, value)}`
  ));
}

/**
 * @param {string} markup A serialized document, where a `<` in the text is always escaped.
 * @returns {string} The same document with `relativeSizes` applied to its styles and to nothing else.
 */
export function relativeDocumentSizes(markup) {
  return markup.replace(STYLES_OF_DOCUMENT, relativeSizes);
}

/**
 * The one style sheet of a reflowable book. Each call to the renderer replaces the one before, so it has it all.
 * The color scheme is always a single one: the frame of the book only keeps the background of the page if its scheme
 * is the scheme of the page, and it follows no media query from there.
 * @param {{theme: string, textSize: number}} options
 * @param {boolean} systemDark Whether Windows has a dark theme now.
 * @returns {string}
 */
export function bookStyle({ theme, textSize }, systemDark) {
  const dark = theme === SYSTEM ? systemDark : theme === DARK;
  return `html { color-scheme: ${dark ? DARK : LIGHT}; font-size: ${textSize}px !important; }
body { font-size: 1rem !important; }
${dark ? `${DARK_COLORS}\n` : ''}${HIGHLIGHT_RULE}`;
}
