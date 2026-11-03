// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generates the EPUB test files in test/fixtures/, byte for byte the same on every
// run. Usage: node tools/make-fixture-epub.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { isEntryPoint } from './is-entry-point.mjs';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_DIRECTORY = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_FLAG_UTF8_NAME = 0x0800;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATED = 8;
// A deflate block of the one type that does not exist: readable as a ZIP entry, and it fails when it is unpacked. Written
// out because compressing and spoiling real data would depend on the version of zlib.
const SPOILED_DEFLATE = Buffer.from([0x07, 0x00, 0x00, 0x00]);
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = (1 << 5) | 1; // 1980-01-01, so the output never depends on the clock

// The fields shared by the local header and the central directory entry.
function zipEntryFields(crc, packedSize, size, nameLength, method) {
  const fields = Buffer.alloc(26);
  fields.writeUInt16LE(ZIP_VERSION, 0);
  fields.writeUInt16LE(ZIP_FLAG_UTF8_NAME, 2);
  fields.writeUInt16LE(method, 4);
  fields.writeUInt16LE(ZIP_DOS_TIME, 6);
  fields.writeUInt16LE(ZIP_DOS_DATE, 8);
  fields.writeUInt32LE(crc, 10);
  fields.writeUInt32LE(packedSize, 14);
  fields.writeUInt32LE(size, 18);
  fields.writeUInt16LE(nameLength, 22);
  return fields;
}

// Writes a ZIP without compression, entries in the given order. EPUB requires
// `mimetype` to come first and stored, and allows every other entry to be stored.
// An entry marked `spoiled` claims to be compressed, and its data cannot be unpacked.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, { spoiled = false } = {}] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const text = Buffer.from(content, 'utf8');
    const data = spoiled ? SPOILED_DEFLATE : text;
    const method = spoiled ? ZIP_METHOD_DEFLATED : ZIP_METHOD_STORED;
    const fields = zipEntryFields(crc32(text), data.length, text.length, nameBytes.length, method);

    const localSignature = Buffer.alloc(4);
    localSignature.writeUInt32LE(ZIP_LOCAL_HEADER);
    const local = Buffer.concat([localSignature, fields, nameBytes, data]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_HEADER, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    fields.copy(central, 6);
    central.writeUInt32LE(offset, 42);

    locals.push(local);
    centrals.push(Buffer.concat([central, nameBytes]));
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_OF_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const XHTML_TYPE = 'application/xhtml+xml';
const HTML_TYPE = 'text/html';

const xhtml = (title, body, head = '') => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title>${head}</head>
<body>
${body}
</body>
</html>
`;

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

// An encryption method that is not font obfuscation, which is what marks a book as
// DRM protected. The chapter stays readable: only that check may refuse the book.
const DRM_ENCRYPTION = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>
    <CipherData>
      <CipherReference URI="OEBPS/chapter-1.xhtml"/>
    </CipherData>
  </EncryptedData>
</encryption>
`;

// Font obfuscation, the one kind of encryption that hides no text: this book must open.
const FONT_ENCRYPTION = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <CipherData>
      <CipherReference URI="OEBPS/font.otf"/>
    </CipherData>
  </EncryptedData>
</encryption>
`;

// Pages of a set size: a renderer of its own in foliate-js, with no style sheet to set. They come one to a screen
// with `spread` none. With no `spread` they come in pairs, and the first page has an empty frame next to it.
const fixedLayoutMetadata = (spread) => `    <meta property="rendition:layout">pre-paginated</meta>
${spread ? `    <meta property="rendition:spread">${spread}</meta>
` : ''}`;
const FIXED_LAYOUT_VIEWPORT = '<meta name="viewport" content="width=600, height=800"/>';

// `identifier` is left out of the metadata altogether when it is null, `encryption`
// adds META-INF/encryption.xml with that content, and `fixedLayout` makes it a book of pages. A chapter can name
// the `mediaType` its file is declared with, add to its `head`, or be a `raw` file instead of a page made here. Its file
// can be `spoiled`, so that it fails when it is unpacked, or `missing` from the ZIP while the book still lists it.
function epub({ identifier, title, chapters, encryption, fixedLayout = false, spread = 'none' }) {
  const uniqueIdentifier = identifier ? ' unique-identifier="book-id"' : '';
  const identifierElement = identifier
    ? `    <dc:identifier id="book-id">${identifier}</dc:identifier>\n`
    : '';
  const manifestItems = chapters
    .map(
      ({ properties, mediaType = XHTML_TYPE }, index) =>
        `    <item id="chapter-${index + 1}" href="chapter-${index + 1}.xhtml" ` +
        `media-type="${mediaType}"${properties ? ` properties="${properties}"` : ''}/>`,
    )
    .join('\n');
  const spineItems = chapters
    .map((_, index) => `    <itemref idref="chapter-${index + 1}"/>`)
    .join('\n');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"${uniqueIdentifier}>
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${identifierElement}    <dc:title>${title}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-11-02T00:00:00Z</meta>
${fixedLayout ? fixedLayoutMetadata(spread) : ''}  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifestItems}
  </manifest>
  <spine>
${spineItems}
  </spine>
</package>
`;
  const tocLinks = chapters
    .map(({ title: label }, index) => `    <li><a href="chapter-${index + 1}.xhtml">${label}</a></li>`)
    .join('\n');
  const nav = xhtml(
    'Contents',
    `<nav epub:type="toc">\n  <ol>\n${tocLinks}\n  </ol>\n</nav>`,
  );
  return zip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', CONTAINER],
    ...(encryption ? [['META-INF/encryption.xml', encryption]] : []),
    ['OEBPS/content.opf', opf],
    ['OEBPS/nav.xhtml', nav],
    ...chapters.flatMap(({ title: label, body, head = '', raw, spoiled, missing }, index) => (missing ? [] : [[
      `OEBPS/chapter-${index + 1}.xhtml`,
      raw ?? xhtml(label, body, fixedLayout ? FIXED_LAYOUT_VIEWPORT : head),
      { spoiled },
    ]])),
  ]);
}

