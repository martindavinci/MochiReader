// SPDX-License-Identifier: GPL-3.0-or-later
import { HOST_URLS, SCHEME_URL, hostName, isSchemeUrlText, isUrlText, namesAddress } from './hostname.js';
import { splitSentences } from './sentences.js';

/**
 * @typedef {Object} Sentence
 * @property {string} text
 * @property {{node: Node, offset: number}|null} start  null for text added by the app
 * @property {{node: Node, offset: number}|null} end    exclusive; null for text added by the app
 *
 * @typedef {Object} SpeechBlock
 * @property {'heading'|'item'|'para'|'cell'} kind
 * @property {number} [level]    heading level
 * @property {boolean} [rowEnd]  last cell read in its table row
 * @property {number|null} line  source line, from data-sourcepos
 * @property {Sentence[]} sentences
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const SOURCE_LABEL = 'Fonte';
const SKIPPED_TAGS = new Set(['pre', 'script', 'style', 'template', 'noscript', 'head', 'svg', 'math',
  'audio', 'video', 'canvas', 'iframe', 'object', 'embed', 'input', 'select', 'textarea', 'button', 'hr', 'rp']);
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd',
  'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hgroup', 'li', 'main', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul', 'pre', 'hr']);
const NOTE_EPUB_TYPES = new Set(['footnote', 'footnotes', 'endnote', 'endnotes', 'rearnote', 'rearnotes', 'note',
  'noteref', 'pagebreak']);
const NOTE_ROLES = new Set(['doc-footnote', 'doc-endnote', 'doc-endnotes', 'doc-noteref', 'doc-backlink', 'doc-pagebreak']);
const NOTE_CLASSES = new Set(['footnote-ref', 'footnote-backref']);
const NOTE_ATTRIBUTES = ['data-footnote-ref', 'data-footnote-backref'];

const NOTE_MARKER = /^[[(]?(\d{1,4}|[*†‡]+)[\])]?$/;
const BRACKETED = /^[[(]/;
const HEADING = /^h([1-6])$/;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?)$/i;
const CODE_LIKE_WORD = /^\S*[_\d]\S*$/;
const READABLE = /[\p{L}\p{N}]/u;

const LITERAL_COMMENTS = [/<!--[\s\S]*?(?:-->|$)/g, /%%[\s\S]*?%%/g];
const LITERAL_LINK_MARKS = /!?\[(?=[^[\]]*\]\([^)]*\))|\](?<=\[[^[\]]*\])\([^)]*\)/g;
const UNRESOLVED_NOTE = /\[\^[^\]\s]+\]/g;
const DELIMITERS = /[*_`~=]+/g;
const STANDALONE_OPERATOR = /^[*=~]$/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const KEYCAP_EMOJI = /[0-9#*]️?⃣/gu;
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣]/gu;
const INVISIBLE = /[­​⁠﻿]/g;
const EMPTY_BRACKETS = /\(\s*\)|\[\s*\]/g;
const REPEATED_SPACE = /(?<=\s)\s+/g;
const OUTER_SPACE = /^\s+|\s+$/g;
const SPACE_BEFORE_PUNCTUATION = /\s+(?=[.,;:!?)\]])/g;
const TRAILING_SOURCE = /\s*\(\s*(fonte|source)\s*\)[\s.,;:]*$/i;

const tokens = (el, attribute) => (el.getAttribute(attribute) ?? '').split(/\s+/);
const hasToken = (el, attribute, set) => tokens(el, attribute).some((token) => set.has(token));

function isNoteMarker(link) {
  const href = link.getAttribute('href') ?? '';
  const text = link.textContent.trim();
  if (!href.includes('#') || !NOTE_MARKER.test(text)) return false;
  const inSuperscript = link.parentElement?.localName === 'sup' || link.querySelector('sup') !== null;
  return inSuperscript || BRACKETED.test(text);
}

function isNoteSuperscript(sup) {
  const [link] = sup.children;
  return sup.children.length === 1 && link.localName === 'a'
    && (link.getAttribute('href') ?? '').startsWith('#')
    && sup.textContent.trim() === link.textContent.trim();
}

/** Whether a link's text is inline code, either inside code or wrapped around it. */
function readsAsCode(link) {
  const [only] = link.children;
  return link.closest('code') !== null
    || (link.children.length === 1 && only.localName === 'code' && only.textContent.trim() === link.textContent.trim());
}

function isUrlLink(link) {
  const text = link.textContent.trim();
  if (namesAddress(text, link.getAttribute('href') ?? '')) return true;
  return readsAsCode(link) ? isSchemeUrlText(text) : isUrlText(text);
}

