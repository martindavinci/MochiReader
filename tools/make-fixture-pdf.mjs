// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generates the PDF test files in test/fixtures/, byte for byte the same on every run, written by hand: no library.
// The text is made up. Usage: node tools/make-fixture-pdf.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './is-entry-point.mjs';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT = 72;
const INDENT = 86;
const BODY = 12;
const REGULAR = 'F1';
const BOLD = 'F2';

/** A string in a PDF literal: Latin-1, with its delimiters escaped. */
const literal = (text) => `(${text.replace(/[\\()]/g, (mark) => `\\${mark}`)})`;

/** Text at `y` from the top of the page, as a reader sees it. */
const text = (x, y, words, { size = BODY, font = REGULAR } = {}) => ({ kind: 'text', x, y, words, size, font });

/** An image whose top edge is `y` from the top of the page. */
const image = (name, x, y, width, height) => ({ kind: 'image', name, x, y, width, height });

function contentOf(items) {
  return items.map((item) => {
    if (item.kind === 'text') {
      return `BT /${item.font} ${item.size} Tf ${item.x} ${PAGE_HEIGHT - item.y} Td ${literal(item.words)} Tj ET`;
    }
    const bottom = PAGE_HEIGHT - item.y - item.height;
    return `q ${item.width} 0 0 ${item.height} ${item.x} ${bottom} cm /${item.name} Do Q`;
  }).join('\n');
}

/** Pixels of one colour, uncompressed DeviceRGB. */
function pixels(width, height, [red, green, blue]) {
  const bytes = Buffer.alloc(width * height * 3);
  for (let at = 0; at < bytes.length; at += 3) {
    bytes[at] = red;
    bytes[at + 1] = green;
    bytes[at + 2] = blue;
  }
  return { width, height, bytes };
}

/**
 * @param {{pages: object[][], images: Record<string, ReturnType<typeof pixels>>, outline?: object[],
 *   info?: Record<string, string>}} book `outline` items: {title, page (0-based), top (from the page top), children}.
 */
