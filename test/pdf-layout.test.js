// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasText, reflow, REFLOW_VERSION } from '../app/readers/pdf-layout.js';

const WIDTH = 612;
const HEIGHT = 792;
const LEFT = 72;
const INDENT = 86;
const BODY = 12;
const GAP = 16;
// About the width of Helvetica: half the size for each character.
const CHAR = 0.5;

/** A line of text, as one run: `y` is its baseline from the top of the page. */
const line = (text, y, { x = LEFT, size = BODY, bold = false } = {}) => ({ text, x, y, width: text.length * size * CHAR, size, bold });
/** An image whose top is `y`. */
const picture = (x, y, width, height) => ({ picture: true, x, y, width, height });
const page = (...items) => ({
  width: WIDTH,
  height: HEIGHT,
  runs: items.filter((item) => !item.picture),
  images: items.filter((item) => item.picture).map(({ x, y, width, height }) => ({ x, y, width, height })),
});
/** Lines of a paragraph from `y`, the first indented. */
const paragraph = (y, ...texts) => texts.map((text, at) => line(text, y + at * GAP, { x: at === 0 ? INDENT : LEFT }));
// A full line: as wide as the text column.
const FULL = 'word '.repeat(16).trim();
const full = (text) => `${text} ${FULL}`.slice(0, FULL.length).trimEnd();

const blocksOf = (pages, marks = []) => reflow(pages, marks).flatMap(({ blocks }) => blocks);
const texts = (blocks) => blocks.map((block) => (block.kind === 'figure' ? `[figure ${block.caption}]` : `${block.kind}: ${block.text}`));

test('the reflow has a version, for the places saved in it', () => {
  assert.equal(REFLOW_VERSION, 1);
});

test('lines on one baseline join with one space, in order of x', () => {
  const runs = [line('second half.', 100, { x: 300 }), line('The first half', 100)];
  const [block] = blocksOf([page(...runs, ...paragraph(200, full('Filler so the body'), 'is known.'))]);
  assert.equal(block.text, 'The first half second half.');
});

test('an indent or a bigger gap starts a paragraph; a short last line ends one', () => {
  const blocks = blocksOf([page(
    ...paragraph(100, full('One starts'), 'and ends short.'),
    line(full('Two starts after a gap'), 100 + 3 * GAP),
    line('and goes on.', 100 + 4 * GAP),
    ...paragraph(100 + 5 * GAP, full('Three is indented'), 'and ends.'),
  )]);
  assert.deepEqual(blocks.map(({ text }) => text.split(' ')[0]), ['One', 'Two', 'Three']);
});

test('a paragraph cut by the page break is joined', () => {
  const blocks = blocksOf([
    page(...paragraph(100, full('It starts'), full('and the sentence goes on'))),
    page(line('across the page break.', 80), ...paragraph(80 + 2 * GAP, full('Next'), 'one.')),
  ]);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text, /goes on\b.* across the page break\.$/);
});

test('a page that starts a new paragraph is not joined', () => {
  const blocks = blocksOf([
    page(...paragraph(100, full('It starts'), `${full('and')} and it ends at the foot.`)),
    page(...paragraph(80, full('Another paragraph starts here.'), 'Done.')),
  ]);
  assert.equal(blocks.length, 2);
  assert.match(blocks[1].text, /^Another paragraph/);
});

test('a word hyphenated at a line end is joined, other hyphens stay', () => {
  const [block] = blocksOf([page(
    line(`${full('A well-known test keeps')} contin-`, 100, { x: INDENT }),
    line(`uing to the end where it reads ${'x '.repeat(20)}COVID-19`, 100 + GAP),
    line('cases.', 100 + 2 * GAP),
  )]);
  assert.match(block.text, /continuing/);
  assert.match(block.text, /well-known/);
  assert.match(block.text, /COVID-19 cases\.$/);
});

