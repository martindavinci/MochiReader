// SPDX-License-Identifier: GPL-3.0-or-later
// The real player, extraction and highlight, with a fake engine and a reader that only says what it was told.
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { getLang, setLang } from '../app/core/i18n.js';
import en from '../app/lang/en.js';
import { HIGHLIGHT_NAME } from '../app/speech/highlight.js';
import { caretAt, createSession } from '../app/speech/session.js';
import { withHighlights } from './speech-fakes.js';

const ELSA = { id: 'elsa', name: 'Elsa', lang: 'it-IT' };
const COSIMO = { id: 'cosimo', name: 'Cosimo', lang: 'it-IT' };
const ZIRA = { id: 'zira', name: 'Zira', lang: 'en-US' };
const TWO = '<p data-sourcepos="1:1-1:9">Uno è qui. Due è qui.</p><p data-sourcepos="3:1-3:9">Tre è qui.</p>';
const ITALIAN_TEXT = '<p data-sourcepos="1:1-1:9">Questa è una frase della nota che si legge con la voce.</p>';

const flush = async () => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

function fakeEngine(voices = [ELSA, COSIMO, ZIRA]) {
  let pending = null;
  return {
    calls: [],
    stops: 0,
    voices: async () => voices,
    speak(text, options) {
      this.calls.push({ text, ...options });
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    stop() {
      this.stops += 1;
      pending?.('stopped');
      pending = null;
    },
    finish(outcome = 'end') {
      const settle = pending;
      pending = null;
      settle(outcome);
    },
    get said() {
      return this.calls.map(({ text }) => text);
    },
  };
}

/** A tab with a document. `html` is one section, or the sections of a book in turn. */
function fakeTab(html, { lang = 'it', name = 'a.md', start = { line: 1, sentence: 0 } } = {}) {
  const sections = [html].flat().map((part) => {
    const { document } = parseHTML(`<!doctype html><html><body>${part}</body></html>`);
    withHighlights(document);
    return document;
  });
  let at = 0;
  const callbacks = { hand: [], section: [] };
  const reader = {
    lang,
    spoken: [],
    stopped: 0,
    start,
    speechRoots: async () => [{ root: sections[at].body, section: at }],
    speechStart: () => reader.start,
    speakAt: (place) => reader.spoken.push(place),
    speechStopped: () => {
      reader.stopped += 1;
    },
    onHandMove: (callback) => callbacks.hand.push(callback),
    nextSpeechSection: async () => {
      if (reader.nextFails) throw new Error('no section');
      if (at + 1 >= sections.length) return false;
      at += 1;
      return true;
    },
    prevSpeechSection: async () => {
      if (at === 0) return false;
      at -= 1;
      return true;
    },
  };
  return {
    entry: { reader, path: `C:/x/${name}`, name },
    reader,
    document: () => sections[at],
    sections,
    goToSection: (index) => {
      at = index;
    },
    handMoves: () => callbacks.hand.forEach((callback) => callback()),
  };
}

const sessions = [];
afterEach(() => {
  sessions.splice(0).forEach((session) => session.stop());
  setLang('en');
});

function setup({ voices, state = {}, sourceMode = 'skip', inFront = () => true } = {}) {
  const engine = fakeEngine(voices);
  const saved = [];
  const messages = [];
  const helps = [];
  const commands = [];
  const bar = {
    view: null,
    hidden: 0,
    show(view) {
      this.view = view;
    },
    hide() {
      this.view = null;
      this.hidden += 1;
    },
  };
  let barHandlers;
  const media = {
    log: [],
    playing(title) {
      this.log.push(`playing ${title}`);
    },
    paused() {
      this.log.push('paused');
    },
    stopped() {
      this.log.push('stopped');
    },
    pressKey(action) {
      this.press(action);
    },
    audioPlaying: () => true,
  };
  const session = createSession({
    engine,
    sleep: async () => {},
    makeBar: (handlers) => {
      barHandlers = handlers;
      return bar;
    },
    makeMedia: ({ onPress }) => {
      media.press = onPress;
      return media;
    },
    invoke: async (command, args) => {
      commands.push([command, args]);
      if (command === 'state_get') return { voices: {}, options: {}, ...state };
      return undefined;
    },
    save: (entry) => saved.push(entry),
    isInFront: inFront,
    nameOf: (entry) => entry.name,
    showMessage: (text) => messages.push(text),
    showVoiceHelp: (paragraphs) => helps.push(paragraphs),
    sourceMode: () => sourceMode,
  });
  sessions.push(session);
  return { session, engine, bar, media, saved, messages, helps, commands, handlers: () => barHandlers };
}

test('reading starts where the reader says, and each sentence is shown, followed and saved', async () => {
  const { session, engine, bar, media, saved } = setup();
  const tab = fakeTab(TWO, { start: { line: 1, sentence: 1 } });
  await session.start(tab.entry);
  await flush();
  assert.deepEqual(engine.said, ['Due è qui.']);
  assert.equal(session.active(), true);
  assert.equal(bar.view.name, 'a.md');
  assert.equal(bar.view.playing, true);
  assert.deepEqual(media.log, ['playing a.md']);
  assert.deepEqual(saved, [tab.entry]);
  const [place] = tab.reader.spoken;
  assert.equal(place.line, 1);
  assert.equal(place.sentence, 1);
  assert.equal(place.follow, true);
  assert.equal(place.range.toString(), 'Due è qui.');
  const shown = tab.document().defaultView.CSS.highlights.get(HIGHLIGHT_NAME);
  assert.deepEqual(shown.ranges, [place.range]);
  engine.finish();
  await flush();
  assert.deepEqual(engine.said, ['Due è qui.', 'Tre è qui.']);
  assert.equal(tab.reader.spoken[1].line, 3);
  assert.equal(saved.length, 2);
});

test('a document with nothing to read says so, with no voice and no bar', async () => {
  const { session, engine, bar, messages, media } = setup();
  await session.start(fakeTab('<pre>solo codice</pre>').entry);
  await flush();
  assert.deepEqual(engine.calls, []);
  assert.deepEqual(messages, [en['speech.nothingToRead']]);
  assert.equal(bar.view, null);
  assert.equal(session.active(), false);
  assert.deepEqual(media.log, []);
});

test('with no voice for the language, a message tells how to add one', async () => {
  setLang('en');
  const { session, engine, helps, bar } = setup({ voices: [ZIRA] });
  await session.start(fakeTab(TWO, { lang: 'it' }).entry);
  await flush();
  assert.deepEqual(engine.calls, []);
  assert.equal(helps.length, 1);
  assert.ok(helps[0][0].includes('Add voices'));
  assert.ok(helps[0][0].includes(en['lang.it']));
  assert.equal(helps[0][1], en['speech.hiddenVoice']);
  assert.equal(bar.view, null);
  assert.equal(session.active(), false);
});

test('a language with no name in the app is named by the browser, and a voice list that fails counts as empty', async () => {
  const { session, helps, engine } = setup({ voices: [ZIRA] });
  await session.start(fakeTab(TWO, { lang: 'de' }).entry);
  await flush();
  assert.ok(helps[0][0].includes('German'));
  engine.voices = async () => {
    throw new Error('no list');
  };
  await session.start(fakeTab(TWO, { lang: 'it' }).entry);
  await flush();
  assert.equal(helps.length, 2);
});

test('the language of the document goes to the engine, and without one it is found in the text', async () => {
  const first = setup();
  await first.session.start(fakeTab(TWO, { lang: 'en' }).entry);
  await flush();
  assert.equal(first.engine.calls[0].lang, 'en');
  assert.equal(first.engine.calls[0].voiceId, 'zira');
  const second = setup();
  await second.session.start(fakeTab(ITALIAN_TEXT, { lang: null }).entry);
  await flush();
  assert.equal(second.engine.calls[0].lang, 'it');
  assert.equal(second.engine.calls[0].voiceId, 'elsa');
});

test('text too short to tell goes by the language of the interface', async () => {
  setLang('it');
  const { session, engine } = setup();
  await session.start(fakeTab('<p>Ok.</p>', { lang: null }).entry);
  await flush();
  assert.equal(engine.calls[0].lang, getLang());
});

test('a language tag that is no language goes by the text', async () => {
  const { session, engine } = setup();
  await session.start(fakeTab(ITALIAN_TEXT, { lang: 'und' }).entry);
  await flush();
  assert.equal(engine.calls[0].lang, 'it');
});

test('the last voice of the language is the one used, unless it is gone', async () => {
  const { session, engine } = setup({ state: { voices: { it: 'cosimo' } } });
  await session.start(fakeTab(TWO).entry);
  await flush();
  assert.equal(engine.calls[0].voiceId, 'cosimo');
  const other = setup({ state: { voices: { it: 'gone' } } });
  await other.session.start(fakeTab(TWO).entry);
  await flush();
  assert.equal(other.engine.calls[0].voiceId, 'elsa');
});

test('the bar offers the voices of the language; a choice is kept for the language and for the tab', async () => {
  const { session, engine, bar, commands, handlers } = setup();
  const tab = fakeTab(TWO);
  await session.start(tab.entry);
  await flush();
  assert.deepEqual(bar.view.voices, [ELSA, COSIMO]);
  assert.equal(bar.view.voiceId, 'elsa');
  handlers().onVoice('cosimo');
  await flush();
  assert.deepEqual(commands.at(-1), ['state_set_voice', { lang: 'it', voiceId: 'cosimo' }]);
  assert.equal(engine.calls.at(-1).voiceId, 'cosimo');
  assert.equal(engine.calls.at(-1).text, 'Uno è qui.');
  assert.equal(bar.view.voiceId, 'cosimo');
  session.stop();
  await session.start(tab.entry);
  await flush();
  assert.equal(engine.calls.at(-1).voiceId, 'cosimo');
});

test('a default voice chosen in the options applies at once to a reading in that language', async () => {
  const { session, engine } = setup();
  await session.start(fakeTab(TWO).entry);
  await flush();
  session.defaultVoiceChanged('en', 'zira');
  assert.equal(engine.calls.length, 1);
  session.defaultVoiceChanged('it', 'cosimo');
  await flush();
  assert.equal(engine.calls.at(-1).voiceId, 'cosimo');
});

test('the speed comes from the options, moves along the levels of Windows and is kept', async () => {
  const { session, engine, bar, commands } = setup({ state: { options: { speechRate: 1.3 } } });
  await session.start(fakeTab(TWO).entry);
  await flush();
  assert.equal(engine.calls[0].rate, 1.3);
  session.command('speech.faster');
  await flush();
  assert.equal(engine.calls.at(-1).rate, 1.5);
  assert.equal(engine.calls.at(-1).text, 'Uno è qui.');
  assert.equal(bar.view.rate, 1.5);
  assert.deepEqual(commands.at(-1), ['state_set_option', { name: 'speechRate', value: 1.5 }]);
  session.command('speech.slower');
  session.command('speech.slower');
  assert.equal(bar.view.rate, 1);
});

test('toggling pauses and resumes, with the audio of the media keys following', async () => {
  const { session, engine, bar, media } = setup();
  const tab = fakeTab(TWO);
  await session.start(tab.entry);
  await flush();
  session.command('speech.toggle');
  assert.equal(bar.view.playing, false);
  assert.equal(session.active(), true);
  assert.equal(media.log.at(-1), 'paused');
  session.command('speech.toggle');
  await flush();
  assert.equal(bar.view.playing, true);
  assert.equal(media.log.at(-1), 'playing a.md');
  assert.deepEqual(engine.said, ['Uno è qui.', 'Uno è qui.']);
});

test('starting the tab being read goes on from a pause, and does not restart while reading', async () => {
  const { session, engine } = setup();
  const tab = fakeTab(TWO);
  await session.start(tab.entry);
  await flush();
  await session.start(tab.entry);
  await flush();
  assert.equal(engine.calls.length, 1);
  session.command('speech.toggle');
  await session.start(tab.entry);
  await flush();
  assert.equal(engine.calls.length, 2);
});

test('a media key moves the reading through the one place for presses', async () => {
  const { session, engine, media } = setup();
  await session.start(fakeTab(TWO).entry);
  await flush();
  session.pressKey('speech.nextSentence');
  await flush();
  assert.equal(engine.said.at(-1), 'Due è qui.');
  media.press('speech.toggle');
  assert.equal(session.report(null), null);
  assert.equal(media.log.at(-1), 'paused');
});

test('sentences, blocks and sections move with their commands', async () => {
  const { session, engine } = setup();
  const html = `<h1 data-sourcepos="1:1-1:5">Uno.</h1>${TWO.replaceAll('1:1-1:9', '2:1-2:9').replaceAll('3:1-3:9', '4:1-4:9')}<h1 data-sourcepos="6:1-6:5">Due.</h1><p data-sourcepos="8:1-8:9">Fine è qui.</p>`;
  await session.start(fakeTab(html).entry);
  await flush();
  session.command('speech.nextSentence');
  await flush();
  session.command('speech.nextBlock');
  await flush();
  session.command('speech.prevBlock');
  await flush();
  session.command('speech.nextSection');
  await flush();
  session.command('speech.prevSection');
  await flush();
  session.command('speech.prevSentence');
  await flush();
  assert.deepEqual(engine.said, ['Uno.', 'Uno è qui.', 'Tre è qui.', 'Uno è qui.', 'Due.', 'Uno.', 'Uno.']);
});

test('a click on a sentence jumps there while reading, and only in the tab being read', async () => {
  const { session, engine } = setup();
  const tab = fakeTab(TWO);
  const other = fakeTab(TWO);
  await session.start(tab.entry);
  await flush();
  const [first, second] = tab.document().querySelectorAll('p');
  tab.document().caretPositionFromPoint = () => ({ offsetNode: second.firstChild, offset: 3 });
  session.textClicked(other.entry, { target: first, clientX: 1, clientY: 2 });
  assert.equal(engine.calls.length, 1);
  session.textClicked(tab.entry, { target: first, clientX: 1, clientY: 2 });
  await flush();
  assert.equal(engine.said.at(-1), 'Tre è qui.');
});

test('a click does not start the voice, follow a link twice or undo a selection', async () => {
  const { session, engine } = setup();
  const tab = fakeTab(`${TWO}<p data-sourcepos="5:1-5:9"><a href="#x">Vai lì.</a></p>`);
  const [first] = tab.document().querySelectorAll('p');
  tab.document().caretPositionFromPoint = () => ({ offsetNode: first.firstChild, offset: 0 });
  session.textClicked(tab.entry, { target: first });
  assert.deepEqual(engine.calls, []);
  await session.start(tab.entry);
  await flush();
  session.textClicked(tab.entry, { target: tab.document().querySelector('a') });
  session.textClicked(tab.entry, { target: first, defaultPrevented: true });
  tab.document().getSelection = () => ({ isCollapsed: false });
  session.textClicked(tab.entry, { target: first });
  assert.equal(engine.calls.length, 1);
});

test('a caret comes from whichever way the browser has', () => {
  const node = {};
  assert.deepEqual(caretAt({ caretPositionFromPoint: () => ({ offsetNode: node, offset: 2 }) }, 0, 0), { node, offset: 2 });
  assert.deepEqual(caretAt({ caretRangeFromPoint: () => ({ startContainer: node, startOffset: 3 }) }, 0, 0), { node, offset: 3 });
  assert.equal(caretAt({ caretPositionFromPoint: () => null }, 0, 0), null);
  assert.equal(caretAt({}, 0, 0), null);
});

test('reading from a point starts at the sentence there, and in the tab being read it jumps', async () => {
  const { session, engine } = setup();
  const tab = fakeTab(TWO);
  const [first, second] = tab.document().querySelectorAll('p');
  await session.readFrom(tab.entry, { node: first.firstChild, offset: 13 });
  await flush();
  assert.deepEqual(engine.said, ['Due è qui.']);
  await session.readFrom(tab.entry, { node: second.firstChild, offset: 0 });
  await flush();
  assert.equal(engine.said.at(-1), 'Tre è qui.');
});

test('scrolling by hand lets go of the sentence until the reader asks to follow again', async () => {
  const { session, engine, bar } = setup();
  const tab = fakeTab(TWO);
  await session.start(tab.entry);
  await flush();
  assert.equal(bar.view.following, true);
  tab.handMoves();
  assert.equal(bar.view.following, false);
  engine.finish();
  await flush();
  assert.equal(tab.reader.spoken.at(-1).follow, false);
  session.command('speech.follow');
  assert.equal(bar.view.following, true);
  const last = tab.reader.spoken.at(-1);
  assert.equal(last.follow, true);
  assert.equal(last.range.toString(), 'Due è qui.');
});

test('the hand of a tab not being read changes nothing', async () => {
  const { session, bar } = setup();
  const one = fakeTab(TWO);
  const two = fakeTab(TWO);
  await session.start(one.entry);
  await flush();
  await session.start(two.entry);
  await flush();
  one.handMoves();
  assert.equal(bar.view.following, true);
});

test('a tab in the back takes no scrolling, and coming to the front brings it to the sentence', async () => {
  let front = false;
  const { session } = setup({ inFront: () => front });
  const tab = fakeTab(TWO);
  await session.start(tab.entry);
  await flush();
  assert.equal(tab.reader.spoken.at(-1).follow, false);
  front = true;
  session.tabShown(tab.entry);
  assert.equal(tab.reader.spoken.at(-1).follow, true);
  const count = tab.reader.spoken.length;
  session.tabShown(fakeTab(TWO).entry);
  assert.equal(tab.reader.spoken.length, count);
});

test('one tab reads at a time: starting another stops the first, and the bar says which', async () => {
  const { session, engine, bar } = setup();
  const one = fakeTab(TWO, { name: 'uno.md' });
  const two = fakeTab(TWO, { name: 'due.md' });
  await session.start(one.entry);
  await flush();
  await session.start(two.entry);
  await flush();
  assert.equal(bar.view.name, 'due.md');
  assert.equal(one.reader.stopped, 1);
  assert.equal(engine.stops, 1);
  assert.equal(engine.calls.length, 2);
});

test('closing the tab being read stops everything, and closing another stops nothing', async () => {
  const { session, bar, engine, media } = setup();
  const one = fakeTab(TWO);
  const two = fakeTab(TWO);
  await session.start(one.entry);
  await flush();
  session.tabClosed(two.entry);
  assert.equal(session.active(), true);
  session.tabClosed(one.entry);
  assert.equal(session.active(), false);
  assert.equal(bar.view, null);
  assert.equal(engine.stops, 1);
  assert.equal(media.log.at(-1), 'stopped');
  assert.equal(one.document().defaultView.CSS.highlights.has(HIGHLIGHT_NAME), false);
});

test('the end of the file stops and opens nothing; starting again goes from the top', async () => {
  const { session, engine, bar, media } = setup();
  const tab = fakeTab(TWO);
  await session.start(tab.entry);
  await flush();
  for (let sentence = 0; sentence < 3; sentence += 1) {
    engine.finish();
    await flush();
  }
  assert.equal(session.active(), false);
  assert.equal(bar.view, null);
  assert.equal(media.log.at(-1), 'stopped');
  assert.equal(tab.reader.stopped, 1);
  assert.equal(engine.calls.length, 3);
  tab.reader.start = { line: 3, sentence: 0 };
  await session.start(tab.entry);
  await flush();
  assert.equal(engine.said.at(-1), 'Uno è qui.');
});

test('a book goes on by itself to its next section, with the highlight in the new frame', async () => {
  const { session, engine, media, saved } = setup();
  const book = fakeTab(['<p>Uno è qui.</p>', '<p>Due è qui.</p>'], { start: null });
  await session.start(book.entry);
  await flush();
  const first = book.document();
  engine.finish();
  await flush();
  assert.deepEqual(engine.said, ['Uno è qui.', 'Due è qui.']);
  assert.equal(media.log.includes('stopped'), false);
  assert.equal(session.active(), true);
  assert.equal(saved.length, 2);
  assert.equal(first.defaultView.CSS.highlights.get(HIGHLIGHT_NAME).ranges[0].toString(), 'Due è qui.', 'a linkedom window is shared');
  engine.finish();
  await flush();
  assert.equal(session.active(), false);
});

test('a section with nothing to read is passed over, and a book with nothing says so', async () => {
  const { session, engine, messages } = setup();
  const book = fakeTab(['<pre>copertina</pre>', '<p>Uno è qui.</p>'], { start: null });
  await session.start(book.entry);
  await flush();
  assert.deepEqual(engine.said, ['Uno è qui.']);
  session.stop();
  await session.start(fakeTab(['<pre>a</pre>', '<pre>b</pre>'], { start: null }).entry);
  await flush();
  assert.deepEqual(messages, [en['speech.nothingToRead']]);
  assert.equal(session.active(), false);
});

test('a next section that cannot be shown stops with a message', async () => {
  const { session, engine, messages, bar } = setup();
  const book = fakeTab(['<p>Uno è qui.</p>', '<p>Due è qui.</p>'], { start: null });
  book.reader.nextFails = true;
  await session.start(book.entry);
  await flush();
  const warn = console.warn;
  console.warn = () => {};
  engine.finish();
  await flush();
  console.warn = warn;
  assert.deepEqual(messages, [en['speech.sectionError']]);
  assert.equal(bar.view, null);
  assert.equal(session.active(), false);
});

test('stopping while the next section comes reads no more', async () => {
  const { session, engine } = setup();
  const book = fakeTab(['<p>Uno è qui.</p>', '<p>Due è qui.</p>'], { start: null });
  await session.start(book.entry);
  await flush();
  engine.finish();
  session.stop();
  await flush();
  assert.deepEqual(engine.said, ['Uno è qui.']);
  assert.equal(session.active(), false);
});

test('in a pause, a move past the end of the section stays silent in the next one', async () => {
  const { session, engine, bar } = setup();
  const book = fakeTab(['<p>Uno è qui.</p>', '<p>Due è qui.</p>'], { start: null });
  await session.start(book.entry);
  await flush();
  session.command('speech.toggle');
  session.command('speech.nextSentence');
  await flush();
  assert.deepEqual(engine.said, ['Uno è qui.']);
  assert.equal(bar.view.playing, false);
  assert.equal(session.active(), true);
  assert.equal(book.reader.spoken.at(-1).range.toString(), 'Due è qui.');
  session.command('speech.toggle');
  await flush();
  assert.equal(engine.said.at(-1), 'Due è qui.');
});

test('going back from the start of a section goes to the section before', async () => {
  const { session, engine } = setup();
  const book = fakeTab(['<p>Uno è qui.</p>', '<p>Due è qui.</p>'], { start: null });
  book.goToSection(1);
  await session.start(book.entry);
  await flush();
  session.command('speech.prevSection');
  await flush();
  assert.equal(engine.said.at(-1), 'Uno è qui.');
  session.command('speech.prevSection');
  await flush();
  assert.equal(engine.said.at(-1), 'Uno è qui.');
  assert.equal(session.active(), true);
});

test('another section coming on screen takes the voice there, but its own move does not count', async () => {
  const { session, engine, bar } = setup();
  const book = fakeTab(['<p>Uno è qui.</p>', '<p>Due è qui.</p>', '<p>Tre è qui.</p>'], { start: null });
  let tell = () => {};
  book.reader.onSectionShown = (callback) => {
    tell = callback;
  };
  const next = book.reader.nextSpeechSection;
  book.reader.nextSpeechSection = async () => {
    const moved = await next();
    tell();
    return moved;
  };
  await session.start(book.entry);
  await flush();
  engine.finish();
  await flush();
  assert.deepEqual(engine.said, ['Uno è qui.', 'Due è qui.']);
  book.goToSection(2);
  tell();
  await flush();
  assert.equal(engine.said.at(-1), 'Tre è qui.');
  assert.equal(engine.calls.length, 3);
  assert.equal(bar.view.following, true);
});

test('moving the reader on purpose takes the voice there, and in a pause keeps it silent', async () => {
  const { session, engine, bar } = setup();
  const tab = fakeTab(TWO);
  await session.start(tab.entry);
  await flush();
  tab.reader.start = { line: 3, sentence: 0 };
  await session.readerMoved(tab.entry);
  await flush();
  assert.equal(engine.said.at(-1), 'Tre è qui.');
  session.command('speech.toggle');
  const count = engine.calls.length;
  tab.reader.start = { line: 1, sentence: 0 };
  await session.readerMoved(tab.entry);
  await flush();
  assert.equal(engine.calls.length, count);
  assert.equal(bar.view.playing, false);
  assert.equal(tab.reader.spoken.at(-1).range.toString(), 'Uno è qui.');
  await session.readerMoved(fakeTab(TWO).entry);
  assert.equal(engine.calls.length, count);
});

test('a new reader for the tab, after the file changed, goes on with the new text', async () => {
  const { session, engine } = setup();
  const tab = fakeTab(TWO);
  await session.start(tab.entry);
  await flush();
  const replacement = fakeTab('<p data-sourcepos="1:1-1:9">Testo nuovo.</p>');
  tab.entry.reader = replacement.reader;
  await session.readerMoved(tab.entry);
  await flush();
  assert.equal(engine.said.at(-1), 'Testo nuovo.');
  assert.equal(replacement.reader.spoken.length, 1);
});

test('an engine error stops once with a message, and the position stays where it was', async () => {
  const { session, engine, messages, bar, saved } = setup();
  const tab = fakeTab(TWO);
  await session.start(tab.entry);
  await flush();
  engine.finish();
  await flush();
  engine.finish('error');
  await flush();
  assert.deepEqual(messages, [en['speech.error']]);
  assert.equal(bar.view, null);
  assert.equal(session.active(), false);
  assert.equal(tab.reader.stopped, 1);
  assert.equal(tab.reader.spoken.at(-1).range.toString(), 'Due è qui.');
  assert.equal(saved.length, 2);
});

test('sources are read or skipped as the options say', async () => {
  const html = '<ul><li data-sourcepos="1:1-1:9">Notizia vera (<a href="https://www.theverge.com/x">fonte</a>)</li></ul>';
  const skipping = setup();
  await skipping.session.start(fakeTab(html).entry);
  await flush();
  skipping.engine.finish();
  await flush();
  assert.deepEqual(skipping.engine.said, ['Notizia vera']);
  const naming = setup({ sourceMode: 'name' });
  await naming.session.start(fakeTab(html).entry);
  await flush();
  naming.engine.finish();
  await flush();
  assert.deepEqual(naming.engine.said, ['Notizia vera', 'Fonte: theverge']);
});

test('text the app added has no range, and the highlight goes', async () => {
  const html = '<ul><li data-sourcepos="1:1-1:9">Notizia vera (<a href="https://www.theverge.com/x">fonte</a>)</li></ul>';
  const { session, engine } = setup({ sourceMode: 'name' });
  const tab = fakeTab(html);
  await session.start(tab.entry);
  await flush();
  engine.finish();
  await flush();
  assert.equal(tab.reader.spoken.at(-1).range, null);
  assert.equal(tab.document().defaultView.CSS.highlights.has(HIGHLIGHT_NAME), false);
});

test('starting and stopping at once reads nothing, and a second start wins over the first', async () => {
  const { session, engine, bar } = setup();
  const one = fakeTab(TWO, { name: 'uno.md' });
  const two = fakeTab(TWO, { name: 'due.md' });
  const started = session.start(one.entry);
  session.stop();
  await started;
  await flush();
  assert.deepEqual(engine.calls, []);
  assert.equal(session.active(), false);
  const first = session.start(one.entry);
  const second = session.start(two.entry);
  await Promise.all([first, second]);
  await flush();
  assert.equal(engine.calls.length, 1);
  assert.equal(bar.view.name, 'due.md');
});

test('a tab with no reader has nothing to start', async () => {
  const { session, engine } = setup();
  await session.start({ reader: null, path: 'x' });
  await session.start(null);
  await flush();
  assert.deepEqual(engine.calls, []);
});

test('the report says what is going on in the tab being read', async () => {
  const { session } = setup();
  const tab = fakeTab(TWO);
  assert.equal(session.report(tab.entry), null);
  await session.start(tab.entry);
  await flush();
  const report = session.report(tab.entry);
  assert.equal(report.state, 'playing');
  assert.deepEqual(report.current, { block: 0, sentence: 0 });
  assert.equal(report.sentence, 'Uno è qui.');
  assert.equal(report.lang, 'it');
  assert.equal(report.voice, 'elsa');
  assert.equal(report.rate, 1);
  assert.equal(report.following, true);
  assert.equal(report.audioPlaying, true);
  assert.deepEqual(report.highlight, ['Uno è qui.']);
  assert.equal(session.report(fakeTab(TWO).entry), null);
});

test('a document of many parts is read as one, and the page gets its turns while it is prepared', async () => {
  const { session, engine } = setup();
  const tab = fakeTab('<div><p data-sourcepos="1:1-1:9">Uno è qui.</p></div><div><p data-sourcepos="3:1-3:9">Due è qui.</p></div>');
  const parts = [...tab.document().body.children];
  tab.reader.speechRoots = async () => parts.map((root) => ({ root, section: null }));
  const now = mock.method(performance, 'now', () => now.mock.callCount() * 100);
  let turns = 0;
  const realSetTimeout = globalThis.setTimeout;
  const timeout = mock.method(globalThis, 'setTimeout', (callback, ms) => {
    if (ms === undefined) turns += 1;
    return realSetTimeout(callback, ms);
  });
  await session.start(tab.entry);
  await flush();
  now.mock.restore();
  timeout.mock.restore();
  assert.ok(turns > 0);
  assert.deepEqual(engine.said, ['Uno è qui.']);
  engine.finish();
  await flush();
  assert.equal(engine.said.at(-1), 'Due è qui.');
});

test('stopping while a long document is prepared reads nothing of it', async () => {
  const { session, engine } = setup();
  const tab = fakeTab('<div><p>Uno è qui.</p></div><div><p>Due è qui.</p></div>', { start: null });
  const parts = [...tab.document().body.children];
  tab.reader.speechRoots = async () => parts.map((root) => ({ root, section: null }));
  const now = mock.method(performance, 'now', () => now.mock.callCount() * 100);
  const started = session.start(tab.entry);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  session.stop();
  await started;
  await flush();
  now.mock.restore();
  assert.deepEqual(engine.calls, []);
});
