// SPDX-License-Identifier: GPL-3.0-or-later

// Chords are written lower case, modifiers first: `ctrl+shift+s`.

/** Chords that always mean the same action. `+` needs shift on some layouts, and `=` is its unshifted key there. */
const FIXED = new Map([
  ['ctrl+o', 'file.open'],
  ['ctrl+w', 'tab.close'],
  ['ctrl+tab', 'tab.next'],
  ['ctrl+r', 'panel.recents'],
  ['ctrl+b', 'panel.bookmarks'],
  ['ctrl+t', 'panel.toc'],
  ['ctrl+,', 'panel.options'],
  ['escape', 'panel.close'],
  ['f1', 'panel.shortcuts'],
  ['?', 'panel.shortcuts'],
  ['shift+?', 'panel.shortcuts'],
  ['ctrl+d', 'bookmark.toggle'],
  ['f5', 'speech.start'],
  ['ctrl+shift+s', 'speech.start'],
  ['+', 'speech.faster'],
  ['shift++', 'speech.faster'],
  ['-', 'speech.slower'],
  ['ctrl++', 'text.bigger'],
  ['ctrl+shift++', 'text.bigger'],
  ['ctrl+=', 'text.bigger'],
  ['ctrl+-', 'text.smaller'],
]);

/** Chords whose action depends on speech: [while speech is active, otherwise]. */
const BY_SPEECH = new Map([
  [' ', ['speech.toggle', 'scroll.page']],
  ['shift+arrowleft', ['speech.prevBlock', 'block.prev']],
  ['shift+arrowright', ['speech.nextBlock', 'block.next']],
  ['ctrl+arrowleft', ['speech.prevSection', 'section.prev']],
  ['ctrl+arrowright', ['speech.nextSection', 'section.next']],
  ['mediaplaypause', ['speech.toggle', 'speech.start']],
  ['mediatrackprevious', ['speech.prevSentence', null]],
  ['mediatracknext', ['speech.nextSentence', null]],
]);

/** Plain arrows: [while speech is active, otherwise in a paginated format]. A Markdown view scrolls on its own. */
const ARROWS = new Map([
  ['arrowleft', ['speech.prevSentence', 'page.prev']],
  ['arrowright', ['speech.nextSentence', 'page.next']],
]);

/**
 * Maps a key press to the name of an action.
 * @param {{key: string, ctrl?: boolean, shift?: boolean, alt?: boolean}} event
 * @param {{speaking: boolean, kind: string}} ctx `speaking` is true while speech is active, even if paused.
 * @returns {string|null} The action, or null when the key is not a shortcut here. Alt is never one: AltGr sets it.
 */
export function resolveKey(event, ctx) {
  if (event.alt) return null;
  const chord = `${event.ctrl ? 'ctrl+' : ''}${event.shift ? 'shift+' : ''}${event.key.toLowerCase()}`;

  const fixed = FIXED.get(chord);
  if (fixed) return fixed;

  const bySpeech = BY_SPEECH.get(chord);
  if (bySpeech) return ctx.speaking ? bySpeech[0] : bySpeech[1];

  const arrow = ARROWS.get(chord);
  if (!arrow) return null;
  if (ctx.speaking) return arrow[0];
  return ctx.kind === 'epub' ? arrow[1] : null;
}
