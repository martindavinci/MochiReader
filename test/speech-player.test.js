// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SpeechPlayer,
  HEADING_PAUSE_MS,
  ITEM_PAUSE_MS,
  ROW_PAUSE_MS,
  MIN_RATE,
  MAX_RATE,
  RATE_STEP,
  SPEAK_WATCHDOG_MS,
  ERROR_ENGINE,
  ERROR_NOTHING_TO_READ,
  speakWatchdogMs,
} from '../app/speech/player.js';

const block = (kind, texts, extra = {}) => ({
  kind,
  line: null,
  sentences: texts.map((text) => ({ text, start: null, end: null })),
  ...extra,
});
const heading = (text, level = 1) => block('heading', [text], { level });
const item = (...texts) => block('item', texts);
const para = (...texts) => block('para', texts);
const cell = (text, rowEnd = false) => block('cell', [text], rowEnd ? { rowEnd } : {});

// Fake clock everywhere: a player left playing must not keep a real watchdog timer alive.
beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeEngine({ auto = false } = {}) {
  let pending = null;
  return {
    calls: [],
    stops: 0,
    voices: async () => [],
    speak(text, opts) {
      this.calls.push({ text, ...opts });
      if (auto) return Promise.resolve('end');
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    stop() {
      this.stops += 1;
      if (pending) pending('stopped');
      pending = null;
    },
    answer(outcome) {
      const resolve = pending;
      pending = null;
      resolve(outcome);
    },
    get lastText() {
      return this.calls.at(-1)?.text;
    },
  };
}

function harness(blocks, { at, auto = false, sleep } = {}) {
  const engine = fakeEngine({ auto });
  const log = [];
  const states = [];
  const errors = [];
  const moves = [];
  const player = new SpeechPlayer({
    engine,
    sleep:
      sleep ??
      (async (ms) => {
        log.push(ms);
      }),
    onSentence: (position, sentence) => {
      log.push(sentence.text);
      moves.push(position);
    },
    onState: (state) => states.push(state),
    onError: (code) => errors.push(code),
  });
  player.load(blocks, at);
  const advance = async (outcome = 'end') => {
    engine.answer(outcome);
    await flush();
  };
  return { engine, player, log, states, errors, moves, advance };
}

test('reads in order, with pauses after headings and items', async () => {
  assert.equal(HEADING_PAUSE_MS, 600);
  assert.equal(ITEM_PAUSE_MS, 300);
  assert.equal(ROW_PAUSE_MS, 250);
  const h = harness(
    [
      heading('Titolo'),
      item('Uno.'),
      item('Due.'),
      para('Frase a.', 'Frase b.'),
      cell('a'),
      cell('b', true),
      para('Fine.'),
    ],
    { auto: true },
  );
  h.player.play();
  await flush();
  assert.deepEqual(h.log, [
    'Titolo', 600,
    'Uno.', 300,
    'Due.', 300,
    'Frase a.', 'Frase b.', 300,
    'a', 'b', 250,
    'Fine.',
  ]);
});

test('changing the rate restarts the current sentence', async () => {
  const h = harness([para('Uno.'), para('Due.'), para('Tre.')]);
  h.player.play();
  await h.advance();
  assert.deepEqual(h.engine.calls.at(-1), { text: 'Due.', voiceId: null, rate: 1, lang: null });

  h.player.setRate(1.5);
  await flush();
  assert.equal(h.engine.stops, 1);
  assert.equal(h.engine.calls.length, 3);
  assert.equal(h.engine.lastText, 'Due.');
  assert.equal(h.engine.calls.at(-1).rate, 1.5);
  assert.deepEqual(h.player.current, { block: 1, sentence: 0 });

  h.player.setRate(1.5);
  await flush();
  assert.equal(h.engine.calls.length, 3, 'same rate does not restart');
});

test('changing the rate while paused does not start the audio', async () => {
  const h = harness([para('Uno.')]);
  h.player.play();
  h.player.pause();
  h.player.setRate(2);
  await flush();
  assert.equal(h.engine.calls.length, 1);
  h.player.resume();
  assert.equal(h.engine.calls.at(-1).rate, 2);
});

test('rate is clamped and stepped', () => {
  assert.equal(MIN_RATE, 0.5);
  assert.equal(MAX_RATE, 3);
  assert.equal(RATE_STEP, 0.1);
  const { player } = harness([para('Uno.')]);
  assert.equal(player.rate, 1);
  player.setRate(0.1);
  assert.equal(player.rate, MIN_RATE);
  player.setRate(99);
  assert.equal(player.rate, MAX_RATE);
  player.setRate(1.23);
  assert.equal(player.rate, 1.2);
  for (let i = 0; i < 3; i += 1) player.setRate(player.rate + RATE_STEP);
  assert.equal(player.rate, 1.5);
  player.setRate(Number.NaN);
  assert.equal(player.rate, 1.5);
});

test('pause then resume restarts the current sentence', async () => {
  const h = harness([para('Uno.'), para('Due.')]);
  h.player.play();
  await h.advance();
  h.player.pause();
  await flush();
  assert.equal(h.player.state, 'paused');
  assert.equal(h.engine.stops, 1);
  assert.equal(h.engine.calls.length, 2);

  h.player.resume();
  await flush();
  assert.equal(h.player.state, 'playing');
  assert.equal(h.engine.calls.length, 3);
  assert.equal(h.engine.lastText, 'Due.');
});

test('play while paused resumes', () => {
  const h = harness([para('Uno.')]);
  h.player.play();
  h.player.pause();
  h.player.play();
  assert.equal(h.player.state, 'playing');
  assert.equal(h.engine.calls.length, 2);
});

test('a pause during the gap between blocks keeps the next sentence and speaks nothing late', async () => {
  let wake;
  const sleep = () =>
    new Promise((resolve) => {
      wake = resolve;
    });
  const h = harness([heading('Titolo'), para('Uno.')], { sleep });
  h.player.play();
  await h.advance();
  assert.equal(h.engine.calls.length, 1, 'waiting in the gap');
  h.player.pause();
  wake();
  await flush();
  assert.equal(h.engine.calls.length, 1, 'the expired gap does not speak');
  assert.deepEqual(h.player.current, { block: 1, sentence: 0 });
  h.player.resume();
  assert.equal(h.engine.lastText, 'Uno.');
});

test('next sentence crosses blocks, and past the last one it ends', async () => {
  const h = harness([para('Uno.', 'Due.'), para('Tre.')]);
  h.player.play();
  h.player.nextSentence();
  assert.equal(h.engine.lastText, 'Due.');
  h.player.nextSentence();
  assert.equal(h.engine.lastText, 'Tre.');
  const spoken = h.engine.calls.length;
  h.player.nextSentence();
  await flush();
  assert.equal(h.player.state, 'ended');
  assert.equal(h.engine.calls.length, spoken);
});

test('previous sentence crosses blocks, and on the first one it restarts', () => {
  const h = harness([para('Uno.', 'Due.'), para('Tre.')], { at: { block: 1, sentence: 0 } });
  h.player.play();
  h.player.prevSentence();
  assert.equal(h.engine.lastText, 'Due.');
  h.player.prevSentence();
  h.player.prevSentence();
  assert.equal(h.engine.lastText, 'Uno.');
  assert.deepEqual(h.player.current, { block: 0, sentence: 0 });
});

test('next and previous block go to the first sentence of the block', () => {
  const h = harness([para('Uno.', 'Due.'), para('Tre.', 'Quattro.'), para('Cinque.')], {
    at: { block: 1, sentence: 1 },
  });
  h.player.play();
  h.player.nextBlock();
  assert.equal(h.engine.lastText, 'Cinque.');
  h.player.prevBlock();
  assert.equal(h.engine.lastText, 'Tre.');
  h.player.prevBlock();
  assert.equal(h.engine.lastText, 'Uno.');
  h.player.prevBlock();
  assert.equal(h.engine.lastText, 'Uno.');
});

test('blocks without sentences are never landed on', () => {
  const h = harness([para('Uno.'), para(), para('Due.')]);
  h.player.play();
  h.player.nextBlock();
  assert.deepEqual(h.player.current, { block: 2, sentence: 0 });
  h.player.prevSentence();
  assert.deepEqual(h.player.current, { block: 0, sentence: 0 });
});

const sections = () => [
  heading('Intro', 1),
  para('Prima.'),
  heading('A', 2),
  para('Dentro A.'),
  heading('A1', 3),
  para('Dentro A1.'),
  heading('B', 2),
  para('Dentro B.'),
  heading('Altro', 1),
];

test('next section jumps to the next heading of a level not lower', () => {
  const h = harness(sections(), { at: { block: 3, sentence: 0 } });
  h.player.play();
  h.player.nextSection();
  assert.equal(h.engine.lastText, 'B', 'A1 is a subsection of A and is skipped');
  h.player.nextSection();
  assert.equal(h.engine.lastText, 'Altro', 'a higher level also ends the section');
});

test('next section before any heading goes to the first heading', () => {
  const h = harness([para('Prima.'), heading('A1', 3), heading('A', 2)]);
  h.player.play();
  h.player.nextSection();
  assert.equal(h.engine.lastText, 'A1');
});

test('next section with no more headings stops at the end', async () => {
  const h = harness([heading('Unica', 2), para('Uno.'), para('Due.')], { at: { block: 1, sentence: 0 } });
  h.player.play();
  const spoken = h.engine.calls.length;
  h.player.nextSection();
  await flush();
  assert.equal(h.player.state, 'ended');
  assert.equal(h.engine.calls.length, spoken);
  assert.equal(h.engine.stops, 1);
  assert.deepEqual(h.player.current, { block: 2, sentence: 0 });
});

test('previous section goes to the current heading, then to the one before', () => {
  const h = harness(sections(), { at: { block: 7, sentence: 0 } });
  h.player.play();
  h.player.prevSection();
  assert.equal(h.engine.lastText, 'B');
  h.player.prevSection();
  assert.equal(h.engine.lastText, 'A', 'A1 is a subsection and is skipped');
  h.player.prevSection();
  assert.equal(h.engine.lastText, 'Intro');
  h.player.prevSection();
  assert.equal(h.engine.lastText, 'Intro');
});

test('previous section before any heading goes to the start', () => {
  const h = harness([para('Uno.'), para('Due.'), heading('A')], { at: { block: 1, sentence: 0 } });
  h.player.play();
  h.player.prevSection();
  assert.equal(h.engine.lastText, 'Uno.');
});

test('jumpTo while playing moves there', async () => {
  const h = harness([para('Uno.'), para('Due.', 'Tre.'), para('Quattro.')]);
  h.player.play();
  h.player.jumpTo({ block: 1, sentence: 1 });
  await flush();
  assert.equal(h.engine.stops, 1);
  assert.equal(h.engine.lastText, 'Tre.');
  assert.deepEqual(h.player.current, { block: 1, sentence: 1 });
  await h.advance();
  assert.equal(h.engine.lastText, 'Quattro.', 'the old sentence does not move the reading');
  assert.equal(h.engine.calls.length, 3);
});

test('jumpTo while stopped moves without any audio', () => {
  const h = harness([para('Uno.'), para('Due.')]);
  h.player.jumpTo({ block: 1, sentence: 0 });
  assert.equal(h.player.state, 'idle');
  assert.equal(h.engine.calls.length, 0);
  assert.deepEqual(h.moves, [{ block: 1, sentence: 0 }]);
  h.player.play();
  assert.equal(h.engine.lastText, 'Due.');
});

test('moving while paused stays paused and resumes from there', async () => {
  const h = harness([para('Uno.'), para('Due.')]);
  h.player.play();
  h.player.pause();
  h.player.nextSentence();
  await flush();
  assert.equal(h.player.state, 'paused');
  assert.equal(h.engine.calls.length, 1);
  h.player.resume();
  assert.equal(h.engine.lastText, 'Due.');
});

test('engine error stops, reports once and keeps the position', async () => {
  const h = harness([para('Uno.'), para('Due.'), para('Tre.'), para('Quattro.')]);
  h.player.play();
  await h.advance();
  await h.advance();
  assert.equal(h.engine.lastText, 'Tre.');
  await h.advance('error');
  assert.equal(h.player.state, 'idle');
  assert.deepEqual(h.errors, [ERROR_ENGINE]);
  assert.deepEqual(h.player.current, { block: 2, sentence: 0 });
  assert.equal(h.engine.calls.length, 3);
});

test('an engine that rejects or throws counts as an engine error', async () => {
  const blocks = [para('Uno.'), para('Due.')];
  for (const speak of [() => Promise.reject(new Error('boom')), () => { throw new Error('boom'); }]) {
    const h = harness(blocks);
    h.engine.speak = speak;
    h.player.play();
    await flush();
    assert.equal(h.player.state, 'idle');
    assert.deepEqual(h.errors, [ERROR_ENGINE]);
    assert.deepEqual(h.player.current, { block: 0, sentence: 0 });
  }
});

test('a sentence stopped from outside goes idle without an error', async () => {
  const h = harness([para('Uno.'), para('Due.')]);
  h.player.play();
  await h.advance('stopped');
  assert.equal(h.player.state, 'idle');
  assert.deepEqual(h.errors, []);
  assert.equal(h.engine.calls.length, 1);
  assert.deepEqual(h.player.current, { block: 0, sentence: 0 });
});

test('no blocks: nothing to read, no speak call', async () => {
  for (const blocks of [[], [para(), para()]]) {
    const h = harness(blocks);
    h.player.play();
    await flush();
    assert.equal(h.engine.calls.length, 0);
    assert.deepEqual(h.errors, [ERROR_NOTHING_TO_READ]);
    assert.equal(h.player.state, 'idle');
    h.player.nextSentence();
    h.player.prevSection();
    assert.equal(h.player.state, 'idle');
  }
});

test('engine that never answers is stopped by a watchdog', async () => {
  const h = harness([para('Uno.'), para('Due.')]);
  h.player.play();
  const limit = speakWatchdogMs('Uno.', 1);
  mock.timers.tick(limit - 1);
  await flush();
  assert.equal(h.player.state, 'playing');
  assert.deepEqual(h.errors, []);

  mock.timers.tick(1);
  await flush();
  assert.equal(h.player.state, 'idle');
  assert.deepEqual(h.errors, [ERROR_ENGINE]);
  assert.deepEqual(h.player.current, { block: 0, sentence: 0 });
  assert.equal(h.engine.stops, 1, 'a late answer must not speak over what comes next');
  assert.equal(h.engine.calls.length, 1);
});

test('the watchdog grows with the length of the text and shrinks with the rate', () => {
  const long = 'x'.repeat(500);
  assert.ok(speakWatchdogMs('x', 1) >= SPEAK_WATCHDOG_MS);
  assert.ok(speakWatchdogMs(long, 1) > speakWatchdogMs('x', 1));
  assert.ok(speakWatchdogMs(long, 0.5) > speakWatchdogMs(long, 1));
  assert.ok(speakWatchdogMs(long, 3) < speakWatchdogMs(long, 1));
});

test('a sentence that answers in time is not hit by its watchdog', async () => {
  const h = harness([para('Uno.'), para('Due.')]);
  h.player.play();
  await h.advance();
  mock.timers.tick(speakWatchdogMs('Uno.', 1) - 1);
  await flush();
  assert.equal(h.player.state, 'playing');
  assert.equal(h.engine.lastText, 'Due.');
  assert.deepEqual(h.errors, []);
});

test('restarting a sentence does not leave the old watchdog running', async () => {
  const h = harness([para('Uno.')]);
  h.engine.stop = () => {};
  h.player.play();
  mock.timers.tick(speakWatchdogMs('Uno.', 1) - 1);
  h.player.setRate(MIN_RATE);
  await flush();
  mock.timers.tick(1);
  await flush();
  assert.equal(h.player.state, 'playing');
  assert.deepEqual(h.errors, []);
});

test('end of file stops and does not open another file', async () => {
  const h = harness([heading('Titolo'), para('Uno.')], { auto: true });
  h.player.play();
  await flush();
  assert.equal(h.player.state, 'ended');
  assert.deepEqual(h.states, ['playing', 'ended']);
  assert.deepEqual(h.engine.calls.map((c) => c.text), ['Titolo', 'Uno.']);
  assert.deepEqual(h.player.current, { block: 1, sentence: 0 });
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.log.at(-1), 'Uno.', 'no pause after the last sentence');
});