const PROSE_CHAPTERS = [
  {
    title: 'The First Chapter',
    body: `<h1>The First Chapter</h1>
<p>This is the first paragraph of the first chapter. It has two sentences.</p>
<p>This is the second paragraph of the first chapter.</p>`,
  },
  {
    title: 'The Second Chapter',
    body: `<h1>The Second Chapter</h1>
<p>This is the first paragraph of the second chapter. It has two sentences.</p>
<p>This is the second paragraph of the second chapter.</p>`,
  },
];

// Both attempts must stay dead: the app's CSP blocks them, and the command they
// call only exists in builds with the `smoke` feature.
const IPC_ATTEMPT = "window.parent.__TAURI__.core.invoke('smoke_canary')";

const SCRIPTED_CHAPTERS = [
  {
    title: 'A Chapter With Scripts',
    properties: 'scripted',
    body: `<h1>A Chapter With Scripts</h1>
<p>This book tries to reach the application from its content.</p>
<script>${IPC_ATTEMPT}</script>
<img src="missing-image.png" alt="" onerror="${IPC_ATTEMPT}"/>`,
  },
];

// The CSP lets a book name a script of the app itself, which would run in the frame of the book. Declared as HTML
// because Chromium runs no module script in XHTML. The elements are the ones the shell looks for on its page: if it
// runs, it fills them with its first screen, next to the one sentence that should be here.
const SELF_SCRIPT_CHAPTERS = [
  {
    title: 'A Chapter Naming The App',
    mediaType: HTML_TYPE,
    body: `<p>This book names a script of the application.</p>
<i id="tabbar"></i><i id="panes"></i><i id="home"></i><i id="toast"></i><i id="panel"></i>
<script type="module" src="http://tauri.localhost/ui/shell.js"></script>`,
  },
];

// Each on a port of its own, which tools/smoke.ps1 listens on. The CSP stops none of these: Chromium connects for them,
// and for the prerender it even sends the request. Prefixes and odd spacing are what a check of the text alone misses.
const LOOPBACK = 'http://127.0.0.1';
const NETWORK_CHAPTERS = [
  {
    title: 'A Chapter That Reaches Out',
    head: `<link rel="preconnect" href="${LOOPBACK}:48311"/>
<link rel="prerender" href="${LOOPBACK}:48312/page"/>
<link rel=" stylesheet  PRECONNECT " href="${LOOPBACK}:48313"/>
<h:link xmlns:h="http://www.w3.org/1999/xhtml" rel="preconnect" href="${LOOPBACK}:48314"/>
<base href="${LOOPBACK}:48315/"/>`,
    body: `<p>This book tries to reach the network from its content.</p>
<iframe src="${LOOPBACK}:48316/frame.html"></iframe>
<iframe srcdoc="&lt;link rel='preconnect' href='${LOOPBACK}:48317'&gt;"></iframe>
<h:iframe xmlns:h="http://www.w3.org/1999/xhtml" src="${LOOPBACK}:48318/frame.html"></h:iframe>
<iframe src="relative.html"></iframe>`,
  },
];

// Only the HTML parser of the frame makes a shadow root of a template, and nothing looks inside a template.
const NETWORK_HTML_CHAPTERS = [
  {
    title: 'A Chapter That Reaches Out From A Shadow',
    mediaType: HTML_TYPE,
    raw: `<!doctype html>
<html><head><title>Shadow</title></head>
<body>
<p>This book tries to reach the network from its content.</p>
<div><template shadowrootmode="open"><iframe src="${LOOPBACK}:48319/frame.html"></iframe></template></div>
</body></html>
`,
  },
];

const DRAWN_PAGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" fill="#88a"/><text x="10" y="50">Drawn page</text>
</svg>
`;
const PAGE_WITH_NO_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Nothing</title></head></html>
`;

