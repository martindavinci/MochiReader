// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSpeechEngine, VOICES_WAIT_MS } from '../app/speech/engine-web.js';
import { SpeechPlayer } from '../app/speech/player.js';

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

test('any spelling of a language tag finds the installed voice', async () => {
  for (const lang of ['ita', 'ITA', 'it', 'IT', 'it_IT', 'IT-it', 'it-CH', ' it-IT ']) {
    const { engine, synth } = setup([ZIRA, ELSA]);
    engine.speak('Ciao.', { voiceId: null, rate: 1, lang });
    assert.equal(synth.spoken[0]?.voice, ELSA, lang);
  }
  for (const lang of ['eng', 'en', 'en_US', 'EN-gb', 'en-GB']) {
    const { engine, synth } = setup([ELSA, ZIRA]);
    engine.speak('Hi.', { voiceId: null, rate: 1, lang });
    assert.equal(synth.spoken[0]?.voice, ZIRA, lang);
  }
});

test('an installed voice written in another spelling is found too', async () => {
  const underscored = voice('Android', 'it_IT');
  const { engine, synth } = setup([ZIRA, underscored]);
  engine.speak('Ciao.', { voiceId: null, rate: 1, lang: 'ita' });
  assert.equal(synth.spoken[0].voice, underscored);
});

test('the voice of the same region comes first', async () => {
  const HAZEL = voice('Hazel', 'en-GB');
  for (const lang of ['en-GB', 'en_GB', 'EN-gb', 'eng-GB']) {
    const { engine, synth } = setup([ZIRA, HAZEL]);
    engine.speak('Hi.', { voiceId: null, rate: 1, lang });
    assert.equal(synth.spoken[0].voice, HAZEL, lang);
  }
  const { engine, synth } = setup([ZIRA, HAZEL]);
  engine.speak('Hi.', { voiceId: null, rate: 1, lang: 'en-AU' });
  assert.equal(synth.spoken[0].voice, ZIRA, 'another region is better than no voice');
});

test('the utterance gets a well-formed language tag', async () => {
  const cases = { ita: 'it', it_IT: 'it-IT', 'IT-it': 'it-IT', 'en-GB': 'en-GB', it: 'it' };
  for (const [lang, expected] of Object.entries(cases)) {
    const { engine, synth } = setup([ELSA, voice('Hazel', 'en-GB')]);
    engine.speak('Ciao.', { voiceId: null, rate: 1, lang });
    assert.equal(synth.spoken[0].lang, expected, lang);
  }
});

test('a language with no voice still resolves as error, whatever its spelling', async () => {
  for (const lang of ['fra', 'fre', 'fr_FR', 'xyz']) {
    const { engine, synth } = setup([ELSA, ZIRA]);
    assert.equal(await engine.speak('Salut.', { voiceId: null, rate: 1, lang }), 'error', lang);
    assert.equal(synth.spoken.length, 0);
  }
});

test('a blank language counts as no language', async () => {
  const { engine, synth } = setup([ZIRA, ELSA]);
  engine.speak('Hi.', { voiceId: null, rate: 1, lang: '   ' });
  assert.equal(synth.spoken[0].voice, ZIRA);
  assert.equal(synth.spoken[0].lang, 'en-US');
});

test('without a language it takes the first local voice and its language', async () => {
  const { engine, synth } = setup([ONLINE, ZIRA, ELSA]);
  engine.speak('Hi.', { voiceId: null, rate: 1, lang: null });
  assert.equal(synth.spoken[0].voice, ZIRA);
  assert.equal(synth.spoken[0].lang, 'en-US');
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function voicesArrive(synth, list) {
  synth.list = list;
  synth.dispatchEvent(new Event('voiceschanged'));
}

test('speak waits for the voice list when it arrives late', async () => {
  const { engine, synth } = setup([]);
  const done = engine.speak('Ciao.', { voiceId: null, rate: 1, lang: 'it' });
  assert.equal(synth.spoken.length, 0);
  voicesArrive(synth, [ELSA]);
  await flush();
  assert.equal(synth.spoken[0].voice, ELSA);
  synth.spoken[0].onend();
  assert.equal(await done, 'end');
});

test('speak does not wait forever for a voice list that never arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, synth } = setup([]);
  const done = engine.speak('Ciao.', { voiceId: null, rate: 1, lang: 'it' });
  t.mock.timers.tick(VOICES_WAIT_MS - 1);
  await flush();
  assert.equal(synth.spoken.length, 0);
  t.mock.timers.tick(1);
  assert.equal(await done, 'error');
  assert.equal(synth.spoken.length, 0);
});

test('a late list without a usable voice resolves as error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, synth } = setup([]);
  const done = engine.speak('Ciao.', { voiceId: null, rate: 1, lang: 'it' });
  voicesArrive(synth, [ONLINE, ZIRA]);
  assert.equal(await done, 'error');
  assert.equal(synth.spoken.length, 0);
});

