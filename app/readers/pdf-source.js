// SPDX-License-Identifier: GPL-3.0-or-later
// What pdf.js tells of a PDF, in the terms of pdf-layout.js: runs of text and image boxes measured from the top of each
// page, and the outline as marks. pdf.js is handed in, so the app can load its own copy and the tests the one for Node.
import { hasText } from './pdf-layout.js';

/** A PDF the reader cannot read: `password` when it is locked, `no-text` when its pages are only pictures. */
export class PdfError extends Error {
  /** @param {'password'|'no-text'} code */
  constructor(code) {
    super(code === 'password' ? 'the PDF has a password' : 'the PDF has no text');
    this.name = 'PdfError';
    this.code = code;
  }
}

const PASSWORD_EXCEPTION = 'PasswordException';
// pdf.js gives a font's name only once the page has been read for drawing, under its own key.
const BOLD_NAME = /bold|black|heavy|semibold|demi/i;
const DESTINATION_TOP = { XYZ: 3, FitH: 2, FitBH: 2, FitR: 5 };
const IDENTITY = [1, 0, 0, 1, 0, 0];
const ESCAPED_BRACKET = /\\([()])/g;

/** @returns {number[]} The transform `matrix` then `current`, as PDF composes them. */
function compose([a, b, c, d, e, f], [A, B, C, D, E, F]) {
  return [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
}

/** The boxes the page paints images in, in the PDF's own space (y up). */
function imageBoxes({ fnArray, argsArray }, OPS) {
  const paints = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
  const saved = [];
  let current = IDENTITY;
  const boxes = [];
  fnArray.forEach((fn, at) => {
    if (fn === OPS.save) saved.push(current);
    else if (fn === OPS.restore) current = saved.pop() ?? IDENTITY;
    else if (fn === OPS.transform) current = compose(argsArray[at], current);
    else if (paints.has(fn)) {
      const [a, b, c, d, e, f] = current;
      const xs = [e, a + e, c + e, a + c + e];
      const ys = [f, b + f, d + f, b + d + f];
      boxes.push({ left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) });
    }
  });
  return boxes;
}

function fontIsBold(page, fontName, styles) {
  try {
    if (page.commonObjs?.has?.(fontName)) {
      const font = page.commonObjs.get(fontName);
      if (font?.bold || font?.black || BOLD_NAME.test(font?.name ?? '')) return true;
    }
  } catch {
    // A font pdf.js could not load is read as regular.
  }
  return BOLD_NAME.test(styles?.[fontName]?.fontFamily ?? '');
}

async function readPage(page, OPS) {
  const [x0, y0, x1, y1] = page.view;
  const operators = await page.getOperatorList();
  const { items, styles } = await page.getTextContent();
  const runs = items.filter(({ str }) => str && str.trim()).map(({ str, transform, width, fontName }) => ({
    text: str,
    x: transform[4] - x0,
    y: y1 - transform[5],
    width,
    size: Math.hypot(transform[2], transform[3]),
    bold: fontIsBold(page, fontName, styles),
  }));
  const images = imageBoxes(operators, OPS).map(({ left, right, bottom, top }) => ({
    x: left - x0,
    y: y1 - top,
    width: right - left,
    height: top - bottom,
  }));
  return { width: x1 - x0, height: y1 - y0, runs, images };
}

async function markOf(doc, { title, dest }, depth, pages) {
  const destination = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
  if (!Array.isArray(destination) || destination.length === 0) return null;
  const [target, fit] = destination;
  const page = Number.isInteger(target) ? target : await doc.getPageIndex(target);
  if (!Number.isInteger(page) || page < 0 || page >= doc.numPages) return null;
  const at = DESTINATION_TOP[fit?.name];
  const top = at === undefined ? null : destination[at];
  const height = pages[page]?.height ?? 0;
  return { title: (title ?? '').trim(), page, y: typeof top === 'number' ? Math.max(0, height - top) : 0, depth };
}

/** The outline, depth first, as marks; an entry that leads nowhere is left out, its children are not. */
async function marksOf(doc, pages) {
  const outline = (await doc.getOutline()) ?? [];
  const marks = [];
  const walk = async (items, depth) => {
    for (const item of items) {
      const mark = await markOf(doc, item, depth, pages);
      if (mark?.title) marks.push(mark);
      await walk(item.items ?? [], depth + 1);
    }
  };
  await walk(outline, 0);
  return marks;
}

const textOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * @param {ArrayBuffer|Uint8Array} data
 * @param {object} pdfjs The module of pdf.js.
 * @returns {Promise<{info: {title: string|null, author: string|null, language: string|null},
 *   pages: import('./pdf-layout.js').Page[], marks: import('./pdf-layout.js').Mark[], pdf: object}>}
 */
export async function readPdf(data, pdfjs) {
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data, useWasm: false, isEvalSupported: false, verbosity: 0 }).promise;
  } catch (error) {
    if (error?.name === PASSWORD_EXCEPTION) throw new PdfError('password');
    throw error;
  }
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    pages.push(await readPage(await pdf.getPage(number), pdfjs.OPS));
  }
  if (!hasText(pages)) throw new PdfError('no-text');
  const { info, metadata } = (await pdf.getMetadata().catch(() => null)) ?? {};
  return {
    info: {
      // Some makers escape the brackets of a title a second time, and the backslashes stay in it.
      title: textOrNull(info?.Title)?.replace(ESCAPED_BRACKET, '$1') ?? null,
      author: textOrNull(info?.Author),
      language: textOrNull(info?.Language) ?? textOrNull(metadata?.get?.('dc:language')),
    },
    pages,
    marks: await marksOf(pdf, pages),
    pdf,
  };
}

/**
 * The rectangle of pixels a box covers once its page is drawn at `scale`: rounded outwards, never off the page's
 * top or left.
 * @param {import('./pdf-layout.js').Box} box
 */
export function cropOf({ x, y, width, height }, scale) {
  const left = Math.max(0, Math.floor(x * scale));
  const top = Math.max(0, Math.floor(y * scale));
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.ceil((x + width) * scale) - left),
    height: Math.max(1, Math.ceil((y + height) * scale) - top),
  };
}

/**
 * A figure cut from its page: the page drawn at `scale`, the box copied out of it.
 * @param {object} pdf The document pdf.js opened.
 * @param {number} pageIndex From 0.
 * @param {import('./pdf-layout.js').Box} box
 * @param {Document} document Where the canvases are made.
 * @returns {Promise<Blob>} A PNG.
 */
export async function drawFigure(pdf, pageIndex, box, document, scale = 2) {
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const crop = cropOf(box, scale);
  const width = Math.min(crop.width, canvas.width - crop.x);
  const height = Math.min(crop.height, canvas.height - crop.y);
  const figure = document.createElement('canvas');
  figure.width = Math.max(1, width);
  figure.height = Math.max(1, height);
  figure.getContext('2d').drawImage(canvas, crop.x, crop.y, width, height, 0, 0, width, height);
  canvas.width = 0;
  canvas.height = 0;
  return new Promise((resolve, reject) => {
    figure.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the figure could not be drawn'))), 'image/png');
  });
}
