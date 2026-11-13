// SPDX-License-Identifier: GPL-3.0-or-later

/** The name the style sheets of the app and of a book draw, in `::highlight(mochi-tts)`. */
export const HIGHLIGHT_NAME = 'mochi-tts';
/** The word being said, over the sentence: `::highlight(mochi-tts-word)`. */
export const WORD_HIGHLIGHT_NAME = 'mochi-tts-word';

/**
 * The sentence being read, in the window of its own document: a section of a book has a window of its own, and a
 * Highlight only counts in the window that made it.
 */
export function createHighlighter() {
  let shownIn = null;

  const clear = () => {
    try {
      shownIn?.CSS.highlights.delete(HIGHLIGHT_NAME);
      shownIn?.CSS.highlights.delete(WORD_HIGHLIGHT_NAME);
    } catch (error) {
      // Its frame may have been closed by now, and took the highlight with it.
      console.warn(error);
    }
    shownIn = null;
  };

  return {
    /** @param {Range} range */
    show(range) {
      const window = range.startContainer.ownerDocument.defaultView;
      if (shownIn !== window) clear();
      if (!window) return;
      window.CSS.highlights.set(HIGHLIGHT_NAME, new window.Highlight(range));
      window.CSS.highlights.delete(WORD_HIGHLIGHT_NAME);
      shownIn = window;
    },
    /** @param {Range} range A word of the sentence shown. */
    showWord(range) {
      const window = range.startContainer.ownerDocument.defaultView;
      if (!window || window !== shownIn) return;
      window.CSS.highlights.set(WORD_HIGHLIGHT_NAME, new window.Highlight(range));
    },
    clearWord() {
      try {
        shownIn?.CSS.highlights.delete(WORD_HIGHLIGHT_NAME);
      } catch (error) {
        console.warn(error);
      }
    },
    clear,
  };
}
