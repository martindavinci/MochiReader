// SPDX-License-Identifier: GPL-3.0-or-later
import { hostName } from './hostname.js';
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
const NOTE_CLASSES = new Set(['footnotes', 'footnote-ref', 'footnote-backref']);
const NOTE_ATTRIBUTES = ['data-footnotes', 'data-footnote-ref', 'data-footnote-backref'];

const RENDERED_NOTE_ID = /^fn-/;
const NOTE_MARKER = /^[[(]?(\d{1,4}|[*†‡]+)[\])]?$/;
const BRACKETED = /^[[(]/;
const HEADING = /^h([1-6])$/;
const URL_LIKE = /^(https?:\/\/|www\.)\S*$/i;
const HTTP_SCHEME = /^https?:\/\//i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?)$/i;
const CODE_LIKE_WORD = /^\S*[_\d]\S*$/;
const READABLE = /[\p{L}\p{N}]/u;

const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>]*[^\s<>.,;:!?)\]'"»]/gi;
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

function isUrlLink(link) {
  const text = link.textContent.trim();
  const href = (link.getAttribute('href') ?? '').replace(HTTP_SCHEME, '').replace(/\/$/, '');
  return URL_LIKE.test(text) || (text !== '' && text.replace(/\/$/, '') === href);
}

function isSkipped(el) {
  const tag = el.localName;
  if (SKIPPED_TAGS.has(tag)) return true;
  if (el.hasAttribute('data-noread') || el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (hasToken(el, 'epub:type', NOTE_EPUB_TYPES) || hasToken(el, 'role', NOTE_ROLES)) return true;
  if (hasToken(el, 'class', NOTE_CLASSES)) return true;
  if (NOTE_ATTRIBUTES.some((name) => el.hasAttribute(name))) return true;
  if (tag === 'li' && RENDERED_NOTE_ID.test(el.getAttribute('id') ?? '')) return true;
  return tag === 'a' && (isNoteMarker(el) || isUrlLink(el));
}

function isRealAlt(alt) {
  return READABLE.test(alt) && !URL_LIKE.test(alt) && !IMAGE_FILE.test(alt) && !CODE_LIKE_WORD.test(alt);
}

/** The text of a block, with the DOM position of every UTF-16 unit. */
class TextRun {
  text = '';
  nodes = [];
  offsets = [];
  links = [];

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
    }
  }
}

/** Removes matches from text, a string whose map gives each UTF-16 unit's index in its TextRun. */
function removeMatches({ text, map }, pattern) {
  let kept = '';
  const keptMap = [];
  let from = 0;
  const keep = (to) => {
    kept += text.slice(from, to);
    for (let i = from; i < to; i += 1) keptMap.push(map[i]);
  };
  for (const match of text.matchAll(pattern)) {
    keep(match.index);
    from = match.index + match[0].length;
  }
  keep(text.length);
  return { text: kept, map: keptMap };
}

function normalize(run) {
  let clean = { text: run.text, map: Array.from(run.nodes.keys()) };
  for (const pattern of [BARE_URL, KEYCAP_EMOJI, EMOJI, INVISIBLE, EMPTY_BRACKETS]) {
    clean = removeMatches(clean, pattern);
  }
  clean.text = clean.text.replace(/\s/g, ' ');
  for (const pattern of [REPEATED_SPACE, OUTER_SPACE, SPACE_BEFORE_PUNCTUATION]) {
    clean = removeMatches(clean, pattern);
  }
  return clean;
}

/** Cuts the trailing "(fonte)" parts off clean and returns their links, in reading order. */
function takeSources(clean, run) {
  const hrefs = [];
  for (let match = TRAILING_SOURCE.exec(clean.text); match; match = TRAILING_SOURCE.exec(clean.text)) {
    const word = clean.map[match.index + match[0].indexOf(match[1])];
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
