// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser, parseHTML } from 'linkedom';
import {
  bookLang,
  epubKey,
  flattenToc,
  isDrmProtected,
  mainTitle,
  makeReader,
  nextSpeechSection,
  openEpub,
} from '../app/readers/epub.js';
import { HIGHLIGHT_RULE } from '../app/readers/epub-style.js';

const noWait = async () => {};
const SAVE_WAIT_MS = 600;

const after = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const encryption = (...algorithms) => `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  ${algorithms.map((uri) => `<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="${uri}"/></EncryptedData>`).join('')}
</encryption>`;

const parser = new DOMParser();

const SECTIONS = [{ cfi: '/6/2' }, { cfi: '/6/4', linear: 'no' }, { cfi: '/6/6' }];

class FakeRenderer extends EventTarget {
  constructor(sections = SECTIONS) {
    super();
    this.sections = sections;
    this.at = 0;
    this.locked = 0;
    this.styles = [];
    this.attributes = new Map();
    this.doc = parseHTML('<html><head></head><body><p>Page text</p></body></html>').document;
    this.turns = 0;
  }

  getContents() {
    return [{ doc: this.doc, index: this.at }];
  }

  async nextSection() {
    this.turns += 1;
    if (this.locked > 0) {
      this.locked -= 1;
      return;
    }
    const next = this.sections.findIndex((section, index) => index > this.at && section.linear !== 'no');
    this.at = next < 0 ? this.at : next;
  }

  async prevSection() {
    this.at = Math.max(0, this.at - 1);
  }

