// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The media keys of the keyboard. `speechSynthesis` registers nothing with Windows, so while reading a silent <audio>
 * really plays: that makes this page a media session, which gets the keys even with the window minimised.
 */

/** A press in front arrives both as a key and as an action of the session, in either order, this close together. */
export const MEDIA_PRESS_WINDOW_MS = 300;

const SILENCE_RATE = 8000;
const SILENCE_SECONDS = 2;
const SILENCE_SAMPLE = 128;
const WAV_HEADER_BYTES = 44;
const WAV_TYPE = 'audio/wav';
const PCM = 1;
const MONO = 1;
const BITS_PER_SAMPLE = 8;
const FORMAT_BYTES = 16;
const FROM_KEY = 'key';
const FROM_ACTION = 'action';

const ACTIONS = {
  play: 'speech.toggle',
  pause: 'speech.toggle',
  nexttrack: 'speech.nextSentence',
  previoustrack: 'speech.prevSentence',
};

/** @returns {ArrayBuffer} A WAV file of silence. */
export function silentWav() {
  const samples = SILENCE_RATE * SILENCE_SECONDS;
  const wav = new ArrayBuffer(WAV_HEADER_BYTES + samples);
  const view = new DataView(wav);
  const write = (at, text) => [...text].forEach((letter, index) => view.setUint8(at + index, letter.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, wav.byteLength - 8, true);
  write(8, 'WAVEfmt ');
  view.setUint32(16, FORMAT_BYTES, true);
  view.setUint16(20, PCM, true);
  view.setUint16(22, MONO, true);
  view.setUint32(24, SILENCE_RATE, true);
  view.setUint32(28, SILENCE_RATE, true);
  view.setUint16(32, MONO, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  write(36, 'data');
  view.setUint32(40, samples, true);
  new Uint8Array(wav, WAV_HEADER_BYTES).fill(SILENCE_SAMPLE);
  return wav;
}

const browserParts = () => ({
  mediaSession: navigator.mediaSession,
  makeAudio: () => document.createElement('audio'),
  makeSilenceUrl: () => URL.createObjectURL(new Blob([silentWav()], { type: WAV_TYPE })),
  releaseUrl: (url) => URL.revokeObjectURL(url),
  makeMetadata: (data) => new MediaMetadata(data),
});

/**
 * @param {{onPress: (action: string) => void}} handlers `onPress` gets one action for each press, however it came.
 * @param {object} [parts] What it uses of the browser.
 */
export function createMediaKeys({ onPress, ...given }) {
  const { mediaSession, makeAudio, makeSilenceUrl, releaseUrl, makeMetadata } = given.makeAudio ? given : browserParts();
  let audio = null;
  let silenceUrl = null;
  let last = { action: null, from: null, at: -Infinity };

  /** The one place a press comes through. Whichever way it comes second, it is the same press. */
  const press = (action, from) => {
    const now = Date.now();
    const samePress = last.action === action && last.from !== from && now - last.at <= MEDIA_PRESS_WINDOW_MS;
    last = samePress ? { action: null, from: null, at: -Infinity } : { action, from, at: now };
    if (!samePress) onPress(action);
  };

  const setHandlers = (on) => {
    if (!mediaSession) return;
    for (const [name, action] of Object.entries(ACTIONS)) {
      mediaSession.setActionHandler(name, on ? () => press(action, FROM_ACTION) : null);
    }
  };

  return {
    /** @param {string} title What Windows shows as playing. */
    playing(title) {
      if (!audio) {
        silenceUrl = makeSilenceUrl();
        audio = makeAudio();
        audio.loop = true;
        audio.src = silenceUrl;
        setHandlers(true);
      }
      audio.play()?.catch((error) => console.warn(error));
      if (!mediaSession) return;
      if (mediaSession.metadata?.title !== title) mediaSession.metadata = makeMetadata({ title });
      mediaSession.playbackState = 'playing';
    },
    /** The state alone would not do: while the element plays, Windows only ever offers pause. */
    paused() {
      audio?.pause();
      if (mediaSession) mediaSession.playbackState = 'paused';
    },
    stopped() {
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        releaseUrl(silenceUrl);
      }
      audio = null;
      silenceUrl = null;
      setHandlers(false);
      if (!mediaSession) return;
      mediaSession.metadata = null;
      mediaSession.playbackState = 'none';
    },
    /** @param {string} action What a media key pressed in this page means. */
    pressKey: (action) => press(action, FROM_KEY),
    /** Only the report of the tabs asks. */
    audioPlaying: () => Boolean(audio && !audio.paused),
  };
}
