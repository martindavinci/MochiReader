// SPDX-License-Identifier: GPL-3.0-or-later
// Nothing of foliate-js loads until the first book opens: a Markdown file never pays for it.
import { debounce, SAVE_DEBOUNCE_MS, SCROLL_KEYS } from '../core/position.js';
import { HIGHLIGHT_RULE, relativeDocumentSizes, relativeSizes } from './epub-style.js';
import { epubKey, mainTitle } from './epub-key.js';
import { isUnreadablePage, keepSectionsLoading, sectionPage, sectionType } from './epub-section.js';
import { excerptOf } from './excerpt.js';

export { epubKey, mainTitle };

const FOLIATE_VIEW_TAG = 'foliate-view';
// foliate tells some other formats by the name of the file, and here it is always a book.
const BOOK_FILE_NAME = 'book.epub';
const ENCRYPTION_FILE = 'META-INF/encryption.xml';
const XML_ENCRYPTION_NAMESPACE = 'http://www.w3.org/2001/04/xmlenc#';
// These only hide fonts from being copied out of the book. Anything else hides the text.
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);
const XML_TYPE = 'application/xml';
const NOT_IN_READING_ORDER = 'no';
const FIRST_SENTENCE = 0;
const SPREAD_START = 'left';
const COLUMN_COUNT = '1';
// About 70 characters at the default size, like the text of a Markdown file.
const COLUMN_WIDTH = '660px';
// The paginator ignores a move while it turns a page, which takes it about 100 ms.
const BUSY_RETRY_MS = 150;
const BUSY_RETRIES = 10;
const SPACES = /\s+/g;
// A spread with one page keeps a frame next to it that never loads anything, so it has no listeners.
const EMPTY_FRAME_URL = 'about:blank';
const FIXED_LAYOUT = 'pre-paginated';
const STYLE_SHEET_TYPE = 'text/css';
const DOCUMENT_TYPES = new Set(['application/xhtml+xml', 'text/html', 'image/svg+xml']);
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, dt, dd, figure, div, tr';
const PICTURES = 'img, svg, image';
const TEXT_NODE = 3;
const SECTION_START = 0;
const SECTION_END = 1;
const FILE_NAME = /^.*\/|\.[^.]*$/g;
const LINKS = 'a, area';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
// Why foliate moved. A change of layout keeps a place, and a swipe is the one move by hand with no key to see.
const MOVED_BY_LAYOUT = 'anchor';
const MOVED_BY_SWIPE = 'snap';

const pause = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const importFoliate = () => import('../vendor/foliate/view.js');

/**
 * @param {{language?: string|string[]}} [metadata]
 * @returns {string|null} The language of the book, the first if it names several.
 */
export function bookLang(metadata) {
  return [metadata?.language].flat()[0] ?? null;
}

/**
 * foliate does not fail on a protected book, it shows its encrypted chapters as garbage.
 * @param {string|null|undefined} encryptionXml The encryption file of the book, if it has one.
 * @param {{parseFromString: (text: string, type: string) => Document}} [parser]
 * @returns {boolean} Whether something in the book is encrypted by more than font obfuscation.
 */
export function isDrmProtected(encryptionXml, parser = new DOMParser()) {
  if (!encryptionXml) return false;
  const doc = parser.parseFromString(encryptionXml, XML_TYPE);
  const methods = [...doc.getElementsByTagNameNS(XML_ENCRYPTION_NAMESPACE, 'EncryptionMethod')];
  return methods.some((method) => !FONT_OBFUSCATION.has(method.getAttribute('Algorithm')));
}

/** An entry can hold only a picture, and foliate gives it no text. It is still a way into the book. */
const nameOfFile = (href) => (href ?? '').split('#')[0].replace(FILE_NAME, '');

/**
 * @param {{label: string|null, href: string, subitems?: object[]}[]} [toc] As foliate reads it from the book.
 * @returns {import('./reader.js').TocEntry[]}
 */
export function flattenToc(toc, level = 1) {
  return (toc ?? []).flatMap(({ label, href, subitems }) => [
    { label: label?.trim() || nameOfFile(href), level, target: { kind: 'epub', href } },
    ...flattenToc(subitems, level + 1),
  ]);
}

