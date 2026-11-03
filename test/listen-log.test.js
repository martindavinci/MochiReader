// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DELAY_MS, listenVerdict, readListenLog } from '../tools/listen-log.mjs';

const line = (at, event, chars = 20) => JSON.stringify({ at, event, chars });

test('the delay is the time from the end of a sentence to the start of the next', () => {
  const report = readListenLog([
    line(1000, 'start'), line(3000, 'end'),
    line(3300, 'start'), line(5000, 'end'),
    line(5900, 'start'), line(7000, 'end'),
  ].join('\n'));
  assert.equal(report.sentences, 3);
  assert.equal(report.ended, 3);
  assert.deepEqual(report.errors, []);
  assert.equal(report.medianDelayMs, 600);
  assert.equal(report.maxDelayMs, 900);
  assert.equal(report.delaysOver1s, 0);
  assert.equal(report.minutes, 0.1);
});

test('errors are listed, while the cuts of the voice stopping on purpose are not errors', () => {
  const report = readListenLog([
    line(0, 'start'), line(1000, 'error:synthesis-failed'),
    line(2000, 'start'), line(3000, 'error:canceled'), line(3100, 'error:interrupted'),
  ].join('\n'));
  assert.deepEqual(report.errors, ['synthesis-failed']);
});

test('the wait for a new start from the test itself is no delay', () => {
  const report = readListenLog([
    line(0, 'start'), line(1000, 'end'), line(9000, 'restart'), line(9500, 'start'), line(10000, 'end'),
  ].join('\n'));
  assert.equal(report.maxDelayMs, 0);
  assert.equal(report.restarts, 1);
});

test('a sentence that started and never ended counts, and half a line at the end is left out', () => {
  const report = readListenLog(`${line(0, 'start')}\n${line(1000, 'end')}\n${line(1200, 'start')}\n{"at":13`);
  assert.equal(report.sentences, 2);
  assert.equal(report.ended, 1);
  assert.equal(report.unfinished, 1);
});

test('a log with nothing in it says so', () => {
  const report = readListenLog('');
  assert.equal(report.sentences, 0);
  assert.equal(report.maxDelayMs, 0);
  assert.equal(report.medianDelayMs, 0);
  assert.equal(report.minutes, 0);
});

const GOOD = { sentences: 100, ended: 100, unfinished: 0, errors: [], maxDelayMs: MAX_DELAY_MS - 1, minutes: 30 };

test('a run passes with no errors, every delay under a second and the whole time read', () => {
  assert.deepEqual(listenVerdict(GOOD, 30), []);
});

test('a run fails for each thing it missed, and says which', () => {
  assert.equal(listenVerdict({ ...GOOD, errors: ['x'] }, 30).length, 1);
  assert.equal(listenVerdict({ ...GOOD, maxDelayMs: MAX_DELAY_MS }, 30).length, 1);
  assert.equal(listenVerdict({ ...GOOD, minutes: 28.9 }, 30).length, 1);
  assert.equal(listenVerdict({ ...GOOD, sentences: 0, ended: 0 }, 30).length, 1);
  assert.equal(listenVerdict({ ...GOOD, unfinished: 2 }, 30).length, 1);
});

test('the sentence being read when the time ran out is not one that failed', () => {
  assert.deepEqual(listenVerdict({ ...GOOD, unfinished: 1 }, 30), []);
});
