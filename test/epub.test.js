// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser, parseHTML } from 'linkedom';
import {
  blockFrom,
  bookLang,
  epubKey,
  flattenToc,
  isDrmProtected,
  mainTitle,
  makeReader,
  nextSpeechSection,
  prevSpeechSection,
  openEpub,
  readingBlocks,
} from '../app/readers/epub.js';
import { HIGHLIGHT_RULE } from '../app/readers/epub-style.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

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

test('the frames of a book run no script at all, whatever the book names', () => {
  for (const file of ['paginator.js', 'fixed-layout.js']) {
    const source = read(`app/vendor/foliate/${file}`);
    assert.match(source, /setAttribute\('sandbox', 'allow-same-origin'\)/, file);
    assert.doesNotMatch(source, /allow-scripts/, file);
  }
});

test('a fresh copy of foliate gets its frames closed to scripts again', () => {
  const script = read('tools/vendor-foliate.sh');
  assert.ok(script.includes('allow-same-origin allow-scripts'));
  assert.match(script, /SANDBOXED_FILES=\(paginator\.js fixed-layout\.js\)/);
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
    { label: 'Uno', level: 1, target: { kind: 'epub', href: 'a.xhtml' } },
    { label: 'Uno punto uno', level: 2, target: { kind: 'epub', href: 'a.xhtml#b' } },
    { label: 'Due', level: 1, target: { kind: 'epub', href: 'c.xhtml' } },
  ]);
  assert.deepEqual(flattenToc(undefined), []);
});

test('an entry of the contents with no text is named after its file, and the others stay', () => {
  const toc = [
    { label: 'Chapter A', href: 'a.xhtml' },
    { label: null, href: 'Text/b.xhtml#part' },
    { label: '  ', href: 'c.xhtml', subitems: [{ label: 'Inside', href: 'c.xhtml#d' }] },
  ];
  assert.deepEqual(flattenToc(toc).map(({ label }) => label), ['Chapter A', 'b', 'c', 'Inside']);
});