function isSkipped(el) {
  const tag = el.localName;
  if (SKIPPED_TAGS.has(tag)) return true;
  if (el.hasAttribute('data-noread') || el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (hasToken(el, 'epub:type', NOTE_EPUB_TYPES) || hasToken(el, 'role', NOTE_ROLES)) return true;
  if (hasToken(el, 'class', NOTE_CLASSES)) return true;
  if (NOTE_ATTRIBUTES.some((name) => el.hasAttribute(name))) return true;
  if (tag === 'sup' && isNoteSuperscript(el)) return true;
  return tag === 'a' && (isNoteMarker(el) || isUrlLink(el));
}

function isRealAlt(alt) {
  return READABLE.test(alt) && !isUrlText(alt) && !IMAGE_FILE.test(alt) && !CODE_LIKE_WORD.test(alt);
}

/** The text of a block, with the DOM position of every UTF-16 unit. */
class TextRun {
  text = '';
  nodes = [];
  offsets = [];
  links = [];
  code = [];

  isCode(index) {
    return this.code.some(({ from, to }) => from <= index && index < to);
  }

  /** Whether any unit from first to last, both included, is inline code. */
  touchesCode(first, last) {
    return this.code.some(({ from, to }) => from <= last && first < to);
  }

  #push(text, node, offsetOf) {
    for (let i = 0; i < text.length; i += 1) {
      this.nodes.push(node);
      this.offsets.push(offsetOf(i));
    }
    this.text += text;
  }

  addText(node) {
    this.#push(node.data, node, (i) => i);
  }

  addSpace() {
    this.#push(' ', null, () => 0);
  }

  addAlt(img, alt) {
    const parent = img.parentNode;
    const index = [...parent.childNodes].indexOf(img);
    this.addSpace();
    this.#push(alt, parent, () => index);
    this.addSpace();
  }

  addInline(node) {
    if (node.nodeType === TEXT_NODE) {
      this.addText(node);
    } else if (node.nodeType === ELEMENT_NODE && !isSkipped(node)) {
      this.#addElement(node);
    }
  }

  #addElement(el) {
    const tag = el.localName;
    if (tag === 'br') {
      this.addSpace();
    } else if (tag === 'img') {
      const alt = (el.getAttribute('alt') ?? '').trim();
      if (isRealAlt(alt)) this.addAlt(el, alt);
    } else {
      const from = this.text.length;
      if (BLOCK_TAGS.has(tag)) this.addSpace();
      for (const child of el.childNodes) this.addInline(child);
      if (BLOCK_TAGS.has(tag)) this.addSpace();
      if (tag === 'a') this.links.push({ from, to: this.text.length, href: el.getAttribute('href') ?? '' });
      if (tag === 'code') this.code.push({ from, to: this.text.length });
    }
  }
}

/**
 * Removes matches from text, a string whose map gives each UTF-16 unit's index in its TextRun.
 * With a filter, only the matches it accepts.
 */
function removeMatches({ text, map }, pattern, accepts = () => true) {
  let kept = '';
  const keptMap = [];
  let from = 0;
  const keep = (to) => {
    kept += text.slice(from, to);
    for (let i = from; i < to; i += 1) keptMap.push(map[i]);
  };
  for (const match of text.matchAll(pattern)) {
    if (!accepts(match)) continue;
    keep(match.index);
    from = match.index + match[0].length;
  }
  keep(text.length);
  return { text: kept, map: keptMap };
}

/**
 * Whether delimiters left in the text are a Markdown token. One between two word characters
 * (snake_case, a=b, 2*3) or a spaced operator (a = b) belongs to the sentence.
 */
function isDelimiterToken({ 0: delimiters, index }, text) {
  if (delimiters.length > 1) return true;
  const before = text[index - 1] ?? ' ';
  const after = text[index + 1] ?? ' ';
  if (WORD_CHARACTER.test(before) && WORD_CHARACTER.test(after)) return false;
  return !(SPACE.test(before) && SPACE.test(after) && STANDALONE_OPERATOR.test(delimiters));
}

function normalize(run) {
  let clean = { text: run.text, map: Array.from(run.nodes.keys()) };
  // Inline code is read as written, so what looks like Markdown in it stays.
  const removeOutsideCode = (pattern, accepts = () => true) => {
    const { text, map } = clean;
    clean = removeMatches(clean, pattern, (match) => !run.isCode(map[match.index]) && accepts(match, text));
  };
  for (const pattern of LITERAL_COMMENTS) removeOutsideCode(pattern);
  clean = removeMatches(clean, SCHEME_URL);
  // A host is only a guess from its shape, so it must not take any code with it.
  const touchesCode = ({ 0: found, index }) => run.touchesCode(clean.map[index], clean.map[index + found.length - 1]);
  for (const pattern of HOST_URLS) removeOutsideCode(pattern, (match) => !touchesCode(match));
  for (const pattern of [KEYCAP_EMOJI, EMOJI]) removeOutsideCode(pattern);
  clean = removeMatches(clean, INVISIBLE);
  for (const pattern of [LITERAL_LINK_MARKS, UNRESOLVED_NOTE]) removeOutsideCode(pattern);
  removeOutsideCode(DELIMITERS, isDelimiterToken);
  removeOutsideCode(EMPTY_BRACKETS);
  clean.text = clean.text.replace(/\s/g, ' ');
  for (const pattern of [REPEATED_SPACE, OUTER_SPACE]) clean = removeMatches(clean, pattern);
  // Punctuation that starts a piece of code (.gitignore, :root) is not punctuation of the sentence.
  removeOutsideCode(SPACE_BEFORE_PUNCTUATION, ({ 0: spaces, index }) => !run.isCode(clean.map[index + spaces.length]));
  return clean;
}

