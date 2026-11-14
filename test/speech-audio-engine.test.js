// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_RATES, AudioEngine } from '../app/speech/engine-audio.js';
import { decodePcm } from '../app/speech/pcm.js';

const RATE = 22050;

/** The bytes `tts::pack` makes in Rust. */
function pack({ id = '1', sampleRate = RATE, from = 0, rate = 1, words = [], samples }) {
  const header = new TextEncoder().encode(JSON.stringify({ id, sampleRate, from, rate, words }));
  const start = Math.ceil((4 + header.length) / 4) * 4;
  const buffer = new ArrayBuffer(start + samples.length * 4);
  const view = new DataView(buffer);
  view.setUint32(0, header.length, true);
  new Uint8Array(buffer, 4, header.length).set(header);
  samples.forEach((sample, i) => view.setFloat32(start + i * 4, sample, true));
  return buffer;
}

const seconds = (count, rate = 1) => new Float32Array(Math.round((RATE * count) / rate));

function fakeAudio() {
  const sources = [];
  class FakeContext {
    currentTime = 0;
    state = 'running';
    destination = {};
    constructor() {
      audio.context = this;
    }
    createGain() {
      audio.gain = { gain: { value: 1 }, connect() {} };
      return audio.gain;
    }
    createBuffer(channels, length, sampleRate) {
      return { length, sampleRate, copyToChannel(samples) { this.samples = samples; } };
    }
    createBufferSource() {
      const source = {
        started: null,
        stopped: false,
        connect() {},
        start(when, offset) { this.started = { when, offset }; },
        stop() { this.stopped = true; },
      };
      sources.push(source);
      return source;
    }
  }
  const audio = { sources, FakeContext, context: null, gain: null };
  return audio;
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    set(callback, ms) {
      pending.set(next, { callback, ms });
      return next++;
    },
    clear(timer) {
      pending.delete(timer);
    },
    runAll() {
      const due = [...pending.values()];
      pending.clear();
      due.forEach(({ callback }) => callback());
    },
  };
}

/** An invoke whose answers the test hands out one by one. */
function controlledInvoke() {
  const calls = [];
  const invoke = (command, args) => new Promise((resolve, reject) => {
    calls.push({ command, args, resolve, reject });
  });
  return { calls, invoke };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const audio = fakeAudio();
  const timers = fakeTimers();
  const { calls, invoke } = controlledInvoke();
  const engine = new AudioEngine({ invoke, AudioContext: audio.FakeContext, timers });
  return { audio, timers, calls, engine };
}

test('decodePcm reads what rust packs', () => {
  const words = [{ start: 0, end: 3, from: 0, to: 10 }];
  const sound = decodePcm(pack({ id: '42', from: 5, rate: 1.5, words, samples: [0.25, -0.5, 1] }));
  assert.equal(sound.id, '42');
  assert.equal(sound.sampleRate, RATE);
  assert.equal(sound.from, 5);
  assert.equal(sound.rate, 1.5);
  assert.deepEqual(sound.words, words);
  assert.deepEqual([...sound.samples], [0.25, -0.5, 1]);
});

test('speak plays one buffer and ends', async () => {
  const { audio, calls, engine } = setup();
  const said = engine.speak('Ciao.', { voiceId: 'piper:x', rate: 1 });
  assert.equal(calls[0].command, 'tts_speak');
  assert.deepEqual(calls[0].args, { voiceId: 'piper:x', text: 'Ciao.', rate: 1, sound: 'natural' });
  calls[0].resolve(pack({ samples: seconds(1) }));
  await flush();
  assert.equal(audio.sources.length, 1);
  assert.deepEqual(audio.sources[0].started, { when: 0, offset: 0 });
  audio.sources[0].onended();
  assert.equal(await said, 'end');
});

test('stop resolves stopped and silences', async () => {
  const { audio, calls, engine } = setup();
  const said = engine.speak('Ciao.', { voiceId: 'piper:x' });
  calls[0].resolve(pack({ samples: seconds(1) }));
  await flush();
  engine.stop();
  assert.equal(await said, 'stopped');
  assert.equal(audio.sources[0].stopped, true);
});

test('set rate while playing restretches from where it is', async () => {
  const { audio, calls, engine } = setup();
  const said = engine.speak('Ciao.', { voiceId: 'piper:x', rate: 1 });
  calls[0].resolve(pack({ id: '3', samples: seconds(1) }));
  await flush();
  audio.context.currentTime = 0.25;
  engine.setRate(2);
  assert.equal(calls[1].command, 'tts_restretch');
  assert.equal(calls[1].args.id, '3');
  assert.equal(calls[1].args.rate, 2);
  assert.ok(Math.abs(calls[1].args.from - 5512) <= 64, `from ${calls[1].args.from}`);
  calls[1].resolve(pack({ id: '3', from: calls[1].args.from, rate: 2, samples: seconds(0.75, 2) }));
  await flush();
  assert.equal(audio.sources.length, 2);
  assert.equal(audio.sources[0].stopped, true);
  assert.equal(audio.sources[1].stopped, false);
  audio.sources[1].onended();
  assert.equal(await said, 'end');
});