test('an entry of the contents with neither text nor place has an empty name, and does not fail', () => {
  assert.deepEqual(flattenToc([{ label: null, subitems: [] }]).map(({ label }) => label), ['']);
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

test('the empty frame next to a page of a spread is not a page', async () => {
  const fixed = new FakeFixedRenderer([[{}]]);
  const blank = parseHTML('<html><head></head><body></body></html>').document;
  Object.defineProperty(blank, 'URL', { value: 'about:blank' });
  const page = fixed.doc;
  let focused = null;
  const frameWindow = (doc) => ({
    focus: () => {
      focused = doc;
    },
  });
  Object.defineProperty(blank, 'defaultView', { value: frameWindow(blank) });
  Object.defineProperty(page, 'defaultView', { value: frameWindow(page) });
  fixed.getContents = () => [{ doc: blank }, { doc: page }];
  const view = new FakeView(fixed, { isFixedLayout: true });
  view.lastLocation = { cfi: 'epubcfi(/6/2)', range: null };
  const reader = makeReader(view, {});
  reader.focus();
  assert.ok(focused === page, 'the keys go to the page, not to the frame that has no listeners');
  assert.equal(reader.excerpt(), 'Fixed page');
  const roots = await reader.speechRoots();
  assert.equal(roots.length, 1);
  assert.ok(roots[0].root === page.body);
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

// A range from inside one block to inside another, by place among the boundaries of all the blocks.
function rangeOver(blocks, first, last) {
  const place = (node, offset) => blocks.indexOf(node) * 2 + (offset === 0 ? 0 : 1);
  const make = (from, to) => ({
    comparePoint: (node, offset) => {
      const at = place(node, offset);
      if (at < from) return -1;
      return at > to ? 1 : 0;
    },
    cloneRange: () => make(from, to),
    collapse(toStart) {
      Object.assign(this, make(toStart ? from : to, toStart ? from : to));
    },
  });
  return make(first * 2 + 0.5, last * 2 + 0.5);
}

const blocksDoc = (html) => parseHTML(`<html><head></head><body>${html}</body></html>`).document;

test('the blocks of a section are its paragraphs, items and headings, in order, without their wrappers', () => {
  const { body } = blocksDoc(`<div><h1>T</h1><p>One</p><ul><li>Two</li><li><p>Three</p></li></ul></div>
    <p>   </p><div>Four</div><blockquote><p>Five</p></blockquote><p><img src="i.png" alt=""/></p>`);
  assert.deepEqual(readingBlocks(body).map((block) => block.textContent), ['T', 'One', 'Two', 'Three', 'Four', 'Five', '']);
});

test('an item with a sublist is a block for its own text', () => {
  const { body } = blocksDoc('<ul><li>Own text<ul><li>Inner</li></ul></li></ul>');
  assert.deepEqual(readingBlocks(body).map((block) => block.firstChild.textContent), ['Own text', 'Inner']);
});

test('a block the book hides is not a place to stop', () => {
  const { body } = blocksDoc('<p>Shown</p><p id="gone">Hidden</p>');
  body.querySelector('p').getClientRects = () => [{}];
  body.querySelector('#gone').getClientRects = () => [];
  assert.deepEqual(readingBlocks(body).map((block) => block.textContent), ['Shown']);
});

test('the next block starts after what is shown, the previous one ends before it', () => {
  const { body } = blocksDoc('<p>a</p><p>b</p><p>c</p><p>d</p>');
  const blocks = [...body.querySelectorAll('p')];
  const shown = rangeOver(blocks, 1, 2);
  assert.ok(blockFrom(blocks, shown, 1) === blocks[3]);
  assert.ok(blockFrom(blocks, shown, -1) === blocks[0]);
  assert.equal(blockFrom(blocks, rangeOver(blocks, 0, 3), 1), null);
  assert.equal(blockFrom(blocks, rangeOver(blocks, 0, 3), -1), null);
});

function blocksView({ flow = 'paginated', index = 1, sections = [{}, {}, { linear: 'no' }, {}] } = {}) {
  const doc = blocksDoc('<p>a</p><p>b</p><p>c</p><p>d</p>');
  const renderer = new FakeRenderer(sections);
  renderer.doc = doc;
  renderer.at = index;
  renderer.scrolled = flow === 'scrolled';
  renderer.went = [];
  renderer.goTo = async (target) => {
    renderer.went.push(target);
  };
  const view = new FakeView(renderer);
  const blocks = [...doc.querySelectorAll('p')];
  view.lastLocation = { cfi: 'x', range: rangeOver(blocks, 1, 2) };
  return { view, renderer, blocks };
}

test('in a paged book the next block is past the page, so the key always shows something new', async () => {
  const { view, renderer, blocks } = blocksView();
  const reader = makeReader(view, {});
  await reader.moveBlock(1);
  assert.equal(renderer.went[0].index, 1);
  assert.ok(renderer.went[0].anchor() === blocks[3]);
  await reader.moveBlock(-1);
  assert.ok(renderer.went[1].anchor() === blocks[0]);
});

test('in a scrolling book the next block is the one after the top of the screen', async () => {
  const { view, renderer, blocks } = blocksView({ flow: 'scrolled' });
  const reader = makeReader(view, {});
  await reader.moveBlock(1);
  assert.ok(renderer.went[0].anchor() === blocks[2]);
  await reader.moveBlock(-1);
  assert.ok(renderer.went[1].anchor() === blocks[0]);
});

test('past the last block comes the start of the next section in the reading order', async () => {
  const { view, renderer, blocks } = blocksView();
  view.lastLocation.range = rangeOver(blocks, 0, 3);
  await makeReader(view, {}).moveBlock(1);
  assert.deepEqual(renderer.went, [{ index: 3, anchor: 0 }]);
});

test('before the first block comes the end of the section before', async () => {
  const { view, renderer, blocks } = blocksView();
  view.lastLocation.range = rangeOver(blocks, 0, 3);
  await makeReader(view, {}).moveBlock(-1);
  assert.deepEqual(renderer.went, [{ index: 0, anchor: 1 }]);
});

test('the blocks of a book have an end on both sides', async () => {
  const last = blocksView({ index: 3 });
  last.view.lastLocation.range = rangeOver(last.blocks, 0, 3);
  await makeReader(last.view, {}).moveBlock(1);
  assert.deepEqual(last.renderer.went, []);

  const first = blocksView({ index: 0 });
  first.view.lastLocation.range = rangeOver(first.blocks, 0, 3);
  await makeReader(first.view, {}).moveBlock(-1);
  assert.deepEqual(first.renderer.went, []);
});

test('a section with no text to stand on still moves on', async () => {
  const { view, renderer } = blocksView();
  view.lastLocation.range = null;
  await makeReader(view, {}).moveBlock(1);
  assert.deepEqual(renderer.went, [{ index: 3, anchor: 0 }]);
});

test('in a fixed layout the blocks are all on screen, so the key goes to the next spread', async () => {
  const sections = [{}, {}];
  const fixed = new FakeFixedRenderer([[sections[0]], [sections[1]]]);
  const view = new FakeView(fixed, { isFixedLayout: true });
  await makeReader(view, {}).moveBlock(1);
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
  serializer: { serializeToString: (doc) => doc.toString() },
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

/** Sends a file through the transform of foliate as its loader does, and gives back what would reach the frame. */
const transformed = async (book, type, data, name = 'not-a-section') => {
  const event = new CustomEvent('data', { detail: { data, type, name } });
  book.transformTarget.dispatchEvent(event);
  return event.detail.data;
};

/** The same, for both what reaches the frame and what it is served as. */
const transformedFile = async (book, type, data, name) => {
  const event = new CustomEvent('data', { detail: { data, type, name } });
  book.transformTarget.dispatchEvent(event);
  return { data: await event.detail.data, type: await event.detail.type };
};

const bookWithTransform = (over = {}) => ({ ...plainBook(), transformTarget: new EventTarget(), ...over });

test('the sizes of a book follow the text size, in style sheets and in documents', async (t) => {
  t.after(stubFetch(okFile()));
  const book = bookWithTransform();
  const { host, foliate } = fakeFoliate({ makeBook: async () => book });
  await openEpub('u', host, openOptions(), foliate);
  assert.equal(await transformed(book, 'text/css', 'p { font-size: 12pt }'), 'p { font-size: 1rem }');
  assert.equal(
    await transformed(book, 'application/xhtml+xml', '<p style="font-size: 24px">x</p>'),
    '<p style="font-size: 1.5rem">x</p>',
  );
  assert.equal(
    await transformed(book, 'text/html', '<head><style>p { line-height: 16px }</style></head>'),
    '<head><style>p { line-height: 1rem }</style></head>',
  );
});

test('only text is rewritten: an image of the book reaches its frame as it is', async (t) => {
  t.after(stubFetch(okFile()));
  const book = bookWithTransform();
  const { host, foliate } = fakeFoliate({ makeBook: async () => book });
  await openEpub('u', host, openOptions(), foliate);
  const image = new Blob(['font-size: 12pt']);
  assert.ok(await transformed(book, 'image/png', Promise.resolve(image)) === image);
});

test('a file the book cannot give stays a failure for its frame', async (t) => {
  t.after(stubFetch(okFile()));
  const book = bookWithTransform();
  const { host, foliate } = fakeFoliate({ makeBook: async () => book });
  await openEpub('u', host, openOptions(), foliate);
  await assert.rejects(transformed(book, 'text/css', Promise.reject(new Error('gone'))), /gone/);
});

test('a book of fixed pages keeps the sizes its pages are drawn with', async (t) => {
  t.after(stubFetch(okFile()));
  const book = bookWithTransform({ rendition: { layout: 'pre-paginated' } });
  const { host, foliate } = fakeFoliate({ makeBook: async () => book });
  await openEpub('u', host, openOptions(), foliate);
  assert.equal(await transformed(book, 'text/css', 'p { font-size: 12pt }'), 'p { font-size: 12pt }');
});

test('what reaches out never gets to the frame of a section', async (t) => {
  t.after(stubFetch(okFile()));
  const book = bookWithTransform({ sections: [{ id: 'a.xhtml' }, { id: 'b.xhtml' }] });
  const { host, foliate } = fakeFoliate({ makeBook: async () => book });
  await openEpub('u', host, openOptions(), foliate);
  const source = '<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="preconnect" href="http://e.org"/></head><body><iframe src="http://e.org/"></iframe><p style="font-size: 16px">Text</p></body></html>';
  const out = await transformed(book, 'application/xhtml+xml', source, 'b.xhtml');
  assert.doesNotMatch(out, /<link|iframe/);
  assert.match(out, /font-size: 1rem/);
  assert.match(out, /Text/);
});

test('a fixed layout loses what reaches out too, and keeps its sizes', async (t) => {
  t.after(stubFetch(okFile()));
  const book = bookWithTransform({ rendition: { layout: 'pre-paginated' }, sections: [{ id: 'a.xhtml' }] });
  const { host, foliate } = fakeFoliate({ makeBook: async () => book });
  await openEpub('u', host, openOptions(), foliate);
  const source = '<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="preconnect" href="http://e.org"/></head><body><p style="font-size: 16px">Text</p></body></html>';
  const out = await transformed(book, 'application/xhtml+xml', source, 'a.xhtml');
  assert.doesNotMatch(out, /<link/);
  assert.match(out, /font-size: 16px/);
});

test('a page drawn in SVG in the reading order is served as a page', async (t) => {
  t.after(stubFetch(okFile()));
  const book = bookWithTransform({ sections: [{ id: 's.svg' }] });
  const { host, foliate } = fakeFoliate({ makeBook: async () => book });
  await openEpub('u', host, openOptions(), foliate);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Drawn</text></svg>';
  const { data, type } = await transformedFile(book, 'image/svg+xml', svg, 's.svg');
  assert.equal(type, 'application/xhtml+xml');
  assert.match(data, /<body><svg.*Drawn/s);
});

test('an SVG used as a picture in a page stays a picture', async (t) => {
  t.after(stubFetch(okFile()));
  const book = bookWithTransform({ sections: [{ id: 'a.xhtml' }] });
  const { host, foliate } = fakeFoliate({ makeBook: async () => book });
  await openEpub('u', host, openOptions(), foliate);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Drawn</text></svg>';
  assert.deepEqual(await transformedFile(book, 'image/svg+xml', svg, 'picture.svg'), { data: svg, type: 'image/svg+xml' });
});

test('a file of the reading order that cannot be read stays a failure for its frame', async (t) => {
  t.after(stubFetch(okFile()));
  const book = bookWithTransform({ sections: [{ id: 'a.xhtml' }] });
  const { host, foliate } = fakeFoliate({ makeBook: async () => book });
  await openEpub('u', host, openOptions(), foliate);
  await assert.rejects(transformed(book, 'application/xhtml+xml', Promise.reject(new Error('gone')), 'a.xhtml'), /gone/);
});

test('foliate is told not to load the target of an SVG link as a resource of the page', () => {
  assert.ok(read('app/vendor/foliate/epub.js').includes("'[*|href]:not([href]):not(a)'"));
  const script = read('tools/vendor-foliate.sh');
  assert.ok(script.includes('[*|href]:not([href])'));
  assert.ok(script.includes(':not(a)'));
});

test('foliate tells a scroll of the reader from the echo of its own move by where the page is', () => {
  const source = read('app/vendor/foliate/paginator.js');
  assert.ok(source.includes('this.#justAnchored && this.start === this.#anchoredAt'));
  assert.ok(!source.includes('if (this.#justAnchored) this.#justAnchored = false'));
  const script = read('tools/vendor-foliate.sh');
  assert.ok(script.includes('this.#anchoredAt'));
  assert.ok(script.includes('SCROLL_ECHO_FILE=paginator.js'));
});

test('no section of an open book can fail to load, whatever its file holds', async (t) => {
  t.after(stubFetch(okFile()));
  const message = 'Cannot be read';
  const book = { ...plainBook(), sections: [{ load: async () => 'blob:fine' }, { load: async () => Promise.reject(new Error('damaged')) }] };
  const { host, foliate } = fakeFoliate({ makeBook: async () => book });
  await openEpub('u', host, openOptions({ unreadableSection: message }), foliate);
  assert.equal(await book.sections[0].load(), 'blob:fine');
  assert.match(await book.sections[1].load(), /^blob:/);
});

test('the reader knows when what it shows is the message of a damaged section', () => {
  const renderer = new FakeRenderer();
  const reader = makeReader(new FakeView(renderer), {});
  assert.equal(reader.unreadablePage(), false);
  renderer.doc = parseHTML('<html><head></head><body><p data-unreadable-section="">Gone</p></body></html>').document;
  assert.equal(reader.unreadablePage(), true);
});

const XLINK = 'http://www.w3.org/1999/xlink';

/** A section on screen, with the links of a book in it. foliate has its own listener, which comes first. */
async function linksInASection(t, html) {
  t.after(stubFetch(okFile()));
  const opened = [];
  const { host, view, foliate } = fakeFoliate({
    makeBook: async () => ({
      ...plainBook(),
      sections: [{}, { resolveHref: (href) => (href.includes(':') ? href : `dir/${href}`) }],
      isExternal: (href) => /^(?!blob)\w+:/i.test(href),
    }),
  });
  await openEpub('u', host, openOptions({ openExternal: (url) => opened.push(url) }), foliate);
  const { document, window } = parseHTML(`<html><head></head><body>${html}</body></html>`);
  // linkedom knows nothing of namespaces.
  for (const element of document.querySelectorAll('a')) {
    element.getAttributeNS = (namespace, name) => (
      namespace === XLINK && name === 'href' ? element.getAttribute('xlink:href') : null
    );
  }
  document.addEventListener('click', (event) => {
    if (event.target.closest('a[href]')) event.preventDefault();
  });
  view.dispatchEvent(new CustomEvent('load', { detail: { doc: document, index: 1 } }));
  const click = (selector) => {
    const event = new window.Event('click', { bubbles: true, cancelable: true });
    document.querySelector(selector).dispatchEvent(event);
    return event;
  };
  return { view, opened, click };
}

test('an SVG link inside the book goes to its place and leaves the frame where it is', async (t) => {
  const { view, opened, click } = await linksInASection(t, '<svg><a xlink:href="two.xhtml#mid"><rect id="r"></rect></a></svg>');
  const event = click('#r');
  assert.ok(event.defaultPrevented);
  assert.deepEqual(view.goes, ['dir/two.xhtml#mid']);
  assert.deepEqual(opened, []);
});

test('an area of an image map inside the book does the same', async (t) => {
  const { view, opened, click } = await linksInASection(t, '<map name="m"><area id="r" href="two.xhtml"/></map>');
  const event = click('#r');
  assert.ok(event.defaultPrevented);
  assert.deepEqual(view.goes, ['dir/two.xhtml']);
  assert.deepEqual(opened, []);
});

test('an SVG link or an area out of the book goes to the app, as the links foliate sees do', async (t) => {
  const { view, opened, click } = await linksInASection(t, `<svg><a xlink:href="https://e.org/"><rect id="r"></rect></a></svg>
    <map name="m"><area id="m" href="https://e.org/m"/></map>`);
  assert.ok(click('#r').defaultPrevented);
  assert.ok(click('#m').defaultPrevented);
  assert.deepEqual(opened, ['https://e.org/', 'https://e.org/m']);
  assert.deepEqual(view.goes, []);
});

test('a link foliate has followed is not followed twice', async (t) => {
  const { view, opened, click } = await linksInASection(t, '<a href="two.xhtml"><span id="r">x</span></a>');
  click('#r');
  assert.deepEqual(view.goes, []);
  assert.deepEqual(opened, []);
});

test('an SVG link with nowhere to go still cannot take the frame away', async (t) => {
  const { view, opened, click } = await linksInASection(t, '<svg><a id="r"></a></svg>');
  assert.ok(click('#r').defaultPrevented);
  assert.deepEqual(view.goes, []);
  assert.deepEqual(opened, []);
});

test('a click on anything else stays as it was', async (t) => {
  const { view, opened, click } = await linksInASection(t, '<p id="r">Text</p>');
  assert.equal(click('#r').defaultPrevented, false);
  assert.deepEqual(view.goes, []);
  assert.deepEqual(opened, []);
});

test('the renderer takes the view asked for and one column', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate();
  await openEpub('u', host, openOptions({ flow: 'scrolled' }), foliate);
  assert.equal(view.renderer.attributes.get('flow'), 'scrolled');
  assert.equal(view.renderer.attributes.get('max-column-count'), '1');
  assert.match(view.renderer.attributes.get('max-inline-size'), /^\d+px$/);
});

/** A view whose renderer can say where a place is. Enough of foliate for the place being read. */
function speakingView({ scrolled = false } = {}) {
  const view = new FakeView();
  view.getCFI = (index, range) => `cfi(${index},${range?.tag ?? ''})`;
  view.resolveCFI = (cfi) => ({ anchor: () => ({ startContainer: 'resolved', startOffset: cfi.length }) });
  view.renderer.scrolled = scrolled;
  view.renderer.anchored = [];
  view.renderer.scrollToAnchor = async (range) => view.renderer.anchored.push(range);
  const { doc } = view.renderer;
  view.visible = { comparePoint: () => 0, startContainer: { ownerDocument: doc }, startOffset: 2 };
  view.lastLocation = { cfi: 'page-cfi', range: view.visible };
  return view;
}

const sentenceIn = (view, tag) => ({ tag, startContainer: { ownerDocument: view.renderer.doc }, startOffset: 0 });

test('the sentence being read is the position of a book, under its own place', () => {
  const view = speakingView();
  const reader = makeReader(view, {});
  reader.speakAt({ range: sentenceIn(view, 's1'), sentence: 4, follow: false });
  assert.deepEqual(reader.position(), { kind: 'epub', cfi: 'cfi(0,s1)', sentence: 4 });
});

test('a page in the book is turned only when the sentence is not on it', () => {
  const view = speakingView();
  const reader = makeReader(view, {});
  const onPage = sentenceIn(view, 'on');
  reader.speakAt({ range: onPage, sentence: 0, follow: true });
  assert.deepEqual(view.renderer.anchored, []);
  view.visible.comparePoint = () => 1;
  const past = sentenceIn(view, 'past');
  reader.speakAt({ range: past, sentence: 1, follow: true });
  assert.deepEqual(view.renderer.anchored, [past]);
});

test('not following, a book stays on its page', () => {
  const view = speakingView();
  view.visible.comparePoint = () => 1;
  const reader = makeReader(view, {});
  reader.speakAt({ range: sentenceIn(view, 'past'), sentence: 1, follow: false });
  assert.deepEqual(view.renderer.anchored, []);
});

test('a page that shows another document does not count as showing the sentence', () => {
  const view = speakingView();
  view.visible = { comparePoint: () => assert.fail('another document'), startContainer: { ownerDocument: {} } };
  view.lastLocation = { cfi: 'page-cfi', range: view.visible };
  const reader = makeReader(view, {});
  reader.speakAt({ range: sentenceIn(view, 's'), sentence: 0, follow: true });
  assert.equal(view.renderer.anchored.length, 1);
});

test('text the app added has no place of its own: the position stays on the sentence before it', () => {
  const view = speakingView();
  const reader = makeReader(view, {});
  reader.speakAt({ range: sentenceIn(view, 's1'), sentence: 4, follow: true });
  reader.speakAt({ range: null, sentence: 5, follow: true });
  assert.deepEqual(reader.position(), { kind: 'epub', cfi: 'cfi(0,s1)', sentence: 4 });
});

test('a fixed layout keeps the place of its page, which nothing has to turn', () => {
  const sections = [{}, {}];
  const renderer = new FakeFixedRenderer([[sections[0]], [sections[1]]]);
  const view = new FakeView(renderer, { isFixedLayout: true });
  view.lastLocation = { cfi: 'page-cfi', range: null };
  const reader = makeReader(view, {});
  reader.speakAt({ range: { startContainer: { ownerDocument: renderer.doc } }, sentence: 1, follow: true });
  assert.deepEqual(reader.position(), { kind: 'epub', cfi: 'page-cfi', sentence: 1 });
});

test('when the voice stops, its sentence stays the position while the page stays', () => {
  const view = speakingView();
  const reader = makeReader(view, {});
  reader.speakAt({ range: sentenceIn(view, 's1'), sentence: 4, follow: false });
  reader.speechStopped();
  assert.equal(reader.position().cfi, 'cfi(0,s1)');
  assert.equal(reader.position().sentence, 4);
  view.lastLocation = { cfi: 'next-page', range: view.visible };
  assert.equal(reader.position().cfi, 'next-page');
  assert.equal(reader.position().sentence, 0);
});

test('a book opened at a place inside its page keeps that place while the page stays', () => {
  const view = speakingView();
  const reader = makeReader(view, { place: { cfi: 'saved-sentence', sentence: 3 } });
  assert.deepEqual(reader.position(), { kind: 'epub', cfi: 'saved-sentence', sentence: 3 });
  view.lastLocation = { cfi: 'next-page', range: view.visible };
  assert.deepEqual(reader.position(), { kind: 'epub', cfi: 'next-page', sentence: 0 });
});

test('going to a place keeps it while the page stays, and takes the position from the voice', async () => {
  const view = speakingView();
  const reader = makeReader(view, {});
  reader.speakAt({ range: sentenceIn(view, 's1'), sentence: 4, follow: false });
  await reader.goTo({ kind: 'epub', cfi: 'bookmark', sentence: 2 });
  assert.deepEqual(reader.position(), { kind: 'epub', cfi: 'bookmark', sentence: 2 });
  await reader.goTo({ kind: 'epub', href: 'a.xhtml' });
  assert.equal(reader.position().cfi, 'page-cfi');
});

test('a change of layout moves where the page starts, and the place stays', () => {
  const view = speakingView();
  const reader = makeReader(view, { place: { cfi: 'saved', sentence: 2 } });
  view.lastLocation = { cfi: 'reflowed', range: view.visible };
  view.renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'anchor', index: 0 } }));
  assert.equal(reader.position().cfi, 'saved');
  view.lastLocation = { cfi: 'next-page', range: view.visible };
  view.renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'page', index: 0 } }));
  assert.equal(reader.position().cfi, 'next-page');
});

