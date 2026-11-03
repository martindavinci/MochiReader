// SPDX-License-Identifier: GPL-3.0-or-later
// What the speech tests need of a browser and linkedom does not have. Not a test: the name keeps it out of the run.

/** A Range with only what the app asks of one. */
export class FakeRange {
  setStart(node, offset) {
    this.startContainer = node;
    this.startOffset = offset;
  }

  setEnd(node, offset) {
    this.endContainer = node;
    this.endOffset = offset;
  }

  toString() {
    if (this.startContainer === this.endContainer) return this.startContainer.data.slice(this.startOffset, this.endOffset);
    return `${this.startContainer.data.slice(this.startOffset)}${this.endContainer.data.slice(0, this.endOffset)}`;
  }

  getBoundingClientRect() {
    return this.box ?? { top: 0, bottom: 0, width: 0, height: 0 };
  }
}

const DOCUMENT_POSITION_PRECEDING = 2;
const DOCUMENT_POSITION_FOLLOWING = 4;

const pathOf = (node) => {
  const path = [];
  for (let at = node; at.parentNode; at = at.parentNode) path.unshift([...at.parentNode.childNodes].indexOf(at));
  return path;
};

/** Document order, which linkedom gets wrong for nodes that are not related. */
function compareDocumentPosition(other) {
  const mine = pathOf(this);
  const theirs = pathOf(other);
  const first = mine.findIndex((step, index) => step !== theirs[index]);
  if (first < 0) return mine.length === theirs.length ? 0 : DOCUMENT_POSITION_FOLLOWING;
  if (first >= theirs.length) return DOCUMENT_POSITION_PRECEDING;
  return mine[first] < theirs[first] ? DOCUMENT_POSITION_FOLLOWING : DOCUMENT_POSITION_PRECEDING;
}

/** Gives a linkedom document ranges, and a window with highlights: each `Highlight` remembers its ranges. */
export function withHighlights(document, window = document.defaultView) {
  Object.getPrototypeOf(Object.getPrototypeOf(Object.getPrototypeOf(document.createTextNode('')))).compareDocumentPosition = compareDocumentPosition;
  document.createRange = () => new FakeRange();
  window.CSS = { ...window.CSS, highlights: new Map() };
  window.Highlight = class {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  };
  return window;
}
