// SPDX-License-Identifier: GPL-3.0-or-later

export const MAX_SENTENCE_CHARS = 500;

const SHARED_ABBREVIATIONS = ['e.g.', 'i.e.', 'vs.', 'dr.', 'prof.', 'mr.', 'mrs.', 'ms.'];
const ABBREVIATIONS = {
  it: ['es.', 'p.es.', 'ad.es.', 'dott.', 'dott.ssa', 'sig.', 'sig.ra', 'sig.na', 'ing.', 'avv.', 'arch.', 'geom.',
    'cfr.', 'art.', 'pag.', 'pagg.', 'vol.', 'cap.', 'fig.', 'tel.', 'n.', 'nn.', 'p.', 'pp.'],
  en: ['jr.', 'sr.', 'st.', 'fig.', 'vol.', 'pp.', 'approx.', 'dept.'],
};
const ALL_ABBREVIATIONS = new Set([...SHARED_ABBREVIATIONS, ...ABBREVIATIONS.it, ...ABBREVIATIONS.en]);
const ABBREVIATIONS_BY_LANG = Object.fromEntries(
  Object.entries(ABBREVIATIONS).map(([lang, list]) => [lang, new Set([...SHARED_ABBREVIATIONS, ...list])]),
);

const OPENING_PUNCTUATION = /^[^\p{L}\p{N}]+/u;
// The start of a word elided or joined to the last one: l'ing., Dott.ssa/Dott.
const JOINED_START = /^.*['’/]/u;
const INITIAL = /^\p{Lu}\.$/u;
const LIST_NUMBER = /^\d+\.$/;
const LOW_SURROGATE = /[\uDC00-\uDFFF]/;
const WHITESPACE = /\s/;

const segmenters = new Map();

function segmenterFor(lang) {
  if (!segmenters.has(lang)) {
    let segmenter;
    try {
      segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
    } catch {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    }
    segmenters.set(lang, segmenter);
  }
  return segmenters.get(lang);
}

function abbreviationsFor(lang) {
  const primary = String(lang ?? '').toLowerCase().split('-')[0];
  return ABBREVIATIONS_BY_LANG[primary] ?? ALL_ABBREVIATIONS;
}

function continuesAfter(segment, abbreviations) {
  const trimmed = segment.trim();
  if (LIST_NUMBER.test(trimmed)) return true;
  const lastWord = trimmed.split(/\s+/).at(-1).replace(OPENING_PUNCTUATION, '').replace(JOINED_START, '');
  return INITIAL.test(lastWord) || abbreviations.has(lastWord.toLowerCase());
}

function cutPoint(text, start) {
  const limit = start + MAX_SENTENCE_CHARS;
  const space = text.lastIndexOf(' ', limit);
  if (space > start) return space;
  return LOW_SURROGATE.test(text[limit]) ? limit - 1 : limit;
}

function cut(text, { start, end }) {
  const spans = [];
  let from = start;
  while (end - from > MAX_SENTENCE_CHARS) {
    const at = cutPoint(text, from);
    spans.push({ start: from, end: at });
    from = at;
  }
  spans.push({ start: from, end });
  return spans;
}

function trimSpan(text, span) {
  let { start, end } = span;
  while (start < end && WHITESPACE.test(text[start])) start += 1;
  while (end > start && WHITESPACE.test(text[end - 1])) end -= 1;
  return { start, end };
}

/**
 * Splits text into the sentences a voice reads one at a time, as offsets into
 * text. No span is longer than MAX_SENTENCE_CHARS or has surrounding spaces.
 * @param {string} text
 * @param {string} lang
 * @returns {{start: number, end: number}[]}
 */
export function splitSentences(text, lang) {
  const abbreviations = abbreviationsFor(lang);
  const merged = [];
  for (const { segment, index } of segmenterFor(lang).segment(text)) {
    const previous = merged.at(-1);
    if (previous && continuesAfter(text.slice(previous.start, previous.end), abbreviations)) {
      previous.end = index + segment.length;
    } else {
      merged.push({ start: index, end: index + segment.length });
    }
  }
  return merged
    .flatMap((span) => cut(text, trimSpan(text, span)))
    .map((span) => trimSpan(text, span))
    .filter((span) => span.end > span.start);
}