test('a new section settling into its layout is a move away, not a change of layout', () => {
  const view = speakingView();
  const reader = makeReader(view, { place: { cfi: 'saved', sentence: 2 } });
  view.lastLocation = { cfi: 'next-section', range: view.visible };
  view.renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'anchor', index: 2 } }));
  assert.equal(reader.position().cfi, 'next-section');
});

test('a place given up does not come back with a change of layout', () => {
  const view = speakingView();
  const reader = makeReader(view, { place: { cfi: 'saved', sentence: 2 } });
  view.lastLocation = { cfi: 'next-page', range: view.visible };
  view.renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'page', index: 0 } }));
  view.lastLocation = { cfi: 'reflowed', range: view.visible };
  view.renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'anchor', index: 0 } }));
  assert.equal(reader.position().cfi, 'reflowed');
});

test('reading starts at the place held, or at the start of the page', () => {
  const view = speakingView();
  const reader = makeReader(view, {});
  assert.deepEqual(reader.speechStart(), { node: view.visible.startContainer, offset: 2 });
  const held = makeReader(view, { place: { cfi: 'saved', sentence: 0 } });
  assert.deepEqual(held.speechStart(), { node: 'resolved', offset: 'saved'.length });
});

test('reading starts at the start of the page if the place cannot be found, or at the start of a fixed page', () => {
  const view = speakingView();
  view.resolveCFI = () => {
    throw new Error('not in this file');
  };
  const warn = console.warn;
  console.warn = () => {};
  const reader = makeReader(view, { place: { cfi: 'saved', sentence: 0 } });
  assert.deepEqual(reader.speechStart(), { node: view.visible.startContainer, offset: 2 });
  console.warn = warn;
  const sections = [{}];
  const fixed = new FakeView(new FakeFixedRenderer([sections]), { isFixedLayout: true });
  fixed.lastLocation = { cfi: 'page', range: null };
  assert.equal(makeReader(fixed, {}).speechStart(), null);
});