/** Cuts the trailing "(fonte)" parts off clean and returns their links, in reading order. */
function takeSources(clean, run) {
  const hrefs = [];
  for (let match = TRAILING_SOURCE.exec(clean.text); match; match = TRAILING_SOURCE.exec(clean.text)) {
    const word = clean.map[match.index + match[0].indexOf(match[1])];
    if (run.isCode(word)) break;
    const link = run.links.find(({ from, to }) => from <= word && word < to);
    if (link) hrefs.unshift(link.href);
    clean.text = clean.text.slice(0, match.index);
    clean.map.length = match.index;
  }
  return hrefs;
}

function toSentences(clean, run, lang) {
  return splitSentences(clean.text, lang)
    .filter(({ start, end }) => READABLE.test(clean.text.slice(start, end)))
    .map(({ start, end }) => {
      const first = clean.map[start];
      const last = clean.map[end - 1];
      return {
        text: clean.text.slice(start, end),
        start: { node: run.nodes[first], offset: run.offsets[first] },
        end: { node: run.nodes[last], offset: run.offsets[last] + 1 },
      };
    });
}

function addedSentence(text) {
  return { text, start: null, end: null };
}

function lineOf(el) {
  for (let current = el; current; current = current.parentElement) {
    const sourcepos = current.getAttribute('data-sourcepos');
    if (sourcepos) {
      const line = Number.parseInt(sourcepos, 10);
      return Number.isNaN(line) ? null : line;
    }
  }
  return null;
}

class BlockCollector {
  blocks = [];

  constructor({ sourceMode, lang }) {
    this.sourceMode = sourceMode;
    this.lang = lang;
  }

  #flush(nodes, container, style) {
    if (nodes.length === 0) return;
    const run = new TextRun();
    for (const node of nodes) run.addInline(node);
    nodes.length = 0;

    const clean = normalize(run);
    const hrefs = takeSources(clean, run);
    const sentences = toSentences(clean, run, this.lang);
    if (this.sourceMode === 'name') {
      for (const href of hrefs) {
        const name = hostName(href);
        if (name) sentences.push(addedSentence(`${SOURCE_LABEL}: ${name}`));
      }
    }
    if (sentences.length === 0) return;

    const block = { kind: style.kind };
    if (style.level !== undefined) block.level = style.level;
    block.line = lineOf(container);
    block.sentences = sentences;
    this.blocks.push(block);
  }

  /** Inline children become blocks of the given style, block children are visited in turn. */
  walk(container, style) {
    const inline = [];
    for (const child of container.childNodes) {
      if (child.nodeType === ELEMENT_NODE && BLOCK_TAGS.has(child.localName)) {
        this.#flush(inline, container, style);
        this.#visit(child, style);
      } else {
        inline.push(child);
      }
    }
    this.#flush(inline, container, style);
  }

  #visit(el, style) {
    if (isSkipped(el)) return;
    const tag = el.localName;
    const heading = HEADING.exec(tag);
    if (heading) {
      this.walk(el, { kind: 'heading', level: Number(heading[1]) });
    } else if (tag === 'li') {
      this.walk(el, { kind: 'item' });
    } else if (tag === 'td' || tag === 'th') {
      this.walk(el, { kind: 'cell' });
    } else if (tag === 'tr') {
      this.#visitRow(el, style);
    } else {
      this.walk(el, style);
    }
  }

  #visitRow(row, style) {
    const before = this.blocks.length;
    this.walk(row, style);
    const last = this.blocks.at(-1);
    if (this.blocks.length > before && last.kind === 'cell') last.rowEnd = true;
  }
}

/**
 * Finds what a voice should read in a rendered document.
 * @param {Element} root
 * @param {{sourceMode: 'skip'|'name', lang: string}} opts
 * @returns {SpeechBlock[]}
 */
export function extractBlocks(root, opts) {
  const collector = new BlockCollector(opts);
  collector.walk(root, { kind: 'para' });
  return collector.blocks;
}