test('play after the end starts again from the beginning', async () => {
  const h = harness([para('Uno.'), para('Due.')], { auto: true });
  h.player.play();
  await flush();
  h.engine.calls.length = 0;
  h.player.play();
  await flush();
  assert.deepEqual(h.engine.calls.map((c) => c.text), ['Uno.', 'Due.']);
});

test('moving back after the end stays stopped and plays from there', async () => {
  const h = harness([para('Uno.'), para('Due.')], { auto: true });
  h.player.play();
  await flush();
  h.engine.calls.length = 0;
  h.player.prevSentence();
  assert.equal(h.player.state, 'idle');
  assert.equal(h.engine.calls.length, 0);
  h.player.play();
  await flush();
  assert.deepEqual(h.engine.calls.map((c) => c.text), ['Uno.', 'Due.']);
});

test('stop keeps the position and silences the engine', async () => {
  const h = harness([para('Uno.'), para('Due.')]);
  h.player.play();
  await h.advance();
  h.player.stop();
  await flush();
  assert.equal(h.player.state, 'idle');
  assert.equal(h.engine.stops, 1);
  assert.deepEqual(h.player.current, { block: 1, sentence: 0 });
  assert.equal(h.engine.calls.length, 2);
  assert.deepEqual(h.errors, []);
});