test('a new section on screen is told, and no more once the book has closed', () => {
  const view = speakingView();
  const reader = makeReader(view, {});
  let shown = 0;
  reader.onSectionShown(() => {
    shown += 1;
  });
  view.dispatchEvent(new CustomEvent('load', { detail: { doc: view.renderer.doc, index: 0 } }));
  assert.equal(shown, 1);
  reader.destroy();
  view.dispatchEvent(new CustomEvent('load', { detail: { doc: view.renderer.doc, index: 0 } }));
  assert.equal(shown, 1);
});

test('the section before is the one before in the reading order', async () => {
  const view = new FakeView();
  view.renderer.at = 2;
  view.renderer.goTo = async ({ index }) => {
    view.renderer.at = index;
  };
  assert.equal(await prevSpeechSection(view), true);
  assert.equal(view.renderer.at, 0);
  assert.equal(await prevSpeechSection(view), false);
});

test('in a fixed layout the section before is the spread before', async () => {
  const sections = [{}, {}];
  const renderer = new FakeFixedRenderer([[sections[0]], [sections[1]]]);
  const view = new FakeView(renderer, { isFixedLayout: true });
  renderer.spread = 1;
  assert.equal(await prevSpeechSection(view), true);
  assert.equal(renderer.spread, 0);
  assert.equal(await prevSpeechSection(view), false);
});

