// SPDX-License-Identifier: GPL-3.0-or-later

const DARK = 'dark';
const LIGHT = 'light';
const SYSTEM = 'system';

/** The sentence being read aloud, in any section of a book. */
export const HIGHLIGHT_RULE = '::highlight(mochi-tts) { background-color: rgb(255 200 60 / 45%); }';

/**
 * The one style sheet of a reflowable book. Each call to the renderer replaces the one before, so it has it all.
 * The color scheme is always a single one: the frame of the book only keeps the background of the page if its scheme
 * is the scheme of the page, and it follows no media query from there.
 * @param {{theme: string, textSize: number}} options
 * @param {boolean} systemDark Whether Windows has a dark theme now.
 * @returns {string}
 */
export function bookStyle({ theme, textSize }, systemDark) {
  const dark = theme === SYSTEM ? systemDark : theme === DARK;
  return `html { color-scheme: ${dark ? DARK : LIGHT}; font-size: ${textSize}px; }
body { font-size: 1rem !important; }
${HIGHLIGHT_RULE}`;
}
