// SPDX-License-Identifier: GPL-3.0-or-later
// What a run of tools/listen-test.ps1 heard, from the log the page writes: one JSON line for each thing the voice did.
//   node tools/listen-log.mjs <log> <minutes>     prints the report and what it missed as JSON
import { readFileSync } from 'node:fs';
import { isEntryPoint } from './is-entry-point.mjs';

/** The target of the plan: from the end of a sentence to the start of the next, pause included. */
export const MAX_DELAY_MS = 1000;
const MS_PER_MINUTE = 60_000;
const MINUTES_DECIMALS = 2;
const ERROR_PREFIX = 'error:';
// What the voice says when it was told to stop. The player gives no sound for these.
const CUTS = new Set(['canceled', 'interrupted']);
// A run is cut when its time is over, which is most likely in the middle of a sentence.
const UNFINISHED_AT_THE_END = 1;
// The log stops at the last thing the voice did, up to one long sentence before the time was over.
const MINUTES_MARGIN = 1;

function parseLine(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Written as it came: a process that ended can leave half a line.
    return null;
  }
}

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * @param {string} text The log.
 * @returns {{sentences: number, ended: number, unfinished: number, restarts: number, errors: string[], medianDelayMs: number,
 *   maxDelayMs: number, delaysOver1s: number, minutes: number}}
 */
export function readListenLog(text) {
  const events = text.split('\n').map(parseLine).filter(Boolean);
  const delays = [];
  const errors = [];
  let sentences = 0;
  let ended = 0;
  let restarts = 0;
  let lastEnd = null;
  let open = false;
  for (const { at, event } of events) {
    if (event === 'start') {
      sentences += 1;
      if (lastEnd !== null) delays.push(at - lastEnd);
      lastEnd = null;
      open = true;
    } else if (event === 'end') {
      ended += 1;
      lastEnd = at;
      open = false;
    } else if (event === 'restart') {
      restarts += 1;
      lastEnd = null;
    } else if (event.startsWith(ERROR_PREFIX)) {
      const kind = event.slice(ERROR_PREFIX.length);
      if (!CUTS.has(kind)) errors.push(kind);
      lastEnd = null;
      open = false;
    }
  }
  const span = events.length === 0 ? 0 : events.at(-1).at - events[0].at;
  return {
    sentences,
    ended,
    unfinished: open ? 1 : 0,
    restarts,
    errors,
    medianDelayMs: median(delays),
    maxDelayMs: Math.max(0, ...delays),
    delaysOver1s: delays.filter((delay) => delay >= MAX_DELAY_MS).length,
    minutes: Number((span / MS_PER_MINUTE).toFixed(MINUTES_DECIMALS)),
  };
}

/**
 * @param {ReturnType<typeof readListenLog>} report
 * @param {number} minutes How long the run was meant to read.
 * @returns {string[]} What the run missed: nothing means it passed.
 */
export function listenVerdict({ sentences, unfinished, errors, maxDelayMs, minutes: read }, minutes) {
  const missed = [];
  if (sentences === 0) missed.push('nothing was read');
  if (errors.length > 0) missed.push(`voice errors: ${errors.join(', ')}`);
  if (maxDelayMs >= MAX_DELAY_MS) missed.push(`a delay of ${maxDelayMs} ms, against ${MAX_DELAY_MS} ms`);
  if (read < minutes - MINUTES_MARGIN) missed.push(`read for ${read} minutes of ${minutes}`);
  if (unfinished > UNFINISHED_AT_THE_END) missed.push(`${unfinished} sentences never ended`);
  return missed;
}

if (isEntryPoint(import.meta.url)) {
  const report = readListenLog(readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify({ ...report, missed: listenVerdict(report, Number(process.argv[3])) }));
}