  setStyles(css) {
    this.styles.push(css);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

class FakeFixedRenderer extends EventTarget {
  constructor(spreads) {
    super();
    this.spreads = spreads;
    this.spread = 0;
    this.doc = parseHTML('<html><head></head><body><p>Fixed page</p></body></html>').document;
    this.sections = spreads.flat();
  }

  get index() {
    return this.sections.indexOf(this.spreads[this.spread][0]);
  }

  getSpreadOf(section) {
    return { index: this.spreads.findIndex((spread) => spread.includes(section)), side: 'left' };
  }

  async goToSpread(index) {
    if (index >= 0 && index < this.spreads.length) this.spread = index;
  }

  getContents() {
    return [{ doc: this.doc }];
  }

  setAttribute() {}
}

class FakeView extends EventTarget {
  constructor(renderer = new FakeRenderer(), { isFixedLayout = false, metadata = {} } = {}) {
    super();
    this.renderer = renderer;
    this.isFixedLayout = isFixedLayout;
    this.book = {
      metadata,
      sections: renderer.sections,
      toc: [],
      loadText: async () => null,
      destroy: () => {
        this.bookDestroyed = true;
      },
    };
    this.lastLocation = { cfi: 'epubcfi(/6/2!/4)', range: { toString: () => '  Visible   text\n here ' } };
    this.goes = [];
    this.moved = [];
  }

  async goTo(target) {
    this.goes.push(target);
  }

  goLeft() {
    this.moved.push('left');
  }

  goRight() {
    this.moved.push('right');
  }

  async next() {
    this.moved.push('next');
  }

  close() {
    this.closed = true;
    this.lastLocation = null;
  }

  remove() {
    this.removed = true;
  }
}

test('nothing of foliate-js loads before the first book', () => {
  const staticImports = (path) => [
    ...readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').matchAll(/^(?:import|export) .* from '([^']+)'/gm),
  ].map(([, target]) => target);
  assert.deepEqual(staticImports('app/ui/shell.js').filter((target) => /epub\.js|vendor/.test(target)), []);
  assert.deepEqual(staticImports('app/readers/epub.js').filter((target) => target.includes('vendor')), []);
  assert.deepEqual(staticImports('app/readers/epub-style.js'), []);
});

test('the book module hands on the key and the title', async () => {
  assert.equal(await epubKey({ identifier: 'x', title: 'T' }, () => 'h'), 'epub:x|T');
  assert.equal(mainTitle({ it: 'Il titolo' }), 'Il titolo');
});

test('the language of a book can be a string, a list or missing', () => {
  assert.equal(bookLang({ language: 'it' }), 'it');
  assert.equal(bookLang({ language: ['it', 'en'] }), 'it');
  assert.equal(bookLang({ language: undefined }), null);
  assert.equal(bookLang({}), null);
  assert.equal(bookLang(undefined), null);
});

test('a book without an encryption file is not protected', () => {
  assert.equal(isDrmProtected(null, parser), false);
  assert.equal(isDrmProtected(undefined, parser), false);
});

test('font obfuscation is not DRM', () => {
  const xml = encryption('http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC');
  assert.equal(isDrmProtected(xml, parser), false);
});

test('any other encryption method is DRM, even next to font obfuscation', () => {
  assert.equal(isDrmProtected(encryption('http://www.w3.org/2001/04/xmlenc#aes256-cbc'), parser), true);
  const mixed = encryption('http://www.idpf.org/2008/embedding', 'http://www.w3.org/2001/04/xmlenc#aes128-cbc');
  assert.equal(isDrmProtected(mixed, parser), true);
});

test('the encryption file of the DRM fixture counts as DRM', () => {
  const text = readFileSync(new URL('fixtures/drm.epub', import.meta.url)).toString('utf8');
  const start = text.indexOf('<?xml', text.indexOf('META-INF/encryption.xml'));
  const xml = text.slice(start, text.indexOf('</encryption>', start) + '</encryption>'.length);
  assert.equal(isDrmProtected(xml, parser), true);
});

test('the table of contents comes flat, in reading order, with places to go to', () => {
  const toc = [
    { label: ' Uno ', href: 'a.xhtml', subitems: [{ label: 'Uno punto uno', href: 'a.xhtml#b' }] },
    { label: 'Due', href: 'c.xhtml' },
  ];
  assert.deepEqual(flattenToc(toc), [
    { label: 'Uno', target: { kind: 'epub', href: 'a.xhtml' } },
    { label: 'Uno punto uno', target: { kind: 'epub', href: 'a.xhtml#b' } },
    { label: 'Due', target: { kind: 'epub', href: 'c.xhtml' } },
  ]);
  assert.deepEqual(flattenToc(undefined), []);
});

test('the next section to read skips the ones outside the reading order', async () => {
  const view = new FakeView();
  assert.equal(await nextSpeechSection(view, noWait), true);
  assert.equal(view.renderer.at, 2);
});

test('after the last section there is nothing more to read', async () => {
  const view = new FakeView();
  view.renderer.at = 2;
  assert.equal(await nextSpeechSection(view, noWait), false);
  assert.equal(view.renderer.turns, 0);
});

test('sections outside the reading order at the end are not read', async () => {
  const view = new FakeView(new FakeRenderer([{}, { linear: 'no' }]));
  assert.equal(await nextSpeechSection(view, noWait), false);
});

test('a paginator busy turning a page gets asked again', async () => {
  const view = new FakeView();
  view.renderer.locked = 2;
  const waits = [];
  assert.equal(await nextSpeechSection(view, async (ms) => waits.push(ms)), true);
  assert.equal(view.renderer.at, 2);
  assert.equal(view.renderer.turns, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] > 0);
});

test('a paginator that never moves stops the reading, it does not wait forever', async () => {
  const view = new FakeView();
  view.renderer.locked = Infinity;
  await assert.rejects(nextSpeechSection(view, noWait));
});

test('a section that could not be shown stops the reading', async () => {
  const before = new FakeView();
  before.renderer.getContents = () => [{ doc: before.renderer.doc, index: undefined }];
  await assert.rejects(nextSpeechSection(before, noWait));

  const later = new FakeView();
  later.renderer.nextSection = async () => {
    later.renderer.at = undefined;
  };
  await assert.rejects(nextSpeechSection(later, noWait));
});

test('in a fixed layout the next section is the next spread', async () => {
  const sections = [{}, {}, {}];
  const renderer = new FakeFixedRenderer([[sections[0]], [sections[1], sections[2]]]);
  const view = new FakeView(renderer, { isFixedLayout: true });
  assert.equal(await nextSpeechSection(view, noWait), true);
  assert.equal(renderer.spread, 1);
  assert.equal(await nextSpeechSection(view, noWait), false);
  assert.equal(renderer.spread, 1);
});

test('the reader is a book with the language of the book', () => {
  const view = new FakeView(undefined, { metadata: { language: ['it', 'en'] } });
  const reader = makeReader(view, { key: 'k', title: 'T' });
  assert.equal(reader.kind, 'epub');
  assert.equal(reader.lang, 'it');
  assert.equal(reader.key, 'k');
  assert.equal(reader.title, 'T');
});

test('the position of a book is where foliate says it is', () => {
  const reader = makeReader(new FakeView(), {});
  assert.deepEqual(reader.position(), { kind: 'epub', cfi: 'epubcfi(/6/2!/4)', sentence: 0 });
});

test('going to a position or to an entry of the contents uses what they name', async () => {
  const view = new FakeView();
  const reader = makeReader(view, {});
  await reader.goTo({ kind: 'epub', cfi: 'epubcfi(/6/4)', sentence: 0 });
  await reader.goTo({ kind: 'epub', href: 'a.xhtml#b' });
  assert.deepEqual(view.goes, ['epubcfi(/6/4)', 'a.xhtml#b']);
});

test('moves are told once the reader has stopped, and not after the book has closed', async () => {
  const view = new FakeView();
  const reader = makeReader(view, {});
  const told = [];
  reader.onMove((at) => told.push(at));
  view.dispatchEvent(new CustomEvent('relocate'));
  view.dispatchEvent(new CustomEvent('relocate'));
  await after(SAVE_WAIT_MS);
  assert.equal(told.length, 1);
  assert.equal(told[0].cfi, 'epubcfi(/6/2!/4)');

  view.dispatchEvent(new CustomEvent('relocate'));
  reader.destroy();
  await after(SAVE_WAIT_MS);
  assert.equal(told.length, 1);
});

test('only the documents on screen are read, never a copy made for it', async () => {
  const view = new FakeView();
  view.book.sections[0].createDocument = () => assert.fail('a copy is not the document on screen');
  const roots = await makeReader(view, {}).speechRoots();
  assert.equal(roots.length, 1);
  assert.ok(roots[0].root === view.renderer.doc.body);
  assert.equal(roots[0].section, 0);
});

test('a fixed layout has no section index in its contents, so the renderer tells it', async () => {
  const sections = [{}, {}];
  const renderer = new FakeFixedRenderer([[sections[0]], [sections[1]]]);
  const roots = await makeReader(new FakeView(renderer, { isFixedLayout: true }), {}).speechRoots();
  assert.equal(roots[0].section, 0);
});

test('an empty frame of a spread is not read', async () => {
  const view = new FakeView();
  view.renderer.getContents = () => [{ doc: null }, { doc: view.renderer.doc, index: 1 }];
  const roots = await makeReader(view, {}).speechRoots();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].section, 1);
});