test('stop while waiting for the voices resolves as stopped and speaks nothing later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, synth } = setup([]);
  const done = engine.speak('Ciao.', { voiceId: null, rate: 1, lang: 'it' });
  engine.stop();
  assert.equal(await done, 'stopped');
  voicesArrive(synth, [ELSA]);
  await flush();
  assert.equal(synth.spoken.length, 0);
});

test('a new speak while waiting for the voices replaces the old one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, synth } = setup([]);
  const first = engine.speak('Uno.', { voiceId: null, rate: 1, lang: 'it' });
  const second = engine.speak('Due.', { voiceId: null, rate: 1, lang: 'it' });
  assert.equal(await first, 'stopped');
  voicesArrive(synth, [ELSA]);
  await flush();
  assert.deepEqual(synth.spoken.map((u) => u.text), ['Due.']);
  synth.spoken[0].onend();
  assert.equal(await second, 'end');
});

test('a player started before the voices arrive reads as soon as they do', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, synth } = setup([]);
  const errors = [];
  const player = new SpeechPlayer({ engine, onError: (code) => errors.push(code) });
  player.load([{ kind: 'para', line: null, sentences: [{ text: 'Ciao.', start: null, end: null }] }]);
  player.setLang('it');
  player.play();
  voicesArrive(synth, [ELSA]);
  await flush();
  assert.equal(player.state, 'playing');
  assert.deepEqual(errors, []);
  assert.equal(synth.spoken[0].voice, ELSA);
  synth.spoken[0].onend();
  await flush();
  assert.equal(player.state, 'ended');
});

/** Behaves like Chromium: one utterance at a time, and every event arrives later, not during the call. */
class QueueingSynth extends FakeSynth {
  #queue = [];
  #current = null;

  get speaking() {
    return this.#current !== null;
  }

  speak(utterance) {
    super.speak(utterance);
    this.#queue.push(utterance);
    this.#startNext();
  }

  cancel() {
    super.cancel();
    const dropped = [this.#current, ...this.#queue].filter(Boolean);
    this.#current = null;
    this.#queue = [];
    setImmediate(() => dropped.forEach((utterance) => utterance.onerror({ error: 'interrupted' })));
  }

  finishCurrent() {
    const utterance = this.#current;
    this.#current = null;
    setImmediate(() => {
      utterance.onend();
      this.#startNext();
    });
  }

  #startNext() {
    if (!this.#current) this.#current = this.#queue.shift() ?? null;
  }
}

test('a player replaced on a shared engine goes idle and leaves the new player speaking', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const synth = new QueueingSynth([ELSA]);
  const engine = new WebSpeechEngine({ synth, Utterance: FakeUtterance });
  const errors = [];
  const playerFor = (text) => {
    const player = new SpeechPlayer({ engine, onError: (code) => errors.push(code) });
    player.load([{ kind: 'para', line: null, sentences: [{ text, start: null, end: null }] }]);
    return player;
  };
  const first = playerFor('tab A');
  const second = playerFor('tab B');

  first.play();
  await flush();
  second.play();
  await flush();
  await flush();
  assert.equal(first.state, 'idle');
  assert.equal(second.state, 'playing');
  assert.equal(synth.speaking, true);
  assert.deepEqual(synth.spoken.map((u) => u.text), ['tab A', 'tab B']);
  assert.deepEqual(errors, []);

  synth.finishCurrent();
  await flush();
  assert.equal(second.state, 'ended');
  assert.equal(synth.speaking, false);
  assert.deepEqual(errors, []);
});

