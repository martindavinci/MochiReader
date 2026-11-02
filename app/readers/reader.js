// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The contract every format implements, so speech, position and bookmarks do not tell the formats apart.
 *
 * @typedef {Object} Reader
 * @property {'markdown'|'epub'} kind
 * @property {string|null} lang
 * @property {() => TocEntry[]} toc
 * @property {() => Position} position Current point.
 * @property {(p: Position) => Promise<void>} goTo
 * @property {() => Promise<SpeechRoot[]>} speechRoots
 * @property {(cb: (p: Position) => void) => void} onMove
 * @property {() => string} excerpt Short passage at the current point.
 * @property {() => void} destroy
 */

/**
 * @typedef {Object} TocEntry
 * @property {string} label
 * @property {*} target
 */

/**
 * @typedef {Object} SpeechRoot
 * @property {Element} root
 * @property {*} section
 */

/**
 * @typedef {{kind: 'md', line: number, sentence: number} | {kind: 'epub', cfi: string, sentence: number}} Position
 */
