// SPDX-License-Identifier: GPL-3.0-or-later
// Only what a test run sends through the smoke build reaches this. A release has no way to ask for it.

/** However a test asks, a test never speaks up: someone may be using this machine. */
const MAX_TEST_VOLUME = 0.1;
const LOG_COMMAND = 'smoke_speech_log';
const MEDIA_PREFIX = 'media.';
const KEY_PREFIX = 'key.';
// One press as Windows tells it with the window in front: as a key in the page and as an action of the session.
const PRESS_PREFIX = 'press.';
const VOICE_GONE = 'voice-gone';
const GONE_VOICE_ID = 'a voice that was removed';
const NOTE_LANGUAGE = 'it';

const mediaHandlers = new Map();
let watching = false;

/** The page has no way to read back what it gave the media session, so this keeps a copy on the way in. */
function watchMediaHandlers() {
  const session = navigator.mediaSession;
  if (watching || !session) return;
  watching = true;
  const set = session.setActionHandler.bind(session);
  session.setActionHandler = (name, handler) => {
    if (handler) mediaHandlers.set(name, handler);
    else mediaHandlers.delete(name);
    set(name, handler);
  };
}

let writeLog = () => {};

/** A start asked for by the test: what comes before it is no delay of the voice. */
export const markRestart = () => writeLog('restart', '');

/**
 * @param {{engine: object}} session
 * @param {{volume?: string|null, log?: string|null}} settings
 * @param {(command: string, args: object) => Promise<*>} invoke
 */
export function applySpeechTest({ engine }, { volume, log }, invoke) {
  watchMediaHandlers();
  if (volume !== null && volume !== undefined) engine.volume = Math.min(Number(volume), MAX_TEST_VOLUME);
  if (log) {
    writeLog = (event, text) => {
      const line = JSON.stringify({ at: Date.now(), event, chars: text.length });
      invoke(LOG_COMMAND, { out: log, line });
    };
    engine.onTrace = writeLog;
  }
}

const pressKey = (key) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  (document.activeElement ?? document).dispatchEvent(event);
};

/**
 * @param {string} command `media.<action>` calls what the media session has for it, `key.<name>` presses a key in this
 *   page alone, and `press.<name>.<action>` does both at once: none can reach another program. `voice-gone` asks for a
 *   voice Windows no longer has. Anything else is the name of a command of the session.
 * @param {{command: (action: string) => void, defaultVoiceChanged: (lang: string, voiceId: string) => void}} session
 */
export function runSpeechTest(command, session) {
  if (command.startsWith(MEDIA_PREFIX)) {
    mediaHandlers.get(command.slice(MEDIA_PREFIX.length))?.();
  } else if (command.startsWith(KEY_PREFIX)) {
    pressKey(command.slice(KEY_PREFIX.length));
  } else if (command.startsWith(PRESS_PREFIX)) {
    const [key, action] = command.slice(PRESS_PREFIX.length).split('.');
    pressKey(key);
    mediaHandlers.get(action)?.();
  } else if (command === VOICE_GONE) {
    session.defaultVoiceChanged(NOTE_LANGUAGE, GONE_VOICE_ID);
  } else {
    session.command(command);
  }
}
