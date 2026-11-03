// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaKeys, MEDIA_PRESS_WINDOW_MS, silentWav } from '../app/speech/media-keys.js';

beforeEach(() => mock.timers.enable({ apis: ['Date'], now: 1000 }));
afterEach(() => mock.timers.reset());

function setup({ playFails = false } = {}) {
  const handlers = new Map();
  const session = {
    playbackState: 'none',
    metadata: null,
    setActionHandler: (action, handler) => {
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
    },
  };
  const audio = {
    paused: true,
    loop: false,
    src: '',
    play() {
      if (playFails) return Promise.reject(new Error('not allowed'));
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    load() {},
    removeAttribute(name) {
      this[name] = '';
    },
  };
  const presses = [];
  const keys = createMediaKeys({
    mediaSession: session,
    makeAudio: () => audio,
    makeSilenceUrl: () => 'blob:silence',
    releaseUrl: (url) => {
      audio.released = url;
    },
    makeMetadata: (data) => data,
    onPress: (action) => presses.push(action),
  });
  return { keys, session, audio, handlers, presses };
}

test('silence is a real WAV file of silence, long enough to be taken for media', () => {
  const wav = silentWav();
  const view = new DataView(wav);
  const text = (from, to) => String.fromCharCode(...new Uint8Array(wav.slice(from, to)));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 12), 'WAVE');
  assert.equal(text(36, 40), 'data');
  assert.equal(view.getUint32(4, true), wav.byteLength - 8);
  assert.equal(view.getUint32(40, true), wav.byteLength - 44);
  assert.ok(new Uint8Array(wav.slice(44)).every((sample) => sample === 128));
  assert.ok(view.getUint32(40, true) / view.getUint32(28, true) >= 2);
});

test('while reading, the silent audio really plays and the handlers are in place', async () => {
  const { keys, audio, session, handlers } = setup();
  keys.playing('2026-10-30.md');
  assert.equal(audio.paused, false);
  assert.equal(audio.loop, true);
  assert.equal(audio.src, 'blob:silence');
  assert.equal(session.playbackState, 'playing');
  assert.equal(session.metadata.title, '2026-10-30.md');
  assert.deepEqual([...handlers.keys()].sort(), ['nexttrack', 'pause', 'play', 'previoustrack']);
});

test('in a pause the audio is really paused, or Windows would never offer play again', () => {
  const { keys, audio, session } = setup();
  keys.playing('a');
  keys.paused();
  assert.equal(audio.paused, true);
  assert.equal(session.playbackState, 'paused');
  keys.playing('a');
  assert.equal(audio.paused, false);
  assert.equal(session.playbackState, 'playing');
});

test('stopping gives up the session and the audio', () => {
  const { keys, audio, session, handlers } = setup();
  keys.playing('a');
  keys.stopped();
  assert.equal(audio.paused, true);
  assert.equal(audio.src, '');
  assert.equal(audio.released, 'blob:silence');
  assert.equal(session.playbackState, 'none');
  assert.equal(session.metadata, null);
  assert.equal(handlers.size, 0);
});

test('audio that refuses to play is no reason to stop reading', async () => {
  const { keys } = setup({ playFails: true });
  const warn = mock.method(console, 'warn', () => {});
  keys.playing('a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warn.mock.callCount(), 1);
  warn.mock.restore();
});

test('the actions of Windows reach the reading', () => {
  const { keys, handlers, presses } = setup();
  keys.playing('a');
  handlers.get('pause')();
  mock.timers.tick(MEDIA_PRESS_WINDOW_MS + 1);
  handlers.get('play')();
  mock.timers.tick(MEDIA_PRESS_WINDOW_MS + 1);
  handlers.get('nexttrack')();
  mock.timers.tick(MEDIA_PRESS_WINDOW_MS + 1);
  handlers.get('previoustrack')();
  assert.deepEqual(presses, ['speech.toggle', 'speech.toggle', 'speech.nextSentence', 'speech.prevSentence']);
});

for (const [name, first, second] of [
  ['the key before the action', 'key', 'action'],
  ['the action before the key', 'action', 'key'],
]) {
  test(`one press counts once with ${name}`, () => {
    const { keys, handlers, presses } = setup();
    keys.playing('a');
    const from = { key: () => keys.pressKey('speech.toggle'), action: () => handlers.get('pause')() };
    from[first]();
    mock.timers.tick(MEDIA_PRESS_WINDOW_MS - 1);
    from[second]();
    assert.deepEqual(presses, ['speech.toggle']);
  });
}

test('only the other way in can repeat a press: two quick presses of one kind both count', () => {
  const { keys, handlers, presses } = setup();
  keys.playing('a');
  handlers.get('nexttrack')();
  handlers.get('nexttrack')();
  keys.pressKey('speech.prevSentence');
  assert.deepEqual(presses, ['speech.nextSentence', 'speech.nextSentence', 'speech.prevSentence']);
});

test('later than the window, the same action from the other way is a new press', () => {
  const { keys, handlers, presses } = setup();
  keys.playing('a');
  handlers.get('pause')();
  mock.timers.tick(MEDIA_PRESS_WINDOW_MS + 1);
  keys.pressKey('speech.toggle');
  assert.deepEqual(presses, ['speech.toggle', 'speech.toggle']);
});

test('a page with no media session reads all the same', () => {
  const keys = createMediaKeys({
    mediaSession: undefined,
    makeAudio: () => ({ play: async () => {}, pause() {}, load() {}, removeAttribute() {} }),
    makeSilenceUrl: () => 'x',
    releaseUrl: () => {},
    makeMetadata: (data) => data,
    onPress: () => {},
  });
  assert.doesNotThrow(() => {
    keys.playing('a');
    keys.paused();
    keys.stopped();
  });
});
