// SPDX-License-Identifier: GPL-3.0-or-later
// The translation engine of Firefox Translations (Bergamot, in WebAssembly), run in workers of the page. Its models
// come from the app's own files: nothing is fetched from the network here. Nothing of it loads until a book is first
// translated.

const PIVOT = 'en';
const DEFAULT_WORKERS = 2;

const importBergamot = () => import('../vendor/bergamot/translator.js');

/**
 * @param {{invoke: (command: string, args?: object) => Promise<*>, workers?: number,
 *   load?: () => Promise<{BatchTranslator: Function, TranslatorBacking: Function}>}} options
 * @returns {{translate: (from: string, to: string, htmls: string[]) => Promise<string[]>,
 *   installed: () => Promise<string[]>, close: () => Promise<void>}}
 */
export function createEngine({ invoke, workers = DEFAULT_WORKERS, load = importBergamot }) {
  let translator = null;

  const installedPairs = async () => {
    const { pairs } = await invoke('tr_catalog');
    return pairs.filter(({ installed }) => installed);
  };

  const start = async () => {
    const { BatchTranslator, TranslatorBacking } = await load();
    class AppBacking extends TranslatorBacking {
      async loadModelRegistery() {
        return (await installedPairs()).map(({ id, from, to, kinds }) => ({ id, from, to, kinds }));
      }

      async loadTranslationModel({ from, to }) {
        const entry = (await this.registry).find((model) => model.from === from && model.to === to);
        if (!entry) throw new Error(`No model for '${from}' -> '${to}'`);
        const file = (kind) => invoke('tr_model_file', { pair: entry.id, kind });
        const split = entry.kinds.includes('srcvocab');
        const [model, shortlist, ...vocabs] = await Promise.all(
          ['model', 'lex', ...(split ? ['srcvocab', 'trgvocab'] : ['vocab'])].map(file),
        );
        return { model, shortlist, vocabs, config: {} };
      }
    }
    const options = { workers, pivotLanguage: PIVOT };
    return new BatchTranslator(options, new AppBacking(options));
  };

  const ready = () => {
    translator ??= start();
    return translator;
  };

  return {
    async translate(from, to, htmls) {
      const engine = await ready();
      const results = await Promise.all(htmls.map((text) => engine.translate({
        from, to, text, html: true, qualityScores: false,
      })));
      return results.map(({ target }) => target.text);
    },
    installed: async () => (await installedPairs()).map(({ id }) => id),
    async close() {
      if (!translator) return;
      const engine = await translator;
      translator = null;
      await engine.delete();
    },
  };
}