const SVG_PAGES_CHAPTERS = [
  { title: 'A Drawn Page', mediaType: 'image/svg+xml', raw: DRAWN_PAGE },
  { title: 'After The Drawing', body: '<p>The page after the drawing.</p>' },
  { title: 'Nothing', raw: PAGE_WITH_NO_BODY },
  { title: 'After Nothing', body: '<p>The page after the one with no body.</p>' },
];

const SVG_LINK_NAMESPACES = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// Large enough to be under the middle of the window, where tools/smoke.ps1 clicks. The last one leads to a kind of
// address the app refuses, so that the check opens no browser.
const svgLink = (href, text) => `<svg ${SVG_LINK_NAMESPACES} width="100%" height="600"><a xlink:href="${href}"><rect width="100%" height="100%" fill="#88a"/></a></svg>
<p>${text}</p>`;

const LINKS_CHAPTERS = [
  { title: 'SVG Link', body: svgLink('chapter-2.xhtml', 'The page with the link in a drawing.') },
  {
    title: 'Image Map',
    body: `<img usemap="#map" src="data:image/png;base64,${ONE_PIXEL_PNG}" width="800" height="600" alt=""/>
<map name="map"><area shape="rect" coords="0,0,800,600" href="chapter-3.xhtml" alt="next"/></map>
<p>The page with the image map.</p>`,
  },
  { title: 'SVG Link Out', body: svgLink('ftp://example.invalid/', 'The page with the link out of the book.') },
  { title: 'The End', body: '<p>The page after the links.</p>' },
];

const DAMAGED_CHAPTERS = [
  { title: 'Before The Damage', body: '<p>The page before the damage.</p>' },
  { title: 'Spoiled', body: '<p>Nobody reads this.</p>', spoiled: true },
  { title: 'After The Spoiled One', body: '<p>The page after the spoiled file.</p>' },
  { title: 'Missing', missing: true },
  { title: 'After The Missing One', body: '<p>The page after the missing file.</p>' },
  { title: 'Empty', raw: '' },
  { title: 'After The Empty One', body: '<p>The page after the empty file.</p>' },
];

// Long enough to scroll several screens in the scrolling view.
const LONG_CHAPTER_PARAGRAPHS = 200;
const longChapter = (title) => ({
  title,
  body: Array.from(
    { length: LONG_CHAPTER_PARAGRAPHS },
    (_, index) => `<p>Paragraph ${index + 1} of ${title}, long enough to take a line and a little more of the column.</p>`,
  ).join('\n'),
});

const plain = epub({
  identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e01',
  title: 'Plain Fixture',
  chapters: PROSE_CHAPTERS,
});

export const FIXTURES = {
  'plain.epub': plain,
  'scripted.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e02',
    title: 'Scripted Fixture',
    chapters: SCRIPTED_CHAPTERS,
  }),
  'no-id.epub': epub({ identifier: null, title: 'No Identifier Fixture', chapters: PROSE_CHAPTERS }),
  'drm.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e03',
    title: 'DRM Fixture',
    chapters: PROSE_CHAPTERS,
    encryption: DRM_ENCRYPTION,
  }),
  'obfuscated-font.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e05',
    title: 'Obfuscated Font Fixture',
    chapters: PROSE_CHAPTERS,
    encryption: FONT_ENCRYPTION,
  }),
  'fixed.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e04',
    title: 'Fixed Layout Fixture',
    chapters: PROSE_CHAPTERS,
    fixedLayout: true,
  }),
  'self-script.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e06',
    title: 'Self Script Fixture',
    chapters: SELF_SCRIPT_CHAPTERS,
  }),
  'fixed-spread.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e07',
    title: 'Fixed Spread Fixture',
    chapters: PROSE_CHAPTERS,
    fixedLayout: true,
    spread: null,
  }),
  'network.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e08',
    title: 'Network Fixture',
    chapters: NETWORK_CHAPTERS,
  }),
  'network-html.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e09',
    title: 'Network HTML Fixture',
    chapters: NETWORK_HTML_CHAPTERS,
  }),
  'svg-pages.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e0a',
    title: 'SVG Pages Fixture',
    chapters: SVG_PAGES_CHAPTERS,
  }),
  'links.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e0b',
    title: 'Links Fixture',
    chapters: LINKS_CHAPTERS,
  }),
  'damaged-chapters.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e0c',
    title: 'Damaged Chapters Fixture',
    chapters: DAMAGED_CHAPTERS,
  }),
  'long-chapters.epub': epub({
    identifier: 'urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e0d',
    title: 'Long Chapters Fixture',
    chapters: [longChapter('Chapter One'), longChapter('Chapter Two'), longChapter('Chapter Three')],
  }),
  // A real ZIP signature whose central directory has been cut away.
  'corrupt.epub': plain.subarray(0, Math.floor(plain.length / 2)),
};

if (isEntryPoint(import.meta.url)) {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [name, bytes] of Object.entries(FIXTURES)) {
    writeFileSync(join(FIXTURES_DIR, name), bytes);
  }
}