test('load starts from a saved position and keeps it inside the document', () => {
  const blocks = [para('Uno.', 'Due.'), para(), para('Tre.')];
  const at = (position) => harness(blocks, { at: position }).player.current;
  assert.deepEqual(at(undefined), { block: 0, sentence: 0 });
  assert.deepEqual(at({ block: 0, sentence: 1 }), { block: 0, sentence: 1 });
  assert.deepEqual(at({ block: 0, sentence: 9 }), { block: 0, sentence: 1 });
  assert.deepEqual(at({ block: 1, sentence: 0 }), { block: 2, sentence: 0 });
  assert.deepEqual(at({ block: 9, sentence: 9 }), { block: 2, sentence: 0 });
  assert.deepEqual(at({ block: -1, sentence: -1 }), { block: 0, sentence: 0 });
});

test('load while playing silences the old document', async () => {
  const h = harness([para('Uno.')]);
  h.player.play();
  h.player.load([para('Altro.')]);
  await flush();
  assert.equal(h.player.state, 'idle');
  assert.equal(h.engine.stops, 1);
  assert.equal(h.engine.calls.length, 1);
  assert.deepEqual(h.player.current, { block: 0, sentence: 0 });
});

test('voice and language reach the engine, and a new voice restarts the sentence', async () => {
  const h = harness([para('Uno.')]);
  h.player.setLang('it');
  h.player.setVoice('elsa');
  h.player.play();
  assert.deepEqual(h.engine.calls.at(-1), { text: 'Uno.', voiceId: 'elsa', rate: 1, lang: 'it' });
  h.player.setVoice('cosimo');
  await flush();
  assert.equal(h.engine.calls.length, 2);
  assert.equal(h.engine.calls.at(-1).voiceId, 'cosimo');
});

test('onSentence reports the position and the sentence with its place in the DOM', () => {
  const node = {};
  const sentence = { text: 'Uno.', start: { node, offset: 0 }, end: { node, offset: 4 } };
  const seen = [];
  const player = new SpeechPlayer({
    engine: fakeEngine(),
    onSentence: (position, current) => seen.push([position, current]),
  });
  player.load([{ kind: 'para', line: 3, sentences: [sentence] }]);
  player.play();
  assert.deepEqual(seen, [[{ block: 0, sentence: 0 }, sentence]]);
});

test('a callback that stops the player keeps the sentence from being spoken', () => {
  const engine = fakeEngine();
  const player = new SpeechPlayer({ engine, onSentence: () => player.stop() });
  player.load([para('Uno.')]);
  player.play();
  assert.equal(player.state, 'idle');
  assert.equal(engine.calls.length, 0);
});
