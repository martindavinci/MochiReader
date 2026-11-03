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
 *   Markdown: `click` from the text and no `keydown`, because `keydown` already reaches the shell's document.
 *   EPUB: `keydown` and `click` from each section's document, because they do not leave the iframe.
 *   Both: `contextmenu`, for reading from a point in the text.
 * @property {(css: string) => void} setStyle Applies the theme and text size to the book. Markdown: no effect.
 * @property {() => Promise<boolean>} nextSpeechSection Moves to the next section to read; `false` means the end of
 *   reading. It rejects if the next section cannot be shown, which stops the reading with a message. Markdown: always
 *   `false`.
 * @property {() => Promise<boolean>} prevSpeechSection The same, backwards; `false` at the start. Markdown: always `false`.
 * @property {() => ({line: number, sentence: number}|{node: Node, offset: number}|null)} speechStart Where reading starts
 *   from here: a place in the source, or a point on the page, or nothing to say.
 * @property {(place: {range: Range|null, line: number|null, sentence: number, follow: boolean}) => void} speakAt The voice
 *   is on this sentence: until `speechStopped` it is the position, and if `follow` the reader brings it on screen.
 * @property {() => void} speechStopped The voice has stopped. Its sentence stays the position until the reader moves away.
 * @property {(cb: () => void) => void} onHandMove The reader scrolled by hand, which is not the voice taking them along.
 * @property {(cb: () => void) => void} [onSectionShown] Another section of a book came on screen.
 * @property {() => string} excerpt Short passage at the current point.
 * @property {(delta: 1|-1) => Promise<void>} [moveBlock] To the next or previous item or paragraph, if the format has them.
 * @property {(delta: 1|-1) => Promise<void>} [moveSection] To the next or previous section, if the format has them.
 * @property {string} [key] What the position of a book is saved under. It comes from the book itself.
 * @property {string} [title] The title a book declares, empty if none.
 * @property {() => Promise<void>} [goLeft] To the page on the left, if the format has pages.
 * @property {() => Promise<void>} [goRight] To the page on the right, if the format has pages.
 * @property {() => Promise<void>} [next] To the next page in reading order, if the format has pages.
 * @property {(flow: 'paginated'|'scrolled') => void} [setFlow] The view of a book.
 * @property {() => void} [focus] Sends the keys to the text, if the shell cannot do it by focusing the pane.
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
 * An entry of the contents of a book goes to `{kind: 'epub', href: string}`, which is not a position to save.
 */