// With more parts than this a bar of chapters is only a row of dots: it becomes one bar.
const MOST_PROGRESS_PARTS = 40;
const FULL = 100;
// The paginator keeps an empty page at each end of a section.
const SPARE_PAGES = 2;

/**
 * @param {object} view
 * @returns {import('./reader.js').BookProgress} Told from what foliate knows about the place on screen.
 */
export function bookProgress(view) {
  const { book, renderer, lastLocation: location, isFixedLayout: fixed } = view;
  const shown = shownIndex(view);
  const order = book.sections
    .map((section, index) => ({ index, size: section.size || 1, linear: section.linear }))
    .filter(({ linear }) => linear !== NOT_IN_READING_ORDER);
  const scrolled = Boolean(renderer.scrolled);
  const paged = !fixed && !scrolled;
  const pages = paged ? Math.max(renderer.pages - SPARE_PAGES, 1) : null;
  const page = paged ? Math.min(Math.max(renderer.page, 1), pages) : null;
  const seen = scrolled ? renderer.start / (renderer.viewSize || 1) : (page ?? 1) / (pages ?? 1);

  // A chapter is an entry at the top of the contents, whatever is inside it. Without contents, each section is one.
  const chapters = book.toc ?? [];
  const href = location?.tocItem?.href;
  const holds = ({ href: at, subitems }) => at === href || (subitems ?? []).some(holds);
  const listed = href ? chapters.findIndex(holds) : -1;
  const inOrder = order.findIndex(({ index }) => index === shown);
  const parts = order.length > MOST_PROGRESS_PARTS
    ? [{ weight: 1, done: Math.round((location?.fraction ?? 0) * FULL) }]
    : order.map(({ index, size }) => ({
      weight: size,
      done: index < shown ? FULL : index === shown ? Math.round(seen * FULL) : 0,
    }));

  const after = paged && page === pages ? order.find(({ index }) => index > shown) : null;
  const label = location?.tocItem?.label?.trim() ?? '';
  const nextLabel = after ? view.getProgressOf?.(after.index)?.tocItem?.label?.trim() ?? '' : '';
  return {
    chapter: (listed >= 0 ? listed : Math.max(inOrder, 0)) + 1,
    chapters: listed >= 0 ? chapters.length : order.length,
    label,
    page,
    pages,
    percent: Math.round((location?.fraction ?? 0) * FULL),
    parts,
    next: nextLabel === label ? '' : nextLabel,
    atStart: Boolean(renderer.atStart),
    atEnd: Boolean(renderer.atEnd),
    scrolled,
    damaged: false,
  };
}

const hasOwnText = (element) => [...element.childNodes]
  .some((node) => node.nodeType === TEXT_NODE && node.textContent.trim());

/**
 * @param {Element} body The body of a section.
 * @returns {Element[]} The places to stop at, in order: the innermost blocks, and an outer one for its own text.
 */
export function readingBlocks(body) {
  return [...body.querySelectorAll(BLOCKS)].filter((element) => {
    if (element.getClientRects?.().length === 0) return false;
    if (element.querySelector(BLOCKS)) return hasOwnText(element);
    return Boolean(element.textContent.trim() || element.querySelector(PICTURES));
  });
}

/**
 * @param {Element[]} blocks
 * @param {Range} shown
 * @param {1|-1} delta
 * @returns {Element|null} The first block that starts after `shown`, or the last that ends before it.
 */
export function blockFrom(blocks, shown, delta) {
  const found = delta > 0
    ? blocks.find((block) => shown.comparePoint(block, 0) > 0)
    : blocks.findLast((block) => shown.comparePoint(block, block.childNodes.length) < 0);
  return found ?? null;
}

/** A page can hold many blocks and shows them all, so only what is past the page is a move. Scrolling, the top decides. */
function shownPart({ renderer, lastLocation }) {
  const range = lastLocation?.range;
  if (!range || !renderer.scrolled) return range ?? null;
  const top = range.cloneRange();
  top.collapse(true);
  return top;
}