test('the excerpt is the text on the page, in one line', () => {
  assert.equal(makeReader(new FakeView(), {}).excerpt(), 'Visible text here');
});

test('in a fixed layout, which has no range, the excerpt comes from the page', () => {
  const view = new FakeView(new FakeFixedRenderer([[{}]]), { isFixedLayout: true });
  view.lastLocation = { cfi: 'epubcfi(/6/2)', range: null };
  assert.equal(makeReader(view, {}).excerpt(), 'Fixed page');
});

test('the style reaches a reflowable book, and a fixed layout does not break', () => {
  const view = new FakeView();
  makeReader(view, {}).setStyle('css');
  assert.deepEqual(view.renderer.styles, ['css']);
  makeReader(new FakeView(new FakeFixedRenderer([[{}]]), { isFixedLayout: true }), {}).setStyle('css');
});

test('the arrows turn the pages of the book and the view can change', () => {
  const view = new FakeView();
  const reader = makeReader(view, {});
  reader.goLeft();
  reader.goRight();
  reader.next();
  assert.deepEqual(view.moved, ['left', 'right', 'next']);
  reader.setFlow('scrolled');
  assert.equal(view.renderer.attributes.get('flow'), 'scrolled');
});

test('sections move on both renderers', async () => {
  const view = new FakeView();
  const reader = makeReader(view, {});
  await reader.moveSection(1);
  assert.equal(view.renderer.at, 2);
  await reader.moveSection(-1);
  assert.equal(view.renderer.at, 1);

  const sections = [{}, {}];
  const fixed = new FakeFixedRenderer([[sections[0]], [sections[1]]]);
  await makeReader(new FakeView(fixed, { isFixedLayout: true }), {}).moveSection(1);
  assert.equal(fixed.spread, 1);
});

