// SPDX-License-Identifier: GPL-3.0-or-later

/** Between a place in the blocks of a document, {block, sentence}, and what the page or the saved position say. */

const FOLLOWS = 4;
const PRECEDES = 2;
const ELEMENT_NODE = 1;

const lastLeaf = (node) => {
  let leaf = node;
  while (leaf.lastChild) leaf = leaf.lastChild;
  return leaf;
};

const leafLength = (leaf) => leaf.data?.length ?? 0;

/** A point on an element names one of its children, or the end of them: as a point on a leaf it compares with any other. */
function toLeaf(node, offset) {
  if (node.nodeType !== ELEMENT_NODE) return { node, offset };
  const child = node.childNodes[offset];
  if (child) return { node: child, offset: 0 };
  const leaf = lastLeaf(node);
  return { node: leaf, offset: leafLength(leaf) };
}

/** Below zero if `a` comes first, above if it comes later. Inside a node seen from outside counts by where that node starts. */
function comparePoints(a, b) {
  if (a.node === b.node) return a.offset - b.offset;
  const relation = a.node.compareDocumentPosition(b.node);
  if (relation & FOLLOWS) return -1;
  return relation & PRECEDES ? 1 : 0;
}

function* eachSentence(blocks) {
  for (let block = 0; block < blocks.length; block += 1) {
    const { sentences } = blocks[block];
    for (let sentence = 0; sentence < sentences.length; sentence += 1) {
      // Text the app added is nowhere on the page.
      if (sentences[sentence].start) yield { block, sentence, start: sentences[sentence].start, end: sentences[sentence].end };
    }
  }
}

/**
 * @param {import('./extract.js').Sentence} sentence
 * @returns {Range|null} What it covers on the page; null for text the app added.
 */
export function sentenceRange({ start, end }) {
  if (!start) return null;
  const range = start.node.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/**
 * @param {{pointAt?: (index: number) => {node: Node, offset: number}|null}} sentence
 * @param {number} start
 * @param {number} end UTF-16 units of the text of the sentence, as an engine tells a word.
 * @returns {Range|null} The word on the page: from its first unit that is on it to its last. Null for a word the app
 *   added, which is nowhere on the page.
 */
export function wordRange(sentence, start, end) {
  if (!sentence?.pointAt || !(start < end)) return null;
  let first = null;
  let from = start;
  for (; from < end && !first; from += 1) first = sentence.pointAt(from);
  let last = null;
  let to = end - 1;
  for (; to >= start && !last; to -= 1) last = sentence.pointAt(to);
  if (!first || !last || from - 1 > to + 1) return null;
  const range = first.node.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/** @returns {{block: number, sentence: number}|null} The sentence around a point, or the next one; null past the last. */
export function sentenceAt(blocks, node, offset) {
  const point = toLeaf(node, offset);
  for (const { block, sentence, end } of eachSentence(blocks)) {
    if (comparePoints(point, end) < 0) return { block, sentence };
  }
  return null;
}

/**
 * Where to start reading a page, which can open on the tail of a sentence begun on the page before.
 * @returns {{block: number, sentence: number}|null} The first sentence that starts at the point or later; if none does,
 *   the sentence around it.
 */
export function sentenceFrom(blocks, node, offset) {
  const point = toLeaf(node, offset);
  for (const { block, sentence, start } of eachSentence(blocks)) {
    if (comparePoints(point, start) <= 0) return { block, sentence };
  }
  return sentenceAt(blocks, node, offset);
}

/**
 * A block has its source line, and a line can hold several blocks: the cells of a table row.
 * @returns {{line: number|null, sentence: number}} The line of a place, and the number of its sentence on that line.
 */
export function lineOfPlace(blocks, { block, sentence }) {
  const { line } = blocks[block];
  if (line === null) {
    const before = blocks.slice(0, block).findLast((other) => other.line !== null);
    return { line: before?.line ?? null, sentence: 0 };
  }
  const earlier = blocks.slice(0, block).filter((other) => other.line === line);
  return { line, sentence: earlier.reduce((sum, other) => sum + other.sentences.length, sentence) };
}

/**
 * @param {{line: number, sentence: number}} position From a position, saved perhaps by an older version of the file.
 * @returns {{block: number, sentence: number}} The place it stands for; on the closest line if that one is gone.
 */
export function placeOfLine(blocks, { line, sentence }) {
  let closest = -1;
  let distance = Infinity;
  blocks.forEach((block, index) => {
    const away = Math.abs((block.line ?? Infinity) - line);
    if (away < distance) {
      closest = index;
      distance = away;
    }
  });
  if (closest < 0) return { block: 0, sentence: 0 };
  let left = sentence;
  let at = closest;
  while (left >= blocks[at].sentences.length && blocks[at + 1]?.line === blocks[closest].line) {
    left -= blocks[at].sentences.length;
    at += 1;
  }
  return { block: at, sentence: Math.min(left, blocks[at].sentences.length - 1) };
}