function neighbourSection(view, index, delta) {
  const { sections } = view.book;
  for (let at = index + delta; at >= 0 && at < sections.length; at += delta) {
    if (sections[at].linear !== NOT_IN_READING_ORDER) {
      return view.renderer.goTo({ index: at, anchor: delta > 0 ? SECTION_START : SECTION_END });
    }
  }
  return undefined;
}

const spreadOfSection = ({ renderer, book }) => renderer.getSpreadOf(book.sections[renderer.index]).index;

async function nextSpread(view) {
  const spread = spreadOfSection(view);
  await view.renderer.goToSpread(spread + 1, SPREAD_START);
  return spreadOfSection(view) !== spread;
}

const shownIndex = ({ renderer }) => renderer.getContents()[0]?.index;

/**
 * Moves on to the next section to read aloud.
 * @param {object} view The foliate view.
 * @param {(ms: number) => Promise<void>} [wait]
 * @returns {Promise<boolean>} `false` at the end of the reading order.
 * @throws {Error} If no section can be shown, because reading can neither go on nor say it has finished.
 */
export async function nextSpeechSection(view, wait = pause) {
  if (view.isFixedLayout) return nextSpread(view);
  const current = shownIndex(view);
  if (current === undefined) throw new Error('no section on screen');
  const hasNext = view.book.sections.some((section, index) => index > current && section.linear !== NOT_IN_READING_ORDER);
  if (!hasNext) return false;
  for (let left = BUSY_RETRIES; left > 0; left -= 1) {
    await view.renderer.nextSection();
    const shown = shownIndex(view);
    if (shown === undefined) throw new Error('the next section could not be shown');
    if (shown !== current) return true;
    await wait(BUSY_RETRY_MS);
  }
  throw new Error('the next section did not come');
}

/**
 * Moves back to the section before, to read it aloud.
 * @param {object} view The foliate view.
 * @returns {Promise<boolean>} `false` at the start of the reading order.
 * @throws {Error} If no section can be shown.
 */
export async function prevSpeechSection(view) {
  if (view.isFixedLayout) {
    const spread = spreadOfSection(view);
    await view.renderer.goToSpread(spread - 1, SPREAD_START);
    return spreadOfSection(view) !== spread;
  }
  const current = shownIndex(view);
  if (current === undefined) throw new Error('no section on screen');
  const index = view.book.sections.findLastIndex((section, at) => at < current && section.linear !== NOT_IN_READING_ORDER);
  if (index < 0) return false;
  await view.renderer.goTo({ index });
  if (shownIndex(view) === undefined) throw new Error('the section before could not be shown');
  return true;
}

function closeView(view) {
  try {
    view.close();
  } catch (error) {
    // A view that never showed a page has nothing to close, and fails on it.
    console.warn(error);
  }
  view.book?.destroy?.();
  view.remove();
}

/**
 * foliate only follows `a[href]`, and it does so first. Any other link, in SVG or in an image map, would be followed
 * by the browser, in the frame of the section: the page would be gone, and the keys with it.
 */
function followOtherLinks(view, doc, index, openExternal) {
  doc.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const link = event.target.closest?.(LINKS);
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') ?? link.getAttributeNS(XLINK_NAMESPACE, 'href');
    if (!href) return;
    const { book } = view;
    const target = book.sections[index]?.resolveHref?.(href) ?? href;
    if (book.isExternal?.(target)) openExternal(href);
    else view.goTo(target);
  });
}

/** @returns {(callback: (event: Event) => void) => void} What the reader offers as `onInput`. */
function watchSections(view, openExternal, handCallbacks) {
  const callbacks = [];
  const pass = (event) => callbacks.forEach((callback) => callback(event));
  // A book on pages has nothing to scroll: its pages only turn with the keys of the app.
  const handMoved = () => {
    if (view.renderer.scrolled) handCallbacks.forEach((callback) => callback());
  };
  // Out here means on the scrollbar: everything else is inside the frame.
  view.addEventListener('pointerdown', handMoved);
  view.addEventListener('load', ({ detail: { doc, index } }) => {
    followOtherLinks(view, doc, index, openExternal);
    // None of these leaves the frame of the section, and a new section is a new frame.
    doc.addEventListener('keydown', pass);
    doc.addEventListener('click', pass);
    doc.addEventListener('contextmenu', pass);
    doc.addEventListener('wheel', handMoved, { passive: true });
    doc.addEventListener('keydown', ({ key }) => {
      if (SCROLL_KEYS.has(key)) handMoved();
    });
    if (!view.isFixedLayout || !doc.head) return;
    // A fixed layout takes no style from the renderer, and keeps its own colours and sizes.
    const style = doc.createElement('style');
    style.textContent = HIGHLIGHT_RULE;
    doc.head.append(style);
  });
  return (callback) => callbacks.push(callback);
}