test('closing the reader closes the view and frees the book', () => {
  const view = new FakeView();
  makeReader(view, {}).destroy();
  assert.ok(view.closed);
  assert.ok(view.removed);
  assert.ok(view.bookDestroyed);
});

// openEpub, with foliate and the file replaced.

function stubFetch(answer) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => answer;
  return () => {
    globalThis.fetch = real;
  };
}

const okFile = () => new Response('fake book', { status: 200 });

const plainBook = () => ({
  metadata: { identifier: 'id', title: { it: 'Il titolo' }, language: 'it' },
  sections: [{}, {}],
  loadText: async () => null,
});

function fakeFoliate({ makeBook = async (file) => ({ ...plainBook(), file }), renderer = new FakeRenderer(), init } = {}) {
  const { document } = parseHTML('<html><body><section id="host"></section></body></html>');
  const host = document.getElementById('host');
  const view = new FakeView(renderer);
  view.open = async (book) => {
    view.opened = book;
    view.book = { ...view.book, ...book };
  };
  view.init = init ?? (async ({ lastLocation }) => {
    view.inits = [...(view.inits ?? []), lastLocation];
    view.lastLocation = { cfi: lastLocation ?? 'epubcfi(/6/2!/4)', range: null };
  });
  const realCreate = document.createElement.bind(document);
  document.createElement = (tag) => (tag === 'foliate-view' ? view : realCreate(tag));
  host.replaceChildren = (...nodes) => {
    view.placedIn = nodes;
  };
  return { host, view, foliate: async () => ({ makeBook }) };
}

const openOptions = (over = {}) => ({
  flow: 'paginated',
  style: 'css',
  hash: async () => 'h',
  savedPosition: async () => null,
  openExternal: () => {},
  parser,
  ...over,
});

test('a book opens with a key from its metadata and section count, at the start', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate();
  const reader = await openEpub('http://mochi.localhost/file/x', host, openOptions(), foliate);
  assert.equal(reader.key, 'epub:id|Il titolo|2');
  assert.equal(reader.title, 'Il titolo');
  assert.equal(reader.lang, 'it');
  assert.deepEqual(view.inits, [undefined]);
  assert.equal(view.opened.file.name, 'book.epub');
  assert.deepEqual(view.renderer.styles, ['css']);
  assert.equal(view.renderer.attributes.get('flow'), 'paginated');
  assert.deepEqual(view.placedIn, [view]);
});

test('a book without an identifier is known by the hash of its file', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, foliate } = fakeFoliate({
    makeBook: async () => ({ metadata: { title: 'T' }, sections: [{}], loadText: async () => null }),
  });
  const reader = await openEpub('u', host, openOptions({ hash: async () => 'abc' }), foliate);
  assert.equal(reader.key, 'sha256:abc');
});

test('a book opens at its saved position, asked for under its key', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate();
  const asked = [];
  const savedPosition = async (key) => {
    asked.push(key);
    return { kind: 'epub', cfi: 'epubcfi(/6/4!/2)', sentence: 0 };
  };
  await openEpub('u', host, openOptions({ savedPosition }), foliate);
  assert.deepEqual(asked, ['epub:id|Il titolo|2']);
  assert.deepEqual(view.inits, ['epubcfi(/6/4!/2)']);
});

test('a saved position that throws falls back to the first page in the reading order', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate({
    makeBook: async () => ({ ...plainBook(), sections: [{ linear: 'no' }, {}] }),
    init: async () => {
      throw new Error('this place is gone');
    },
  });
  view.lastLocation = null;
  view.goTo = async (target) => {
    view.goes.push(target);
    view.lastLocation = { cfi: 'epubcfi(/6/4)', range: null };
  };
  const savedPosition = async () => ({ kind: 'epub', cfi: 'epubcfi(/6/99!/2)', sentence: 0 });
  await openEpub('u', host, openOptions({ savedPosition }), foliate);
  assert.deepEqual(view.goes, [1]);
});

test('a saved position that lands nowhere also falls back', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate({ init: async () => {} });
  view.lastLocation = null;
  view.goTo = async (target) => {
    view.goes.push(target);
    view.lastLocation = { cfi: 'epubcfi(/6/2)', range: null };
  };
  await openEpub('u', host, openOptions({ savedPosition: async () => ({ cfi: 'x' }) }), foliate);
  assert.deepEqual(view.goes, [0]);
});

