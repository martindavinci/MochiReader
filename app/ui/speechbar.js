// SPDX-License-Identifier: GPL-3.0-or-later
// Loads with the first reading, never with the first frame.
import { t } from '../core/i18n.js';
import { icon, named } from './icons.js';
import { shortVoiceName } from './voice-name.js';

const BAR_ID = 'speechbar';
const TOGGLE = 'speech.toggle';
const FOLLOW = 'speech.follow';
const GO_TO_TAB = 'speech.goToTab';

// Each one in the order of the bar: its action, what it shows, the name of its text, and its key.
const TRANSPORT = [
  ['speech.prevSentence', 'prev', 'speech.prevSentence', '←'],
  [TOGGLE, 'pause', null, 'Space'],
  ['speech.nextSentence', 'next', 'speech.nextSentence', '→'],
];
const RATE = [
  ['speech.slower', 'slower', 'speech.slower', '-'],
  ['speech.faster', 'faster', 'speech.faster', '+'],
];
const STOP = ['speech.stop', 'stop', 'speech.stop', null];

const made = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

/** The arrows and space stay with the text: a button pressed with the mouse must not keep the focus. */
const keepFocusOnText = (event) => event.preventDefault();

/**
 * The bar of a reading: only there while there is one.
 * @param {{onCommand: (action: string) => void, onVoice: (voiceId: string) => void}} handlers
 * @returns {{show: (view: object) => void, hide: () => void}}
 */
export function createSpeechBar({ onCommand, onVoice }) {
  const bar = made('footer');
  bar.id = BAR_ID;
  bar.hidden = true;
  const buttons = new Map();
  const button = (action, glyph, className) => {
    const element = made('button', className);
    element.setAttribute('data-action', action);
    element.append(icon(document, glyph));
    element.addEventListener('mousedown', keepFocusOnText);
    element.addEventListener('click', () => onCommand(action));
    buttons.set(action, element);
    return element;
  };

  const status = made('span', 'speech-status');
  const name = made('span', 'speech-name');
  const goToTab = made('button', 'speech-go');
  goToTab.setAttribute('data-action', GO_TO_TAB);
  goToTab.addEventListener('click', () => onCommand(GO_TO_TAB));
  const words = made('div', 'speech-words');
  const title = made('div', 'speech-title');
  title.append(name, goToTab);
  words.append(status, title);
  const mark = made('div', 'speech-mark');
  mark.append(icon(document, 'speaking'));
  const about = made('div', 'speech-about');
  about.append(mark, words);

  const transport = made('div', 'speech-transport');
  transport.append(...TRANSPORT.map(([action, glyph]) => button(action, glyph, action === TOGGLE ? 'speech-play' : undefined)));
  const rate = made('span', 'speech-rate');
  const stepper = made('div', 'speech-stepper');
  stepper.append(button(RATE[0][0], RATE[0][1]), rate, button(RATE[1][0], RATE[1][1]));
  transport.append(made('span', 'speech-divider'), stepper, button(STOP[0], STOP[1], 'speech-stop'));

  const voice = made('select', 'speech-voice');
  // With the mouse a choice is over when made. With the keyboard the arrows are still walking the list.
  let choosingByMouse = false;
  voice.addEventListener('mousedown', () => {
    choosingByMouse = true;
  });
  voice.addEventListener('change', () => {
    onVoice(voice.value);
    if (choosingByMouse) voice.blur();
    choosingByMouse = false;
  });
  const voiceZone = made('div', 'speech-voice-zone');
  voiceZone.append(voice);

  const follow = made('button', 'speech-follow');
  follow.setAttribute('data-action', FOLLOW);
  follow.addEventListener('mousedown', keepFocusOnText);
  follow.addEventListener('click', () => onCommand(FOLLOW));
  buttons.set(FOLLOW, follow);
  const followLabel = made('span');
  follow.append(icon(document, 'down'), followLabel);

  bar.append(follow, about, transport, voiceZone);
  document.getElementById('panes').after(bar);

  const drawVoices = (voices, voiceId) => {
    voice.replaceChildren(...voices.map(({ id, name: voiceName }) => {
      const option = made('option', undefined, shortVoiceName(voiceName));
      option.setAttribute('value', id);
      option.setAttribute('title', voiceName);
      if (id === voiceId) option.setAttribute('selected', '');
      return option;
    }));
    named(voice, t('speech.voice'));
  };

  return {
    show({ name: fileName, playing, rate: speed, voices, voiceId, following, elsewhere = false }) {
      status.textContent = t(elsewhere ? 'speech.elsewhere' : playing ? 'speech.reading' : 'speech.paused');
      name.textContent = fileName;
      name.setAttribute('title', fileName);
      goToTab.textContent = t('speech.goToTab');
      goToTab.hidden = !elsewhere;
      rate.textContent = t('speech.rate', { rate: speed });
      for (const [action, , key, keys] of [...TRANSPORT, ...RATE, STOP]) {
        if (key) named(buttons.get(action), t(key), keys);
      }
      const toggle = buttons.get(TOGGLE);
      toggle.replaceChildren(icon(document, playing ? 'pause' : 'play'));
      named(toggle, t(playing ? 'speech.pause' : 'speech.resume'), 'Space');
      follow.hidden = following;
      followLabel.textContent = t(FOLLOW);
      drawVoices(voices, voiceId);
      bar.hidden = false;
    },
    hide() {
      bar.hidden = true;
    },
  };
}
