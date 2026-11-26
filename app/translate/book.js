// SPDX-License-Identifier: GPL-3.0-or-later
// The translation of one book, a chapter at a time: first the one on screen, then the one the voice will need next,
// then the rest in book order. Every chapter done is kept on disk, so a book is translated only once.
import { blockSources, translatableBlocks } from './bilingual.js';

/** The book was closed before the chapter asked for was translated. */
export class CancelledError extends Error {}

/**
 * @param {{key: string, from: string, to: string, version: string, sections: number,
 *   sourceOf: (index: number) => Promise<Document>,
 *   engine: {translate: (from: string, to: string, htmls: string[]) => Promise<string[]>, close: () => Promise<void>},
 *   invoke: (command: string, args?: object) => Promise<*>}} options
 *   `version` names the models used (two joined by `+` when the pair goes through English). `sourceOf` gives the
 *   document of a section as the book has it, whether or not it is on screen.
 */
export function createBookTranslation({ key, from, to, version, sections, sourceOf, engine, invoke }) {
  const pair = `${from}-${to}`;
  const where = { key, pair, version };
  const memory = new Map();
  const done = new Set();
  const failed = new Set();
  const waiters = new Map();
  const asked = [];
  const wanted = [];
  const progressCallbacks = [];
  let started = false;
  let running = false;
  let closed = false;

  const progress = () => ({ done: done.size, total: sections });

  const settle = (index, texts) => {
    memory.set(index, texts);
    done.add(index);
    failed.delete(index);
    (waiters.get(index) ?? []).forEach(({ resolve }) => resolve(texts));
    waiters.delete(index);
    progressCallbacks.forEach((callback) => callback(progress()));
  };

  const fail = (index, error) => {
    failed.add(index);
    (waiters.get(index) ?? []).forEach(({ reject }) => reject(error));
    waiters.delete(index);
  };

  const translate = async (index) => {
    const doc = await sourceOf(index);
    const blocks = translatableBlocks(doc.body);
    const texts = blocks.length === 0 ? [] : await engine.translate(from, to, blockSources(blocks));
    if (closed) return null;
    await invoke('tr_cache_put', { ...where, section: index, texts });
    return texts;
  };

  const next = () => {
    for (const queue of [asked, wanted]) {
      while (queue.length > 0) {
        const index = queue.shift();
        if (!done.has(index)) return index;
      }
    }
    if (!started) return null;
    for (let index = 0; index < sections; index += 1) {
      if (!done.has(index) && !failed.has(index)) return index;
    }
    return null;
  };

  const pump = async () => {
    if (running) return;
    running = true;
    try {
      for (let index = next(); index !== null && !closed; index = next()) {
        try {
          const texts = await translate(index);
          if (closed) break;
          settle(index, texts);
        } catch (error) {
          if (!closed) fail(index, error);
        }
      }
    } finally {
      running = false;
    }
  };

  const cached = async (index) => {
    if (memory.has(index)) return memory.get(index);
    const texts = await invoke('tr_cache_get', { ...where, section: index });
    if (texts && !closed) {
      memory.set(index, texts);
      done.add(index);
    }
    return texts ?? null;
  };

  return {
    cached,
    /** Whether the section is translated, on disk or here: known without waiting. */
    known: (index) => done.has(index),
    async ready(index) {
      if (closed) throw new CancelledError(pair);
      const texts = await cached(index);
      if (texts) return texts;
      if (closed) throw new CancelledError(pair);
      const promise = new Promise((resolve, reject) => {
        waiters.set(index, [...(waiters.get(index) ?? []), { resolve, reject }]);
      });
      asked.unshift(index);
      pump();
      return promise;
    },
    want(index) {
      if (closed || index < 0 || index >= sections || done.has(index) || wanted.includes(index)) return;
      wanted.push(index);
      pump();
    },
    async start() {
      if (started || closed) return;
      const known = await invoke('tr_cache_sections', where);
      known.forEach((index) => done.add(index));
      started = true;
      pump();
    },
    progress,
    onProgress: (callback) => progressCallbacks.push(callback),
    close() {
      if (closed) return;
      closed = true;
      for (const [, list] of waiters) list.forEach(({ reject }) => reject(new CancelledError(pair)));
      waiters.clear();
      engine.close().catch(() => {});
    },
  };
}
