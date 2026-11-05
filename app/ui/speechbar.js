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
// The speeds offered with one click, where the voice has them.
const PRESET_RATES = [1, 1.5, 2, 2.5, 3, 3.5, 4];
const PERCENT = 100;
const VOLUME_STEP = 5;
const EDGE_PX = 8;

const made = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

/** The arrows and space stay with the text: a button pressed with the mouse must not keep the focus. */
const keepFocusOnText = (event) => event.preventDefault();

/**
 * Speed and volume, over the bar, opened from the speed or the volume button. It leaves with the focus.
 * @param {{onRate: (rate: number) => void, onVolume: (volume: number) => void}} handlers
 */
function createSoundPanel({ onRate, onVolume }) {
  const panel = made('div', 'speech-sound');
  panel.setAttribute('role', 'dialog');
  panel.hidden = true;
  let rates = [];
  let rate = 1;

  const row = (labelKey) => {
    const line = made('div', 'sound-row');
    const label = made('span', 'sound-label');
    const value = made('output', 'sound-value');
    line.append(label, value);
    return { line, label, value, labelKey };
  };
  const speedRow = row('speech.speed');
  const speed = made('input', 'sound-speed');
  speed.setAttribute('type', 'range');
  speed.setAttribute('min', '0');
  speed.setAttribute('step', '1');
  const presets = made('div', 'sound-presets');
  const volumeRow = row('speech.volume');
  const volume = made('input', 'sound-volume');
  volume.setAttribute('type', 'range');
  volume.setAttribute('min', '0');
  volume.setAttribute('max', String(PERCENT));
  volume.setAttribute('step', String(VOLUME_STEP));
  panel.append(speedRow.line, speed, presets, volumeRow.line, volume);

  const rateText = (value) => t('speech.rate', { rate: value });
  const volumeText = (value) => t('speech.volumeValue', { value });
  speed.addEventListener('input', () => {
    speedRow.value.textContent = rateText(rates[Number(speed.value)]);
  });
  speed.addEventListener('change', () => onRate(rates[Number(speed.value)]));
  volume.addEventListener('input', () => {
    volumeRow.value.textContent = volumeText(volume.value);
  });
  volume.addEventListener('change', () => onVolume(Number(volume.value) / PERCENT));
  panel.addEventListener('focusout', ({ relatedTarget }) => {
    if (!relatedTarget || !panel.contains(relatedTarget)) panel.hidden = true;
  });

  return {
    element: panel,
    /** @param {{rate: number, rates: number[], volume: number}} view */
    update(view) {
      rates = view.rates;
      rate = view.rate;
      panel.setAttribute('aria-label', t('speech.sound'));
      speedRow.label.textContent = t(speedRow.labelKey);
      volumeRow.label.textContent = t(volumeRow.labelKey);
      speed.setAttribute('max', String(rates.length - 1));
      named(speed, t('speech.speed'));
      named(volume, t('speech.volume'));
      // What a hand is moving stays as the hand puts it.
      if (panel.ownerDocument.activeElement !== speed) {
        speed.value = String(Math.max(rates.indexOf(rate), 0));
        speedRow.value.textContent = rateText(rate);
      }
      if (panel.ownerDocument.activeElement !== volume) {
        volume.value = String(Math.round(view.volume * PERCENT));
        volumeRow.value.textContent = volumeText(Math.round(view.volume * PERCENT));
      }
      presets.replaceChildren(...PRESET_RATES.filter((value) => rates.includes(value)).map((value) => {
        const choice = made('button', undefined, rateText(value));
        if (value === rate) choice.setAttribute('aria-pressed', 'true');
        choice.addEventListener('click', () => onRate(value));
        return choice;
      }));
    },
    /** @param {HTMLElement} anchor What it opens over. @param {'speed'|'volume'} part What takes the focus. */
    toggle(anchor, part) {
      if (!panel.hidden) {
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      const host = panel.offsetParent;
      const half = panel.offsetWidth / 2;
      const middle = anchor.offsetLeft + anchor.offsetWidth / 2;
      const room = host?.clientWidth ?? Infinity;
      panel.style.left = `${Math.min(Math.max(middle, half + EDGE_PX), room - half - EDGE_PX)}px`;
      (part === 'volume' ? volume : speed).focus();
    },
  };
}

/**
 * The bar of a reading: only there while there is one.
 * @param {{onCommand: (action: string) => void, onVoice: (voiceId: string) => void, onRate?: (rate: number) => void,
 *   onVolume?: (volume: number) => void}} handlers
 * @returns {{show: (view: object) => void, hide: () => void}}
 */
export function createSpeechBar({ onCommand, onVoice, onRate = () => {}, onVolume = () => {} }) {
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
  const sound = createSoundPanel({ onRate, onVolume });
  const rate = made('button', 'speech-rate');
  rate.setAttribute('aria-haspopup', 'dialog');
  rate.addEventListener('mousedown', keepFocusOnText);
  rate.addEventListener('click', () => sound.toggle(rate, 'speed'));
  const loudness = made('button', 'speech-loudness');
  loudness.setAttribute('aria-haspopup', 'dialog');
  loudness.append(icon(document, 'speaker'));
  loudness.addEventListener('mousedown', keepFocusOnText);
  loudness.addEventListener('click', () => sound.toggle(loudness, 'volume'));
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
  voiceZone.append(loudness, voice);

  const follow = made('button', 'speech-follow');
  follow.setAttribute('data-action', FOLLOW);
  follow.addEventListener('mousedown', keepFocusOnText);
  follow.addEventListener('click', () => onCommand(FOLLOW));
  buttons.set(FOLLOW, follow);
  const followLabel = made('span');
  follow.append(icon(document, 'down'), followLabel);

  bar.append(follow, sound.element, about, transport, voiceZone);
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
    show({ name: fileName, playing, rate: speed, rates = [speed], volume = 1, voices, voiceId, following, elsewhere = false }) {
      status.textContent = t(elsewhere ? 'speech.elsewhere' : playing ? 'speech.reading' : 'speech.paused');
      name.textContent = fileName;
      name.setAttribute('title', fileName);
      goToTab.textContent = t('speech.goToTab');
      goToTab.hidden = !elsewhere;
      rate.textContent = t('speech.rate', { rate: speed });
      named(rate, t('speech.sound'));
      named(loudness, `${t('speech.volume')} ${t('speech.volumeValue', { value: Math.round(volume * PERCENT) })}`);
      sound.update({ rate: speed, rates, volume });
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
