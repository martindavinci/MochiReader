// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { DOMParser, parseHTML } from 'linkedom';
import { isUnreadablePage, keepSectionsLoading, sectionPage, sectionType } from '../app/readers/epub-section.js';

const XHTML = 'application/xhtml+xml';
const HTML = 'text/html';
const SVG = 'image/svg+xml';

const tools = (over = {}) => ({
  fixed: false,
  parser: new DOMParser(),
  serializer: { serializeToString: (doc) => doc.toString() },
  ...over,
});

const page = (head, body) => `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title>${head}</head><body>${body}</body></html>`;

test('what a browser would connect for before the CSP has a say does not reach the frame', async () => {
  const kinds = ['preconnect', 'dns-prefetch', 'prerender', 'prefetch', 'preload', 'modulepreload', 'next', 'icon'];
  for (const kind of kinds) {
    const out = await sectionPage(page(`<link rel="${kind}" href="http://e.org/x"/>`, '<p>Text</p>'), XHTML, tools());
    assert.doesNotMatch(out, /<link/, kind);
    assert.match(out, /Text/, kind);
  }
});

test('a link counts for all it says, in any case and with any spaces', async () => {
  for (const rel of [' PRECONNECT ', 'stylesheet preconnect', 'Dns-Prefetch\nstylesheet', '']) {
    const out = await sectionPage(page(`<link rel="${rel}" href="http://e.org/"/>`, ''), XHTML, tools());
    assert.doesNotMatch(out, /<link/, JSON.stringify(rel));
  }
});

test('the style sheets of a book stay', async () => {
  for (const rel of ['stylesheet', 'STYLESHEET', 'alternate stylesheet']) {
    const out = await sectionPage(page(`<link rel="${rel}" href="blob:x"/>`, ''), XHTML, tools());
    assert.match(out, /<link/, rel);
  }
});

test('frames go whatever they hold, and a base cannot point the rest of the page away', async () => {
  const body = '<iframe src="http://e.org/"></iframe><iframe srcdoc="x"></iframe><iframe src="blob:x"></iframe><p>Text</p>';
  const out = await sectionPage(page('<base href="http://e.org/"/>', body), XHTML, tools());
  assert.doesNotMatch(out, /iframe|<base/);
  assert.match(out, /Text/);
});

test('a template, which the frame could turn into a shadow root, goes too', async () => {
  const body = '<template shadowrootmode="open"><iframe src="http://e.org/"></iframe></template><p>Text</p>';
  const out = await sectionPage(`<!doctype html><html><head></head><body>${body}</body></html>`, HTML, tools());
  assert.doesNotMatch(out, /template|iframe/);
  assert.match(out, /Text/);
});

test('the mouse over a link does not make the browser look up its host', async () => {
  const off = /<head[^>]*><meta [^>]*http-equiv="x-dns-prefetch-control"[^>]*>/;
  const link = '<a href="https://e.org/">x</a>';
  assert.match(await sectionPage(page('', link), XHTML, tools()), off);
  assert.match(await sectionPage(page('', link), XHTML, tools({ fixed: true })), off);
  assert.match(await sectionPage(`<html><head></head><body>${link}</body></html>`, HTML, tools()), off);
  assert.match(await sectionPage('<svg xmlns="http://www.w3.org/2000/svg"></svg>', SVG, tools()), off);
});

test('an HTML section is read as HTML and stays HTML', async () => {
  const source = '<!doctype html><html><head><link rel=preconnect href="http://e.org/"></head><body><p>Text</p></body></html>';
  const out = await sectionPage(source, HTML, tools());
  assert.doesNotMatch(out, /<link/);
  assert.match(out, /Text/);
  assert.equal(sectionType(HTML, false), HTML);
});

test('a page drawn in SVG is held by a page the renderer can stand on', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>Drawn</text></svg>';
  const out = await sectionPage(svg, SVG, tools());
  assert.match(out, /<html[^>]*><head[^>]*>.*<\/head><body><svg[^>]*>.*Drawn.*<\/svg><\/body><\/html>/s);
  assert.equal(sectionType(SVG, false), XHTML);
});

test('a section with no body gets one, and keeps what it has', async () => {
  const out = await sectionPage('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Kept</title></head></html>', XHTML, tools());
  assert.match(out, /<title>Kept<\/title>.*<body/s);
});

test('a section with no head gets one, or the styles of the app have nowhere to go', async () => {
  const out = await sectionPage('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Text</p></body></html>', XHTML, tools());
  assert.match(out, /<head.*<body><p>Text<\/p><\/body>/s);
});

