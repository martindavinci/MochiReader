// SPDX-License-Identifier: GPL-3.0-or-later

const SEPARATORS = /[\\/]/;
const OPENABLE = /\.(md|markdown|epub)$/i;

/** @param {string} path */
export function fileName(path) {
  return path.split(SEPARATORS).at(-1);
}

/** @param {string} path Whether the app can open the file in a tab. */
export function isSupported(path) {
  return OPENABLE.test(fileName(path));
}