test('the sound the reader chose goes with each sentence', async () => {
  const audio = fakeAudio();
  const { calls, invoke } = controlledInvoke();
  let chosen = 'warm';
  const engine = new AudioEngine({ invoke, AudioContext: audio.FakeContext, timers: fakeTimers(), sound: () => chosen });
  engine.speak('Ciao.', { voiceId: 'piper:x', rate: 1 });
  assert.equal(calls[0].args.sound, 'warm');
  calls[0].resolve(pack({ id: '3', samples: seconds(1) }));
  await flush();
  chosen = 'radio';
  audio.context.currentTime = 0.5;
  engine.resound();
  assert.equal(calls[1].command, 'tts_restretch');
  assert.equal(calls[1].args.sound, 'radio');
  assert.equal(calls[1].args.rate, 1);
  assert.ok(Math.abs(calls[1].args.from - 11025) <= 64, `from ${calls[1].args.from}`);
  calls[1].resolve(pack({ id: '3', from: calls[1].args.from, samples: seconds(0.5) }));
  await flush();
  assert.equal(audio.sources.length, 2);
  assert.equal(audio.sources[0].stopped, true);
});

test('a new sound with nothing being said asks for nothing', () => {
  const { calls, engine } = setup();
  engine.resound();
  assert.equal(calls.length, 0);
});

test('five rate changes in a row leave one source at the last rate', async () => {
  const { audio, calls, engine } = setup();
  const said = engine.speak('Ciao.', { voiceId: 'piper:x', rate: 1 });
  calls[0].resolve(pack({ samples: seconds(2) }));
  await flush();
  [1.5, 2, 2.5, 3, 3.5].forEach((rate) => engine.setRate(rate));
  const asked = calls.slice(1);
  assert.equal(asked.length, 5);
  asked.forEach((call) => call.resolve(pack({ from: call.args.from, rate: call.args.rate, samples: seconds(1, call.args.rate) })));
  await flush();
  assert.equal(audio.sources.length, 2);
  const playing = audio.sources.filter((source) => !source.stopped);
  assert.equal(playing.length, 1);
  assert.equal(playing[0].buffer.length, Math.round(RATE / 3.5));
  engine.stop();
  assert.equal(await said, 'stopped');
});

test('set volume changes the gain without restarting', async () => {
  const { audio, calls, engine } = setup();
  engine.speak('Ciao.', { voiceId: 'piper:x', volume: 1 });
  calls[0].resolve(pack({ samples: seconds(1) }));
  await flush();
  engine.setVolume(0.3);
  assert.equal(audio.gain.gain.value, 0.3);
  assert.equal(calls.length, 1);
  assert.equal(audio.sources.length, 1);
  engine.stop();
});

test('words are announced at their time scaled by rate', async () => {
  const { audio, calls, engine, timers } = setup();
  const heard = [];
  engine.speak('uno due', { voiceId: 'piper:x', rate: 2, onWord: (word) => heard.push(word) });
  const words = [{ start: 0, end: 3, from: 0, to: 11025 }, { start: 4, end: 7, from: 11025, to: 22050 }];
  calls[0].resolve(pack({ rate: 2, words, samples: seconds(1, 2) }));
  await flush();
  assert.deepEqual(heard, [{ start: 0, end: 3 }]);
  const [{ ms }] = [...timers.pending.values()];
  assert.ok(Math.abs(ms - 250) < 1, `waits ${ms} ms`);
  audio.context.currentTime = 0.25;
  timers.runAll();
  assert.deepEqual(heard, [{ start: 0, end: 3 }, { start: 4, end: 7 }]);
  audio.sources[0].onended();
  await flush();
  assert.equal(heard.at(-1), null);
});

test('a failed invoke is an error', async () => {
  const { calls, engine } = setup();
  const said = engine.speak('Ciao.', { voiceId: 'piper:x' });
  calls[0].reject({ kind: 'voice', message: 'gone' });
  assert.equal(await said, 'error');
  assert.deepEqual(engine.lastError, { kind: 'voice', message: 'gone' });
  const again = engine.speak('Ciao.', { voiceId: 'piper:x' });
  assert.equal(engine.lastError, null);
  engine.stop();
  await again;
});

test('rates are half to four by tenths', () => {
  const { engine } = setup();
  assert.equal(engine.rates().length, 36);
  assert.equal(engine.rates()[0], 0.5);
  assert.equal(engine.rates().at(-1), 4);
  assert.equal(AUDIO_RATES[10], 1.5);
});