function queueingEngine() {
  const synth = new QueueingSynth([ELSA]);
  return { synth, engine: new WebSpeechEngine({ synth, Utterance: FakeUtterance }) };
}

const blocksOf = (...texts) => texts.map((text) => ({
  kind: 'para',
  line: null,
  sentences: [{ text, start: null, end: null }],
}));

function sharedEngine() {
  const { synth, engine } = queueingEngine();
  const errors = [];
  const playerFor = (...texts) => {
    const gaps = [];
    const player = new SpeechPlayer({
      engine,
      onError: (code) => errors.push(code),
      sleep: () => new Promise((resolve) => gaps.push(resolve)),
    });
    player.load(blocksOf(...texts));
    player.endGap = () => gaps.shift()();
    return player;
  };
  const settle = async () => {
    await flush();
    await flush();
  };
  const assertOnlySpeaker = (speaker, text) => {
    assert.equal(speaker.state, 'playing');
    assert.equal(synth.speaking, true);
    assert.equal(synth.spoken.at(-1).text, text);
    assert.deepEqual(errors, []);
  };
  return { synth, errors, playerFor, settle, assertOnlySpeaker };
}

/** Leaves the player in the pause after its first block, with nothing being spoken. */
async function reachGap(player, { synth, settle }) {
  player.play();
  await settle();
  synth.finishCurrent();
  await settle();
  assert.equal(player.state, 'playing');
  assert.equal(synth.speaking, false);
}

test('a stop right after the new player started does not silence it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = sharedEngine();
  const a = shared.playerFor('tab A');
  const b = shared.playerFor('tab B');
  a.play();
  await shared.settle();

  b.play();
  a.stop();
  await shared.settle();
  assert.equal(a.state, 'idle');
  shared.assertOnlySpeaker(b, 'tab B');
  assert.equal(shared.synth.spoken.length, 2);

  shared.synth.finishCurrent();
  await shared.settle();
  assert.equal(b.state, 'ended');
  assert.deepEqual(shared.errors, []);
});

test('a stop right before the new player starts does not silence it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = sharedEngine();
  const a = shared.playerFor('tab A');
  const b = shared.playerFor('tab B');
  a.play();
  await shared.settle();

  a.stop();
  b.play();
  await shared.settle();
  assert.equal(a.state, 'idle');
  shared.assertOnlySpeaker(b, 'tab B');
});

test('stopping in the pause between blocks does not cut the player now speaking', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = sharedEngine();
  const a = shared.playerFor('A one', 'A two');
  const b = shared.playerFor('tab B');
  await reachGap(a, shared);

  b.play();
  await shared.settle();
  const { cancels } = shared.synth;
  a.stop();
  await shared.settle();
  assert.equal(shared.synth.cancels, cancels);
  assert.equal(a.state, 'idle');
  shared.assertOnlySpeaker(b, 'tab B');
});

test('stopping in the pause and then starting another player leaves it speaking', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = sharedEngine();
  const a = shared.playerFor('A one', 'A two');
  const b = shared.playerFor('tab B');
  await reachGap(a, shared);

  a.stop();
  b.play();
  await shared.settle();
  assert.equal(a.state, 'idle');
  shared.assertOnlySpeaker(b, 'tab B');
});

test('a player replaced in the pause does not come back when the pause ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = sharedEngine();
  const a = shared.playerFor('A one', 'A two');
  const b = shared.playerFor('tab B');
  await reachGap(a, shared);

  b.play();
  await shared.settle();
  assert.equal(a.state, 'idle', 'only one player reads at a time');
  assert.deepEqual(a.current, { block: 1, sentence: 0 });

  a.endGap();
  await shared.settle();
  shared.assertOnlySpeaker(b, 'tab B');
  assert.equal(shared.synth.spoken.length, 2);
});

