// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { epubFiles, makePdfBook, pdfLoader } from '../app/readers/pdf-book.js';
import { fixtureBytes, pdfjs } from './pdf-helpers.js';


const FIGURE = { kind: 'figure', page: 3, box: { x: 1, y: 2, width: 300, height: 150 }, caption: 'Figure 1: <a square> & more' };
const CHAPTERS = [
  { title: null, depth: 0, blocks: [{ kind: 'paragraph', text: 'Before the first chapter.' }], notes: [] },
  { title: 'One', depth: 0, blocks: [{ kind: 'heading', level: 1, text: 'One' }, { kind: 'paragraph', text: 'a < b & c' }, FIGURE], notes: ['* A note.'] },
  { title: 'One, part', depth: 1, blocks: [{ kind: 'heading', level: 2, text: 'One, part' }], notes: [] },
  { title: 'Two', depth: 0, blocks: [{ kind: 'heading', level: 1, text: 'Two' }], notes: [] },
];
const BOOK = { title: 'A <Book>', author: 'Nobody', language: 'en', identifier: 'pdf:abc|reflow-1', chapters: CHAPTERS, notesTitle: 'Notes' };

const parse = (text) => new DOMParser().parseFromString(text, 'text/xml');

test('every section is well-formed XHTML and escapes its text', () => {
  const { files } = epubFiles(BOOK);
  const sections = [...files.keys()].filter((name) => name.startsWith('OEBPS/text/'));
  assert.equal(sections.length, 4);
  const one = files.get(sections[1]);
  assert.match(one, /<p>a &lt; b &amp; c<\/p>/);
  assert.match(one, /<figcaption>Figure 1: &lt;a square&gt; &amp; more<\/figcaption>/);
  assert.match(one, /<img src="\.\.\/images\/p3-0\.png"/);
  assert.match(one, /<h2>Notes<\/h2><ol><li>\* A note\.<\/li><\/ol>/);
  for (const name of files.keys()) {
    if (name.endsWith('.png')) continue;
    assert.equal(parse(files.get(name)).querySelector('parsererror'), null, name);
  }
});

test('the nav nests chapters by depth and leaves out an untitled start', () => {
  const nav = epubFiles(BOOK).files.get('OEBPS/nav.xhtml');
  const flat = nav.replace(/\s+/g, '');
  assert.match(flat, /<ol><li><ahref="text\/c002\.xhtml">One<\/a><ol><li><ahref="text\/c003\.xhtml">One,part<\/a><\/li><\/ol><\/li><li><ahref="text\/c004\.xhtml">Two<\/a><\/li><\/ol>/);
  assert.doesNotMatch(nav, /c001/);
});

test('the identifier carries the file hash and the reflow version', () => {
  const opf = epubFiles(BOOK).files.get('OEBPS/content.opf');
  assert.match(opf, /<dc:identifier id="id">pdf:abc\|reflow-1<\/dc:identifier>/);
  assert.match(opf, /<dc:title>A &lt;Book&gt;<\/dc:title>/);
  assert.match(opf, /<dc:language>en<\/dc:language>/);
});

test('the loader has no encryption file, so a PDF is never taken for DRM', async () => {
  const loader = pdfLoader(epubFiles(BOOK), async () => new Blob());
  assert.equal(await loader.loadText('META-INF/encryption.xml'), null);
  assert.match(await loader.loadText('META-INF/container.xml'), /OEBPS\/content\.opf/);
});

test('a figure is drawn only when asked, and once', async () => {
  const asked = [];
  const loader = pdfLoader(epubFiles(BOOK), async (page, box) => {
    asked.push([page, box]);
    return new Blob(['png'], { type: 'image/png' });
  });
  assert.equal(asked.length, 0);
  const first = await loader.loadBlob('OEBPS/images/p3-0.png');
  const again = await loader.loadBlob('OEBPS/images/p3-0.png');
  assert.equal(first, again);
  assert.deepEqual(asked, [[3, FIGURE.box]]);
  assert.equal(loader.getSize('OEBPS/images/p3-0.png'), 0);
  assert.ok(loader.getSize('OEBPS/text/c002.xhtml') > 0);
});

