// SPDX-License-Identifier: GPL-3.0-or-later
// The text of a PDF made from a book comes as runs of letters placed on pages. Here they become a book again:
// paragraphs joined across lines and pages, headings, figures in their place, notes out of the way, chapters cut where
// the PDF's outline says. Nothing here reads a PDF: the pages come already read (pdf-source.js).

/**
 * @typedef {{text: string, x: number, y: number, width: number, size: number, bold: boolean}} Run y: the baseline,
 *   from the top of the page, in points.
 * @typedef {{x: number, y: number, width: number, height: number}} Box y: the top edge, from the top of the page.
 * @typedef {{width: number, height: number, runs: Run[], images: Box[]}} Page
 * @typedef {{title: string, page: number, y: number|null, depth: number}} Mark An entry of the outline: page from 0, y from
 *   the top.
 * @typedef {{kind: 'heading', level: number, text: string} | {kind: 'paragraph', text: string}
 *   | {kind: 'figure', page: number, box: Box, caption: string|null}} Block
 * @typedef {{title: string|null, depth: number, blocks: Block[], notes: string[]}} Chapter
 */

/** Bumped whenever a change here moves text between paragraphs or chapters: places saved in the old ones are dropped. */
export const REFLOW_VERSION = 1;

// A page with fewer letters than this, on average, is a picture of a page.
const MIN_LETTERS_PER_PAGE = 20;
const FALLBACK_BODY_SIZE = 12;
// Where running headers and footers live, as shares of the page's height.
const HEAD_BAND = 0.1;
const FOOT_BAND = 0.9;
// A line in a band that comes back on this many pages (its digits aside) is a running header or footer.
const MIN_REPEATS = 2;
const REPEAT_SHARE = 0.05;
const MAX_REPEATS_NEEDED = 5;
const PAGE_NUMBER = /^\s*(\d+|[ivxlcdm]+)\s*$/i;
// Runs on one line: their baselines differ by less than this share of their size.
const SAME_BASELINE = 0.4;
// A gap between runs wider than this share of the size is a space.
const SPACE_GAP = 0.2;
const HEADING_SIZE = 1.1;
const NOTE_SIZE = 0.85;
const DROP_CAP_SIZE = 1.8;
const DROP_CAP_LETTERS = 2;
// A note number: digits or a mark, set smaller and raised above the baseline of its line.
const NOTE_MARK = /^[\d*†‡]{1,4}$/u;
const RAISED_SIZE = 0.75;
const RAISED_RISE = 0.7;
const NEW_PARAGRAPH_GAP = 1.4;
const LONE_LINE_GAP = 1.3;
// A line ending this many body sizes short of the right edge, after a full stop, ends its paragraph.
const SHORT_LINE = 3;
const INDENT = 0.5;
const HEADING_LINES_GAP = 1.6;
const SIZE_CHANGE = 1;
const MAX_HEADING_LENGTH = 80;
const MIN_FIGURE_SHARE = 0.02;
const CAPTION = /^figure\s*\d/i;
const PAGES_PER_CHAPTER = 10;
// A heading this short could be anything: a mark is not moved to it.
const MIN_TITLE_LETTERS = 4;
const MAX_LEVEL = 3;
const RIGHT_EDGE_PERCENTILE = 0.95;
const SENTENCE_END = /[.!?…:;"”’')\]]$/u;
const LINE_END_HYPHEN = /\p{Ll}-$/u;
const SOFT_HYPHEN_END = /­$/u;
const STARTS_LOWER = /^\p{Ll}/u;
const TWO_CAPITALS = /\p{Lu}.*\p{Lu}/u;
const ENDS_LIKE_A_SENTENCE_PART = /[.,;]$/;
const SPACES = /\s+/g;
const DIGITS = /\d+/g;
const LETTERS = /\p{L}/gu;
const NOT_A_WORD = /[^\p{L}\p{N}]+/gu;

const letterCount = (text) => (text.match(LETTERS) ?? []).length;

/** @param {Page[]} pages Whether they hold text at all: a scan holds only pictures of it. */
export function hasText(pages) {
  if (pages.length === 0) return false;
  const letters = pages.reduce((sum, { runs }) => sum + runs.reduce((count, { text }) => count + letterCount(text), 0), 0);
  return letters / pages.length >= MIN_LETTERS_PER_PAGE;
}

/** The size most of the letters have. */
function bodySizeOf(pages) {
  const letters = new Map();
  for (const { runs } of pages) {
    for (const { text, size } of runs) {
      const key = Math.round(size * 2) / 2;
      letters.set(key, (letters.get(key) ?? 0) + letterCount(text));
    }
  }
  let best = FALLBACK_BODY_SIZE;
  let most = 0;
  for (const [size, count] of letters) {
    if (count > most) [best, most] = [size, count];
  }
  return best;
}

/** The runs of a page put in lines, top to bottom. */
function linesOf({ runs }, page) {
  const lines = [];
  const sorted = [...runs].filter(({ text }) => text.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const run of sorted) {
    const line = lines.find(({ y, size }) => Math.abs(y - run.y) <= SAME_BASELINE * Math.min(size, run.size));
    if (line) line.runs.push(run);
    else lines.push({ y: run.y, size: run.size, runs: [run] });
  }
  // A note number set above the line it belongs to is part of that line.
  const raised = lines.filter((marker) => {
    const text = marker.runs.map((run) => run.text).join('').trim();
    if (!NOTE_MARK.test(text)) return false;
    const owner = lines.find((line) => line !== marker && marker.size <= RAISED_SIZE * line.size
      && line.y - marker.y > 0 && line.y - marker.y <= RAISED_RISE * line.size
      && marker.runs[0].x >= Math.min(...line.runs.map(({ x }) => x)) - 1
      && marker.runs[0].x <= Math.max(...line.runs.map(({ x, width }) => x + width)) + line.size);
    if (!owner) return false;
    owner.runs.push(...marker.runs);
    return true;
  });
  return lines.filter((line) => !raised.includes(line)).map(({ runs: parts }) => {
    parts.sort((a, b) => a.x - b.x);
    let text = '';
    let end = -Infinity;
    const letters = new Map();
    let lastSize = Infinity;
    for (const run of parts) {
      const spaced = text === '' || text.endsWith(' ') || run.text.startsWith(' ');
      // Measured on the smaller of the two: a lead-in in small capitals sits close to the text after it.
      if (!spaced && run.x - end > SPACE_GAP * Math.min(lastSize, run.size)) text += ' ';
      lastSize = run.size;
      text += run.text;
      end = Math.max(end, run.x + run.width);
      letters.set(run.size, (letters.get(run.size) ?? 0) + Math.max(1, letterCount(run.text)));
    }
    const size = [...letters].sort((a, b) => b[1] - a[1])[0][0];
    return {
      page,
      text: text.replace(SPACES, ' ').trim(),
      x: parts[0].x,
      right: end,
      y: parts[0].y,
      size,
      bold: parts.every(({ bold }) => bold),
      lead: parts[0],
    };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
}

const inHeadBand = (line, height) => line.y < height * HEAD_BAND;
const inFootBand = (line, height) => line.y > height * FOOT_BAND;
const runningKey = (text) => text.replace(DIGITS, '').replace(SPACES, ' ').trim().toLowerCase();

/** Running headers, running footers and page numbers taken out. */
function withoutRunning(linesByPage, pages) {
  const inBand = (line, page) => inHeadBand(line, pages[page].height) || inFootBand(line, pages[page].height);
  const seen = new Map();
  linesByPage.forEach((lines, page) => {
    for (const key of new Set(lines.filter((line) => inBand(line, page)).map(({ text }) => runningKey(text)))) {
      if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  });
  const needed = Math.max(MIN_REPEATS, Math.min(MAX_REPEATS_NEEDED, Math.ceil(pages.length * REPEAT_SHARE)));
  return linesByPage.map((lines, page) => lines.filter((line) => {
    if (!inBand(line, page)) return true;
    if (PAGE_NUMBER.test(line.text)) return false;
    const key = runningKey(line.text);
    return !key || (seen.get(key) ?? 0) < needed;
  }));
}

/** A big first letter put back at the start of the line it begins, and the lines beside it back at the left edge. */
function withDropCaps(lines, body, left) {
  const caps = lines.filter(({ text, size }) => letterCount(text) > 0 && text.length <= DROP_CAP_LETTERS && size >= DROP_CAP_SIZE * body);
  let result = lines;
  for (const cap of caps) {
    const beside = result.filter((line) => line !== cap && line.size < cap.size && line.x >= cap.x
      && line.y > cap.y - cap.size && line.y <= cap.y + body * NEW_PARAGRAPH_GAP);
    if (beside.length === 0) continue;
    const [first] = beside;
    result = result.filter((line) => line !== cap).map((line) => {
      if (line === first) return { ...line, text: `${cap.text}${line.text}`, x: cap.x };
      if (beside.includes(line)) return { ...line, x: left };
      return line;
    });
  }
  // A cap set on the baseline of the second line it spans: it begins the line above, beside it.
  for (const line of [...result]) {
    const { lead } = line;
    if (!lead || letterCount(lead.text) === 0 || lead.text.trim().length > DROP_CAP_LETTERS
      || lead.size < DROP_CAP_SIZE * body || line.size >= DROP_CAP_SIZE * body) continue;
    const capRight = lead.x + lead.width;
    const above = result.find((other) => other !== line && other.y < line.y - 1 && other.y > line.y - lead.size
      && other.x >= capRight - 2);
    if (!above) continue;
    result = result.map((other) => {
      if (other === above) return { ...other, text: `${lead.text.trim()}${other.text}`, x: lead.x };
      if (other === line) return { ...other, text: other.text.slice(lead.text.trim().length).trim(), x: left };
      return other;
    });
  }
  return result;
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = null;
  let most = 0;
  for (const [value, count] of counts) {
    if (count > most) [best, most] = [value, count];
  }
  return best;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The text column: its left edge, its right edge and the usual gap between lines, told from the body's lines. */
function columnOf(linesByPage, body) {
  const bodyLines = linesByPage.flat().filter(({ size }) => Math.abs(size - body) < SIZE_CHANGE);
  // The left edge is where most body lines start; where as many start indented, the edge is the smaller x.
  const left = mostCommon(bodyLines.map(({ x }) => Math.round(x)).sort((a, b) => a - b)) ?? 0;
  const rights = bodyLines.map(({ right }) => right).sort((a, b) => a - b);
  const right = rights[Math.min(rights.length - 1, Math.floor(rights.length * RIGHT_EDGE_PERCENTILE))] ?? 0;
  const gaps = linesByPage.flatMap((lines) => lines.slice(1).map((line, at) => line.y - lines[at].y))
    .filter((gap) => gap > body * 0.5 && gap < body * 2.5);
  return { left, right, gap: median(gaps) ?? body * 1.3 };
}

const endsSentence = (text) => SENTENCE_END.test(text);

/** Two lines of one paragraph: a word cut by a hyphen at the end of the first is whole again. */
function joinLines(before, after) {
  if (SOFT_HYPHEN_END.test(before)) return `${before.slice(0, -1)}${after}`;
  if (LINE_END_HYPHEN.test(before) && STARTS_LOWER.test(after)) return `${before.slice(0, -1)}${after}`;
  return `${before} ${after}`;
}

const isCapitals = (text) => letterCount(text) > 1 && text === text.toUpperCase() && TWO_CAPITALS.test(text)
  && text.length <= MAX_HEADING_LENGTH && !ENDS_LIKE_A_SENTENCE_PART.test(text);

const wordsOf = (text) => text.replace(NOT_A_WORD, ' ').trim().toLowerCase().split(' ').filter(Boolean);

/** Whether `text` is the title, or a run of its words: a page may show "1" and the name apart. */
function partOfTitle(text, title) {
  const part = wordsOf(text);
  const whole = wordsOf(title);
  if (part.length === 0 || part.length > whole.length) return false;
  return whole.some((_, at) => part.every((word, offset) => whole[at + offset] === word));
}

/** Every page's lines and figures, in reading order, as blocks with where each starts, and the notes. */
function blocksOf(pages, marks) {
  const body = bodySizeOf(pages);
  const read = withoutRunning(pages.map(linesOf), pages);
  const column = columnOf(read, body);
  const linesByPage = read.map((lines) => withDropCaps(lines, body, column.left));
  const markOn = (page, y) => marks.some((mark) => mark.page === page && mark.y <= y + 1);
  const blocks = [];
  const notes = [];
  let paragraph = null;
  let last = null;

  linesByPage.forEach((lines, page) => {
    const { width, height } = pages[page];
    const figures = pages[page].images.filter((box) => box.width * box.height >= width * height * MIN_FIGURE_SHARE);
    const items = [...lines.map((line) => ({ line, y: line.y })), ...figures.map((box) => ({ box, y: box.y }))]
      .sort((a, b) => a.y - b.y);
    const textLines = items.filter(({ line }) => line).map(({ line }) => line);
    let previous = null;
    let note = null;
    let firstText = true;

    for (const item of items) {
      if (item.box) {
        blocks.push({ kind: 'figure', page, box: { ...item.box }, caption: null, at: { page, y: item.y } });
        paragraph = null;
        last = blocks.at(-1);
        continue;
      }
      const { line } = item;
      const gapBefore = previous ? line.y - previous.y : Infinity;
      const next = textLines[textLines.indexOf(line) + 1];
      const gapAfter = next ? next.y - line.y : Infinity;

      if (inFootBand(line, height) && line.size < NOTE_SIZE * body && (note || gapBefore > column.gap * LONE_LINE_GAP)) {
        if (note && gapBefore <= line.size * HEADING_LINES_GAP) note.text = joinLines(note.text, line.text);
        else {
          note = { text: line.text, at: { page, y: line.y } };
          notes.push(note);
        }
        previous = line;
        continue;
      }
      note = null;

      const lone = gapBefore > column.gap * LONE_LINE_GAP && gapAfter > column.gap * LONE_LINE_GAP;
      if (line.size >= HEADING_SIZE * body || (lone && isCapitals(line.text))) {
        const merge = last?.kind === 'heading' && last.at.page === page && Math.abs(last.size - line.size) < SIZE_CHANGE
          && line.y - last.lastY <= line.size * HEADING_LINES_GAP;
        if (merge) {
          last.text = `${last.text} ${line.text}`;
          last.lastY = line.y;
        } else {
          blocks.push({ kind: 'heading', text: line.text, size: line.size, lastY: line.y, at: { page, y: line.y } });
          last = blocks.at(-1);
        }
        paragraph = null;
        previous = line;
        firstText = false;
        continue;
      }

      const indented = line.x > column.left + INDENT * body;
      let joins = false;
      if (paragraph && paragraph === last) {
        const before = paragraph.lastLine;
        if (before.page !== page) {
          joins = firstText && !indented && !markOn(page, line.y)
            && (!endsSentence(paragraph.text) || STARTS_LOWER.test(line.text));
        } else {
          const short = before.right < column.right - SHORT_LINE * body && endsSentence(before.text);
          // An indent counts against the line above: lines indented together, in a box or a caption, go on.
          const indentedHere = indented && line.x > before.x + INDENT * body;
          joins = gapBefore <= column.gap * NEW_PARAGRAPH_GAP && !indentedHere && !short
            && Math.abs(before.size - line.size) < SIZE_CHANGE;
        }
      }
      if (joins) {
        paragraph.text = joinLines(paragraph.text, line.text);
        paragraph.lastLine = line;
      } else {
        paragraph = { kind: 'paragraph', text: line.text, lastLine: line, at: { page, y: line.y } };
        blocks.push(paragraph);
        last = paragraph;
      }
      previous = line;
      firstText = false;
    }
  });

  // A paragraph right below a figure that says it is a figure is its caption.
  const captioned = blocks.filter((block, at) => {
    const after = blocks[at + 1];
    if (block.kind !== 'figure' || after?.kind !== 'paragraph' || after.at.page !== block.page) return false;
    if (!CAPTION.test(after.text)) return false;
    block.caption = after.text;
    return true;
  });
  const captions = new Set(captioned.map((figure) => blocks[blocks.indexOf(figure) + 1]));
  return { blocks: blocks.filter((block) => !captions.has(block)), notes };
}

const before = (a, b) => a.page < b.page || (a.page === b.page && a.y < b.y - 1);

/** What a block is in the book: the positions and sizes used to place it go. */
function finished(block, level) {
  if (block.kind === 'heading') return { kind: 'heading', level, text: block.text };
  if (block.kind === 'paragraph') return { kind: 'paragraph', text: block.text };
  return { kind: 'figure', page: block.page, box: block.box, caption: block.caption };
}

/**
 * The marks in the outline's order, each where it leads. One that leads back before the mark above it is a broken link
 * of the PDF: it goes to its heading after that mark, if one bears its title, else it is left out.
 */
function placeMarks(marks, blocks) {
  const placed = [];
  let last = null;
  for (const mark of marks) {
    let at = { page: mark.page, y: mark.y ?? 0 };
    // A mark that names its page and no place on it is where its title is, on that page.
    if (mark.y === null) {
      const heading = blocks.find((block) => block.kind === 'heading' && block.at.page === mark.page
        && (!last || !before(block.at, last)) && partOfTitle(block.text, mark.title));
      if (heading) at = { page: mark.page, y: heading.at.y - 1 };
    }
    if (last && before(at, last)) {
      const heading = blocks.find((block) => block.kind === 'heading' && !before(block.at, last)
        && letterCount(block.text) >= MIN_TITLE_LETTERS && partOfTitle(block.text, mark.title));
      if (!heading) continue;
      at = { page: heading.at.page, y: heading.at.y - 1 };
    }
    placed.push({ ...mark, ...at });
    last = at;
  }
  return placed;
}

/**
 * @param {Page[]} pages
 * @param {Mark[]} marks In the outline's order.
 * @returns {Chapter[]}
 */
export function reflow(pages, marks) {
  const { blocks, notes } = blocksOf(pages, marks);
  const placed = placeMarks(marks, blocks);

  if (placed.length === 0) {
    const chapters = [];
    for (const block of blocks) {
      const index = Math.floor(block.at.page / PAGES_PER_CHAPTER);
      const chapter = chapters[index] ??= { title: null, depth: 0, blocks: [], notes: [] };
      chapter.blocks.push(finished(block, 2));
    }
    for (const note of notes) {
      const index = Math.min(Math.floor(note.at.page / PAGES_PER_CHAPTER), chapters.length - 1);
      (chapters[index] ??= { title: null, depth: 0, blocks: [], notes: [] }).notes.push(note.text);
    }
    return chapters.filter(Boolean);
  }

  // The chapter of a place: the last mark at or before it, or -1 before the first one.
  const chapterOf = (at) => placed.findLastIndex((mark) => !before(at, mark));
  const parts = [{ title: null, depth: 0, blocks: [], notes: [] }, ...placed.map(({ title, depth }) => ({ title, depth, blocks: [], notes: [] }))];
  for (const block of blocks) parts[chapterOf(block.at) + 1].blocks.push(block);
  for (const note of notes) parts[chapterOf(note.at) + 1].notes.push(note.text);

  return parts.map((part, index) => {
    if (index === 0) return { ...part, blocks: part.blocks.map((block) => finished(block, 2)) };
    // The title the page shows is the mark's: it is said once. It may come below a decoration, never after the text.
    const lead = part.blocks.findIndex(({ kind }) => kind === 'paragraph');
    const opening = lead === -1 ? part.blocks : part.blocks.slice(0, lead);
    const shown = new Set(opening.filter((block) => block.kind === 'heading' && partOfTitle(block.text, part.title)));
    const level = Math.min(part.depth + 2, MAX_LEVEL);
    return {
      ...part,
      blocks: [
        { kind: 'heading', level: Math.min(part.depth + 1, MAX_LEVEL), text: part.title },
        ...part.blocks.filter((block) => !shown.has(block)).map((block) => finished(block, level)),
      ],
    };
  }).filter((part, index) => index > 0 || part.blocks.length > 0 || part.notes.length > 0);
}
