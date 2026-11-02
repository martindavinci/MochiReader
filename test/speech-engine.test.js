// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSpeechEngine, VOICES_WAIT_MS } from '../app/speech/engine-web.js';

const voice = (name, lang, localService = true) => ({ voiceURI: `uri:${name}`, name, lang, localService });
const ELSA = voice('Elsa', 'it-IT');
const COSIMO = voice('Cosimo', 'it-IT');
const ZIRA = voice('Zira', 'en-US');
const ONLINE = voice('Online', 'it-IT', false);

class FakeUtterance {
  constructor(text) {
    this.text = text;
  }
}

class FakeSynth extends EventTarget {
  constructor(list) {
    super();
    this.list = list;
    this.spoken = [];
    this.cancels = 0;
    this.failSpeak = false;
  }

  getVoices() {
    return this.list;
  }

  speak(utterance) {
    if (this.failSpeak) throw new Error('boom');
    this.spoken.push(utterance);
  }

  cancel() {
    this.cancels += 1;
  }
}

function setup(list = [ELSA, ZIRA]) {
  const synth = new FakeSynth(list);
  return { synth, engine: new WebSpeechEngine({ synth, Utterance: FakeUtterance }) };
}

test('web engine hides non local voices', async () => {
  const { engine } = setup([ELSA, ONLINE, ZIRA]);
  assert.deepEqual(await engine.voices(), [
    { id: 'uri:Elsa', name: 'Elsa', lang: 'it-IT' },
    { id: 'uri:Zira', name: 'Zira', lang: 'en-US' },
  ]);
});

test('voices wait for the list when it arrives late', async () => {
  const { engine, synth } = setup([]);
  const pending = engine.voices();
  synth.list = [ELSA];
  synth.dispatchEvent(new Event('voiceschanged'));
  assert.deepEqual(await pending, [{ id: 'uri:Elsa', name: 'Elsa', lang: 'it-IT' }]);
});

test('voices do not wait forever for a list that never arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine } = setup([]);
  const pending = engine.voices();
  t.mock.timers.tick(VOICES_WAIT_MS);
  assert.deepEqual(await pending, []);
});

test('speak passes text, voice, rate and language, and resolves at the end', async () => {
  const { engine, synth } = setup();
  const done = engine.speak('Ciao.', { voiceId: 'uri:Elsa', rate: 1.5, lang: 'it' });
  const [utterance] = synth.spoken;
  assert.equal(utterance.text, 'Ciao.');
  assert.equal(utterance.voice, ELSA);
  assert.equal(utterance.rate, 1.5);
  assert.equal(utterance.lang, 'it');
  utterance.onend();
  assert.equal(await done, 'end');
});

test('a synthesis error resolves as error', async () => {
  const { engine, synth } = setup();
  const done = engine.speak('Ciao.', { voiceId: 'uri:Elsa', rate: 1, lang: 'it' });
  synth.spoken[0].onerror({ error: 'synthesis-failed' });
  assert.equal(await done, 'error');
});

test('a cancelled utterance resolves as stopped, not as an error', async () => {
  for (const error of ['canceled', 'interrupted']) {
    const { engine, synth } = setup();
    const done = engine.speak('Ciao.', { voiceId: 'uri:Elsa', rate: 1, lang: 'it' });
    synth.spoken[0].onerror({ error });
    assert.equal(await done, 'stopped');
  }
});

test('a speak that throws resolves as error', async () => {
  const { engine, synth } = setup();
  synth.failSpeak = true;
  assert.equal(await engine.speak('Ciao.', { voiceId: 'uri:Elsa', rate: 1, lang: 'it' }), 'error');
});

test('stop cancels the synthesis, resolves as stopped and ignores late events', async () => {
  const { engine, synth } = setup();
  const done = engine.speak('Ciao.', { voiceId: 'uri:Elsa', rate: 1, lang: 'it' });
  engine.stop();
  assert.equal(synth.cancels, 1);
  assert.equal(await done, 'stopped');
  synth.spoken[0].onerror({ error: 'canceled' });

  const next = engine.speak('Due.', { voiceId: 'uri:Elsa', rate: 1, lang: 'it' });
  synth.spoken[0].onend();
  synth.spoken[1].onend();
  assert.equal(await next, 'end');
});

test('a new speak replaces the one in progress', async () => {
  const { engine, synth } = setup();
  const first = engine.speak('Uno.', { voiceId: 'uri:Elsa', rate: 1, lang: 'it' });
  const second = engine.speak('Due.', { voiceId: 'uri:Elsa', rate: 1, lang: 'it' });
  assert.equal(await first, 'stopped');
  assert.equal(synth.cancels, 1);
  synth.spoken[1].onend();
  assert.equal(await second, 'end');
});

test('the first speak does not cancel anything', async () => {
  const { engine, synth } = setup();
  engine.speak('Uno.', { voiceId: 'uri:Elsa', rate: 1, lang: 'it' });
  assert.equal(synth.cancels, 0);
});

test('a voice that was removed resolves as error and speaks nothing', async () => {
  const { engine, synth } = setup([ZIRA]);
  assert.equal(await engine.speak('Ciao.', { voiceId: 'uri:Elsa', rate: 1, lang: 'it' }), 'error');
  assert.equal(synth.spoken.length, 0);
});

test('a non local voice is never used, even when asked for', async () => {
  const { engine, synth } = setup([ONLINE, ELSA]);
  assert.equal(await engine.speak('Ciao.', { voiceId: 'uri:Online', rate: 1, lang: 'it' }), 'error');
  assert.equal(synth.spoken.length, 0);
});

test('without a voice id it picks a local voice for the language', async () => {
  const { engine, synth } = setup([ONLINE, ZIRA, COSIMO]);
  engine.speak('Ciao.', { voiceId: null, rate: 1, lang: 'it' });
  assert.equal(synth.spoken[0].voice, COSIMO);
});

test('without a voice id and without a voice for the language it resolves as error', async () => {
  const { engine, synth } = setup([ONLINE, ZIRA]);
  assert.equal(await engine.speak('Ciao.', { voiceId: null, rate: 1, lang: 'it' }), 'error');
  assert.equal(synth.spoken.length, 0);
});

test('language matching ignores the region and the case', async () => {
  const { engine, synth } = setup([voice('Hazel', 'en-GB')]);
  engine.speak('Hi.', { voiceId: null, rate: 1, lang: 'EN-us' });
  assert.equal(synth.spoken[0].voice.name, 'Hazel');
});

test('without a language it takes the first local voice and its language', async () => {
  const { engine, synth } = setup([ONLINE, ZIRA, ELSA]);
  engine.speak('Hi.', { voiceId: null, rate: 1, lang: null });
  assert.equal(synth.spoken[0].voice, ZIRA);
  assert.equal(synth.spoken[0].lang, 'en-US');
});