test('what a replaced player does next does not reach the player now speaking', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const actions = {
    pause: (player) => player.pause(),
    resume: (player) => player.resume(),
    'load again': (player) => player.load([]),
    'a new rate': (player) => player.setRate(2),
    'a new voice': (player) => player.setVoice('uri:Elsa'),
    'a jump': (player) => player.nextSentence(),
    'a stop': (player) => player.stop(),
    'a second stop': (player) => {
      player.stop();
      player.stop();
    },
  };
  for (const [name, act] of Object.entries(actions)) {
    const shared = sharedEngine();
    const a = shared.playerFor('A one', 'A two');
    const b = shared.playerFor('tab B');
    a.play();
    await shared.settle();

    b.play();
    act(a);
    await shared.settle();
    assert.equal(a.state, 'idle', name);
    shared.assertOnlySpeaker(b, 'tab B');
    assert.equal(shared.synth.spoken.length, 2, name);
    b.stop();
  }
});

test('a paused player stopped later does not cut the player now speaking', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = sharedEngine();
  const a = shared.playerFor('tab A');
  const b = shared.playerFor('tab B');
  a.play();
  await shared.settle();
  a.pause();
  await shared.settle();

  b.play();
  await shared.settle();
  assert.equal(a.state, 'paused');
  const { cancels } = shared.synth;
  a.stop();
  await shared.settle();
  assert.equal(shared.synth.cancels, cancels);
  shared.assertOnlySpeaker(b, 'tab B');
});

test('the old player can take the engine back, and then the other one cannot cut it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = sharedEngine();
  const a = shared.playerFor('tab A');
  const b = shared.playerFor('tab B');
  a.play();
  await shared.settle();
  b.play();
  await shared.settle();

  a.play();
  b.stop();
  await shared.settle();
  assert.equal(b.state, 'idle');
  shared.assertOnlySpeaker(a, 'tab A');
  assert.equal(shared.synth.spoken.length, 3);
});

test('a new player stopped by a callback of the one it replaces never speaks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, synth } = queueingEngine();
  const a = new SpeechPlayer({ engine, onState: (state) => state === 'idle' && b.stop() });
  const b = new SpeechPlayer({ engine });
  a.load(blocksOf('tab A'));
  b.load(blocksOf('tab B'));
  a.play();
  await flush();

  b.play();
  await flush();
  assert.equal(a.state, 'idle');
  assert.equal(b.state, 'idle');
  assert.deepEqual(synth.spoken.map((u) => u.text), ['tab A']);
  assert.equal(synth.speaking, false, 'the old speech must not go on with nobody left to stop it');
});

test('a replaced player that starts again from its callback keeps the engine, once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, synth } = queueingEngine();
  let again = true;
  const a = new SpeechPlayer({
    engine,
    onState: (state) => {
      if (state === 'idle' && again) {
        again = false;
        a.play();
      }
    },
  });
  const b = new SpeechPlayer({ engine });
  a.load(blocksOf('tab A'));
  b.load(blocksOf('tab B'));
  a.play();
  await flush();

  b.play();
  await flush();
  await flush();
  assert.equal(a.state, 'playing');
  assert.equal(b.state, 'idle');
  assert.equal(synth.speaking, true);
  assert.deepEqual(synth.spoken.map((u) => u.text), ['tab A', 'tab A']);

  b.stop();
  await flush();
  assert.equal(a.state, 'playing');
  assert.equal(synth.speaking, true);
});

test('the player that ended leaves the engine free for the next one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = sharedEngine();
  const a = shared.playerFor('tab A');
  const b = shared.playerFor('tab B');
  a.play();
  await shared.settle();
  shared.synth.finishCurrent();
  await shared.settle();
  assert.equal(a.state, 'ended');
  const { cancels } = shared.synth;

  b.play();
  await shared.settle();
  assert.equal(shared.synth.cancels, cancels);
  assert.equal(a.state, 'ended', 'a player that has finished is not told to stop');
  shared.assertOnlySpeaker(b, 'tab B');
});

test('players on different engines do not replace each other', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = new SpeechPlayer({ engine: queueingEngine().engine });
  const b = new SpeechPlayer({ engine: queueingEngine().engine });
  a.load(blocksOf('tab A'));
  b.load(blocksOf('tab B'));
  a.play();
  b.play();
  await flush();
  assert.equal(a.state, 'playing');
  assert.equal(b.state, 'playing');
});
