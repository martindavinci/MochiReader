// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../core/i18n.js';

const THEME_ATTRIBUTE = 'data-theme';
const TEXT_SIZE_VARIABLE = '--text-size';
const SYSTEM = 'system';
const VOICE_OPTIONS_CLASS = 'voice-options';
const ABOUT_CLASS = 'about';

/** Not translated: it is the same notice as the one at the top of `licenses.txt`. */
export const COPYRIGHT_NOTICE = 'Copyright (C) 2026 Martin DaVinci';

/** Text sizes in pixels: `Ctrl +` and `Ctrl −` go along this list, and the options offer it. */
export const TEXT_SIZES = [13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 32];

const keyed = (value, key) => ({ value, text: () => t(key) });
const named = (value, name) => ({ value, text: () => name });

// In the order of the panel. The first choice is the default, except where `fallback` says.
const FIELDS = [
  {
    name: 'theme',
    label: 'options.theme',
    choices: [
      keyed(SYSTEM, 'options.themeSystem'),
      keyed('light', 'options.themeLight'),
      keyed('dark', 'options.themeDark'),
    ],
  },
  {
    name: 'textSize',
    label: 'options.textSize',
    fallback: 17,
    choices: TEXT_SIZES.map((size) => named(size, String(size))),
  },
  {
    name: 'sourceMode',
    label: 'options.source',
    choices: [keyed('skip', 'options.sourceSkip'), keyed('name', 'options.sourceName')],
  },
  {
    name: 'epubView',
    label: 'options.epubView',
    choices: [keyed('paginated', 'options.epubPaginated'), keyed('scrolled', 'options.epubScrolled')],
  },
  {
    name: 'language',
    label: 'options.language',
    // Each in its own language, so that it can be found whatever the interface speaks.
    choices: [keyed(SYSTEM, 'options.themeSystem'), named('it', 'Italiano'), named('en', 'English')],
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
  host.querySelector(`.${VOICE_OPTIONS_CLASS}`)?.remove();
  const section = document.createElement('section');
  section.className = VOICE_OPTIONS_CLASS;
  section.append(...groups.map(({ lang, name, voices, selected }) => {
    const select = document.createElement('select');
    select.setAttribute('name', `voice-${lang}`);
    select.append(...voices.map((voice) => {
      const option = document.createElement('option');
      option.setAttribute('value', voice.id);
      if (voice.id === selected) option.setAttribute('selected', '');
      option.textContent = voice.name;
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
  host.querySelector(`.${ABOUT_CLASS}`).before(section);
}

/**
 * @param {HTMLElement} host
 * @param {Record<string, *>} options
 * @param {{onChange: (name: string, value: *) => void, onLicenses: () => void}} handlers
 */
export function renderOptions(host, options, { onChange, onLicenses }) {
  const document = host.ownerDocument;

  const field = ({ name, label, choices }) => {
    const select = document.createElement('select');
    select.setAttribute('name', name);
    select.append(...choices.map(({ value, text }) => {
      const option = document.createElement('option');
      option.setAttribute('value', String(value));
      if (value === options[name]) option.setAttribute('selected', '');
      option.textContent = text();
      return option;
    }));
    select.addEventListener('change', () => {
      onChange(name, choices.find(({ value }) => String(value) === select.value).value);
    });
    const caption = document.createElement('span');
    caption.textContent = t(label);
    const row = document.createElement('label');
    row.className = 'option';
    row.append(caption, select);
    return row;
  };

  // The notices GPL-3.0 asks of a program with an interface, and the way to the license.
  const about = () => {
    const paragraph = (text) => {
      const made = document.createElement('p');
      made.textContent = text;
      return made;
    };
    const licenses = document.createElement('button');
    licenses.textContent = t('about.licenses');
    licenses.addEventListener('click', () => onLicenses());
    const section = document.createElement('section');
    section.className = ABOUT_CLASS;
    section.append(paragraph(COPYRIGHT_NOTICE), paragraph(t('about.notice')), licenses);
    return section;
  };

  const title = document.createElement('h1');
  title.className = 'panel-title';
  title.textContent = t('options.title');
  host.replaceChildren(title, ...FIELDS.map(field), about());
}
