// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../core/i18n.js';
import { icon, named } from './icons.js';
import { elementIn, panelHead } from './panel-parts.js';

/** The phases of a download still under way, as `tts-download` names them. */
const BUSY = new Set(['queued', 'engine', 'voice']);
const BYTES_PER_MB = 1_000_000;
const PERCENT = 100;

/** What an installed voice says when it is tried: one sentence in the language of the voice, not of the interface. */
export const PREVIEW_TEXT = {
  en: 'Hello, this is how I sound when I read to you.',
  it: 'Ciao, ecco come suono quando ti leggo un testo.',
  de: 'Hallo, so klinge ich, wenn ich dir vorlese.',
  es: 'Hola, así sueno cuando te leo un texto.',
  fr: 'Bonjour, voici ma voix quand je vous fais la lecture.',
  pt: 'Olá, é assim que eu soo quando leio para você.',
};

const languageOf = (tag) => tag.split('-')[0].toLowerCase();
const megabytes = (bytes) => Math.max(1, Math.round(bytes / BYTES_PER_MB));

const ERROR_KEYS = {
  network: 'voices.networkError',
  voice: 'voices.hashError',
  engine: 'voices.engineError',
};

/**
 * The voices the reader can download, their state, and what can be done with each.
 * @param {HTMLElement} host
 * @param {{
 *   catalog: {engine: {state: string, bytes: number, download: number}, used: number, unavailable: string[],
 *     voices: {id: string, name: string, lang: string, quality: string, bytes: number, license: string,
 *       card: string, installed: boolean, busy: boolean}[]},
 *   progress: Map<string, {phase: string, received?: number, total?: number|null, error?: {kind: string}|null}>,
 *   languages: string[],
 *   inUse: Set<string>,
 *   nameOf: (language: string) => string,
 * }} view `languages` are those of the open documents and of the interface, which come first.
 * @param {{onDownload: (id: string) => void, onCancel: (id: string) => void, onDelete: (id: string) => void,
 *   onPreview: (voice: object) => void, onCard: (url: string) => void}} handlers
 */
export function renderVoiceManager(host, view, handlers) {
  const element = elementIn(host);
  const { catalog, progress, inUse, nameOf } = view;
  const engineMissing = catalog.engine.state !== 'ready';

  const button = (className, text, action) => {
    const made = element('button', `btn ${className}`, text);
    made.addEventListener('click', () => action());
    return made;
  };

  const actionsOf = (voice) => {
    const actions = element('div', 'voice-actions');
    const preview = element('button', 'btn btn-secondary voice-preview');
    named(preview, t('voices.preview'));
    preview.append(icon(host.ownerDocument, 'play', 12));
    preview.addEventListener('click', () => handlers.onPreview(voice));
    actions.append(preview);
    const state = progress.get(voice.id);
    if ((state && BUSY.has(state.phase)) || (!state && voice.busy)) {
      const share = state?.total ? Math.floor(((state.received ?? 0) * PERCENT) / state.total) : null;
      const text = share === null ? t('voices.waiting') : t('voices.downloading', { percent: share });
      const bar = element('progress', 'voice-progress');
      bar.setAttribute('max', String(PERCENT));
      if (share !== null) bar.setAttribute('value', String(share));
      actions.append(element('span', 'voice-status', text), bar, button('btn-secondary', t('voices.cancel'), () => handlers.onCancel(voice.id)));
    } else if (voice.installed) {
      if (inUse.has(voice.id)) actions.append(element('span', 'voice-badge', t('voices.inUse')));
      actions.append(button('btn-secondary', t('voices.delete'), () => handlers.onDelete(voice.id)));
    } else {
      const text = engineMissing
        ? t('voices.withEngine', { size: megabytes(catalog.engine.download) })
        : t('voices.download');
      actions.append(button('btn-neutral', text, () => handlers.onDownload(voice.id)));
    }
    return actions;
  };

  const row = (voice) => {
    const item = element('li', 'voice-row');
    item.dataset.voice = voice.id;
    const words = element('div', 'voice-words');
    const quality = t(`voices.quality.${voice.quality}`);
    const license = element('button', 'link-button voice-license', t('voices.license', { license: voice.license }));
    license.addEventListener('click', () => handlers.onCard(voice.card));
    const meta = element('p', 'voice-meta');
    meta.append(
      element('span', undefined, `${quality} · ${t('voices.megabytes', { size: megabytes(voice.bytes) })} · `),
      license,
    );
    words.append(element('p', 'voice-name', voice.name), meta);
    const failure = progress.get(voice.id);
    if (failure?.phase === 'error') {
      words.append(element('p', 'voice-error', t(ERROR_KEYS[failure.error?.kind] ?? 'voices.networkError')));
    }
    item.append(words, actionsOf(voice));
    return item;
  };

  const section = (title, voices, language) => {
    const part = element('section', 'voice-language');
    part.dataset.lang = language ?? '';
    part.append(element('h2', 'option-group', title));
    if (language && catalog.unavailable.includes(language) && voices.length === 0) {
      part.append(element('p', 'voice-none', t('voices.noCleanVoice', { lang: nameOf(language) })));
    }
    if (voices.length > 0) {
      const list = element('ul', 'voice-list');
      list.append(...voices.map(row));
      part.append(list);
    }
    return part;
  };

  const first = [...new Set(view.languages.map(languageOf))].filter((language) => (
    catalog.unavailable.includes(language) || catalog.voices.some((voice) => languageOf(voice.lang) === language)
  ));
  const shown = new Set(first);
  const rest = catalog.voices.filter((voice) => !shown.has(languageOf(voice.lang)));

  const summary = element('div', 'voice-summary');
  const engineText = {
    missing: () => t('voices.engineMissing', { size: megabytes(catalog.engine.download) }),
    ready: () => t('voices.engineReady', { size: megabytes(catalog.engine.bytes) }),
    broken: () => t('voices.engineBroken'),
  }[catalog.engine.state] ?? (() => t('voices.engineBroken'));
  summary.append(
    element('p', 'panel-message', t('voices.intro')),
    element('p', 'voice-used', t('voices.used', { size: megabytes(catalog.used) })),
    element('p', 'voice-engine', engineText()),
  );

  const body = element('div', 'panel-body voice-manager');
  body.append(summary);
  for (const language of first) {
    body.append(section(nameOf(language), catalog.voices.filter((voice) => languageOf(voice.lang) === language), language));
  }
  if (rest.length > 0) body.append(section(t('voices.allLanguages'), rest, null));
  host.replaceChildren(panelHead(host, { glyph: 'speaker', title: t('voices.title') }), body);
}