function pdf({ pages, images, outline = [], info = {} }) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const reserve = () => add(null);

  const catalog = reserve();
  const pageTree = reserve();
  const fonts = {
    [REGULAR]: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    [BOLD]: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
  };
  const imageIds = Object.fromEntries(Object.entries(images).map(([name, { width, height, bytes }]) => [name, add({
    dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB `
      + `/BitsPerComponent 8 /Length ${bytes.length} >>`,
    stream: bytes,
  })]));
  const fontRefs = Object.entries(fonts).map(([name, id]) => `/${name} ${id} 0 R`).join(' ');
  const pageIds = pages.map((items) => {
    const stream = Buffer.from(contentOf(items), 'latin1');
    const content = add({ dict: `<< /Length ${stream.length} >>`, stream });
    const used = [...new Set(items.filter(({ kind }) => kind === 'image').map(({ name }) => name))];
    const xobjects = used.length > 0 ? ` /XObject << ${used.map((name) => `/${name} ${imageIds[name]} 0 R`).join(' ')} >>` : '';
    return add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
      + `/Resources << /Font << ${fontRefs} >>${xobjects} >> /Contents ${content} 0 R >>`);
  });
  objects[pageTree - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;

  let outlines = '';
  if (outline.length > 0) {
    const root = reserve();
    const place = (items, parent) => {
      const ids = items.map(() => reserve());
      items.forEach((item, at) => {
        const kids = item.children ?? [];
        const kidIds = place(kids, ids[at]);
        const links = [
          `/Title ${literal(item.title)}`,
          `/Parent ${parent} 0 R`,
          `/Dest [${pageIds[item.page]} 0 R /XYZ ${LEFT} ${PAGE_HEIGHT - item.top} null]`,
          at > 0 ? `/Prev ${ids[at - 1]} 0 R` : '',
          at < ids.length - 1 ? `/Next ${ids[at + 1]} 0 R` : '',
          kidIds.length > 0 ? `/First ${kidIds[0]} 0 R /Last ${kidIds.at(-1)} 0 R /Count ${kidIds.length}` : '',
        ].filter(Boolean);
        objects[ids[at] - 1] = `<< ${links.join(' ')} >>`;
      });
      return ids;
    };
    const top = place(outline, root);
    objects[root - 1] = `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top.at(-1)} 0 R /Count ${top.length} >>`;
    outlines = ` /Outlines ${root} 0 R /PageMode /UseOutlines`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R${outlines} >>`;
  const infoEntries = Object.entries(info);
  const infoId = infoEntries.length > 0 ? add(`<< ${infoEntries.map(([key, value]) => `/${key} ${literal(value)}`).join(' ')} >>`) : 0;

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let length = chunks[0].length;
  const offsets = objects.map((body, index) => {
    const at = length;
    const parts = typeof body === 'string'
      ? [Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1')]
      : [Buffer.from(`${index + 1} 0 obj\n${body.dict}\nstream\n`, 'latin1'), body.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')];
    for (const part of parts) {
      chunks.push(part);
      length += part.length;
    }
    return at;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root ${catalog} 0 R${infoId ? ` /Info ${infoId} 0 R` : ''} >>`,
    'startxref',
    String(length),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

/** The running header and the page number every page of the book has. */
const running = (number) => [
  text(LEFT, 40, 'A MADE-UP BOOK', { size: 9 }),
  text(300, 760, String(number), { size: 9 }),
];

const BOOK_PAGES = [
  [
    ...running(1),
    text(LEFT, 110, 'Chapter One', { size: 24, font: BOLD }),
    text(INDENT, 150, 'The first paragraph of the made-up book is here, so that its lines are read as'),
    text(LEFT, 166, 'one paragraph again.'),
    text(INDENT, 182, 'A second paragraph begins with an indent, and the word at its end keeps contin-'),
    text(LEFT, 198, 'uing the test on a second line, which is where this paragraph stops.'),
    text(LEFT, 230, 'A HEADING IN CAPITALS', { font: BOLD }),
    text(INDENT, 262, 'Under the heading a paragraph runs on and on, all the way down to the foot of'),
    text(LEFT, 278, 'the page, with no full stop at the end of its last line, and the sentence goes on'),
  ],
  [
    ...running(2),
    text(LEFT, 80, 'across the page break. Then the paragraph ends here.'),
    image('Figure', 156, 110, 300, 150),
    text(INDENT, 280, 'FIGURE 1: A square made of colour.', { size: 10 }),
    text(INDENT, 312, 'A paragraph after the figure has a mark for a note at the end of its first line*'),
    text(LEFT, 328, 'and it goes on for one more line, then stops.'),
    image('Dot', 300, 350, 4, 4),
    text(LEFT, 740, '* A note at the foot of the page.', { size: 8 }),
  ],
  [
    ...running(3),
    image('Band', 117, 60, 378, 85),
    text(LEFT, 180, 'Chapter Two', { size: 24, font: BOLD }),
    text(LEFT, 210, 'Part Two Subtitle', { size: 16, font: BOLD }),
    text(LEFT, 260, 'T', { size: 30 }),
    text(92, 250, 'his chapter starts with a large letter, as books often do, and the text that'),
    text(92, 266, 'comes beside it wraps around the letter until the lines are past it.'),
    text(LEFT, 282, 'Then a well-known phrase sits inside this line, and the next line ends on COVID-19'),
    text(LEFT, 298, 'cases counted in a table that is not here. The paragraph ends at the foot.'),
  ],
  [
    ...running(4),
    text(INDENT, 80, 'Another paragraph starts here.'),
    text(INDENT, 96, 'And a last one closes the book.'),
  ],
];

export const PDF_FIXTURES = {
  'book.pdf': pdf({
    pages: BOOK_PAGES,
    images: {
      Figure: pixels(30, 15, [200, 60, 40]),
      Dot: pixels(2, 2, [0, 0, 0]),
      Band: pixels(38, 9, [120, 120, 200]),
    },
    outline: [
      { title: 'Chapter One', page: 0, top: 90 },
      { title: 'Chapter Two', page: 2, top: 160, children: [{ title: 'Part Two Subtitle', page: 2, top: 195 }] },
    ],
    info: { Title: 'A Made-Up Book', Author: 'Nobody' },
  }),
  'scanned.pdf': pdf({
    pages: [[image('Scan', 0, 0, PAGE_WIDTH, PAGE_HEIGHT)]],
    images: { Scan: pixels(6, 8, [230, 230, 220]) },
  }),
};

if (isEntryPoint(import.meta.url)) {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [name, bytes] of Object.entries(PDF_FIXTURES)) {
    writeFileSync(join(FIXTURES_DIR, name), bytes);
  }
}
