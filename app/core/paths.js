// SPDX-License-Identifier: GPL-3.0-or-later

const SEPARATORS = /[\\/]/;
/** What the app opens. */
export const OPENABLE_EXTENSIONS = ['md', 'markdown', 'epub'];
const OPENABLE = new RegExp(`\\.(${OPENABLE_EXTENSIONS.join('|')})$`, 'i');

/** @param {string} path */
export function fileName(path) {
  return path.split(SEPARATORS).at(-1);
}

/** @param {string} path Whether the app can open the file in a tab. */
export function isSupported(path) {
  return OPENABLE.test(fileName(path));
}