/**
 * The contract of `reader.js` over a foliate view that already shows a page.
 * @param {object} view
 * @param {{key?: string, title?: string, onInput?: (callback: (event: Event) => void) => void,
 *   place?: {cfi: string, sentence?: number}|null, handCallbacks?: (() => void)[]}} info `place` is where the page on
 *   screen was asked for, which can be anywhere inside it.
 * @returns {import('./reader.js').Reader}
 */
export function makeReader(view, { key, title, onInput = () => {}, place = null, handCallbacks = [] }) {
  const moveCallbacks = [];
  const sectionCallbacks = [];
  // A page only says where it starts, and a place inside it holds for as long as it stays on screen.
  const held = (at) => (at?.cfi
    ? { cfi: at.cfi, sentence: at.sentence ?? FIRST_SENTENCE, page: view.lastLocation?.cfi, section: shownIndex(view) }
    : null);
  let holding = held(place);
  // The sentence the voice is on. While it reads this is the position, wherever the reader has scrolled to.
  let spoken = null;

  const placeHeld = () => spoken ?? (holding?.page === view.lastLocation?.cfi ? holding : null);

  const position = () => {
    const at = placeHeld();
    return { kind: 'epub', cfi: at?.cfi ?? view.lastLocation.cfi, sentence: at?.sentence ?? FIRST_SENTENCE };
  };

  const onRelocate = ({ detail }) => {
    if (holding && detail?.reason === MOVED_BY_LAYOUT && detail.index === holding.section) holding.page = view.lastLocation?.cfi;
    else if (holding?.page !== view.lastLocation?.cfi) holding = null;
    if (detail?.reason === MOVED_BY_SWIPE) handCallbacks.forEach((callback) => callback());
  };
  view.renderer.addEventListener('relocate', onRelocate);
  const onSectionLoad = () => sectionCallbacks.forEach((callback) => callback());
  view.addEventListener('load', onSectionLoad);

  /** Whether the page on screen shows the start of `range`. A page of another document does not. */
  const onPage = ({ startContainer, startOffset }) => {
    const shown = view.lastLocation?.range;
    if (shown?.startContainer?.ownerDocument !== startContainer.ownerDocument) return false;
    return shown.comparePoint(startContainer, startOffset) === 0;
  };

  const placeOf = (range) => {
    if (view.isFixedLayout) return view.lastLocation.cfi;
    const shown = view.renderer.getContents().find(({ doc }) => doc === range.startContainer.ownerDocument);
    return view.getCFI(shown?.index ?? shownIndex(view), range);
  };

  const pointOf = ({ cfi }) => {
    try {
      const doc = view.renderer.getContents()[0]?.doc;
      const range = view.resolveCFI(cfi).anchor(doc);
      return { node: range.startContainer, offset: range.startOffset };
    } catch (error) {
      console.warn(error);
      return null;
    }
  };

  const progressCallbacks = [];
  const notifyProgress = () => progressCallbacks.forEach((callback) => callback());
  view.addEventListener('relocate', notifyProgress);

  const notifyMove = debounce(() => {
    const at = position();
    moveCallbacks.forEach((callback) => callback(at));
  }, SAVE_DEBOUNCE_MS);
  view.addEventListener('relocate', notifyMove);

  const shownDocs = () => view.renderer.getContents().filter(({ doc }) => doc?.body && doc.URL !== EMPTY_FRAME_URL);

  const moveSection = (delta) => {
    const { renderer } = view;
    if (view.isFixedLayout) return renderer.goToSpread(spreadOfSection(view) + delta, SPREAD_START);
    return delta > 0 ? renderer.nextSection() : renderer.prevSection();
  };

  const moveBlock = async (delta) => {
    // Every block of a fixed page is on screen already.
    if (view.isFixedLayout) return moveSection(delta);
    const [shown] = shownDocs();
    const part = shownPart(view);
    const block = shown && part ? blockFrom(readingBlocks(shown.doc.body), part, delta) : null;
    if (block) return view.renderer.goTo({ index: shown.index, anchor: () => block });
    const index = shownIndex(view);
    return index === undefined ? undefined : neighbourSection(view, index, delta);
  };

  return {
    kind: 'epub',
    key,
    title,
    lang: bookLang(view.book.metadata),
    toc: () => flattenToc(view.book.toc),
    currentToc: () => flattenToc(view.book.toc).findIndex(({ target }) => target.href === view.lastLocation?.tocItem?.href),
    progress: () => ({ ...bookProgress(view), damaged: shownDocs().some(({ doc }) => isUnreadablePage(doc)) }),
    onProgress: (callback) => progressCallbacks.push(callback),
    placeAt: (node, offset) => {
      const range = node.ownerDocument.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      return { position: { kind: 'epub', cfi: placeOf(range), sentence: FIRST_SENTENCE }, excerpt: excerptOf((node.parentElement ?? node).textContent.replace(SPACES, ' ')) };
    },
    position,
    goTo: async ({ cfi, href, sentence }) => {
      spoken = null;
      holding = null;
      await view.goTo(cfi ?? href);
      holding = held({ cfi, sentence });
    },
    speechRoots: async () => shownDocs().map(({ doc, index }) => ({
      root: doc.body,
      section: index ?? view.renderer.index,
    })),
    onMove: (callback) => moveCallbacks.push(callback),
    onInput,
    setStyle: (css) => view.renderer.setStyles?.(css),
    nextSpeechSection: () => nextSpeechSection(view),
    prevSpeechSection: () => prevSpeechSection(view),
    speechStart: () => {
      const at = placeHeld();
      const point = at && pointOf(at);
      if (point) return point;
      const page = view.lastLocation?.range;
      return page ? { node: page.startContainer, offset: page.startOffset } : null;
    },
    speakAt: ({ range, sentence, follow }) => {
      // Text the app added is nowhere in the book, so the place stays on the sentence before it.
      if (!range) return;
      spoken = { cfi: placeOf(range), sentence };
      if (follow && !view.isFixedLayout && !onPage(range)) view.renderer.scrollToAnchor(range);
    },
    speechStopped: () => {
      if (spoken) holding = held(spoken);
      spoken = null;
    },
    onHandMove: (callback) => handCallbacks.push(callback),
    onSectionShown: (callback) => sectionCallbacks.push(callback),
    excerpt: () => {
      const text = view.lastLocation?.range?.toString() ?? shownDocs()[0]?.doc.body.textContent ?? '';
      return excerptOf(text.replace(SPACES, ' '));
    },
    moveBlock,
    moveSection,
    goLeft: () => view.goLeft(),
    goRight: () => view.goRight(),
    next: () => view.next(),
    setFlow: (flow) => view.renderer.setAttribute('flow', flow),
    /** The keys only reach the book from inside its frame, and only there can they scroll it. */
    focus: () => shownDocs()[0]?.doc.defaultView?.focus(),
    // Not in the contract: only the report of the tabs asks, to tell a page on screen from a book that says it opened.
    pageOnScreen: () => shownDocs().some(({ doc }) => doc.body.getClientRects().length > 0),
    // Not in the contract: a new file of the book is only worth showing if it has this place to show.
    unreadablePage: () => shownDocs().some(({ doc }) => isUnreadablePage(doc)),
    destroy: () => {
      notifyMove.cancel();
      view.removeEventListener('relocate', notifyMove);
      view.removeEventListener('relocate', notifyProgress);
      view.renderer.removeEventListener('relocate', onRelocate);
      view.removeEventListener('load', onSectionLoad);
      closeView(view);
    },
  };
}

