// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterTick, afterUntick, barVoices, usableVoice } from '../app/speech/voice-lists.js';

const ELSA = { id: 'elsa', name: 'Microsoft Elsa', lang: 'it-IT' };
const SERENA = { id: 'piper:serena', name: 'Serena', lang: 'it-IT' };
const MIX = { id: 'kokoro:mix-0a1b2c3d', name: 'Sara e Heart', lang: 'it-IT' };
const HEART = { id: 'kokoro:af_heart', name: 'Heart', lang: 'en-US' };
const ZIRA = { id: 'zira', name: 'Microsoft Zira', lang: 'en-US' };
const ALL = [ELSA, SERENA, MIX, HEART, ZIRA];

test("the bar has the text's voices, then the ticked ones of other languages", () => {
  assert.deepEqual(barVoices(ALL, 'en-GB', ['kokoro:mix-0a1b2c3d', 'piper:serena']), { own: [HEART, ZIRA], others: [SERENA, MIX] });
});

test('nothing ticked: the bar as before', () => {
  assert.deepEqual(barVoices(ALL, 'en', []).others, []);
});

test("a ticked voice of the text's language is shown once, with its language", () => {
  const { own, others } = barVoices(ALL, 'en', ['zira']);
  assert.deepEqual(own, [HEART, ZIRA]);
  assert.deepEqual(others, []);
});

test('ticks of voices no longer there are ignored', () => {
  assert.deepEqual(barVoices(ALL, 'en', ['piper:gone', 'edge:x']).others, []);
});

test('a saved voice holds while it can be shown', () => {
  assert.equal(usableVoice('piper:serena', ALL, 'en', ['piper:serena']), true);
  assert.equal(usableVoice('piper:serena', ALL, 'en', []), false);
  assert.equal(usableVoice('zira', ALL, 'en', []), true);
  assert.equal(usableVoice('piper:gone', ALL, 'en', ['piper:gone']), false);
  assert.equal(usableVoice('', ALL, 'en', []), false);
});

test('unticking clears it where it was chosen for another language', () => {
  assert.deepEqual(
    afterUntick('piper:serena', 'it-IT', ['piper:serena', 'zira'], { it: 'piper:serena', en: 'piper:serena', de: 'x' }),
    { everywhere: ['zira'], clear: ['en'] },
  );
});

test('ticking adds once', () => {
  assert.deepEqual(afterTick('zira', ['zira']), ['zira']);
  assert.deepEqual(afterTick('zira', []), ['zira']);
});
