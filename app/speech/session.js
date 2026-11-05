// SPDX-License-Identifier: GPL-3.0-or-later
// Loads with the first reading, not with the app: this module brings all of app/speech with it.
import { getLang, t } from '../core/i18n.js';
import { closestVoice, languageName, WebSpeechEngine } from './engine-web.js';
import { extractBlocks } from './extract.js';
import { createHighlighter, HIGHLIGHT_NAME } from './highlight.js';
import { detectLang, parseLangTag } from './lang.js';
import { createMediaKeys } from './media-keys.js';
import { lineOfPlace, placeOfLine, sentenceAt, sentenceFrom, sentenceRange } from './place.js';
import { ERROR_ENGINE, nextRate, prevRate, SpeechPlayer } from './player.js';
import { caretAt } from '../core/caret.js';
import { createSpeechBar } from '../ui/speechbar.js';

const STATE_PLAYING = 'playing';
const STATE_PAUSED = 'paused';
const STATE_ENDED = 'ended';
const STATE_IDLE = 'idle';
const OPTION_RATE = 'speechRate';
const LINK = 'a[href]';
// Preparing the text of a very large document takes its time: the page works this long, then lets others have a turn.
const PREPARE_SLICE_MS = 8;
const TOP = { block: 0, sentence: 0 };
const LAST = { block: Infinity, sentence: Infinity };

const nextTurn = () => new Promise((resolve) => {
  setTimeout(resolve);
});

/** Turns a point or a place of the reader into a place in the blocks. */
function placeFor(blocks, from) {
  if (!from) return TOP;
  if (from.exact) return sentenceAt(blocks, from.node, from.offset) ?? LAST;
  if (from.node) return sentenceFrom(blocks, from.node, from.offset) ?? TOP;
  return placeOfLine(blocks, from);
}

/**
 * One document read aloud at a time: the player, what it reads, the highlight, the bar, the media keys, and what the
 * reader of the tab has to hear about it.
 */
class SpeechSession {
  #engine;
  #player;
  #bar;
  #media;
  #highlighter = createHighlighter();
  #invoke;
  #save;
  #isInFront;
  #nameOf;
  #showMessage;
  #showVoiceHelp;
  #showEntry;
  #onReading;
  #sourceMode;
  /** The tab being read, from the moment it was asked for. */
  #entry = null;
  #blocks = [];
  #lang = null;
  #voices = [];
  #voiceId = null;
  #savedVoices = {};
  #following = true;
  /** Whether the bar and the audio of the media keys are out, which a reading that never began does not reach. */
  #shown = false;
  /** Bumped to drop a change under way: whatever waits on a reader or the state checks it when it comes back. */
  #run = 0;
  /** The player is between two documents, which its own state cannot tell from having stopped. */
  #switching = false;
  /** The state before the end of a section. In a pause the next one is not to make a sound. */
  #wasPaused = false;
  /** The tab that was read to its end: to start it again is to start from the top. */
  #finished = null;
  #tabVoices = new WeakMap();
  #watched = new WeakSet();

