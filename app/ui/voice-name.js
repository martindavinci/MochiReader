// SPDX-License-Identifier: GPL-3.0-or-later

// `Microsoft Mark - English (United States)`, which leaves little room for what tells two voices apart.
const WINDOWS_VOICE = /^Microsoft\s+(.+?)(?:\s+Desktop)?\s+-\s+(.+)$/;
const COUNTRY_SHORTENED = [[/\(United States\)/, '(US)'], [/\(United Kingdom\)/, '(UK)']];

/**
 * @param {string} name A voice as Windows names it.
 * @returns {string} The same voice in the words that tell it from another.
 */
export function shortVoiceName(name) {
  const parts = WINDOWS_VOICE.exec(name);
  if (!parts) return name;
  const place = COUNTRY_SHORTENED.reduce((text, [long, short]) => text.replace(long, short), parts[2]);
  return `${parts[1]} · ${place}`;
}