test('running headers, footers and page numbers are dropped', () => {
  const numbers = ['1', '2', 'iv'];
  const pages = numbers.map((number, at) => page(
    line('A RUNNING TITLE', 40, { size: 9 }),
    ...paragraph(100, full(`Text of page ${at + 1}`), 'ends here.'),
    line(`Footer of the book ${at + 1}`, 740, { size: 9 }),
    line(number, 760, { size: 9, x: 300 }),
  ));
  const all = texts(blocksOf(pages)).join('\n');
  assert.doesNotMatch(all, /RUNNING|Footer|: (1|2|iv)$/m);
  assert.equal(blocksOf(pages).length, 3);
});

test('a bigger font or a lone line in capitals is a heading', () => {
  const blocks = blocksOf([page(
    line('A Bigger Title', 80, { size: 20, bold: true }),
    ...paragraph(120, full('Body text'), 'ends.'),
    line('A HEADING IN CAPITALS', 120 + 3 * GAP, { bold: true }),
    ...paragraph(120 + 5 * GAP, full('More body'), 'ends.'),
  )]);
  assert.deepEqual(blocks.filter(({ kind }) => kind === 'heading').map(({ text, level }) => [text, level]),
    [['A Bigger Title', 2], ['A HEADING IN CAPITALS', 2]]);
});

test('a title in two lines of the same big size is one heading', () => {
  const blocks = blocksOf([page(
    line('Waiting Is Overrated; The Room Around You', 80, { size: 24 }),
    line('Matters Most', 108, { size: 24 }),
    ...paragraph(160, full('Body text'), 'ends.'),
  )]);
  assert.equal(blocks[0].text, 'Waiting Is Overrated; The Room Around You Matters Most');
});

test('a drop cap joins the paragraph it starts', () => {
  const blocks = blocksOf([page(
    line('Chapter', 80, { size: 24 }),
    line('T', 260, { size: 30 }),
    line(full('his chapter starts with a large letter'), 250, { x: 92 }),
    line(full('and the text beside it wraps'), 266, { x: 92 }),
    line('until it is past it.', 282),
  )]);
  assert.deepEqual(texts(blocks).filter((text) => text.startsWith('heading')), ['heading: Chapter']);
  assert.match(blocks[1].text, /^This chapter starts with a large letter .* and the text beside it wraps .* until it is past it\.$/);
});

test('a figure keeps its place among the paragraphs, and a tiny image is dropped', () => {
  const blocks = blocksOf([page(
    ...paragraph(80, full('Before'), 'the figure.'),
    picture(156, 120, 300, 150),
    picture(300, 300, 4, 4),
    ...paragraph(320, full('After'), 'the figure.'),
  )]);
  assert.deepEqual(blocks.map(({ kind }) => kind), ['paragraph', 'figure', 'paragraph']);
  assert.deepEqual(blocks[1].box, { x: 156, y: 120, width: 300, height: 150 });
  assert.equal(blocks[1].page, 0);
  assert.equal(blocks[1].caption, null);
});

test('only a paragraph starting with Figure is a caption', () => {
  const blocks = blocksOf([page(
    picture(117, 60, 378, 85),
    line('Chapter Two', 180, { size: 24, bold: true }),
    ...paragraph(220, full('Text'), 'ends.'),
    picture(156, 300, 300, 150),
    line('FIGURE 1: A square made of colour.', 470, { size: 10, x: INDENT }),
    ...paragraph(500, full('After'), 'ends.'),
  )]);
  assert.deepEqual(texts(blocks), [
    '[figure null]',
    'heading: Chapter Two',
    `paragraph: ${full('Text')} ends.`,
    '[figure FIGURE 1: A square made of colour.]',
    `paragraph: ${full('After')} ends.`,
  ]);
});

test('a small note at the foot leaves the flow and goes to the chapter\'s notes', () => {
  const [chapter] = reflow([
    page(...paragraph(600, full('It starts and has a mark*'), full('and goes on')), line('* A note at the foot of the page.', 740, { size: 8 })),
    page(line('to the next page.', 80)),
  ], []);
  assert.deepEqual(chapter.notes, ['* A note at the foot of the page.']);
  assert.equal(chapter.blocks.length, 1);
  assert.match(chapter.blocks[0].text, /goes on\b.* to the next page\.$/);
});

