// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../core/i18n.js';
import { icon, named } from './icons.js';
import { elementIn, panelHead } from './panel-parts.js';
import { KOKORO_PREFIX, PIPER_PREFIX } from '../speech/engine-router.js';
import { renderMixer, renderMixes } from './voice-mixer.js';
import { shortVoiceName } from './voice-name.js';

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
  hi: 'नमस्ते, जब मैं आपको पढ़कर सुनाती हूँ तो मेरी आवाज़ ऐसी लगती है।',
};

/** The id the reader speaks with, from a voice of the catalog: its engine's prefix and its id. */
export const voiceIdOf = (voice) => `${voice.engine === 'kokoro' ? KOKORO_PREFIX : PIPER_PREFIX}${voice.id}`;

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
 *   mixes?: {mix: object, missing: string[]}[],
 *   draft?: object|null,
 * }} view `languages` are those of the open documents and of the interface, which come first. `previewing` is the
 *   voice whose sample is playing, whose play button stops it. `mixes` (with `draft`, the one being made) ends the
 *   panel with the reader's own voices; their handlers are those of `renderMixes` and `renderMixer`.
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
    // A Kokoro voice has no published sample: it is heard once it is on this PC.
    if (voice.engine === 'kokoro' && !voice.installed) {
      preview.setAttribute('disabled', '');
      preview.setAttribute('title', t('voices.kokoroPreviewAfter', { size: megabytes(voice.bytes) }));
    }
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
    const quality = [t(`voices.quality.${voice.quality}`), voice.grade ? t('voices.grade', { grade: voice.grade }) : null]
      .filter(Boolean).join(' · ');
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

  const local = view.local ?? catalog.voices
    .filter((voice) => voice.installed)
    .map((voice) => ({ id: voiceIdOf(voice), name: voice.name, lang: voice.lang, engine: voice.engine ?? 'piper' }));
  const defaults = view.defaults ?? {};
  const everywhere = new Set(view.everywhere ?? []);
  const withMixes = Array.isArray(view.mixes);
  const catalogOf = (id) => catalog.voices.find((voice) => voiceIdOf(voice) === id);

  // The default of a voice: of its own language, or of another one, said so.
  const badgeOf = (id, language) => {
    if (defaults[language] === id) return t('voices.default');
    const other = Object.keys(defaults).find((one) => one !== language && defaults[one] === id);
    return other ? t('voices.defaultFor', { language: nameOf(other) }) : null;
  };
  const tick = (id) => {
    const label = element('label', 'voice-everywhere');
    const box = element('input');
    box.type = 'checkbox';
    box.checked = everywhere.has(id);
    box.addEventListener('change', () => handlers.onEverywhere?.(id, box.checked));
    label.append(box, element('span', undefined, t('voices.everywhere')));
    return label;
  };

  /** A voice on this PC: a downloaded one keeps its row of today (preview, in use, delete); the others say what they are. */
  const localRow = (voice, language) => {
    const known = catalogOf(voice.id);
    let item;
    if (known) {
      item = row(known);
    } else {
      item = element('li', 'voice-row');
      item.dataset.voice = voice.id;
      const words = element('div', 'voice-words');
      words.append(element('p', 'voice-name', shortVoiceName(voice.name)), element('p', 'voice-meta', t(`voices.engine.${voice.engine}`)));
      const actions = element('div', 'voice-actions');
      const mix = voice.engine === 'mix' && view.mixes?.find((one) => `kokoro:mix-${one.mix.id}` === voice.id);
      if (mix) actions.append(button('btn-secondary', t('voices.mix.edit'), () => handlers.onEdit?.(mix.mix)));
      item.append(words, actions);
    }
    const badge = badgeOf(voice.id, language);
    if (badge) item.querySelector('.voice-name').append(element('span', 'voice-badge voice-default-badge', badge));
    item.querySelector('.voice-words').append(tick(voice.id));
    return item;
  };

  const languageOfVoice = (voice) => languageOf(voice.lang);
  const toDownload = (language) => catalog.voices.filter((voice) => !voice.installed && languageOf(voice.lang) === language);
  const onPc = (language) => local.filter((voice) => languageOfVoice(voice) === language);
  const count = (language) => onPc(language).length + toDownload(language).length;

  /** What a language holds: which voice reads it, its voices on this PC (online ones apart), the ones to download. */
  const content = (language, heading) => {
    const part = element('section', 'voice-language');
    part.dataset.lang = language;
    part.append(element(heading, heading === 'h2' ? 'option-group' : 'voice-language-name', nameOf(language)));
    const mine = onPc(language);
    const later = toDownload(language);
    if (mine.length === 0 && later.length === 0) {
      part.append(element('p', 'panel-message', t('voices.noneForLang')));
      return part;
    }
    const choices = [...mine, ...local.filter((voice) => languageOfVoice(voice) !== language && everywhere.has(voice.id))];
    if (choices.length > 0) {
      const select = element('select', 'voice-default');
      const auto = element('option', undefined, t('voices.automatic'));
      auto.setAttribute('value', '');
      select.append(auto, ...choices.map((voice) => {
        const option = element('option', undefined, shortVoiceName(voice.name));
        option.setAttribute('value', voice.id);
        if (defaults[language] === voice.id) option.setAttribute('selected', '');
        return option;
      }));
      select.addEventListener('change', () => handlers.onDefault?.(language, select.value));
      const label = element('label', 'voice-default-field');
      label.append(element('span', undefined, t('voices.readsLang', { language: nameOf(language) })), select);
      part.append(label);
    }
    const offline = mine.filter((voice) => voice.engine !== 'online');
    const online = mine.filter((voice) => voice.engine === 'online');
    if (offline.length > 0 || online.length > 0) {
      part.append(element('h3', 'voice-group', t('voices.onThisPc')));
      const list = element('ul', 'voice-list');
      list.append(...offline.map((voice) => localRow(voice, language)));
      part.append(list);
      if (online.length > 0) {
        const more = element('ul', 'voice-list');
        more.append(...online.map((voice) => localRow(voice, language)));
        part.append(element('h3', 'voice-group', t('voices.online')), more);
      }
    }
    if (later.length > 0) {
      const list = element('ul', 'voice-list');
      list.append(...later.map(row));
      part.append(element('h3', 'voice-group', t('voices.toDownload')), list);
    }
    return part;
  };

  // The column: the languages of the documents and of the interface, then the others with a voice, then all of them
  // and the reader's own voices.
  const voiced = new Set([...local, ...catalog.voices].map(languageOfVoice));
  const first = [...new Set(view.languages.map(languageOf))];
  const rest = [...voiced]
    .filter((language) => !first.includes(language))
    .sort((one, other) => nameOf(one).localeCompare(nameOf(other)));
  const firstShown = first.filter((language) => voiced.has(language) || language === view.selected);
  const languages = [...firstShown, ...rest];
  const selected = view.selected ?? '*';

  const nav = element('nav', 'voice-langs');
  nav.setAttribute('aria-label', t('voices.languages'));
  const entries = [
    ...languages.map((language) => [language, nameOf(language), count(language)]),
    ['*', t('voices.allLanguages'), null],
    ...(withMixes ? [['mine', t('voices.mix.title'), view.mixes.length]] : []),
  ];
  for (const [key, name, many] of entries) {
    const item = element('button', 'voice-lang');
    item.type = 'button';
    item.dataset.lang = key;
    item.append(element('span', 'voice-lang-name', name));
    if (many !== null) item.append(element('span', 'voice-lang-count', String(many)));
    if (key === selected) item.setAttribute('aria-current', 'true');
    item.addEventListener('click', () => handlers.onSelect?.(key));
    nav.append(item);
  }

  const summary = element('div', 'voice-summary');
  summary.append(
    element('p', 'panel-message', t('voices.intro')),
    element('p', 'voice-used', t('voices.used', { size: megabytes(catalog.used) })),
  );
  if (catalog.kokoroModel && catalog.voices.some((voice) => voice.engine === 'kokoro')) {
    summary.append(element('p', 'voice-kokoro-model', t('voices.kokoroModel', { size: megabytes(catalog.kokoroModel.bytes) })));
  }
  if (!engineReady) {
    const why = catalog.engine.state === 'missing' ? 'voices.noEngine' : 'voices.engineBroken';
    summary.append(element('p', 'voice-engine', t(why)));
  }

  // The reader's own voices: the kept ones, or the form of the one being made.
  const mixesSection = () => {
    const mixes = element('section', 'voice-language voice-mixes');
    const kokoroVoices = catalog.voices
      .filter((voice) => voice.engine === 'kokoro' && voice.installed)
      .map(({ id, name, lang }) => ({ id, name, lang }));
    if (view.draft) renderMixer(mixes, { draft: view.draft, kokoroVoices, nameOf }, handlers);
    else renderMixes(mixes, { mixes: view.mixes, kokoroVoices, nameOf, everywhere: view.everywhere ?? null }, handlers);
    return mixes;
  };

  const main = element('div', 'voice-content');
  if (selected === 'mine' && withMixes) {
    main.append(mixesSection());
  } else if (selected === '*') {
    main.append(...languages.filter((language) => count(language) > 0).map((language) => content(language, 'h2')));
    if (withMixes) main.append(mixesSection());
  } else {
    main.append(content(selected, 'h2'));
  }

  const panel = element('div', 'voice-panel');
  panel.append(nav, main);
  const body = element('div', 'panel-body voice-manager');
  body.append(summary, panel);
  host.replaceChildren(panelHead(host, { glyph: 'speaker', title: t('voices.title') }), body);
}
