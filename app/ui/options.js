// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../core/i18n.js';
import { mascot } from './home.js';
import { named } from './icons.js';
import { panelHead } from './panel-parts.js';
import { shortVoiceName } from './voice-name.js';

const THEME_ATTRIBUTE = 'data-theme';
const TEXT_SIZE_VARIABLE = '--text-size';
const SYSTEM = 'system';
const VOICE_OPTIONS_CLASS = 'voice-options';
const ABOUT_CLASS = 'about';
const ABOUT_MASCOT_PX = 32;
const FOCUS_KEY = 'data-key';
const TEXT_SIZE = 'textSize';
const DEFAULT_TEXT_SIZE = 18;

/** Not translated: it is the same notice as the one at the top of `licenses.txt`. */
export const COPYRIGHT_NOTICE = 'Copyright (C) 2026 Martin DaVinci';

/** Text sizes in pixels: `Ctrl +` and `Ctrl −` go along this list, and the options offer it. */
export const TEXT_SIZES = [13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 32];

const keyed = (value, key) => ({ value, text: () => t(key) });
const plain = (value, name) => ({ value, text: () => name });

// In the order of the panel. The first choice is the default, except where `fallback` says.
const FIELDS = [
  {
    name: 'theme',
    label: 'options.theme',
    group: 'options.groupAppearance',
    choices: [
      keyed(SYSTEM, 'options.themeSystem'),
      keyed('light', 'options.themeLight'),
      keyed('dark', 'options.themeDark'),
    ],
  },
  {
    name: TEXT_SIZE,
    label: 'options.textSize',
    group: 'options.groupAppearance',
    fallback: DEFAULT_TEXT_SIZE,
    choices: TEXT_SIZES.map((size) => plain(size, String(size))),
  },
  {
    name: 'epubView',
    label: 'options.epubView',
    group: 'options.groupBooks',
    choices: [keyed('paginated', 'options.epubPaginated'), keyed('scrolled', 'options.epubScrolled')],
  },
  {
    name: 'sourceMode',
    label: 'options.source',
    group: 'options.groupSpeech',
    choices: [keyed('skip', 'options.sourceSkip'), keyed('name', 'options.sourceName')],
  },
  {
    name: 'language',
    label: 'options.language',
    hint: 'options.languageHint',
    group: 'options.groupLanguage',
    // Each in its own language, so that it can be found whatever the interface speaks. Too many for buttons.
    list: true,
    choices: [
      keyed(SYSTEM, 'options.themeSystem'),
      plain('en', 'English'),
      plain('it', 'Italiano'),
      plain('de', 'Deutsch'),
      plain('es', 'Español'),
      plain('fr', 'Français'),
      plain('pt-BR', 'Português (Brasil)'),
      plain('ja', '日本語'),
      plain('ko', '한국어'),
      plain('zh-CN', '中文（简体）'),
    ],
  },
];

/**
 * @param {Record<string, *>} saved The options as the state keeps them.
 * @returns {{theme: string, textSize: number, sourceMode: string, epubView: string, language: string}}
 *   Each one the saved value if the app knows it, or its default.
 */
export function readOptions(saved) {
  return Object.fromEntries(FIELDS.map(({ name, fallback, choices }) => {
    const known = choices.some(({ value }) => value === saved[name]);
    return [name, known ? saved[name] : fallback ?? choices[0].value];
  }));
}

export const DEFAULT_OPTIONS = readOptions({});

/**
 * @param {number} size
 * @param {1|-1} delta
 * @returns {number} The size next to `size` on the list; `size` itself at the end of it.
 */
export function nextTextSize(size, delta) {
  return TEXT_SIZES[TEXT_SIZES.indexOf(size) + delta] ?? size;
}

/** Theme and text size, which the style sheet takes from the root of the page. */
export function applyOptions({ theme, textSize }, root) {
  if (theme === SYSTEM) root.removeAttribute(THEME_ATTRIBUTE);
  else root.setAttribute(THEME_ATTRIBUTE, theme);
  root.style.setProperty(TEXT_SIZE_VARIABLE, `${textSize}px`);
}

/**
 * @param {{language: string}} options
 * @param {string} systemLang
 * @returns {string} The language tag the interface goes by.
 */
export function interfaceLang({ language }, systemLang) {
  return language === SYSTEM ? systemLang : language;
}

/**
 * The voices are asked for separately, and they come when the rest of the panel is on screen.
 * @param {HTMLElement} host The panel, with its options already drawn.
 * @param {{lang: string, name: string, voices: {id: string, name: string}[], selected: string}[]} groups
 * @param {(lang: string, voiceId: string) => void} onVoice
 */
export function renderVoiceOptions(host, groups, onVoice) {
  const document = host.ownerDocument;
  host.querySelector(`.${VOICE_OPTIONS_CLASS}`).replaceChildren(...groups.map(({ lang, name, voices, selected }) => {
    const select = document.createElement('select');
    select.setAttribute('name', `voice-${lang}`);
    select.append(...voices.map((voice) => {
      const option = document.createElement('option');
      option.setAttribute('value', voice.id);
      option.setAttribute('title', voice.name);
      if (voice.id === selected) option.setAttribute('selected', '');
      option.textContent = shortVoiceName(voice.name);
      return option;
    }));
    select.addEventListener('change', () => onVoice(lang, select.value));
    const caption = document.createElement('span');
    caption.textContent = t('options.voice', { lang: name });
    const row = document.createElement('label');
    row.className = 'option';
    row.append(caption, select);
    return row;
  }));
}

