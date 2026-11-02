// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_SENTENCE_CHARS, splitSentences } from '../app/speech/sentences.js';

const parts = (text, lang = 'it') => splitSentences(text, lang).map((s) => text.slice(s.start, s.end));

test('the sentence limit is 500 characters', () => {
  assert.equal(MAX_SENTENCE_CHARS, 500);
});

test('plain sentences are split without surrounding spaces', () => {
  assert.deepEqual(parts('Una frase. Due frasi? Tre!  '), ['Una frase.', 'Due frasi?', 'Tre!']);
});

test('common abbreviations do not end a sentence', () => {
  assert.deepEqual(parts('Si usa es. questo. Poi basta.'), ['Si usa es. questo.', 'Poi basta.']);
  assert.deepEqual(parts('Il dott. Rossi parla.'), ['Il dott. Rossi parla.']);
  assert.deepEqual(parts('Use e.g. this.', 'en'), ['Use e.g. this.']);
  assert.deepEqual(parts('Per es. Roma. Fine.'), ['Per es. Roma.', 'Fine.']);
  assert.deepEqual(parts('Ask Mr. Smith, i.e. Bob. Done.', 'en'), ['Ask Mr. Smith, i.e. Bob.', 'Done.']);
});

test('abbreviations are found in a parenthesis and with a regional language tag', () => {
  assert.deepEqual(parts('Vedi (es. Roma) qui.', 'it-IT'), ['Vedi (es. Roma) qui.']);
  assert.deepEqual(parts('La sig. Bianchi legge.', 'it-IT'), ['La sig. Bianchi legge.']);
});

test('an abbreviation of the other language still ends a sentence', () => {
  assert.equal(parts('He plays the games es. Then he left.', 'en').length, 2);
});

test('initials and list numbers do not end a sentence', () => {
  assert.deepEqual(parts('Di J. R. Tolkien. Fine.'), ['Di J. R. Tolkien.', 'Fine.']);
  assert.deepEqual(parts('1. Primo punto. Poi.'), ['1. Primo punto.', 'Poi.']);
});

test('decimals and versions do not end a sentence', () => {
  assert.deepEqual(parts('La v0.12 costa 3.5 euro. Fine.'), ['La v0.12 costa 3.5 euro.', 'Fine.']);
});

test('a huge unpunctuated sentence is cut', () => {
  const text = 'parola '.repeat(2000);
  const spans = splitSentences(text, 'it');
  assert.ok(spans.every((s) => s.end - s.start <= 500));
  assert.ok(spans.length > 1);
  const pieces = spans.map((s) => text.slice(s.start, s.end));
  assert.equal(pieces.join(' '), text.trim());
  assert.ok(pieces.every((p) => p === p.trim()));
});

test('a huge word without spaces is cut anyway, never inside a surrogate pair', () => {
  const text = `a${'\u{1F600}'.repeat(1000)}`;
  const spans = splitSentences(text, 'it');
  const pieces = spans.map((s) => text.slice(s.start, s.end));
  assert.ok(spans.every((s) => s.end - s.start <= 500));
  assert.equal(pieces.join(''), text);
  assert.ok(pieces.every((p) => !/^[\uDC00-\uDFFF]/.test(p)));
});

test('empty text has no sentences', () => {
  assert.deepEqual(splitSentences('', 'it'), []);
  assert.deepEqual(splitSentences('  \n ', 'it'), []);
});

test('a language tag the segmenter refuses does not fail', () => {
  assert.deepEqual(parts('Una. Due.', 'non valida!'), ['Una.', 'Due.']);
  assert.deepEqual(parts('Una. Due.', null), ['Una.', 'Due.']);
});