test('marks split chapters in order; two on one page give two chapters; text before the first mark has its own', () => {
  const pages = [
    page(...paragraph(100, full('Front matter'), 'ends.')),
    page(line('Chapter One', 100, { size: 24 }), ...paragraph(140, full('One'), 'ends.')),
    page(line('Chapter Two', 100, { size: 24 }), line('Subtitle', 130, { size: 16 }), ...paragraph(170, full('Two'), 'ends.')),
  ];
  const chapters = reflow(pages, [
    { title: 'Chapter One', page: 1, y: 72, depth: 0 },
    { title: 'Chapter Two', page: 2, y: 72, depth: 0 },
    { title: 'Subtitle', page: 2, y: 115, depth: 1 },
  ]);
  assert.deepEqual(chapters.map(({ title, depth }) => [title, depth]), [[null, 0], ['Chapter One', 0], ['Chapter Two', 0], ['Subtitle', 1]]);
  assert.deepEqual(texts(chapters[1].blocks), ['heading: Chapter One', `paragraph: ${full('One')} ends.`]);
  assert.equal(chapters[1].blocks[0].level, 1);
  assert.deepEqual(texts(chapters[2].blocks), ['heading: Chapter Two']);
  assert.deepEqual(texts(chapters[3].blocks), ['heading: Subtitle', `paragraph: ${full('Two')} ends.`]);
  assert.equal(chapters[3].blocks[0].level, 2);
});

test('with no marks the book is cut every ten pages at a paragraph end', () => {
  const pages = Array.from({ length: 25 }, (_, at) => page(
    line(`and page ${at} goes on.`, 80),
    ...paragraph(120, full(`Page ${at} has a paragraph`), 'that runs to the foot'),
  ));
  const chapters = reflow(pages, []);
  assert.equal(chapters.length, 3);
  assert.ok(chapters.every(({ title }) => title === null));
  assert.match(chapters[1].blocks[0].text, /^Page 10 has/);
  assert.match(chapters[0].blocks.at(-1).text, /and page 10 goes on\.$/);
});

test('hasText is false for pages with no text', () => {
  assert.equal(hasText([page(picture(0, 0, WIDTH, HEIGHT))]), false);
  assert.equal(hasText([page(...paragraph(100, full('Words'), 'here.'))]), true);
});

test('the title a page shows below a decoration is said once, by the mark', () => {
  const chapters = reflow([page(
    picture(117, 60, 378, 85),
    line('Chapter Two', 180, { size: 24, bold: true }),
    ...paragraph(220, full('Text'), 'ends.'),
  )], [{ title: 'Chapter Two', page: 0, y: 50, depth: 0 }]);
  assert.deepEqual(texts(chapters[0].blocks), ['heading: Chapter Two', '[figure null]', `paragraph: ${full('Text')} ends.`]);
});

test('a title the page shows in parts, number then name, is said once, by the mark', () => {
  const chapters = reflow([page(
    line('1', 100, { size: 24 }),
    line('The Quiet Weight of Small Stones', 140, { size: 20 }),
    line('WHY SMALL STONES SINK', 180, { bold: true }),
    ...paragraph(220, full('Text'), 'ends.'),
  )], [{ title: '1 The Quiet Weight of Small Stones', page: 0, y: 72, depth: 0 }]);
  assert.deepEqual(texts(chapters[0].blocks), [
    'heading: 1 The Quiet Weight of Small Stones',
    'heading: WHY SMALL STONES SINK',
    `paragraph: ${full('Text')} ends.`,
  ]);
});

