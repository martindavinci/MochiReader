// SPDX-License-Identifier: GPL-3.0-or-later

// The HTML comes from the sanitizer: every tag is lower case and closed, every attribute value is in double
// quotes, and `<` is only written as itself in tags and in attribute values. So this is all it takes to read it.
const TAG = /<(\/?)([a-z][a-z0-9]*)((?:[^>"]|"[^"]*")*)>/g;
const CLOSING_TAG_NEXT = /\s*<\//y;
const VOID_TAGS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'source', 'track', 'wbr']);
// Closed and opened again, these still read as one element. A cell or a `details` would not.
const CUTTABLE_TAGS = new Set(['blockquote', 'div', 'li', 'ol', 'p', 'section', 'table', 'tbody', 'thead', 'ul']);
const NOT_REPEATED_ATTRS = /\s(?:id|start)="[^"]*"/g;
const SOURCE_LINE_ATTR = /\sdata-sourcepos="[^"]*"/;
const START_ATTR = /\sstart="(\d+)"/;
const DEFAULT_START = 1;
const CONTINUED_ATTR = ' data-continued=""';
const SPLIT_ATTR = ' data-split=""';
// Inside a block a part can grow to this many times its size, so a block shorter than one part is never cut.
const INSIDE_BLOCK_PARTS = 2;

function openElement(name, attrs, tagEnd) {
  return { name, attrs, tagEnd, first: Number(START_ATTR.exec(attrs)?.[1] ?? DEFAULT_START), items: 0 };
}

function reopened(element, inner) {
  // A paragraph that goes on is still the same block at the top of the screen. The line of a list or a quote is
  // not where its later items are: as the top block it would send the reader back to its start.
  const repeated = element.name === 'p' ? element.attrs : element.attrs.replace(SOURCE_LINE_ATTR, '');
  const attrs = repeated.replace(NOT_REPEATED_ATTRS, '');
  if (element.name !== 'ol') return `<${element.name}${attrs}${CONTINUED_ATTR}>`;
  // An item left open has its number already, and counts it again when it goes on.
  const number = element.first + element.items - (inner?.name === 'li' ? 1 : 0);
  return `<${element.name}${attrs} start="${number}"${CONTINUED_ATTR}>`;
}

/** The text from `start` to `end`, saying so on a table of it that this cut splits for the first time. */
function bodyOf(html, start, end, open) {
  const table = open.find((element) => element.name === 'table' && element.tagEnd >= start);
  if (!table) return html.slice(start, end);
  return html.slice(start, table.tagEnd) + SPLIT_ATTR + html.slice(table.tagEnd, end);
}

/**
 * Cuts HTML in balanced parts of about `partChars` each, one at a time, so that the page can parse and lay out
 * each one apart. A block too long for one part, as a list or a table can be, goes on in the next part: what is
 * still open is closed and opened again, with `data-continued` and without its id. A numbered list keeps its
 * numbers. The first part of a table that goes on has `data-split`.
 * @param {string} html HTML from the sanitizer.
 * @param {number} partChars
 * @returns {Generator<string>}
 */
export function* htmlParts(html, partChars) {
  const open = [];
  let uncuttable = 0;
  let start = 0;
  let head = '';
  for (const { 0: tag, 1: closing, 2: name, 3: attrs, index } of html.matchAll(TAG)) {
    const end = index + tag.length;
    if (!closing) {
      if (VOID_TAGS.has(name)) continue;
      const parent = open.at(-1);
      if (name === 'li' && parent?.name === 'ol') parent.items += 1;
      open.push(openElement(name, attrs, end - 1));
      if (!CUTTABLE_TAGS.has(name)) uncuttable += 1;
      continue;
    }
    if (!CUTTABLE_TAGS.has(open.pop().name)) uncuttable -= 1;
    const room = open.length ? partChars * INSIDE_BLOCK_PARTS : partChars;
    // Text and inline elements directly in an item stay together: the item would look like two.
    if (uncuttable > 0 || open.at(-1)?.name === 'li' || head.length + end - start < room) continue;
    // The parent ends here anyway: cut after it, or the next part would open it just to close it.
    CLOSING_TAG_NEXT.lastIndex = end;
    if (CLOSING_TAG_NEXT.test(html)) continue;
    const closers = open.toReversed().map((element) => `</${element.name}>`).join('');
    yield head + bodyOf(html, start, end, open) + closers;
    head = open.map((element, at) => reopened(element, open[at + 1])).join('');
    start = end;
  }
  const rest = html.slice(start);
  if (rest.trim()) yield head + rest;
}
