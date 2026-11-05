// SPDX-License-Identifier: GPL-3.0-or-later

const DARK = 'dark';
const LIGHT = 'light';
const SYSTEM = 'system';
// The colours of app.css, which a frame cannot read from the page.
const COLORS = {
  [LIGHT]: { text: '#24231f', link: '#1f5fa8', line: '#e2dfd6', lineStrong: '#8e8a7f', surface: '#f2f0ea', mark: '#fde6a6', markText: '#24231f' },
  [DARK]: { text: '#dddbd4', link: '#8ab8ec', line: '#3b3a36', lineStrong: '#7c786e', surface: '#252523', mark: '#5a4819', markText: '#f6f1e4' },
};
const BOOK_FACE = '"Sitka Text", Sitka, Cambria, Georgia, serif';
const HEADING_FACE = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
const CODE_FACE = '"Cascadia Mono", Consolas, ui-monospace, monospace';
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

/** The sentence being read aloud on a fixed page, which keeps its own colours whatever the theme of the app. */
export const HIGHLIGHT_RULE = '::highlight(mochi-tts) { background-color: rgb(255 200 60 / 45%); }';

/**
 * A dark page cannot keep the colours of a book: it may set a dark text and no background, or a white page that would
 * then hold light text. So on a dark page all text has one colour and nothing behind it has one. The images stay.
 */
const DARK_COLORS = `html, body { background: none !important; color: ${COLORS[DARK].text} !important; }
body * { background-color: transparent !important; color: inherit !important; }
body a { color: ${COLORS[DARK].link} !important; }`;

/**
 * The house style of a book. Only the face of the body and of the headings is imposed: `:where` weighs nothing, so
 * whatever the book says about its own margins, quotes or tables wins over the rest, and a passage set in a face of its
 * own keeps it.
 */
const houseStyle = ({ line, lineStrong, surface, link }) => `body { font-family: ${BOOK_FACE} !important; line-height: 1.62; text-wrap: pretty; hyphens: auto; -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4, h5, h6 { font-family: ${HEADING_FACE} !important; font-weight: 650; line-height: 1.2; text-wrap: balance; hyphens: manual; }
:where(h1) { font-size: 1.75em; margin: 0 0 .9em; letter-spacing: -.01em; }
:where(h2) { font-size: 1.35em; margin: 1.6em 0 .5em; }
:where(h3) { font-size: 1.12em; margin: 1.4em 0 .4em; }
:where(p) { margin: 0 0 .85em; }
:where(a) { color: ${link}; text-decoration-thickness: 1px; text-underline-offset: .2em; }
:where(blockquote) { margin: 1.2em 0; padding-left: 1.1em; border-left: 2px solid ${lineStrong}; }
:where(hr) { border: 0; border-top: 1px solid ${line}; margin: 2em 25%; }
:where(code, pre, kbd) { font-family: ${CODE_FACE}; font-size: .86em; }
:where(pre) { padding: .9em 1.1em; border-radius: 10px; background: ${surface}; white-space: pre-wrap; }
:where(table) { border-collapse: collapse; font-size: .92em; }
:where(th, td) { padding: .4em .8em .4em 0; border-bottom: 1px solid ${line}; text-align: left; }`;

const themedHighlight = ({ mark, markText }) => `::highlight(mochi-tts) { background-color: ${mark}; color: ${markText}; }
@media (forced-colors: active) { ::highlight(mochi-tts) { background-color: Mark; color: MarkText; } }`;

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
  const colors = COLORS[dark ? DARK : LIGHT];
  return `html { color-scheme: ${dark ? DARK : LIGHT}; font-size: ${textSize}px !important; color: ${colors.text}; }
body { font-size: 1rem !important; }
${houseStyle(colors)}
${dark ? `${DARK_COLORS}\n` : ''}${themedHighlight(colors)}`;
}
