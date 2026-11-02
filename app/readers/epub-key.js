// SPDX-License-Identifier: GPL-3.0-or-later

// foliate-js gives a plain string, or a map from language to title whose first
// entry is the title the book itself declares as its main one.
const mainTitle = (title) =>
  (title && typeof title === 'object' ? Object.values(title)[0] : title) ?? '';

/**
 * The key that recognises a book after its file has moved: its identifier joined
 * to its title or, without an identifier, the hash of the file.
 *
 * @param {{identifier?: string, title?: string | Record<string, string> | null}} metadata
 * @param {() => Promise<string>} hash computed only when the book has no identifier
 * @returns {Promise<string>}
 */
export async function epubKey(metadata, hash) {
  const { identifier, title } = metadata;
  if (!identifier) return `sha256:${await hash()}`;
  return `epub:${identifier}|${mainTitle(title)}`;
}
