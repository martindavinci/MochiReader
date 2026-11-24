// SPDX-License-Identifier: GPL-3.0-or-later
// A PDF made into an EPUB on the fly, file by file, for foliate's own EPUB class: places, the table of contents,
// sections and styles then work as they do for any EPUB. Nothing is zipped; the files are asked for by name, and a
// figure is drawn from its page only when foliate asks for its picture.
import { REFLOW_VERSION, reflow } from './pdf-layout.js';
import { drawFigure, readPdf } from './pdf-source.js';

const ROOT = 'OEBPS';
const CONTAINER = 'META-INF/container.xml';
const PACKAGE = `${ROOT}/content.opf`;
const NAV = `${ROOT}/nav.xhtml`;
const XHTML_TYPE = 'application/xhtml+xml';
const PNG_TYPE = 'image/png';
const UNKNOWN_LANGUAGE = 'und';
// The date EPUB 3 asks for. The book is made again from the same PDF every time: a fixed date says so.
const MODIFIED = '2000-01-01T00:00:00Z';
const PDF_NAME = /\.pdf$/i;
const XML_SPECIALS = /[&<>"']/g;
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

const escape = (text) => String(text).replace(XML_SPECIALS, (mark) => ENTITIES[mark]);
const sectionName = (index) => `text/c${String(index + 1).padStart(3, '0')}.xhtml`;

const xhtml = (title, language, body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escape(language)}" lang="${escape(language)}">
<head><title>${escape(title)}</title></head>
<body>
${body}
</body>
</html>
`;

function blockHtml(block, figurePath) {
  if (block.kind === 'heading') return `<h${block.level}>${escape(block.text)}</h${block.level}>`;
  if (block.kind === 'paragraph') return `<p>${escape(block.text)}</p>`;
  const alt = escape(block.caption ?? '');
  const width = Math.round(block.box.width);
  const image = `<img src="../${figurePath}" alt="${alt}" width="${width}" style="max-width: 100%; height: auto;"/>`;
  const caption = block.caption ? `<figcaption>${escape(block.caption)}</figcaption>` : '';
  return `<figure>${image}${caption}</figure>`;
}

/** The table of contents: a list in a list for each level deeper. Chapters with no title are not in it. */
function navList(chapters) {
  const entries = chapters.map((chapter, index) => ({ ...chapter, href: sectionName(index) })).filter(({ title }) => title);
  if (entries.length === 0) return '<ol></ol>';
  let html = '';
  let depth = -1;
  for (const { title, href, depth: wanted } of entries) {
    // A list goes one level deeper at a time, however deep the outline jumps.
    const level = Math.min(wanted, depth + 1);
    if (level > depth) html += '<ol>';
    else {
      html += '</li>';
      for (let close = depth; close > level; close--) html += '</ol></li>';
    }
    html += `<li><a href="${href}">${escape(title)}</a>`;
    depth = level;
  }
  html += '</li>';
  for (; depth > 0; depth--) html += '</ol></li>';
  return `${html}</ol>`;
}

/**
 * @param {{title: string, author: string|null, language: string|null, identifier: string,
 *   chapters: import('./pdf-layout.js').Chapter[], notesTitle: string}} book
 * @returns {{files: Map<string, string>, figures: Map<string, {page: number, box: import('./pdf-layout.js').Box}>}}
 */
export function epubFiles({ title, author, language, identifier, chapters, notesTitle }) {
  const lang = language ?? UNKNOWN_LANGUAGE;
  const files = new Map();
  const figures = new Map();
  const perPage = new Map();

  const sections = chapters.map((chapter, index) => {
    const body = chapter.blocks.map((block) => {
      if (block.kind !== 'figure') return blockHtml(block);
      const count = perPage.get(block.page) ?? 0;
      perPage.set(block.page, count + 1);
      const path = `images/p${block.page}-${count}.png`;
      figures.set(`${ROOT}/${path}`, { page: block.page, box: block.box });
      return blockHtml(block, path);
    });
    if (chapter.notes.length > 0) {
      body.push(`<section class="notes"><h2>${escape(notesTitle)}</h2><ol>${chapter.notes.map((note) => `<li>${escape(note)}</li>`).join('')}</ol></section>`);
    }
    const name = sectionName(index);
    files.set(`${ROOT}/${name}`, xhtml(chapter.title ?? title, lang, body.join('\n')));
    return { id: `c${index + 1}`, name };
  });

  files.set(CONTAINER, `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="${PACKAGE}" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`);
  files.set(NAV, xhtml(title, lang, `<nav epub:type="toc" id="toc">${navList(chapters)}</nav>`));
  const images = [...figures.keys()].map((path, index) => `<item id="f${index + 1}" href="${path.slice(ROOT.length + 1)}" media-type="${PNG_TYPE}"/>`);
  files.set(PACKAGE, `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id" xml:lang="${escape(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">${escape(identifier)}</dc:identifier>
<dc:title>${escape(title)}</dc:title>
${author ? `<dc:creator>${escape(author)}</dc:creator>\n` : ''}<dc:language>${escape(lang)}</dc:language>
<meta property="dcterms:modified">${MODIFIED}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="${XHTML_TYPE}" properties="nav"/>
${sections.map(({ id, name }) => `<item id="${id}" href="${name}" media-type="${XHTML_TYPE}"/>`).join('\n')}
${images.join('\n')}
</manifest>
<spine>
${sections.map(({ id }) => `<itemref idref="${id}"/>`).join('\n')}
</spine>
</package>
`);
  return { files, figures };
}

/**
 * What foliate's EPUB asks its files of.
 * @param {{files: Map<string, string>, figures: Map<string, {page: number, box: object}>}} book
 * @param {(page: number, box: object) => Promise<Blob>} draw
 */
export function pdfLoader({ files, figures }, draw) {
  const drawn = new Map();
  return {
    loadText: (name) => files.get(name) ?? null,
    loadBlob: (name) => {
      if (files.has(name)) return new Blob([files.get(name)], { type: name.endsWith('.opf') ? 'application/xml' : XHTML_TYPE });
      const figure = figures.get(name);
      if (!figure) return null;
      if (!drawn.has(name)) drawn.set(name, draw(figure.page, figure.box));
      return drawn.get(name);
    },
    getSize: (name) => files.get(name)?.length ?? 0,
  };
}

/**
 * @param {File} file The PDF.
 * @param {{pdfjs: object, EPUB: Function, hash: () => Promise<string>, notesTitle: string, name: string,
 *   document: Document}} opts `name`: the file's name, the title of a PDF that has none.
 * @returns {Promise<object>} A book, as foliate's EPUB makes it.
 */
export async function makePdfBook(file, { pdfjs, EPUB, hash, notesTitle, name, document }) {
  const { info, pages, marks, pdf } = await readPdf(new Uint8Array(await file.arrayBuffer()), pdfjs);
  const identifier = `pdf:${await hash()}|reflow-${REFLOW_VERSION}`;
  const title = (info.title ?? name ?? '').replace(PDF_NAME, '').trim() || name;
  const book = epubFiles({
    title,
    author: info.author,
    language: info.language,
    identifier,
    chapters: reflow(pages, marks),
    notesTitle,
  });
  return new EPUB(pdfLoader(book, (page, box) => drawFigure(pdf, page, box, document))).init();
}