/**
 * Only a section gets a frame, since the frames a book names are taken out of its sections. The one file it costs: an
 * SVG that is both a page in the reading order and a picture inside another page does not show as that picture.
 */
function prepareSections(book, { parser, serializer }) {
  const fixed = book.rendition?.layout === FIXED_LAYOUT;
  const names = new Set(book.sections.map(({ id }) => id));
  book.transformTarget?.addEventListener('data', ({ detail }) => {
    if (!names.has(detail.name)) return;
    const { data, type } = detail;
    detail.type = sectionType(type, fixed);
    detail.data = Promise.resolve(data).then((file) => sectionPage(file, type, {
      fixed,
      parser: parser ?? new DOMParser(),
      serializer: serializer ?? new XMLSerializer(),
    }));
  });
}

/** Sizes are rewritten on the way into the frame. The pages of a fixed layout are drawn with the sizes they have. */
function letSizesFollowTheText(book) {
  if (book.rendition?.layout === FIXED_LAYOUT) return;
  book.transformTarget?.addEventListener('data', ({ detail }) => {
    const rewrite = detail.type === STYLE_SHEET_TYPE ? relativeSizes : DOCUMENT_TYPES.has(detail.type) && relativeDocumentSizes;
    if (rewrite) detail.data = Promise.resolve(detail.data).then(rewrite);
  });
}

