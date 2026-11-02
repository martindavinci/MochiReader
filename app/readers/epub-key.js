// SPDX-License-Identifier: GPL-3.0-or-later

// foliate-js gives a plain string, or a map from language to title whose first
// entry is the title the book itself declares as its main one.
const mainTitle = (title) =>
  (title && typeof title === 'object' ? Object.values(title)[0] : title) ?? '';

/**
 * The key that recognises a book after its file has moved: its identifier joined
 * to its title and section count or, without an identifier, the hash of the file.
 * The section count is there because volumes of one series can declare the same
 * identifier and title, and a saved position only makes sense in its own spine.
 * It is optional only to keep the plain `epub:<identifier>|<title>` form: the
 * reader must pass it, or those volumes share one position and their bookmarks.
 *
 * @param {{identifier?: string, title?: string | Record<string, string> | null}} metadata
 * @param {() => Promise<string>} hash computed only when the book has no identifier
 * @param {number} [sectionCount] the number of sections in the spine
 * @returns {Promise<string>}
 */
export async function epubKey(metadata, hash, sectionCount) {
  const { identifier, title } = metadata;
  if (!identifier) return `sha256:${await hash()}`;
  const key = `epub:${identifier}|${mainTitle(title)}`;
  return sectionCount === undefined ? key : `${key}|${sectionCount}`;
}