test('a mark that points back before the one above it is placed at its heading, else left out', () => {
  const pages = [
    page(...paragraph(100, full('Title page'), 'ends.')),
    page(line('Epigraph', 100, { size: 24 }), ...paragraph(140, full('Words'), 'ends.')),
    page(line('Introduction', 100, { size: 24 }), ...paragraph(140, full('Intro'), 'ends.')),
  ];
  const chapters = reflow(pages, [
    { title: 'Title Page', page: 0, y: 72, depth: 0 },
    { title: 'Epigraph', page: 1, y: 72, depth: 0 },
    { title: 'Introduction: Where It Began', page: 0, y: 0, depth: 0 },
    { title: 'Lost', page: 0, y: 0, depth: 0 },
  ]);
  assert.deepEqual(chapters.map(({ title }) => title), ['Title Page', 'Epigraph', 'Introduction: Where It Began']);
  assert.deepEqual(texts(chapters[2].blocks), ['heading: Introduction: Where It Began', `paragraph: ${full('Intro')} ends.`]);
});

test('a lead-in in small capitals keeps its space before the text', () => {
  const blocks = blocksOf([page(
    line('T', 270, { size: 26, bold: true }),
    { text: 'HE TALE OF', x: 72 + 13, y: 270, width: 33, size: 6, bold: false },
    { text: 'the team changed one day.', x: 72 + 13 + 35, y: 270, width: 200, size: BODY, bold: false },
    ...paragraph(300, full('Filler so the body'), 'is known.'),
  )]);
  assert.equal(blocks[0].text, 'THE TALE OF the team changed one day.');
});

test('lines indented together, as in a box or under a figure, stay one paragraph', () => {
  const blocks = blocksOf([page(
    ...paragraph(80, full('Before'), full('the box'), full('and more'), 'the box.'),
    line(full('FIGURE 1: A line of stones grows longer every day, so'), 545, { x: 100, size: 6 }),
    line('year.', 552, { x: 100, size: 6 }),
    line(full('Inside a box a line'), 600, { x: 100 }),
    line('goes on here.', 616, { x: 100 }),
  )]);
  assert.deepEqual(blocks.map(({ text }) => text.split(' ').at(-1)), ['box.', 'year.', 'here.']);
});

test('a line a seventh bigger than the body is a heading', () => {
  const blocks = blocksOf([page(
    line('Where It Began', 80, { size: 16.6 }),
    ...paragraph(120, full('Body text'), full('in a size'), 'that is not round.').map((run) => ({ ...run, size: 14.4 })),
  )]);
  assert.deepEqual(blocks[0], { kind: 'heading', level: 2, text: 'Where It Began' });
});

test('a raised note number stays in its sentence', () => {
  const blocks = blocksOf([page(
    ...paragraph(100, full('A sentence starts'), full('and it says here')),
    { text: '12', x: LEFT + full('and it says here').length * BODY * CHAR, y: 100 + GAP - 4, width: 7, size: 7, bold: false },
    line('and it goes on to its end.', 100 + 2 * GAP),
  )]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /says here.*12 and it goes on to its end\.$/);
});

test('a drop cap on the baseline of the second line joins the first', () => {
  const blocks = blocksOf([page(
    line('Chapter', 80, { size: 24 }),
    line(full('his chapter starts with a large letter'), 250, { x: 92 }),
    line('T', 266, { size: 30 }),
    line(full('and the text beside it wraps'), 266, { x: 92 }),
    line('until it is past it.', 282),
  )]);
  assert.equal(blocks.length, 2);
  assert.match(blocks[1].text, /^This chapter starts with a large letter .* and the text beside it wraps .* until it is past it\.$/);
});

test('marks that say no place on their page go to the headings bearing their titles', () => {
  const chapters = reflow([page(
    line('Part One', 100, { size: 24 }),
    ...paragraph(140, full('Part text'), 'ends.'),
    line('The Start', 300, { size: 24 }),
    ...paragraph(340, full('Start text'), 'ends.'),
  )], [{ title: 'Part One', page: 0, y: null, depth: 0 }, { title: 'The Start', page: 0, y: null, depth: 0 }]);
  assert.deepEqual(chapters.map(({ blocks }) => texts(blocks)), [
    ['heading: Part One', `paragraph: ${full('Part text')} ends.`],
    ['heading: The Start', `paragraph: ${full('Start text')} ends.`],
  ]);
});
