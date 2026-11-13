// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_RATES } from '../app/speech/engine-audio.js';
import { engineOf, RoutedEngine } from '../app/speech/engine-router.js';
import { RATE_LEVELS } from '../app/speech/player.js';

function fake(name, voices = []) {
  return {
    said: [],
    stops: 0,
    prepared: [],
    adjusted: [],
    voices: async () => voices,
    speak(text) {
      this.said.push(text);
      return Promise.resolve(`${name} end`);
    },
    stop() {
      this.stops += 1;
    },
    prepare(text) {
      this.prepared.push(text);
    },
    setRate(rate) {
      this.adjusted.push(['rate', rate]);
    },
    setVolume(volume) {
      this.adjusted.push(['volume', volume]);
    },
  };
}

test('ids without a known prefix are windows voices', () => {
  assert.equal(engineOf('Microsoft Elsa'), 'sapi');
  assert.equal(engineOf(null), 'sapi');
  assert.equal(engineOf('piper:x'), 'piper');
  assert.equal(engineOf('edge:x'), 'edge');
});

test('speak goes to the engine of the voice', async () => {
  const web = fake('web');
  const audio = fake('audio');
  const engine = new RoutedEngine({ web, audio });
  assert.equal(await engine.speak('Uno.', { voiceId: 'Microsoft Elsa' }), 'web end');
  assert.equal(await engine.speak('Due.', { voiceId: 'piper:paola' }), 'audio end');
  assert.deepEqual(web.said, ['Uno.']);
  assert.deepEqual(audio.said, ['Due.']);
  engine.prepare('Tre.', { voiceId: 'Microsoft Elsa' });
  engine.prepare('Tre.', { voiceId: 'piper:paola' });
  assert.deepEqual(audio.prepared, ['Tre.']);
});

test('the speeds and the live changes follow the engine of the voice', () => {
  const web = fake('web');
  const audio = fake('audio');
  const engine = new RoutedEngine({ web, audio });
  assert.equal(engine.rates('Microsoft Elsa'), RATE_LEVELS);
  assert.equal(engine.rates('piper:x'), AUDIO_RATES);
  assert.equal(engine.live('edge:x'), true);
  assert.equal(engine.live('Microsoft Elsa'), false);
  engine.adjust({ voiceId: 'piper:x', rate: 2.5, volume: 0.5 });
  assert.deepEqual(audio.adjusted, [['rate', 2.5], ['volume', 0.5]]);
});

test('the voices of both engines are listed', async () => {
  const engine = new RoutedEngine({
    web: fake('web', [{ id: 'Microsoft Elsa', lang: 'it-IT' }]),
    audio: fake('audio', [{ id: 'piper:paola', lang: 'it-IT' }]),
  });
  assert.deepEqual((await engine.voices()).map(({ id }) => id), ['Microsoft Elsa', 'piper:paola']);
});