test('a table of contents that ends deeper than it starts is still well-formed', () => {
  const chapters = [CHAPTERS[1], CHAPTERS[2]];
  const nav = epubFiles({ ...BOOK, chapters }).files.get('OEBPS/nav.xhtml');
  assert.equal(parse(nav).querySelector('parsererror'), null);
  assert.match(nav.replace(/\s+/g, ''), /<ol><li><ahref="text\/c001\.xhtml">One<\/a><ol><li><ahref="text\/c002\.xhtml">One,part<\/a><\/li><\/ol><\/li><\/ol>/);
});

/** foliate's EPUB as far as makePdfBook uses it: it keeps the loader it is given. */
class RecordingEpub {
  constructor(loader) {
    this.loader = loader;
  }

  async init() {
    return this;
  }
}

const attributes = (text, tag, name) => [...text.matchAll(new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`, 'g'))].map(([, value]) => value);

const bookOf = (file, opts = {}) => makePdfBook(file, {
  pdfjs,
  EPUB: RecordingEpub,
  hash: async () => 'abc',
  notesTitle: 'Notes',
  name: 'made-up.pdf',
  document: null,
  ...opts,
});

// foliate's own parsing of these files needs a browser: linkedom has no namespaces. Its checks are mirrored here.
test('the fixture becomes the files of an EPUB that foliate can read', async () => {
  let hashed = 0;
  const { loader } = await bookOf(new File([fixtureBytes('book.pdf')], 'book.epub'), {
    hash: async () => {
      hashed += 1;
      return 'abc';
    },
  });
  assert.equal(hashed, 1);
  assert.match(loader.loadText('META-INF/container.xml'), /full-path="OEBPS\/content\.opf" media-type="application\/oebps-package\+xml"/);
  const opf = loader.loadText('OEBPS/content.opf');
  assert.match(opf, /<dc:identifier id="id">pdf:abc\|reflow-1<\/dc:identifier>/);
  assert.match(opf, /<dc:title>A Made-Up Book<\/dc:title>/);
  assert.match(opf, /<item id="nav" href="nav\.xhtml" media-type="application\/xhtml\+xml" properties="nav"\/>/);
  const ids = attributes(opf, 'item', 'id');
  const spine = attributes(opf, 'itemref', 'idref');
  assert.ok(spine.length >= 3);
  assert.ok(spine.every((id) => ids.includes(id)), spine.join());
  for (const href of attributes(opf, 'item', 'href').filter((href) => href.endsWith('.xhtml'))) {
    assert.equal(parse(loader.loadText(`OEBPS/${href}`)).querySelector('parsererror'), null, href);
  }
  const nav = loader.loadText('OEBPS/nav.xhtml');
  assert.deepEqual([...nav.matchAll(/<a href="[^"]+">([^<]+)<\/a>/g)].map(([, label]) => label), ['Chapter One', 'Chapter Two', 'Part Two Subtitle']);
  assert.match(nav.replace(/\s+/g, ''), />ChapterTwo<\/a><ol><li>/);
});

test('a PDF with no title is named after its file', async () => {
  const untitled = {
    ...pdfjs,
    getDocument: (options) => ({
      promise: pdfjs.getDocument(options).promise.then((doc) => new Proxy(doc, {
        get: (target, key) => (key === 'getMetadata' ? async () => ({ info: {} }) : Reflect.get(target, key, target)),
      })),
    }),
  };
  const { loader } = await bookOf(new File([fixtureBytes('book.pdf')], 'book.epub'), { pdfjs: untitled, name: 'Some File.PDF' });
  assert.match(loader.loadText('OEBPS/content.opf'), /<dc:title>Some File<\/dc:title>/);
});

test('closing the book lets pdf.js go', async () => {
  let destroyed = 0;
  let epubDestroyed = 0;
  const watched = {
    ...pdfjs,
    getDocument: (options) => ({
      // pdf.js 6 lets a document go through the task that loaded it: the document itself has no destroy.
      promise: pdfjs.getDocument(options).promise.then((doc) => new Proxy(doc, {
        get: (target, key) => (key === 'loadingTask'
          ? { destroy: async () => { destroyed += 1; return target.loadingTask.destroy(); } }
          : Reflect.get(target, key, target)),
      })),
    }),
  };
  class ClosingEpub extends RecordingEpub {
    destroy() {
      epubDestroyed += 1;
    }
  }
  const book = await bookOf(new File([fixtureBytes('book.pdf')], 'book.epub'), { pdfjs: watched, EPUB: ClosingEpub });
  assert.equal(destroyed, 0);
  book.destroy();
  assert.equal(epubDestroyed, 1);
  assert.equal(destroyed, 1);
});