/**
 * @param {HTMLElement} host
 * @param {Record<string, *>} options
 * @param {{onChange: (name: string, value: *) => void, onLicenses: () => void, version?: string}} handlers
 */
export function renderOptions(host, options, { onChange, onLicenses, version = '' }) {
  const document = host.ownerDocument;
  const make = (tag, className, text) => {
    const made = document.createElement(tag);
    if (className) made.className = className;
    if (text !== undefined) made.textContent = text;
    return made;
  };

  /** Choices that fit on one line: all of them in sight, one click from each other. */
  const segmented = ({ name, label, choices }) => {
    const group = make('div', 'segmented');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', t(label));
    group.append(...choices.map(({ value, text }) => {
      const input = make('input');
      input.setAttribute('type', 'radio');
      input.setAttribute('name', name);
      input.setAttribute('value', String(value));
      input.setAttribute(FOCUS_KEY, `${name}-${value}`);
      if (value === options[name]) input.setAttribute('checked', '');
      input.addEventListener('change', () => onChange(name, value));
      const choice = make('label');
      choice.append(input, make('span', undefined, text()));
      return choice;
    }));
    return group;
  };

  /** The sizes are a long list with an order: a step at a time, between the two ends. */
  const stepper = () => {
    const size = options[TEXT_SIZE];
    const box = make('div', 'stepper');
    const step = (mark, label, delta) => {
      const button = make('button', undefined, mark);
      named(button, t(label));
      button.setAttribute(FOCUS_KEY, `${TEXT_SIZE}${delta}`);
      const next = nextTextSize(size, delta);
      if (next === size) button.setAttribute('disabled', '');
      button.addEventListener('click', () => onChange(TEXT_SIZE, next));
      return button;
    };
    box.append(step('A−', 'options.smaller', -1), make('output', undefined, String(size)), step('A+', 'options.larger', 1));
    return box;
  };

  /** A native list, for choices that do not fit on one line. */
  const list = ({ name, choices }) => {
    const select = make('select');
    select.setAttribute('name', name);
    select.setAttribute(FOCUS_KEY, name);
    select.append(...choices.map(({ value, text }) => {
      const option = make('option', undefined, text());
      option.setAttribute('value', String(value));
      if (value === options[name]) option.setAttribute('selected', '');
      return option;
    }));
    select.addEventListener('change', () => {
      onChange(name, choices.find(({ value }) => String(value) === select.value).value);
    });
    return select;
  };

  const control = (description) => {
    if (description.name === TEXT_SIZE) return stepper();
    return description.list ? list(description) : segmented(description);
  };

  const field = (description) => {
    const caption = make('span', 'option-label');
    caption.append(make('span', undefined, t(description.label)));
    if (description.hint) caption.append(make('span', 'option-hint', t(description.hint)));
    const row = make('div', 'option');
    row.append(caption, control(description));
    return row;
  };

  // The notices GPL-3.0 asks of a program with an interface, and the way to the license.
  const about = () => {
    const licenses = make('button', 'link-button', t('about.licenses'));
    licenses.addEventListener('click', () => onLicenses());
    const words = make('div', 'about-words');
    words.append(
      make('p', 'about-name', version ? `MochiReader ${version}` : 'MochiReader'),
      make('p', undefined, COPYRIGHT_NOTICE),
      make('p', undefined, t('about.short')),
    );
    const section = make('section', ABOUT_CLASS);
    section.append(mascot(document, ABOUT_MASCOT_PX), words, licenses);
    return section;
  };

  // What the voices drew stays until they are asked for again, so the panel does not jump while it waits.
  const voices = host.querySelector(`.${VOICE_OPTIONS_CLASS}`) ?? make('section', VOICE_OPTIONS_CLASS);
  const body = make('div', 'panel-body');
  let group = null;
  for (const description of FIELDS) {
    if (description.group !== group) {
      group = description.group;
      body.append(make('h2', 'option-group', t(group)));
      if (description.name === 'sourceMode') body.append(voices);
    }
    body.append(field(description));
  }
  body.append(about());
  host.replaceChildren(panelHead(host, { glyph: 'sliders', title: t('options.title') }), body);
}

/**
 * Drawing the panel again takes the focus with the old controls.
 * @param {HTMLElement} host
 * @param {string|null} key What the control that had it was called.
 */
export function focusOption(host, key) {
  if (key) host.querySelector(`[${FOCUS_KEY}="${key}"]`)?.focus({ preventScroll: true });
}

/** @param {Document} document @returns {string|null} What to give `focusOption` once the panel is drawn again. */
export const focusedOption = (document) => document.activeElement?.getAttribute?.(FOCUS_KEY) ?? null;
