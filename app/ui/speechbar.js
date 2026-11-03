// SPDX-License-Identifier: GPL-3.0-or-later
// Loads with the first reading or the first menu of the text, never with the first frame.
import { t } from '../core/i18n.js';

const BAR_ID = 'speechbar';
const MENU_CLASS = 'text-menu';
const TOGGLE = 'speech.toggle';
const FOLLOW = 'speech.follow';
const PAUSE_MARK = '❚❚';
const PLAY_MARK = '▶';

// What each button shows, and the name of its text in the interface, in the order of the bar.
const BUTTONS = [
  ['speech.prevSentence', '‹', 'speech.prevSentence'],
  // Which one depends on the state.
  [TOGGLE, PAUSE_MARK, null],
  ['speech.nextSentence', '›', 'speech.nextSentence'],
  ['speech.slower', '−', 'speech.slower'],
  ['speech.rate', null, null],
  ['speech.faster', '+', 'speech.faster'],
  ['speech.stop', '■', 'speech.stop'],
];

const made = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

function labelled(button, text) {
  button.setAttribute('title', text);
  button.setAttribute('aria-label', text);
}

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
  const name = made('span', 'speech-name');
  const buttons = new Map();
  const button = (action, mark, className) => {
    const element = made('button', className, mark);
    element.setAttribute('data-action', action);
    element.addEventListener('mousedown', keepFocusOnText);
    element.addEventListener('click', () => onCommand(action));
    buttons.set(action, element);
    return element;
  };
  const controls = BUTTONS.map(([action, mark]) => (mark ? button(action, mark) : made('span', 'speech-rate')));
  const [rate] = controls.filter((control) => control.className === 'speech-rate');
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
  const follow = button(FOLLOW, '', 'speech-follow');
  bar.append(name, follow, ...controls, voice);
  document.getElementById('panes').after(bar);

  const drawVoices = (voices, voiceId) => {
    voice.replaceChildren(...voices.map(({ id, name: voiceName }) => {
      const option = made('option', undefined, voiceName);
      option.setAttribute('value', id);
      if (id === voiceId) option.setAttribute('selected', '');
      return option;
    }));
    labelled(voice, t('speech.voice'));
  };

  return {
    show({ name: fileName, playing, rate: speed, voices, voiceId, following }) {
      name.textContent = t('speech.reading', { name: fileName });
      name.setAttribute('title', name.textContent);
      rate.textContent = t('speech.rate', { rate: speed });
      for (const [action, , key] of BUTTONS) {
        if (key) labelled(buttons.get(action), t(key));
      }
      const toggle = buttons.get(TOGGLE);
      toggle.textContent = playing ? PAUSE_MARK : PLAY_MARK;
      labelled(toggle, t(playing ? 'speech.pause' : 'speech.resume'));
      follow.hidden = following;
      follow.textContent = t(FOLLOW);
      drawVoices(voices, voiceId);
      bar.hidden = false;
    },
    hide() {
      bar.hidden = true;
    },
  };
}

/**
 * The menu of the text: the one thing it offers is to read from there. It leaves with the focus, which a click anywhere
 * takes, even in the frame of a book where no event of the page can see it.
 * @param {Document} page
 * @param {{x: number, y: number}} at In the window of `page`.
 * @param {() => void} onRead
 */
export function openTextMenu(page, { x, y }, onRead) {
  page.querySelector(`.${MENU_CLASS}`)?.remove();
  const menu = page.createElement('div');
  menu.className = MENU_CLASS;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const read = page.createElement('button');
  read.textContent = t('speech.readFromHere');
  // Removing it takes the focus from it, which would ask for the same again while it is leaving.
  const leave = () => {
    read.removeEventListener('blur', leave);
    menu.remove();
  };
  read.addEventListener('click', () => {
    leave();
    onRead();
  });
  read.addEventListener('blur', leave);
  menu.append(read);
  page.body.append(menu);
  read.focus();
}
