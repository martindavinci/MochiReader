// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { SAVE_DEBOUNCE_MS, debounce, lineFromSourcepos, nearestBlock } from '../app/core/position.js';

test('the save delay is the one in the spec', () => assert.equal(SAVE_DEBOUNCE_MS, 500));

test('line is taken from data-sourcepos', () => assert.equal(lineFromSourcepos('12:1-14:3'), 12));

test('a missing or malformed data-sourcepos gives line 0', () => {
  assert.equal(lineFromSourcepos(null), 0);
  assert.equal(lineFromSourcepos(undefined), 0);
  assert.equal(lineFromSourcepos(''), 0);
  assert.equal(lineFromSourcepos('abc'), 0);
});

test('an exact line returns its block', () => assert.equal(nearestBlock([1, 5, 9], 5), 1));

test('a line past the end goes to the nearest block', () => assert.equal(nearestBlock([1, 5, 9], 100), 2));

test('a line before the start goes to the first block', () => assert.equal(nearestBlock([3, 5, 9], 1), 0));

test('a line between two blocks goes to the closer one', () => {
  assert.equal(nearestBlock([1, 5, 9], 6), 1);
  assert.equal(nearestBlock([1, 5, 9], 8), 2);
});

test('a tie goes to the earlier block, so no text is skipped', () => {
  assert.equal(nearestBlock([1, 5, 9], 7), 1);
});

test('no blocks gives -1', () => assert.equal(nearestBlock([], 3), -1));

test('debounce runs once, after the last call, with the last arguments', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const save = debounce((...args) => calls.push(args), SAVE_DEBOUNCE_MS);
  save(1);
  t.mock.timers.tick(SAVE_DEBOUNCE_MS - 1);
  save(2, 'x');
  t.mock.timers.tick(SAVE_DEBOUNCE_MS - 1);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [[2, 'x']]);
  t.mock.timers.tick(SAVE_DEBOUNCE_MS * 2);
  assert.equal(calls.length, 1);
});

test('debounce can run again after it fired', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const save = debounce(() => { count += 1; }, SAVE_DEBOUNCE_MS);
  save();
  t.mock.timers.tick(SAVE_DEBOUNCE_MS);
  save();
  t.mock.timers.tick(SAVE_DEBOUNCE_MS);
  assert.equal(count, 2);
});

test('cancel drops a pending call, so a closed tab saves nothing late', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const save = debounce(() => { count += 1; }, SAVE_DEBOUNCE_MS);
  save();
  save.cancel();
  t.mock.timers.tick(SAVE_DEBOUNCE_MS * 2);
  assert.equal(count, 0);
});
