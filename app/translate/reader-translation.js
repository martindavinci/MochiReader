// SPDX-License-Identifier: GPL-3.0-or-later
// The translation of the book open in a tab: which language is the main one, what the sections on screen show, and
// when the voice may read them. The book is translated only once Tradotto has been chosen for it.
import { applyTranslation, markPending, setMain as styleDoc } from './bilingual.js';
import { CancelledError, createBookTranslation } from './book.js';
import { modelsFor, versionFor } from './models.js';

const ORIGINAL = 'original';
const TRANSLATED = 'translated';

const languageOf = (tag) => (tag ? String(tag).toLowerCase().split(/[-_]/)[0] : null);

/**
 * @param {{key: string, sourceLang: string|null, target: string, layout: string, fixedLayout: boolean,
 *   sections: number, shown: () => {doc: Document, index: number}[], sourceOf: (index: number) => Promise<Document>,
 *   invoke: (command: string, args?: object) => Promise<*>, makeEngine: () => object, pendingText: string}} options
 */
export function createReaderTranslation({
  key, sourceLang, target, layout, fixedLayout, sections, shown, sourceOf, invoke, makeEngine, pendingText,
}) {
  const from = languageOf(sourceLang);
  const to = languageOf(target);
  const available = Boolean(from && to && from !== to && !fixedLayout);
  const changeCallbacks = [];
  const progressCallbacks = [];
  let main = null;
  let currentLayout = layout;
  let book = null;
  let closed = false;

  const style = (doc) => styleDoc(doc, main ?? ORIGINAL, currentLayout);
  const shownDocs = () => shown().filter(({ doc }) => doc?.body);

  /** Puts the translation of `index` into `doc` once there is one; with Tradotto main it is asked for at once. */
  const fill = async (doc, index) => {
    if (!book) return;
    const waiting = main === TRANSLATED && !book.known(index);
    if (waiting) markPending(doc, pendingText);
    try {
      const texts = waiting ? await book.ready(index) : await book.cached(index);
      if (texts) applyTranslation(doc, texts, { lang: to });
    } catch (error) {
      if (!(error instanceof CancelledError)) throw error;
    } finally {
      if (waiting) markPending(doc, null);
      style(doc);
    }
  };

  const ensureBook = async () => {
    if (book) return book;
    const { pairs } = await invoke('tr_catalog');
    const ids = modelsFor(from, to, pairs);
    if (!ids) throw new Error(`no translation from ${from} to ${to}`);
    const version = versionFor(ids, pairs);
    if (closed) throw new CancelledError(key);
    book = createBookTranslation({ key, from, to, version, sections, sourceOf, engine: makeEngine(), invoke });
    // A chapter done in the background shows in the sections on screen that wait for it. With Originale it waits for
    // the section to load again: wrapping the text the voice may be reading would lose its place.
    book.onProgress((progress) => {
      if (main === TRANSLATED) shownDocs().forEach(({ doc, index }) => fill(doc, index).catch(() => {}));
      progressCallbacks.forEach((callback) => callback(progress));
    });
    book.start();
    return book;
  };

  const refreshShown = () => shownDocs().forEach(({ doc, index }) => {
    style(doc);
    fill(doc, index).catch(() => {});
  });

  return {
    available,
    main: () => main,
    /** The language to read in, when it is not the book's. */
    lang: () => (main === TRANSLATED ? target : null),
    /** As saved for the book; a pair whose models were removed stays untranslated. */
    async restore() {
      if (!available) return;
      const saved = await invoke('state_get_translation', { key });
      if (saved !== ORIGINAL && saved !== TRANSLATED) return;
      try {
        await ensureBook();
      } catch {
        return;
      }
      main = saved;
      refreshShown();
    },
    /** @throws {import('./models.js').MissingModelsError} With Tradotto, when a model is not downloaded. */
    async setMain(next) {
      if (!available) throw new Error('this book cannot be translated');
      if (next === TRANSLATED) await ensureBook();
      main = next;
      await invoke('state_set_translation', { key, main });
      refreshShown();
      changeCallbacks.forEach((callback) => callback(main));
    },
    setLayout(name) {
      currentLayout = name;
      shownDocs().forEach(({ doc }) => style(doc));
    },
    sectionLoaded(doc, index) {
      style(doc);
      return fill(doc, index);
    },
    /** Resolves once the sections on screen have their translation, if the voice is to read it. */
    async speechReady() {
      if (main !== TRANSLATED || !book) return;
      await Promise.all(shownDocs().map(({ doc, index }) => fill(doc, index)));
    },
    want: (index) => book?.want(index),
    progress: () => book?.progress() ?? null,
    onProgress: (callback) => progressCallbacks.push(callback),
    onChange: (callback) => changeCallbacks.push(callback),
    close() {
      closed = true;
      book?.close();
    },
  };
}
