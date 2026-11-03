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
 * @property {(cb: (e: KeyboardEvent|MouseEvent) => void) => void} onInput Input the shell would not otherwise see.
 *   Markdown: only `click` from the text, because `keydown` already reaches the shell's document.
 *   EPUB: `keydown` and `click` from each section's document, because they do not leave the iframe.
 * @property {(css: string) => void} setStyle Applies the theme and text size to the book. Markdown: no effect.
 * @property {() => Promise<boolean>} nextSpeechSection Moves to the next section to read; `false` means the end of
 *   reading. Markdown: always `false`.
 * @property {() => string} excerpt Short passage at the current point.
 * @property {(delta: 1|-1) => Promise<void>} [moveBlock] To the next or previous item or paragraph, if the format has them.
 * @property {(delta: 1|-1) => Promise<void>} [moveSection] To the next or previous section, if the format has them.
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
