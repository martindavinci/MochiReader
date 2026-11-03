// SPDX-License-Identifier: GPL-3.0-or-later
// A section of a book is the one kind of file that gets a frame of its own, so what a frame needs is settled here,
// on the way in: nothing runs in that frame that could fix it later.

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const XHTML_TYPE = 'application/xhtml+xml';
const HTML_TYPE = 'text/html';
const SVG_TYPE = 'image/svg+xml';
const PICTURE_TYPE = /^image\//;
const XML_TYPE = /[/+]xml$/;
const SPACES = /\s+/;
const PARSE_ERROR = 'parsererror';
// Chromium connects for these before the CSP has its say, and for a prerender it sends the request too. A frame does
// not need to load to do it, whatever it names, and a base makes a remote address of any relative one. A template
// would hide all of this from the check here, and the HTML parser of the frame can turn it into a shadow root.
const REACHING_OUT = 'iframe, frame, frameset, base, template';
const LINK = 'link';
const LINK_RELATION = 'rel';
// Every other kind of link is a hint to the browser, and a book has no use for those.
const STYLE_LINK_KINDS = new Set(['stylesheet', 'alternate']);
const NO_LOOKUPS = [['http-equiv', 'x-dns-prefetch-control'], ['content', 'off']];
const EMPTY_PAGE = `<html xmlns="${XHTML_NAMESPACE}"><head></head><body></body></html>`;
const UNREADABLE_MARK = 'data-unreadable-section';

/** Browsers read a type in any case and with parameters. foliate only recognizes the exact words. */
const essenceOf = (type) => (type ?? '').split(';')[0].trim().toLowerCase();

const isPicture = (essence) => PICTURE_TYPE.test(essence) && essence !== SVG_TYPE;

function isStyleLink(link) {
  const kinds = (link.getAttribute(LINK_RELATION) ?? '').toLowerCase().split(SPACES).filter(Boolean);
  return kinds.length > 0 && kinds.every((kind) => STYLE_LINK_KINDS.has(kind));
}

function removeWhatReachesOut(doc) {
  doc.querySelectorAll(REACHING_OUT).forEach((element) => element.remove());
  [...doc.querySelectorAll(LINK)].filter((link) => !isStyleLink(link)).forEach((link) => link.remove());
}

const isPagePart = (element, name) => element.localName === name && element.namespaceURI === XHTML_NAMESPACE;

/**
 * The paginator reads the body of a frame in a listener, where a failure is lost and the book hangs on that page, with
 * no way out. It styles a frame through its head.
 */
function givePageItsParts(doc) {
  const part = (name) => doc.createElementNS(XHTML_NAMESPACE, name);
  const root = doc.documentElement;
  if (isPagePart(root, 'html')) {
    const parts = [...root.children];
    if (!parts.some((element) => isPagePart(element, 'head'))) root.prepend(part('head'));
    if (!parts.some((element) => isPagePart(element, 'body'))) root.append(part('body'));
    return;
  }
  const page = part('html');
  const body = part('body');
  doc.doctype?.remove();
  doc.replaceChild(page, root);
  page.append(part('head'), body);
  body.append(root);
}

/** The mouse over a link is enough for the browser to look up its host, and this is the one way to tell it not to. */
function keepHostsUnasked(doc) {
  const head = [...doc.documentElement.children].find((element) => isPagePart(element, 'head'));
  if (!head) return;
  const meta = doc.createElementNS(XHTML_NAMESPACE, 'meta');
  NO_LOOKUPS.forEach(([name, value]) => meta.setAttribute(name, value));
  head.prepend(meta);
}

/**
 * @param {string} [type] The type the book declares for a section.
 * @param {boolean} fixed Whether the book is of fixed pages.
 * @returns {string} What the section is served as.
 */
export function sectionType(type, fixed) {
  const essence = essenceOf(type);
  if (isPicture(essence)) return type;
  if (essence === HTML_TYPE) return HTML_TYPE;
  // A fixed page takes its size from the root of an SVG, and has no use for a body.
  return fixed && essence === SVG_TYPE ? SVG_TYPE : XHTML_TYPE;
}

/**
 * @param {string|Blob} file The section, as foliate has it: as text if it recognized the type.
 * @param {string} [type] The type the book declares for it.
 * @param {{fixed: boolean, parser: {parseFromString: (text: string, type: string) => Document},
 *   serializer: {serializeToString: (doc: Document) => string}}} tools
 * @returns {Promise<string|Blob>} What the frame of the section gets. A picture stays as it is: the browser draws it on
 *   a page with a body. A file of any kind a browser would not show as a page becomes an empty page.
 */
export async function sectionPage(file, type, { fixed, parser, serializer }) {
  const essence = essenceOf(type);
  if (isPicture(essence)) return file;
  const isHtml = essence === HTML_TYPE;
  if (!isHtml && !XML_TYPE.test(essence)) return EMPTY_PAGE;
  const text = typeof file === 'string' ? file : await file.text();
  const doc = parser.parseFromString(text, isHtml ? HTML_TYPE : XHTML_TYPE);
  if (!isHtml && doc.querySelector(PARSE_ERROR)) return EMPTY_PAGE;
  removeWhatReachesOut(doc);
  if (!fixed) givePageItsParts(doc);
  keepHostsUnasked(doc);
  return serializer.serializeToString(doc);
}

const unreadablePage = (message) => {
  const text = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  return `<!doctype html><html><head><title></title></head><body><p ${UNREADABLE_MARK}="">${text}</p></body></html>`;
};

/** @returns {boolean} Whether `doc` is the page that takes the place of a section that could not be read. */
export const isUnreadablePage = (doc) => Boolean(doc.querySelector(`[${UNREADABLE_MARK}]`));

/**
 * foliate has no answer to a section that does not load. The paginator loses its place in the book and every move with
 * it, and shows nothing about it, so the reader is stuck on the page before. Here every section loads: one that cannot be
 * read is a page saying so, a place in the book like any other, and the keys go on from it.
 * @param {{load: () => Promise<string|null>, unload?: () => void}[]} sections
 * @param {string} message
 */
export function keepSectionsLoading(sections, message) {
  for (const section of sections) {
    const { load, unload } = section;
    let standIn = null;
    section.load = async () => {
      try {
        const url = await load.call(section);
        if (url) return url;
      } catch (error) {
        console.warn(error);
      }
      standIn ??= URL.createObjectURL(new Blob([unreadablePage(message)], { type: HTML_TYPE }));
      return standIn;
    };
    section.unload = () => {
      if (standIn) URL.revokeObjectURL(standIn);
      standIn = null;
      unload?.call(section);
    };
  }
}
