// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../core/i18n.js';
import { elementIn } from './panel-parts.js';

/**
 * The reader's own voices: two or three Kokoro voices mixed, each with a weight. A draft holds weights from 0 to 100;
 * Rust keeps them adding up to 1.
 * @typedef {{id: string, name: string, lang: string, parts: {voice: string, weight: number}[]}} Draft
 * @typedef {{id: string, name: string, lang: string}} KokoroVoice A Kokoro voice on this PC.
 */

const MAX_PARTS = 3;
const MAX_WEIGHT = 100;
const START_WEIGHT = 50;
const THIRD_WEIGHT = 25;

const languageOf = (tag) => tag.split('-')[0].toLowerCase();
const langOfVoice = (voices, id) => voices.find((voice) => voice.id === id)?.lang;
const nameOfVoice = (voices, id) => voices.find((voice) => voice.id === id)?.name ?? id;

/** @returns {Draft} the first two voices, half and half, in the language of the first. */
export function newDraft(kokoroVoices) {
  const [first, second] = kokoroVoices;
  return {
    id: '',
    name: '',
    lang: first.lang,
    parts: [{ voice: first.id, weight: START_WEIGHT }, { voice: second.id, weight: START_WEIGHT }],
  };
}

/** @returns {Draft} a kept mix to edit. */
export function draftOf(mix) {
  return { ...mix, parts: mix.parts.map(({ voice, weight }) => ({ voice, weight: Math.round(weight * MAX_WEIGHT) })) };
}

/** @returns {Draft} a copy of a kept mix, to be kept as a new one. */
export function duplicateOf(mix) {
  return { ...draftOf(mix), id: '', name: `${mix.name} 2` };
}

/** The draft with a language one of its voices speaks: its own if it still fits, else the first voice's. */
export function withLang(draft, kokoroVoices) {
  const langs = draft.parts.map(({ voice }) => langOfVoice(kokoroVoices, voice)).filter(Boolean);
  return langs.includes(draft.lang) || langs.length === 0 ? draft : { ...draft, lang: langs[0] };
}

/**
 * The draft with only voices still on this PC: a part whose voice is gone takes one not used yet; null when fewer than
 * two voices are left to mix. The same draft when nothing is gone.
 */
export function repairDraft(draft, kokoroVoices) {
  if (kokoroVoices.length < 2) return null;
  const known = draft.parts.filter(({ voice }) => langOfVoice(kokoroVoices, voice));
  if (known.length === draft.parts.length) return draft;
  const parts = [...known];
  for (const voice of kokoroVoices) {
    if (parts.length >= 2) break;
    if (!parts.some((part) => part.voice === voice.id)) parts.push({ voice: voice.id, weight: START_WEIGHT });
  }
  return withLang({ ...draft, parts }, kokoroVoices);
}

/** @returns {string|null} the key of what keeps the draft from being kept, or null. */
export function draftProblem(draft, kokoroVoices) {
  if (!draft.name.trim()) return 'voices.mix.needName';
  const known = draft.parts.filter(({ voice }) => langOfVoice(kokoroVoices, voice));
  if (known.length < 2) return 'voices.mix.needTwo';
  if (known.reduce((sum, { weight }) => sum + weight, 0) <= 0) return 'voices.mix.needWeight';
  return null;
}

/**
 * The kept mixes and the button that makes one.
 * @param {HTMLElement} host
 * @param {{mixes: {mix: Draft, missing: string[]}[], kokoroVoices: KokoroVoice[], nameOf: (language: string) => string}} view
 * @param {{onCreate: () => void, onEdit: (mix: Draft) => void, onDuplicate: (mix: Draft) => void,
 *   onDeleteMix: (id: string) => void}} handlers
 */
export function renderMixes(host, { mixes, kokoroVoices, nameOf }, handlers) {
  const element = elementIn(host);
  const button = (text, action) => {
    const made = element('button', 'btn btn-secondary', text);
    made.addEventListener('click', () => action());
    return made;
  };
  const list = element('ul', 'voice-list mix-list');
  for (const { mix, missing } of mixes) {
    const item = element('li', `voice-row mix-row${missing.length > 0 ? ' is-disabled' : ''}`);
    item.dataset.mix = mix.id;
    const words = element('div', 'voice-words');
    const parts = mix.parts
      .map(({ voice, weight }) => `${nameOfVoice(kokoroVoices, voice)} ${Math.round(weight * MAX_WEIGHT)}%`)
      .join(' · ');
    words.append(
      element('p', 'voice-name', mix.name),
      element('p', 'voice-meta', `${nameOf(languageOf(mix.lang))} · ${parts}`),
    );
    if (missing.length > 0) words.append(element('p', 'voice-error', t('voices.mix.missing', { names: missing.join(', ') })));
    const actions = element('div', 'voice-actions');
    if (missing.length === 0) {
      actions.append(button(t('voices.mix.edit'), () => handlers.onEdit(mix)), button(t('voices.mix.duplicate'), () => handlers.onDuplicate(mix)));
    }
    actions.append(button(t('voices.delete'), () => handlers.onDeleteMix(mix.id)));
    item.append(words, actions);
    list.append(item);
  }
  const parts = [element('h2', 'option-group', t('voices.mix.title'))];
  if (mixes.length > 0) parts.push(list);
  if (kokoroVoices.length < 2) {
    parts.push(element('p', 'panel-message', t('voices.mix.needVoices')));
  } else {
    const create = element('button', 'btn btn-neutral mix-create', t('voices.mix.create'));
    create.addEventListener('click', () => handlers.onCreate());
    parts.push(create);
  }
  host.replaceChildren(...parts);
}

