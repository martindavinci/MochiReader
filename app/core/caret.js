// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @param {Document} doc
 * @param {number} x In the window of `doc`.
 * @param {number} y
 * @returns {{node: Node, offset: number}|null} The place in the text at that point.
 */
export function caretAt(doc, x, y) {
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}
