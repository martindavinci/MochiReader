// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { catalogLanguage, MissingModelsError, modelsFor, versionFor } from '../app/translate/models.js';
import { createReaderTranslation } from '../app/translate/reader-translation.js';
import { TR_ATTR } from '../app/translate/marks.js';

const PAIRS = [
  { id: 'en-it', from: 'en', to: 'it', installed: '2.1' },
  { id: 'fr-en', from: 'fr', to: 'en', installed: '2.0' },
  { id: 'en-de', from: 'en', to: 'de', installed: null },
];

test('modelsFor a pair without a direct model asks for both halves through English', () => {
  assert.deepEqual(modelsFor('en', 'it', PAIRS), ['en-it']);
  assert.deepEqual(modelsFor('fr', 'it', PAIRS), ['fr-en', 'en-it']);
  assert.deepEqual(modelsFor('fr', 'de', PAIRS), ['fr-en', 'en-de']);
  assert.equal(modelsFor('xx', 'it', PAIRS), null);
});

test('a language as a book or the options name it becomes the language as the models name it', () => {
  assert.equal(catalogLanguage('eng'), 'en');
  assert.equal(catalogLanguage('English'), 'en');
  assert.equal(catalogLanguage('it-IT'), 'it');
  assert.equal(catalogLanguage('pt-BR'), 'pt');
  assert.equal(catalogLanguage('zh-CN'), 'zh-Hans');
  assert.equal(catalogLanguage('zh-Hans'), 'zh-Hans');
  assert.equal(catalogLanguage('zh-TW'), 'zh-Hant');
  assert.equal(catalogLanguage('und'), null);
  assert.equal(catalogLanguage(null), null);
});

test('a book that names its language in three letters translates', async () => {
  const translation = createReaderTranslation({
    key: 'k', sourceLang: 'eng', target: 'it', layout: 'single', fixedLayout: false, sections: 1,
    shown: () => [], sourceOf: async () => docOf('<p>x</p>'),
    invoke: async (command) => (command === 'tr_catalog' ? { pairs: PAIRS } : command === 'tr_cache_sections' ? [] : null),
    makeEngine: () => ({ translate: async (f, t, h) => h, close: async () => {} }), pendingText: '',
  });
  await translation.setMain('translated');
  assert.equal(translation.main(), 'translated');
  translation.close();
});

test('a book translation that cannot start is quiet: the page stays in its language', async () => {
  const translation = createReaderTranslation({
    key: 'k', sourceLang: 'en', target: 'it', layout: 'single', fixedLayout: false, sections: 1,
    shown: () => [], sourceOf: async () => docOf('<p>x</p>'),
    invoke: async (command) => {
      if (command === 'tr_catalog') return { pairs: PAIRS };
      if (command === 'state_get_translation') return 'translated';
      if (command === 'tr_cache_sections') throw new Error('refused');
      return null;
    },
    makeEngine: () => ({ translate: async (f, t, h) => h, close: async () => {} }), pendingText: '',
  });
  await translation.restore();
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  translation.close();
});

test('versionFor joins the installed versions and refuses a missing model', () => {
  assert.equal(versionFor(['fr-en', 'en-it'], PAIRS), '2.0+2.1');
  assert.throws(() => versionFor(['en-de'], PAIRS), (error) => error instanceof MissingModelsError
    && error.missing.join() === 'en-de');
});

