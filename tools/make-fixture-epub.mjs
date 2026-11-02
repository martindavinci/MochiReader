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
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = (1 << 5) | 1; // 1980-01-01, so the output never depends on the clock

// The fields shared by the local header and the central directory entry.
function zipEntryFields(crc, size, nameLength) {
  const fields = Buffer.alloc(26);
  fields.writeUInt16LE(ZIP_VERSION, 0);
  fields.writeUInt16LE(ZIP_FLAG_UTF8_NAME, 2);
  fields.writeUInt16LE(ZIP_METHOD_STORED, 4);
  fields.writeUInt16LE(ZIP_DOS_TIME, 6);
  fields.writeUInt16LE(ZIP_DOS_DATE, 8);
  fields.writeUInt32LE(crc, 10);
  fields.writeUInt32LE(size, 14);
  fields.writeUInt32LE(size, 18);
  fields.writeUInt16LE(nameLength, 22);
  return fields;
}

// Writes a ZIP without compression, entries in the given order. EPUB requires
// `mimetype` to come first and stored, and allows every other entry to be stored.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const fields = zipEntryFields(crc32(data), data.length, nameBytes.length);

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

const xhtml = (title, body) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title></head>
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

// `identifier` is left out of the metadata altogether when it is null, and
// `encryption` adds META-INF/encryption.xml with that content.
function epub({ identifier, title, chapters, encryption }) {
  const uniqueIdentifier = identifier ? ' unique-identifier="book-id"' : '';
  const identifierElement = identifier
    ? `    <dc:identifier id="book-id">${identifier}</dc:identifier>\n`
    : '';
  const manifestItems = chapters
    .map(
      ({ properties }, index) =>
        `    <item id="chapter-${index + 1}" href="chapter-${index + 1}.xhtml" ` +
        `media-type="application/xhtml+xml"${properties ? ` properties="${properties}"` : ''}/>`,
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
  </metadata>
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
    ...chapters.map(({ title: label, body }, index) => [
      `OEBPS/chapter-${index + 1}.xhtml`,
      xhtml(label, body),
    ]),
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
  // A real ZIP signature whose central directory has been cut away.
  'corrupt.epub': plain.subarray(0, Math.floor(plain.length / 2)),
};

if (isEntryPoint(import.meta.url)) {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [name, bytes] of Object.entries(FIXTURES)) {
    writeFileSync(join(FIXTURES_DIR, name), bytes);
  }
}