test('a section whose root is no page at all is held by a page too', async () => {
  const out = await sectionPage('<book xmlns="urn:x"><p>Text</p></book>', XHTML, tools());
  assert.match(out, /<html.*<body><book.*Text.*<\/book><\/body><\/html>/s);
});

test('a fixed layout takes the size of its SVG page from the root, so the page stays as it is', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>Drawn</text></svg>';
  const out = await sectionPage(svg, SVG, tools({ fixed: true }));
  assert.doesNotMatch(out, /<html/);
  assert.match(out, /Drawn/);
  assert.equal(sectionType(SVG, true), SVG);
});

test('a fixed layout loses what reaches out as well', async () => {
  const out = await sectionPage(page('<link rel="preconnect" href="http://e.org/"/>', '<iframe src="http://e.org/"></iframe>'), XHTML, tools({ fixed: true }));
  assert.doesNotMatch(out, /<link|iframe/);
});

test('a type foliate does not recognize is read for what the browser would take it for', async () => {
  const source = page('<link rel="preconnect" href="http://e.org/"/>', '<p>Text</p>');
  for (const [type, seenAs] of [['TEXT/HTML', HTML], ['text/html; charset=utf-8', HTML], ['text/xml', XHTML], ['application/xml', XHTML], ['Application/XHTML+XML', XHTML]]) {
    assert.equal(sectionType(type, false), seenAs, type);
    const file = new Blob([source], { type });
    const out = await sectionPage(file, type, tools());
    assert.doesNotMatch(out, /<link/, type);
    assert.match(out, /Text/, type);
  }
});

test('a picture in the reading order is left to the browser, which draws it on a page of its own', async () => {
  const file = new Blob(['png'], { type: 'image/png' });
  assert.equal(await sectionPage(file, 'image/png', tools()), file);
  assert.equal(sectionType('image/png', false), 'image/png');
});

test('anything else in the reading order is an empty page, not something a frame can trip over', async () => {
  const unread = { text: () => assert.fail('a file of no known kind is not read') };
  for (const type of ['application/x-foo', 'application/octet-stream', 'text/plain', '', undefined]) {
    const out = await sectionPage(unread, type, tools());
    assert.match(out, /<head.*<body/s, String(type));
    assert.equal(sectionType(type, false), XHTML, String(type));
  }
});

test('XML the parser refuses is an empty page', async () => {
  const parser = {
    parseFromString: () => ({ querySelector: (selector) => (selector === 'parsererror' ? {} : null) }),
  };
  const out = await sectionPage('<<<', XHTML, tools({ parser }));
  assert.match(out, /<head.*<body/s);
});

const MESSAGE = 'This part cannot be read';
const pageAt = (url) => resolveObjectURL(url).text();

const failing = {
  'rejects, as a file that does not unpack': async () => {
    throw new TypeError('The compressed data was not valid');
  },
  'gives nothing, as a file missing from the book': async () => null,
  'gives an empty address, as a file that is empty': async () => '',
};

for (const [what, load] of Object.entries(failing)) {
  test(`a section whose loading ${what} loads a page that says so`, async () => {
    const sections = [{ load }];
    keepSectionsLoading(sections, MESSAGE);
    const url = await sections[0].load();
    assert.match(url, /^blob:/);
    const { document } = parseHTML(await pageAt(url));
    assert.equal(document.body.textContent.trim(), MESSAGE);
    assert.equal(isUnreadablePage(document), true);
  });
}

test('a section that loads is left as it is', async () => {
  const sections = [{ load: async () => 'blob:the-section' }];
  keepSectionsLoading(sections, MESSAGE);
  assert.equal(await sections[0].load(), 'blob:the-section');
});

test('a page of the book is not taken for the message', () => {
  const { document } = parseHTML('<html><head></head><body><p>This part cannot be read</p></body></html>');
  assert.equal(isUnreadablePage(document), false);
});

test('leaving a section lets go of its message and of the section, and coming back works', async () => {
  let unloaded = 0;
  const sections = [{
    load: async () => null,
    unload: () => {
      unloaded += 1;
    },
  }];
  keepSectionsLoading(sections, MESSAGE);
  const first = await sections[0].load();
  sections[0].unload();
  assert.equal(unloaded, 1);
  assert.equal(resolveObjectURL(first), undefined);
  const second = await sections[0].load();
  assert.match(await pageAt(second), /cannot be read/);
  sections[0].unload();
  assert.equal(resolveObjectURL(second), undefined);
});

test('the message cannot become part of the page', async () => {
  const sections = [{ load: async () => null }];
  keepSectionsLoading(sections, 'a < b & c');
  const { document } = parseHTML(await pageAt(await sections[0].load()));
  assert.equal(document.body.textContent.trim(), 'a < b & c');
  assert.equal(document.querySelector('b'), null);
});