  constructor({
    engine = new WebSpeechEngine(),
    sleep,
    makeBar = createSpeechBar,
    makeMedia = createMediaKeys,
    invoke,
    save,
    isInFront,
    nameOf,
    showMessage,
    showVoiceHelp,
    showEntry = () => {},
    onReading = () => {},
    sourceMode,
  }) {
    this.#engine = engine;
    this.#invoke = invoke;
    this.#save = save;
    this.#isInFront = isInFront;
    this.#nameOf = nameOf;
    this.#showMessage = showMessage;
    this.#showVoiceHelp = showVoiceHelp;
    this.#showEntry = showEntry;
    this.#onReading = onReading;
    this.#sourceMode = sourceMode;
    this.#player = new SpeechPlayer({
      engine,
      sleep,
      onSentence: (at, sentence) => this.#onSentence(at, sentence),
      onState: (state) => this.#onState(state),
      onError: (code) => this.#onError(code),
    });
    this.#media = makeMedia({ onPress: (action) => this.command(action) });
    this.#bar = makeBar({
      onCommand: (action) => this.command(action),
      onVoice: (voiceId) => this.#chooseVoice(voiceId),
    });
  }

  /** What a test run needs to reach. */
  get engine() {
    return this.#engine;
  }

  /** @returns {boolean} Whether a tab is being read, even in a pause. */
  active() {
    return this.#entry !== null;
  }

  /** Reads the tab from where its reader is. A tab already being read goes on. */
  async start(entry) {
    if (!entry?.reader) return;
    if (this.#entry === entry) {
      this.#player.resume();
      return;
    }
    const from = this.#finished === entry ? null : entry.reader.speechStart();
    await this.#begin(entry, from);
  }

  /** @param {{node: Node, offset: number}|null} point Where the reader asked to read from. */
  async readFrom(entry, point) {
    if (!entry?.reader) return;
    const from = point && { ...point, exact: true };
    if (this.#entry === entry && !this.#switching) this.#player.jumpTo(placeFor(this.#blocks, from));
    else await this.#begin(entry, from);
  }

  /** The same from a point of the window of `doc`, which the menu of the text remembers. */
  readFromScreen(entry, doc, x, y) {
    return this.readFrom(entry, caretAt(doc, x, y));
  }

  stop() {
    this.#run += 1;
    this.#switching = false;
    if (this.#player.state !== STATE_IDLE) this.#player.stop();
    if (this.#entry) this.#closeReading();
  }

  /** @param {string} action A name from `core/keys.js`, or `speech.stop` or `speech.follow` from the bar. */
  command(action) {
    if (!this.active() || this.#switching) return;
    const player = this.#player;
    const commands = {
      'speech.toggle': () => (player.state === STATE_PLAYING ? player.pause() : player.resume()),
      'speech.stop': () => this.stop(),
      'speech.nextSentence': () => player.nextSentence(),
      'speech.prevSentence': () => player.prevSentence(),
      'speech.nextBlock': () => player.nextBlock(),
      'speech.prevBlock': () => player.prevBlock(),
      'speech.nextSection': () => player.nextSection(),
      'speech.prevSection': () => this.#prevSection(),
      'speech.faster': () => this.#setRate(nextRate(player.rate)),
      'speech.slower': () => this.#setRate(prevRate(player.rate)),
      'speech.follow': () => this.#follow(),
      'speech.goToTab': () => this.#showEntry(this.#entry),
    };
    commands[action]?.();
  }

  /** @param {string} action What a media key pressed in this page means. Windows may also tell, as an action. */
  pressKey(action) {
    this.#media.pressKey(action);
  }

  /** While reading, a click on a sentence goes there. Otherwise a click makes no sound. */
  textClicked(entry, event) {
    if (this.#entry !== entry || this.#switching) return;
    if (event.defaultPrevented || event.target.closest(LINK)) return;
    const doc = event.target.ownerDocument;
    if (doc.getSelection?.()?.isCollapsed === false) return;
    const caret = caretAt(doc, event.clientX, event.clientY);
    const place = caret && sentenceAt(this.#blocks, caret.node, caret.offset);
    if (place) this.#player.jumpTo(place);
  }

  tabClosed(entry) {
    if (this.#entry === entry) this.stop();
  }

  /** A tab in the back has no layout to scroll, so the text catches up when it comes to the front. */
  tabShown(entry) {
    if (this.#entry === entry && this.#following && !this.#switching) this.#tellReader(this.#player.current);
    if (this.#shown) this.#draw();
  }

  /** @returns {object|null} The tab being read. */
  reading() {
    return this.#entry;
  }

  /**
   * The reader of the tab went somewhere on purpose, or is a new one for a file that changed. The voice goes along, and
   * in a pause it stays silent.
   */
  async readerMoved(entry) {
    if (this.#entry === entry) await this.#readHere();
  }

  /** The default voice of a language was chosen. A tab that chose its own keeps it. */
  defaultVoiceChanged(language, voiceId) {
    this.#savedVoices[language] = voiceId;
    if (!this.active() || parseLangTag(this.#lang).language !== language || this.#tabVoices.has(this.#entry)) return;
    this.#useVoice(voiceId);
  }

  /** Draws the bar again, in the language the interface has now. */
  redraw() {
    if (this.active()) this.#draw();
  }

  /** Only the report of the tabs asks: what a test checks, from the page itself. */
  report(entry) {
    if (!entry || this.#entry !== entry) return null;
    const { block, sentence } = this.#player.current;
    const window = this.#blocks[block]?.sentences[sentence]?.start?.node.ownerDocument.defaultView;
    const highlight = window?.CSS.highlights.get(HIGHLIGHT_NAME);
    return {
      state: this.#player.state,
      current: { block, sentence },
      sentence: this.#blocks[block]?.sentences[sentence]?.text ?? null,
      blocks: this.#blocks.length,
      lang: this.#lang,
      voice: this.#voiceId,
      rate: this.#player.rate,
      following: this.#following,
      audioPlaying: this.#media.audioPlaying(),
      highlight: highlight ? [...(highlight.ranges ?? highlight)].map(String) : [],
    };
  }

  async #begin(entry, from) {
    this.stop();
    const run = this.#run;
    this.#entry = entry;
    this.#finished = null;
    this.#following = true;
    this.#lang = null;
    this.#switching = true;
    this.#watch(entry.reader);
    const { voices: saved, options } = await this.#invoke('state_get');
    if (run !== this.#run) return;
    this.#savedVoices = { ...saved };
    this.#player.setRate(options?.[OPTION_RATE]);
    const voices = await this.#engine.voices().catch(() => []);
    if (run !== this.#run) return;
    this.#voices = voices;
    await this.#loadSection(run, from);
  }

  /** Puts the sections on screen through the player, from the first with something to read, and starts or parks. */
  async #loadSection(run, from, { silent = false, sameLanguage = false } = {}) {
    const { reader } = this.#entry;
    let found = await this.#extract(reader, run);
    while (found && found.blocks.length === 0) {
      const more = await this.#moved(() => reader.nextSpeechSection());
      if (run !== this.#run) return;
      if (!more) {
        this.#fail(more === null ? t('speech.sectionError') : t('speech.nothingToRead'));
        return;
      }
      found = await this.#extract(reader, run);
    }
    if (!found) return;
    const { blocks, lang } = found;
    if (!sameLanguage && !this.#pickVoice(lang)) return;
    this.#blocks = blocks;
    this.#player.load(blocks, placeFor(blocks, from));
    this.#switching = false;
    if (silent) this.#player.park();
    else this.#player.play();
  }

  /** @returns {Promise<{blocks: object[], lang: string}|null>} `null` if the change under way was dropped. */
  async #extract(reader, run) {
    const roots = await reader.speechRoots();
    if (run !== this.#run) return null;
    const text = roots.map(({ root }) => root.textContent).join('\n');
    const lang = this.#lang ?? (parseLangTag(reader.lang).language ? reader.lang : detectLang(text)) ?? getLang();
    const options = { sourceMode: this.#sourceMode(), lang };
    const blocks = [];
    let sliceEnd = performance.now() + PREPARE_SLICE_MS;
    for (const { root } of roots) {
      if (performance.now() >= sliceEnd) {
        await nextTurn();
        if (run !== this.#run) return null;
        sliceEnd = performance.now() + PREPARE_SLICE_MS;
      }
      blocks.push(...extractBlocks(root, options));
    }
    return { blocks, lang };
  }

  /** @returns {Promise<boolean|null>} What the move answered; `null` if it failed. */
  async #moved(move) {
    try {
      return await move();
    } catch (error) {
      console.warn(error);
      return null;
    }
  }

  /** @returns {boolean} Whether a voice was found. Without one the reading ends with a way to get one. */
  #pickVoice(lang) {
    const language = parseLangTag(lang).language;
    const ofLanguage = this.#voices.filter((voice) => parseLangTag(voice.lang).language === language);
    if (ofLanguage.length === 0) {
      this.stop();
      this.#showVoiceHelp(languageName(language));
      return false;
    }
    const wanted = [this.#tabVoices.get(this.#entry), this.#savedVoices[language]];
    const known = wanted.find((id) => ofLanguage.some((voice) => voice.id === id));
    this.#lang = lang;
    this.#voiceId = known ?? closestVoice(ofLanguage, lang).id;
    this.#player.setLang(lang);
    this.#player.setVoice(this.#voiceId);
    return true;
  }

  #fail(message) {
    this.stop();
    this.#showMessage(message);
  }

  async #readHere() {
    const entry = this.#entry;
    const run = ++this.#run;
    const silent = this.#player.state === STATE_PAUSED;
    const from = entry.reader.speechStart();
    this.#switching = true;
    this.#following = true;
    this.#watch(entry.reader);
    await this.#loadSection(run, from, { silent, sameLanguage: true });
  }

  async #nextSection() {
    const entry = this.#entry;
    const silent = this.#wasPaused;
    const run = ++this.#run;
    this.#switching = true;
    const more = await this.#moved(() => entry.reader.nextSpeechSection());
    if (run !== this.#run) return;
    if (more === null) {
      this.#fail(t('speech.sectionError'));
    } else if (more) {
      await this.#loadSection(run, null, { silent, sameLanguage: true });
    } else {
      this.stop();
      this.#finished = entry;
    }
  }

  /** At the start of a section of a book, what is before it is its last section. */
  async #prevSection() {
    const { block, sentence } = this.#player.current;
    if (block !== TOP.block || sentence !== TOP.sentence) {
      this.#player.prevSection();
      return;
    }
    const entry = this.#entry;
    const silent = this.#player.state === STATE_PAUSED;
    const run = ++this.#run;
    this.#switching = true;
    const moved = await this.#moved(() => entry.reader.prevSpeechSection());
    if (run !== this.#run) return;
    if (moved === null) this.#fail(t('speech.sectionError'));
    else if (moved) await this.#loadSection(run, null, { silent, sameLanguage: true });
    else {
      this.#switching = false;
      this.#player.prevSection();
    }
  }

  #watch(reader) {
    if (this.#watched.has(reader)) return;
    this.#watched.add(reader);
    reader.onHandMove(() => this.#handMoved(reader));
    reader.onSectionShown?.(() => {
      if (this.#entry?.reader === reader && !this.#switching) this.#readHere();
    });
  }

  #handMoved(reader) {
    if (this.#entry?.reader !== reader || !this.#following) return;
    this.#following = false;
    this.#draw();
  }

  #follow() {
    this.#following = true;
    this.#draw();
    this.#tellReader(this.#player.current);
  }

  #setRate(rate) {
    this.#player.setRate(rate);
    this.#invoke('state_set_option', { name: OPTION_RATE, value: this.#player.rate });
    this.#draw();
  }

  #chooseVoice(voiceId) {
    this.#tabVoices.set(this.#entry, voiceId);
    this.#savedVoices[parseLangTag(this.#lang).language] = voiceId;
    this.#invoke('state_set_voice', { lang: parseLangTag(this.#lang).language, voiceId });
    this.#useVoice(voiceId);
  }

  #useVoice(voiceId) {
    this.#voiceId = voiceId;
    this.#player.setVoice(voiceId);
    this.#draw();
  }

  #tellReader(place) {
    const { block, sentence } = place;
    const range = sentenceRange(this.#blocks[block].sentences[sentence]);
    const follow = this.#following && this.#isInFront(this.#entry);
    this.#entry.reader.speakAt({ range, ...lineOfPlace(this.#blocks, place), follow });
    return range;
  }

  #onSentence(place) {
    const range = this.#tellReader(place);
    if (range) this.#highlighter.show(range);
    else this.#highlighter.clear();
    this.#save(this.#entry);
  }

  #onState(state) {
    if (this.#switching) return;
    if (state === STATE_PLAYING) {
      this.#wasPaused = false;
      this.#media.playing(this.#nameOf(this.#entry));
      this.#draw();
    } else if (state === STATE_PAUSED) {
      this.#wasPaused = true;
      this.#media.paused();
      this.#draw();
    } else if (state === STATE_ENDED) {
      this.#nextSection();
    } else if (state === STATE_IDLE && this.#entry) {
      this.#closeReading();
    }
  }

  #onError(code) {
    if (code === ERROR_ENGINE) this.#showMessage(t('speech.error'));
  }

  #closeReading() {
    const entry = this.#entry;
    this.#entry = null;
    this.#blocks = [];
    this.#run += 1;
    this.#highlighter.clear();
    if (this.#shown) {
      this.#media.stopped();
      this.#bar.hide();
    }
    this.#shown = false;
    this.#onReading(null);
    entry.reader?.speechStopped();
  }

  #draw() {
    const language = parseLangTag(this.#lang).language;
    this.#shown = true;
    this.#bar.show({
      name: this.#nameOf(this.#entry),
      playing: this.#player.state === STATE_PLAYING,
      rate: this.#player.rate,
      voices: this.#voices.filter((voice) => parseLangTag(voice.lang).language === language),
      voiceId: this.#voiceId,
      following: this.#following,
      elsewhere: !this.#isInFront(this.#entry),
    });
    this.#onReading(this.#entry);
  }
}

/** @returns {SpeechSession} */
export const createSession = (parts) => new SpeechSession(parts);