test('a book with no page to show does not open, and leaves nothing behind', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate({ init: async () => {} });
  view.lastLocation = null;
  await assert.rejects(openEpub('u', host, openOptions(), foliate));
  assert.ok(view.closed);
  assert.ok(view.removed);
});

test('a DRM book is refused before foliate opens it', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate({
    makeBook: async () => ({
      metadata: {},
      sections: [{}],
      loadText: async (name) => (name === 'META-INF/encryption.xml'
        ? encryption('http://www.w3.org/2001/04/xmlenc#aes256-cbc')
        : null),
    }),
  });
  await assert.rejects(openEpub('u', host, openOptions(), foliate), /DRM/);
  assert.equal(view.opened, undefined);
});

test('whatever goes wrong on the way, the failure comes out of the one call', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate({
    makeBook: async () => {
      throw new TypeError('no such module: mobi.js');
    },
  });
  await assert.rejects(openEpub('u', host, openOptions(), foliate), /mobi/);
  assert.ok(view.removed);
});

test('foliate that does not load is a failure too', async (t) => {
  t.after(stubFetch(okFile()));
  const { host } = fakeFoliate();
  const missing = async () => {
    throw new Error('no foliate');
  };
  await assert.rejects(openEpub('u', host, openOptions(), missing), /no foliate/);
});

test('a file the protocol refuses is a failure', async (t) => {
  t.after(stubFetch(new Response('', { status: 403 })));
  const { host, foliate } = fakeFoliate();
  await assert.rejects(openEpub('u', host, openOptions(), foliate), /403/);
});

test('input from each section of the book reaches the reader, keys and clicks', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate();
  const reader = await openEpub('u', host, openOptions(), foliate);
  const seen = [];
  reader.onInput((event) => seen.push(event.type));
  for (const html of ['<p>One</p>', '<p>Two</p>']) {
    const { document, window } = parseHTML(`<html><head></head><body>${html}</body></html>`);
    view.dispatchEvent(new CustomEvent('load', { detail: { doc: document, index: 0 } }));
    document.dispatchEvent(new window.Event('keydown'));
    document.dispatchEvent(new window.Event('click'));
  }
  assert.deepEqual(seen, ['keydown', 'click', 'keydown', 'click']);
});

test('a fixed layout gets the highlight rule from a style of its own in each section', async (t) => {
  t.after(stubFetch(okFile()));
  const sections = [{}];
  const { host, view, foliate } = fakeFoliate({ renderer: new FakeFixedRenderer([[sections[0]]]) });
  view.isFixedLayout = true;
  await openEpub('u', host, openOptions(), foliate);
  const { document } = parseHTML('<html><head></head><body></body></html>');
  view.dispatchEvent(new CustomEvent('load', { detail: { doc: document, index: 0 } }));
  assert.equal(document.head.querySelector('style').textContent, HIGHLIGHT_RULE);
});

test('a reflowable section gets no style of its own: the renderer has it all', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate();
  await openEpub('u', host, openOptions(), foliate);
  const { document } = parseHTML('<html><head></head><body></body></html>');
  view.dispatchEvent(new CustomEvent('load', { detail: { doc: document, index: 0 } }));
  assert.equal(document.head.querySelector('style'), null);
});

test('external links are stopped at once and handed to the app', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate();
  const opened = [];
  await openEpub('u', host, openOptions({ openExternal: (url) => opened.push(url) }), foliate);
  const event = new CustomEvent('external-link', { cancelable: true, detail: { href_: 'https://e.org/' } });
  view.dispatchEvent(event);
  assert.ok(event.defaultPrevented);
  assert.deepEqual(opened, ['https://e.org/']);
});

test('the renderer takes the view asked for and one column', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate();
  await openEpub('u', host, openOptions({ flow: 'scrolled' }), foliate);
  assert.equal(view.renderer.attributes.get('flow'), 'scrolled');
  assert.equal(view.renderer.attributes.get('max-column-count'), '1');
  assert.match(view.renderer.attributes.get('max-inline-size'), /^\d+px$/);
});
