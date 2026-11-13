// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../core/i18n.js';
import { icon, named } from './icons.js';
import { elementIn, panelHead } from './panel-parts.js';

/** The phases of a download still under way, as `tts-download` names them. */
const BUSY = new Set(['queued', 'voice']);
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

/** What the row of a download under way says: the share once its size is known. */
export function progressText(state) {
  if (!state?.total) return t('voices.waiting');
  return t('voices.downloading', { percent: Math.floor(((state.received ?? 0) * PERCENT) / state.total) });
}

const ERROR_KEYS = {
  network: 'voices.networkError',
  voice: 'voices.hashError',
  engine: 'voices.engineBroken',
};

/**
 * The voices the reader can download, their state, and what can be done with each.
 * @param {HTMLElement} host
 * @param {{
 *   catalog: {engine: {state: 'ready'|'missing'|'broken'}, used: number, unavailable: string[],
 *     voices: {id: string, name: string, lang: string, quality: string, bytes: number, license: string,
 *       card: string, installed: boolean, busy: boolean}[]},
 *   progress: Map<string, {phase: string, received?: number, total?: number|null, error?: {kind: string}|null}>,
 *   languages: string[],
 *   inUse: Set<string>,
 *   nameOf: (language: string) => string,
 *   previewing?: string|null,
 * }} view `languages` are those of the open documents and of the interface, which come first. `previewing` is the
 *   voice whose sample is playing, whose play button stops it.
 * @param {{onDownload: (id: string) => void, onCancel: (id: string) => void, onDelete: (id: string) => void,
 *   onPreview: (voice: object) => void, onCard: (url: string) => void}} handlers
 */
export function renderVoiceManager(host, view, handlers) {
  const element = elementIn(host);
  const { catalog, progress, inUse, nameOf } = view;
  // The engine comes with the app: a copy built without it, or with it damaged, can only play the samples.
  const engineReady = catalog.engine.state === 'ready';

  const button = (className, text, action) => {
    const made = element('button', `btn ${className}`, text);
    made.addEventListener('click', () => action());
    return made;
  };

  const actionsOf = (voice) => {
    const actions = element('div', 'voice-actions');
    const playing = view.previewing === voice.id;
    const preview = element('button', `btn btn-secondary voice-preview${playing ? ' is-playing' : ''}`);
    named(preview, t(playing ? 'voices.stopPreview' : 'voices.preview'));
    preview.setAttribute('aria-pressed', String(playing));
    preview.append(icon(host.ownerDocument, playing ? 'stop' : 'play', 12));
    preview.addEventListener('click', () => handlers.onPreview(voice));
    actions.append(preview);
    const state = progress.get(voice.id);
    if ((state && BUSY.has(state.phase)) || (!state && voice.busy)) {
      const share = state?.total ? Math.floor(((state.received ?? 0) * PERCENT) / state.total) : null;
      const text = progressText(state);
      const bar = element('progress', 'voice-progress');
      bar.setAttribute('max', String(PERCENT));
      if (share !== null) bar.setAttribute('value', String(share));
      actions.append(element('span', 'voice-status', text), bar, button('btn-secondary', t('voices.cancel'), () => handlers.onCancel(voice.id)));
    } else if (voice.installed) {
      if (inUse.has(voice.id)) actions.append(element('span', 'voice-badge', t('voices.inUse')));
      actions.append(button('btn-secondary', t('voices.delete'), () => handlers.onDelete(voice.id)));
    } else if (engineReady) {
      actions.append(button('btn-neutral', t('voices.download'), () => handlers.onDownload(voice.id)));
    } else {
      const none = element('button', 'btn btn-neutral', t('voices.unavailable'));
      none.setAttribute('disabled', '');
      actions.append(none);
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

  /** The voices of one language. A language without any is not named at all: the voices of Windows read it. */
  const listOf = (language) => {
    const list = element('ul', 'voice-list');
    list.append(...catalog.voices.filter((voice) => languageOf(voice.lang) === language).map(row));
    return list;
  };

  const section = (language) => {
    const part = element('section', 'voice-language');
    part.dataset.lang = language;
    part.append(element('h2', 'option-group', nameOf(language)), listOf(language));
    return part;
  };

  const voiced = new Set(catalog.voices.map((voice) => languageOf(voice.lang)));
  const first = [...new Set(view.languages.map(languageOf))].filter((language) => voiced.has(language));
  const shown = new Set(first);
  const rest = [...voiced]
    .filter((language) => !shown.has(language))
    .sort((one, other) => nameOf(one).localeCompare(nameOf(other)));

  const summary = element('div', 'voice-summary');
  summary.append(
    element('p', 'panel-message', t('voices.intro')),
    element('p', 'voice-used', t('voices.used', { size: megabytes(catalog.used) })),
  );
  if (!engineReady) {
    const why = catalog.engine.state === 'missing' ? 'voices.noEngine' : 'voices.engineBroken';
    summary.append(element('p', 'voice-engine', t(why)));
  }

  const body = element('div', 'panel-body voice-manager');
  body.append(summary);
  body.append(...first.map(section));
  if (rest.length > 0) {
    const all = element('section', 'voice-language');
    all.dataset.lang = '';
    all.append(element('h2', 'option-group', t('voices.allLanguages')));
    for (const language of rest) {
      const part = element('div', 'voice-sublanguage');
      part.dataset.lang = language;
      part.append(element('h3', 'voice-language-name', nameOf(language)), listOf(language));
      all.append(part);
    }
    body.append(all);
  }
  host.replaceChildren(panelHead(host, { glyph: 'speaker', title: t('voices.title') }), body);
}
