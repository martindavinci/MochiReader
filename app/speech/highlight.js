// SPDX-License-Identifier: GPL-3.0-or-later

/** The name the style sheets of the app and of a book draw, in `::highlight(mochi-tts)`. */
export const HIGHLIGHT_NAME = 'mochi-tts';

/**
 * The sentence being read, in the window of its own document: a section of a book has a window of its own, and a
 * Highlight only counts in the window that made it.
 */
export function createHighlighter() {
  let shownIn = null;

  const clear = () => {
    try {
      shownIn?.CSS.highlights.delete(HIGHLIGHT_NAME);
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
      shownIn = window;
    },
    clear,
  };
}