const docOf = (html) => parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`).document;
const SECTIONS = ['<p>Zero.</p>', '<p>One.</p>'];

function fakes({ saved = null, cached = {} } = {}) {
  const state = new Map(saved ? [['epub:k', saved]] : []);
  const store = new Map(Object.entries(cached).map(([k, v]) => [Number(k), v]));
  const invoke = async (command, args) => {
    switch (command) {
      case 'tr_catalog': return { pairs: PAIRS };
      case 'state_get_translation': return state.get(args.key) ?? null;
      case 'state_set_translation': state.set(args.key, args.main); return null;
      case 'tr_cache_get': return store.get(args.section) ?? null;
      case 'tr_cache_put': store.set(args.section, args.texts); return null;
      case 'tr_cache_sections': return [...store.keys()];
      default: throw new Error(`unexpected ${command}`);
    }
  };
  const shown = [{ doc: docOf(SECTIONS[0]), index: 0 }];
  const engines = [];
  const makeEngine = () => {
    const engine = {
      closed: false,
      translate: async (from, to, htmls) => htmls.map((h) => `${to}:${h}`),
      close: async () => { engine.closed = true; },
    };
    engines.push(engine);
    return engine;
  };
  const translation = createReaderTranslation({
    key: 'epub:k', sourceLang: 'en', target: 'it', layout: 'single', fixedLayout: false, sections: SECTIONS.length,
    shown: () => shown, sourceOf: async (index) => docOf(SECTIONS[index]), invoke, makeEngine, pendingText: 'Traduzione…',
  });
  return { translation, state, store, shown, engines };
}

const text = (doc) => doc.body.querySelector(`[${TR_ATTR}]:not([data-mochi-pending])`)?.textContent ?? null;

test('a book never translated has no main language and the book language reads', async () => {
  const { translation } = fakes();
  await translation.restore();
  assert.equal(translation.available, true);
  assert.equal(translation.main(), null);
  assert.equal(translation.lang(), null);
});

test('Tradotto saves the main language, translates the shown section and gives the target language', async () => {
  const { translation, state, shown } = fakes();
  await translation.setMain('translated');
  assert.equal(state.get('epub:k'), 'translated');
  assert.equal(translation.lang(), 'it');
  await translation.speechReady();
  assert.equal(text(shown[0].doc), 'it:Zero.');
  assert.equal(shown[0].doc.documentElement.getAttribute('data-mochi-main'), 'translated');
});

test('a section loaded with a cached translation shows it at once', async () => {
  const { translation } = fakes({ saved: 'translated', cached: { 1: ['it:One.'] } });
  await translation.restore();
  const doc = docOf(SECTIONS[1]);
  await translation.sectionLoaded(doc, 1);
  assert.equal(text(doc), 'it:One.');
});

test('a section not translated yet shows the pending note until its translation lands', async () => {
  const { translation } = fakes({ saved: 'translated' });
  await translation.restore();
  const doc = docOf(SECTIONS[1]);
  const landing = translation.sectionLoaded(doc, 1);
  await Promise.resolve();
  assert.equal(doc.querySelector('[data-mochi-pending]')?.textContent, 'Traduzione…');
  await landing;
  assert.equal(doc.querySelector('[data-mochi-pending]'), null);
  assert.equal(text(doc), 'it:One.');
});

test('Originale keeps the translation and its cache, and the book language reads again', async () => {
  const { translation, state, store, shown } = fakes();
  await translation.setMain('translated');
  await translation.speechReady();
  await translation.setMain('original');
  assert.equal(state.get('epub:k'), 'original');
  assert.equal(translation.lang(), null);
  assert.ok(store.has(0));
  assert.equal(text(shown[0].doc), 'it:Zero.');
  assert.equal(shown[0].doc.documentElement.getAttribute('data-mochi-main'), 'original');
});

test('Tradotto with a model missing is refused with the models to download', async () => {
  const saved = [];
  const german = createReaderTranslation({
    key: 'epub:k', sourceLang: 'en', target: 'de', layout: 'single', fixedLayout: false, sections: 1,
    shown: () => [], sourceOf: async () => docOf(''),
    invoke: async (command, args) => {
      if (command === 'state_set_translation') saved.push(args);
      return command === 'tr_catalog' ? { pairs: PAIRS } : null;
    },
    makeEngine: () => { throw new Error('no engine without a model'); }, pendingText: '',
  });
  await assert.rejects(german.setMain('translated'), (error) => error instanceof MissingModelsError
    && error.missing.join() === 'en-de');
  assert.equal(german.main(), null);
  assert.deepEqual(saved, []);
});

test('no switch for a fixed layout or a book already in the target language', () => {
  const base = { key: 'k', target: 'it', layout: 'single', sections: 1, shown: () => [], sourceOf: async () => null,
    invoke: async () => null, makeEngine: () => null, pendingText: '' };
  assert.equal(createReaderTranslation({ ...base, sourceLang: 'en', fixedLayout: true }).available, false);
  assert.equal(createReaderTranslation({ ...base, sourceLang: 'it-IT', fixedLayout: false }).available, false);
  assert.equal(createReaderTranslation({ ...base, sourceLang: null, fixedLayout: false }).available, false);
});

test('the layout changes every shown section at once', async () => {
  const { translation, shown } = fakes();
  await translation.setMain('translated');
  translation.setLayout('columns');
  assert.equal(shown[0].doc.documentElement.getAttribute('data-mochi-layout'), 'columns');
});

test('close stops the book translation and frees its engine', async () => {
  const { translation, engines } = fakes();
  await translation.setMain('translated');
  translation.close();
  assert.equal(engines[0].closed, true);
});

test('restore tells onChange the main language saved for the book', async () => {
  const { translation } = fakes({ saved: 'translated' });
  const heard = [];
  translation.onChange((main) => heard.push(main));
  await translation.restore();
  assert.deepEqual(heard, ['translated']);
});

test('onChange hears the main language change', async () => {
  const { translation } = fakes();
  const heard = [];
  translation.onChange((main) => heard.push(main));
  await translation.setMain('translated');
  await translation.setMain('original');
  assert.deepEqual(heard, ['translated', 'original']);
});

test('want passes the next section on to the book translation', async () => {
  const { translation, store } = fakes();
  await translation.setMain('translated');
  translation.want(1);
  await translation.speechReady();
  for (let i = 0; i < 20 && !store.has(1); i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.ok(store.has(1));
});