test('scrolling a book by hand counts in its scrolling view only', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate();
  const reader = await openEpub('u', host, openOptions(), foliate);
  let moves = 0;
  reader.onHandMove(() => {
    moves += 1;
  });
  const { document, window } = parseHTML('<html><head></head><body><p>One</p></body></html>');
  view.dispatchEvent(new CustomEvent('load', { detail: { doc: document, index: 0 } }));
  const input = (type, fields = {}) => document.dispatchEvent(Object.assign(new window.Event(type), fields));
  input('wheel');
  input('keydown', { key: 'PageDown' });
  assert.equal(moves, 0, 'a paginated book does not scroll');
  view.renderer.scrolled = true;
  input('wheel');
  assert.equal(moves, 1);
  input('keydown', { key: 'PageDown' });
  assert.equal(moves, 2);
  input('keydown', { key: 'Enter' });
  assert.equal(moves, 2);
  view.dispatchEvent(new Event('pointerdown'));
  assert.equal(moves, 3, 'a press outside the frame is on the scrollbar');
});

test('a swipe to another page is a move by hand in a paginated book too', () => {
  const view = speakingView();
  const reader = makeReader(view, {});
  let moves = 0;
  reader.onHandMove(() => {
    moves += 1;
  });
  view.renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'snap' } }));
  assert.equal(moves, 1);
  view.renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'navigation' } }));
  assert.equal(moves, 1);
});

test('a right click in a section of the book reaches the reader too', async (t) => {
  t.after(stubFetch(okFile()));
  const { host, view, foliate } = fakeFoliate();
  const reader = await openEpub('u', host, openOptions(), foliate);
  const seen = [];
  reader.onInput((event) => seen.push(event.type));
  const { document, window } = parseHTML('<html><head></head><body><p>One</p></body></html>');
  view.dispatchEvent(new CustomEvent('load', { detail: { doc: document, index: 0 } }));
  document.dispatchEvent(new window.Event('contextmenu'));
  assert.deepEqual(seen, ['contextmenu']);
});