/**
 * The form of a draft: its name, its voices with their weights, its language, and preview, save, cancel.
 * @param {HTMLElement} host
 * @param {{draft: Draft, kokoroVoices: KokoroVoice[], nameOf: (language: string) => string}} view
 * @param {{onChange: (draft: Draft) => void, onPreviewMix: (draft: Draft) => void, onSave: (draft: Draft) => void,
 *   onCancel: () => void}} handlers
 */
export function renderMixer(host, { draft, kokoroVoices, nameOf }, handlers) {
  const element = elementIn(host);
  const change = (next) => handlers.onChange(withLang(next, kokoroVoices));
  // What the form holds now: a name typed or a weight slid counts at once, even before the field is left, so that Save
  // and Preview never take the draft the form was drawn with.
  const current = { ...draft, parts: draft.parts.map((part) => ({ ...part })) };
  const label = (text, control) => {
    const made = element('label', 'mix-field');
    made.append(element('span', 'mix-label', text), control);
    return made;
  };

  const name = element('input', 'mix-name');
  name.type = 'text';
  name.maxLength = 40;
  name.value = draft.name;
  name.addEventListener('input', () => {
    current.name = name.value;
    refresh();
  });
  name.addEventListener('change', () => change(current));

  const rows = draft.parts.map((part, index) => {
    const row = element('div', 'mix-part');
    const select = element('select', 'mix-voice');
    for (const voice of kokoroVoices) {
      const option = element('option', undefined, `${voice.name} (${nameOf(languageOf(voice.lang))})`);
      option.value = voice.id;
      if (voice.id === part.voice) option.selected = true;
      select.append(option);
    }
    select.setAttribute('aria-label', t('voices.mix.voice'));
    const weight = element('input', 'mix-weight');
    weight.type = 'range';
    weight.setAttribute('min', '0');
    weight.setAttribute('max', String(MAX_WEIGHT));
    weight.value = String(part.weight);
    weight.setAttribute('aria-label', t('voices.mix.weight'));
    const shown = element('span', 'mix-weight-value', String(part.weight));
    const withPart = (changed) => ({ ...current, parts: current.parts.map((one, at) => (at === index ? { ...one, ...changed } : one)) });
    select.addEventListener('change', () => change(withPart({ voice: select.value })));
    // the number follows the slider as it moves; the panel is drawn again once it is let go
    weight.addEventListener('input', () => {
      shown.textContent = weight.value;
      current.parts[index].weight = Number(weight.value);
      refresh();
    });
    weight.addEventListener('change', () => change(current));
    row.append(select, weight, shown);
    if (index === MAX_PARTS - 1) {
      const remove = element('button', 'btn btn-secondary mix-remove', '×');
      remove.setAttribute('aria-label', t('voices.delete'));
      remove.addEventListener('click', () => change({ ...current, parts: current.parts.slice(0, index) }));
      row.append(remove);
    }
    return row;
  });

  const parts = [label(t('voices.mix.name'), name), ...rows];
  if (draft.parts.length < MAX_PARTS) {
    const add = element('button', 'btn btn-secondary mix-add', t('voices.mix.addThird'));
    const unused = kokoroVoices.find((voice) => !draft.parts.some((part) => part.voice === voice.id)) ?? kokoroVoices[0];
    add.addEventListener('click', () => change({ ...current, parts: [...current.parts, { voice: unused.id, weight: THIRD_WEIGHT }] }));
    parts.push(add);
  }

  const lang = element('select', 'mix-lang');
  for (const tag of [...new Set(draft.parts.map(({ voice }) => langOfVoice(kokoroVoices, voice)).filter(Boolean))]) {
    const option = element('option', undefined, nameOf(languageOf(tag)));
    option.value = tag;
    if (tag === draft.lang) option.selected = true;
    lang.append(option);
  }
  lang.addEventListener('change', () => change({ ...current, lang: lang.value }));
  parts.push(label(t('voices.mix.lang'), lang));

  const said = element('p', 'voice-error mix-problem');
  const actions = element('div', 'voice-actions');
  const preview = element('button', 'btn btn-secondary mix-preview', t('voices.preview'));
  preview.addEventListener('click', () => handlers.onPreviewMix({ ...current }));
  const save = element('button', 'btn btn-neutral mix-save', t('voices.mix.save'));
  save.addEventListener('click', () => handlers.onSave({ ...current }));
  const cancel = element('button', 'btn btn-secondary mix-cancel', t('voices.cancel'));
  cancel.addEventListener('click', () => handlers.onCancel());
  actions.append(preview, save, cancel);
  parts.push(actions);

  const form = element('div', 'mix-form');
  form.append(...parts);
  // what keeps the draft from being kept, said above the buttons; Preview needs only the voices, not a name
  function refresh() {
    const problem = draftProblem(current, kokoroVoices);
    save.toggleAttribute('disabled', Boolean(problem));
    preview.toggleAttribute('disabled', Boolean(draftProblem({ ...current, name: current.name || '-' }, kokoroVoices)));
    if (problem) {
      said.textContent = t(problem);
      if (!said.isConnected) actions.before(said);
    } else {
      said.remove();
    }
  }
  refresh();
  host.replaceChildren(element('h2', 'option-group', t('voices.mix.title')), form);
}
