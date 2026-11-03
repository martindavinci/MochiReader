// SPDX-License-Identifier: GPL-3.0-or-later

export const SAVE_DEBOUNCE_MS = 500;

/** The keys that scroll the text while the voice reads. Space is not one of them: then it pauses. */
export const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

const NO_LINE = 0;
const NO_BLOCK = -1;
const SOURCEPOS_LINE = /^(\d+):/;

/**
 * @param {string|null|undefined} attr A `data-sourcepos` value, such as `12:1-14:3`.
 * @returns {number} The block's first source line, or 0 if the value has none.
 */
export function lineFromSourcepos(attr) {
  const match = SOURCEPOS_LINE.exec(attr ?? '');
  return match ? Number(match[1]) : NO_LINE;
}

/**
 * @param {number[]} lines The first source line of each block.
 * @param {number} line
 * @returns {number} The index of the block closest to `line`, the earlier one on a tie, or -1 with no blocks.
 */
export function nearestBlock(lines, line) {
  let best = NO_BLOCK;
  let bestDistance = Infinity;
  lines.forEach((candidate, index) => {
    const distance = Math.abs(candidate - line);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * @param {(...args: any[]) => void} fn
 * @param {number} ms
 * @returns {((...args: any[]) => void) & {cancel: () => void}} Runs `fn` once, `ms` after the last call, with the
 *   arguments of that call. `cancel` drops a pending run.
 */
export function debounce(fn, ms) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}
