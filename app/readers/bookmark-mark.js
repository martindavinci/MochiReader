// SPDX-License-Identifier: GPL-3.0-or-later
// The mark a bookmark leaves in a book: a small ribbon in the margin, beside the line it was put on. foliate draws it
// in the layer over each section, from the range of the bookmark, again whenever the pages are laid out anew.

const SVG = 'http://www.w3.org/2000/svg';
const ELEMENT_NODE = 1;
// What a bookmark stands beside: the piece of its paragraph in the column it is in.
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, figcaption, dt, dd, td, th, div, section';
// Some room for rounding when a point sits on the very edge of its column.
const EDGE_PX = 1;

export const MARK_WIDTH = 8;
export const MARK_HEIGHT = 13;
/** Between the mark and the text. */
export const MARK_GAP = 10;
// How deep the notch at the foot of the ribbon goes.
const NOTCH = 4;

/**
 * Where a mark goes: the left edge of the piece of the paragraph its point is in (a paragraph broken over two
 * columns has a piece in each), on the point's line.
 * @param {{left: number, top: number, height: number}} point
 * @param {{left: number, right: number, top: number, bottom: number}[]} pieces
 * @returns {{x: number, y: number, height: number}}
 */
export function markPlace(point, pieces) {
  const piece = [...pieces].find(({ left, right, top, bottom }) => point.left >= left - EDGE_PX && point.left <= right + EDGE_PX
    && point.top >= top - EDGE_PX && point.top <= bottom + EDGE_PX);
  return { x: piece?.left ?? point.left, y: point.top, height: point.height };
}

/** The box of a point: its own, or the one of the element it is in or before when it has none. */
function pointBox(range) {
  const [own] = range.getClientRects();
  if (own) return { element: range.startContainer.parentElement ?? range.startContainer, box: own };
  const { startContainer, startOffset } = range;
  const at = startContainer.nodeType === ELEMENT_NODE ? startContainer.childNodes[startOffset] ?? startContainer : startContainer;
  const element = at.nodeType === ELEMENT_NODE ? at : at.parentElement;
  const [box] = element?.getClientRects() ?? [];
  return box ? { element, box } : null;
}

/**
 * The mark of a bookmark, for foliate's overlayer: it is given the range of the bookmark, in its section.
 * @param {Range} range
 * @param {Document} document Where the mark is made.
 * @returns {SVGElement}
 */
export function drawBookmarkMark(range, document) {
  const mark = document.createElementNS(SVG, 'polygon');
  mark.setAttribute('style', 'fill: var(--accent)');
  const found = pointBox(range);
  if (!found) return mark;
  const block = found.element.closest?.(BLOCK) ?? found.element;
  const { x, y, height } = markPlace(found.box, [...block.getClientRects()]);
  const right = x - MARK_GAP;
  const left = right - MARK_WIDTH;
  const top = y + (height - MARK_HEIGHT) / 2;
  const bottom = top + MARK_HEIGHT;
  const middle = left + MARK_WIDTH / 2;
  mark.setAttribute('points', `${left},${top} ${right},${top} ${right},${bottom} ${middle},${bottom - NOTCH} ${left},${bottom}`);
  return mark;
}