async function readFile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the book did not arrive: ${response.status}`);
  return new File([await response.blob()], BOOK_FILE_NAME);
}

/** @returns {Promise<boolean>} Whether the book opened at `cfi`, and not at any other page. */
async function showFirstPage(view, cfi) {
  try {
    await view.init({ lastLocation: cfi });
  } catch (error) {
    // The saved place may no longer exist in this file. Any page beats no book.
    console.warn(error);
  }
  const landed = Boolean(view.lastLocation);
  if (!landed) await view.goTo(view.book.sections.findIndex((section) => section.linear !== NOT_IN_READING_ORDER));
  if (!view.lastLocation) throw new Error('the book has no page to show');
  return landed;
}

/**
 * Every failure comes out of this one call, and a book that fails leaves nothing behind in `host`.
 * @param {string} url Where the file is.
 * @param {HTMLElement} host Takes the book in place of what it holds, once the book has a page to show.
 * @param {{flow: 'paginated'|'scrolled', style: string, hash: () => Promise<string>,
 *   savedPosition: (key: string) => Promise<import('./reader.js').Position|null>, openExternal: (url: string) => void,
 *   unreadableSection: string, parser?: object, serializer?: object}} opts
 * @param {() => Promise<{makeBook: (file: File) => Promise<object>}>} [loadFoliate]
 * @returns {Promise<import('./reader.js').Reader>}
 */
export async function openEpub(url, host, opts, loadFoliate = importFoliate) {
  const { makeBook } = await loadFoliate();
  const view = host.ownerDocument.createElement(FOLIATE_VIEW_TAG);
  try {
    const book = await makeBook(await readFile(url));
    if (isDrmProtected(await book.loadText(ENCRYPTION_FILE), opts.parser)) throw new Error('the book has DRM');
    keepSectionsLoading(book.sections, opts.unreadableSection);
    prepareSections(book, opts);
    letSizesFollowTheText(book);
    const handCallbacks = [];
    const onInput = watchSections(view, opts.openExternal, handCallbacks);
    view.addEventListener('external-link', (event) => {
      event.preventDefault();
      opts.openExternal(event.detail.href_);
    });
    await view.open(book);
    view.renderer.setAttribute('flow', opts.flow);
    view.renderer.setAttribute('max-column-count', COLUMN_COUNT);
    view.renderer.setAttribute('max-inline-size', COLUMN_WIDTH);
    view.renderer.setStyles?.(opts.style);
    const key = await epubKey(book.metadata, opts.hash, book.sections.length);
    const saved = await opts.savedPosition(key);
    host.replaceChildren(view);
    const landed = await showFirstPage(view, saved?.cfi);
    return makeReader(view, {
      key,
      title: mainTitle(book.metadata?.title),
      onInput,
      handCallbacks,
      place: landed ? saved : null,
    });
  } catch (error) {
    closeView(view);
    throw error;
  }
}
