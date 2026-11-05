// SPDX-License-Identifier: GPL-3.0-or-later
import { getLang, getLocale, loadLang, t } from '../core/i18n.js';
import { resolveKey } from '../core/keys.js';
import { linkAction } from '../core/links.js';
import { fileName, isSupported, OPENABLE_EXTENSIONS } from '../core/paths.js';
import { Tabs } from '../core/tabs.js';
import { bookStyle } from '../readers/epub-style.js';
import { openMarkdown } from '../readers/markdown.js';
import { caretAt } from '../core/caret.js';
import { renderHome, mascot } from './home.js';
import { icon } from './icons.js';
import { applyOptions, focusedOption, focusOption, interfaceLang, nextTextSize, readOptions, renderOptions, renderVoiceOptions } from './options.js';
import { createClickShield, createPanels, createRowGuard, keepFocus, renderBookmarks, renderLicenses, renderShortcuts, renderTabList, renderToc, renderVoiceHelp } from './panels.js';
import { renderRecents } from './recents.js';
import { loadingPage, statePage } from './states.js';
import { createTabTools, renderTabBar, watchTabOverflow } from './tabbar.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const { getCurrentWebview } = window.__TAURI__.webview;
const { getVersion } = window.__TAURI__.app;
const { open: openDialog } = window.__TAURI__.dialog;

const APP_NAME = 'MochiReader';
const SOURCE_URL = 'https://github.com/martindavinci/MochiReader';
// A file that takes longer than this no longer keeps the window hidden, and its tab says it is opening.
const SLOW_OPEN_MS = 400;
const TOAST_MS = 4000;
const STATUS_LOADING = 'loading';
const STATUS_OK = 'ok';
const STATUS_ERROR = 'error';
const STATUS_MISSING = 'missing';
const CODE_NOT_FOUND = 'not_found';
const CODE_TIMEOUT = 'timeout';
const CODE_UNREADABLE = 'unreadable';
const KIND_EPUB = 'epub';
const KEY_DOWN = 'keydown';
const DARK_SYSTEM_THEME = '(prefers-color-scheme: dark)';
const THEME_SYSTEM = 'system';
// The file may be back by now, so opening it again tries again.
const RETRIED_STATUSES = [STATUS_ERROR, STATUS_MISSING];
// Focusable from code and by click, but not one more stop for the Tab key.
const PANE_TAB_INDEX = '-1';
const PANEL_RECENTS = 'recents';
const PANEL_BOOKMARKS = 'bookmarks';
const PANEL_TOC = 'toc';
const PANEL_OPTIONS = 'options';
const PANEL_LICENSES = 'licenses';
const PANEL_VOICE_HELP = 'voice-help';
const PANEL_TABS = 'tabs';
const PANEL_SHORTCUTS = 'shortcuts';
const GAP_PX = 6;
const DROP_MASCOT_PX = 88;
const FORWARD = 1;
const BACK = -1;
// The page scrolls the text of a Markdown file on its own, as long as the key reaches it. A book turns its own pages.
const PAGE_ACTIONS = new Set(['scroll.page']);
// What a focused button or list answers to itself, and so must not also act on the text behind it.
const CONTROLS = 'button, select, input, #panel';
const CONTROL_KEYS = new Set([' ', '+', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const MEDIA_KEY_PREFIX = 'Media';
const LINK_SELECTOR = 'a[href]';
const CONTEXT_MENU = 'contextmenu';
const CLICK = 'click';
// What the session does on its own, as soon as it is there. Until then there is no reading for them to act on.
const SPEECH_COMMANDS = [
  'speech.toggle', 'speech.prevSentence', 'speech.nextSentence', 'speech.prevBlock', 'speech.nextBlock',
  'speech.prevSection', 'speech.nextSection', 'speech.slower', 'speech.faster',
];
// A key held down repeats. For these that is still what the reader wants; closing every tab is not.
const REPEATING_ACTIONS = new Set([
  'tab.next', 'text.bigger', 'text.smaller', 'block.prev', 'block.next', 'section.prev', 'section.next',
  'page.prev', 'page.next', 'scroll.page', 'speech.prevSentence', 'speech.nextSentence', 'speech.prevBlock',
  'speech.nextBlock', 'speech.prevSection', 'speech.nextSection', 'speech.slower', 'speech.faster',
]);

const tabs = new Tabs();
/**
 * @type {Map<number, {path: string, pane: HTMLElement, status: string, kind: string|null, reader: object|null,
 *   notice: string, fileNotice: HTMLElement|null, key: string|null, title: string, modified: number|null,
 *   restored: boolean, checking: boolean, opening: Promise<void>|null}>}
 */
const entries = new Map();
const tabBar = document.getElementById('tabbar');
const tabRow = document.getElementById('tabbar-row');
const panes = document.getElementById('panes');
const home = document.getElementById('home');
const toast = document.getElementById('toast');
const panelHost = document.getElementById('panel');
const panels = createPanels(panelHost, { onClose: () => closePanel() });
const rowGuard = createRowGuard();
const clickShield = createClickShield(document.body);
let options = readOptions({});
let shownTabId = null;
let shownTitle = APP_NAME;
let toastTimer = null;
let drawnRecents = null;
let followingSystemTheme = false;
/** What gave the panel on screen, if it should have the focus back when the panel closes. */
let panelOpener = null;
let tabTools = null;
let tabOverflow = null;
let drawnToolsLang = null;
let appVersion = '';
let lastInputWasKey = false;
let dropZone = null;
/** Reading aloud, once it has been asked for: everything it needs stays out of the first frame. */
let speech = null;
let speechLoading = null;

const twoFrames = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const activeEntry = () => entries.get(tabs.active()?.id) ?? null;

/** The body does not scroll, so the keys only move the text while its pane has the focus, or the frame of its book. */
function focusText() {
  const entry = activeEntry();
  if (entry?.reader?.focus) entry.reader.focus();
  else entry?.pane.focus({ preventScroll: true });
}

function moreMenuItems() {
  const entry = activeEntry();
  return [
    { label: t('tools.open'), glyph: 'folder', keys: 'Ctrl+O', run: pickFiles },
    { label: t('tools.recents'), glyph: 'clock', keys: 'Ctrl+R', run: () => showPanel(PANEL_RECENTS) },
    { label: t('tools.bookmarks'), glyph: 'bookmark', keys: 'Ctrl+B', run: () => showPanel(PANEL_BOOKMARKS) },
    { label: t('tools.contents'), glyph: 'contents', keys: 'Ctrl+T', disabled: !entry?.reader, run: () => showPanel(PANEL_TOC) },
    { label: t('tools.options'), glyph: 'sliders', keys: 'Ctrl+,', run: () => showPanel(PANEL_OPTIONS) },
    { label: t('tools.shortcuts'), glyph: 'keyboard', keys: 'F1', run: () => showPanel(PANEL_SHORTCUTS) },
    { label: t('tools.closeTab'), glyph: 'close', keys: 'Ctrl+W', run: () => SHORTCUTS['tab.close']() },
  ];
}

async function openMoreMenu(opener) {
  const { openMenu } = await import('./menu.js');
  const { right, bottom } = opener.getBoundingClientRect();
  openMenu(document, { x: right, y: bottom + GAP_PX, fromRight: true }, moreMenuItems());
}

function toggleReading() {
  const entry = activeEntry();
  if (entry && speech?.reading() === entry) speech.command('speech.stop');
  else readAloud();
}

/** Built when the first file opens, and again if the language changes: a page with no file has no use for it. */
function drawTabTools() {
  if (drawnToolsLang === getLang()) return;
  drawnToolsLang = getLang();
  [...tabRow.children].filter((child) => child !== tabBar).forEach((child) => child.remove());
  tabTools = createTabTools(tabRow, {
    onOpen: pickFiles,
    onCount: (opener) => togglePanel(PANEL_TABS, opener),
    onContents: (opener) => togglePanel(PANEL_TOC, opener),
    onBookmark: toggleBookmark,
    onRead: toggleReading,
    onMore: openMoreMenu,
  });
  tabOverflow ??= watchTabOverflow(tabBar, (overflowing) => {
    tabTools.setCount(overflowing ? tabs.all().length : null);
  });
}

/** The tab bar and what it says about the tab being read. */
function drawTabBar() {
  const active = tabs.active();
  const readingEntry = speech?.reading() ?? null;
  const readingTab = tabs.all().find(({ id }) => entries.get(id) === readingEntry);
  tabRow.hidden = tabs.all().length === 0;
  if (tabRow.hidden) return;
  drawTabTools();
  renderTabBar(tabBar, tabs.all(), active?.id, {
    closeLabel: t('tabs.close'),
    readingId: readingTab?.id ?? null,
    onActivate: (id) => {
      tabs.activate(id);
      refresh();
    },
    onClose: closeTab,
  });
  tabTools.setReading(Boolean(readingEntry) && readingEntry === activeEntry());
  tabOverflow.showActive();
}

function refresh() {
  const active = tabs.active();
  // What a panel shows can be about the tab that was in front.
  if ((active?.id ?? null) !== shownTabId) panels.close();
  shownTabId = active?.id ?? null;
  for (const [id, entry] of entries) entry.pane.classList.toggle('active', id === active?.id);
  speech?.tabShown(entries.get(active?.id));
  home.classList.toggle('active', !active);
  if (!panels.current()) focusText();
  drawTabBar();
  const title = active ? `${fileName(active.path)} — ${APP_NAME}` : APP_NAME;
  if (title !== shownTitle) {
    shownTitle = title;
    getCurrentWindow().setTitle(title);
  }
}

/**
 * Until the saved position has been applied, the reader is still at the top: saving that would lose the real one.
 * @returns {Promise<void>|undefined}
 */
function savePosition(entry, position = entry.reader?.position()) {
  if (!entry.restored || !entry.key || !position) return undefined;
  return invoke('state_save_position', { key: entry.key, position });
}

function closeTab(id) {
  const entry = entries.get(id);
  if (entry) savePosition(entry);
  speech?.tabClosed(entry);
  entry?.chrome?.destroy();
  entry?.reader?.destroy();
  entry?.pane.remove();
  entries.delete(id);
  tabs.close(id);
  refresh();
  if (!tabs.active()) showRecents();
}

const recentsLabels = () => ({
  title: t('recents.title'),
  empty: t('recents.empty'),
  missing: t('recents.missing'),
  remove: t('recents.remove'),
});

/** A list emptied by mistake comes back from the message that says so. */
async function clearRecents() {
  const { recents } = await invoke('state_get');
  await invoke('state_clear_recents');
  showToast(t('recents.cleared'), {
    glyph: 'check',
    action: {
      label: t('action.undo'),
      run: async () => {
        await invoke('state_set_recents', { recents });
        await redrawRecents();
      },
    },
  });
  await redrawRecents();
}

/** What shows them: the home page, the panel, or both. */
async function redrawRecents() {
  if (!tabs.active()) await showRecents();
  if (panels.current() === PANEL_RECENTS) await drawRecentsPanel();
}

/** What a row does when it opens something, which leaves the second click of a double click to what is behind it. */
const openingRow = (action) => rowGuard.open((...args) => {
  clickShield.raise();
  return action(...args);
});

function drawRecents(recents, row) {
  drawnRecents = JSON.stringify(recents);
  const refocus = keepFocus(home, row);
  renderHome(home, recents, {
    labels: recentsLabels(),
    onOpen: openingRow(openPath),
    onRemove: rowGuard.remove(removeRecent),
    onOpenFile: pickFiles,
    onBookmarks: (opener) => togglePanel(PANEL_BOOKMARKS, opener),
    onOptions: (opener) => togglePanel(PANEL_OPTIONS, opener),
    onClear: clearRecents,
  });
  refocus();
}

/** Asks the drives, which can take a while: the list is already on screen, and changes only if the answer differs. */
async function checkRecents() {
  const recents = await invoke('state_check_recents');
  if (JSON.stringify(recents) !== drawnRecents) drawRecents(recents);
}

async function showRecents(row) {
  const { recents } = await invoke('state_get');
  drawRecents(recents, row);
  checkRecents();
}

async function removeRecent(path, row) {
  await invoke('state_remove_recent', { path });
  await showRecents(row);
}

function hideToastLater() {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, TOAST_MS);
}

/**
 * A message that leaves by itself, unless the pointer or the focus is on it: it may have something to press.
 * @param {string} message
 * @param {{glyph?: string, action?: {label: string, run: () => void}}} [options]
 */
function showToast(message, { glyph = 'info', action } = {}) {
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  toast.replaceChildren(icon(document, glyph), text);
  if (action) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      toast.hidden = true;
      action.run();
    });
    toast.append(button);
  }
  toast.hidden = false;
  hideToastLater();
}

const holdToast = () => clearTimeout(toastTimer);
['mouseenter', 'focusin'].forEach((type) => toast.addEventListener(type, holdToast));
['mouseleave', 'focusout'].forEach((type) => toast.addEventListener(type, hideToastLater));

/**
 * foliate holds the place of a book through a change of layout, by what is on the page. Sending it to the start of the
 * page instead gives that up: the page has reflowed and starts earlier, and each change loses a little more.
 */
const holdsItsPlace = ({ kind }) => kind === KIND_EPUB;

/** A message above text that stays readable. An empty one takes it away. */
function setFileNotice(entry, message) {
  if ((entry.fileNotice?.getAttribute('title') ?? '') === message) return;
  entry.notice = message;
  entry.fileNotice?.remove();
  entry.fileNotice = null;
  if (!message) return;
  const place = holdsItsPlace(entry) ? null : entry.reader?.position();
  entry.fileNotice = document.createElement('p');
  entry.fileNotice.className = 'file-notice';
  entry.fileNotice.setAttribute('role', 'status');
  entry.fileNotice.setAttribute('title', message);
  const words = document.createElement('span');
  words.className = 'file-notice-text';
  words.textContent = message;
  const close = document.createElement('button');
  close.textContent = t('state.closeTab');
  close.addEventListener('click', () => closeEntry(entry));
  entry.fileNotice.append(words, close);
  entry.pane.prepend(entry.fileNotice);
  // It sticks over the top of the pane, which is where the reader was: the place goes below it.
  if (place) entry.reader.goTo(place);
}

/** Whatever tab it is now. */
function closeEntry(entry) {
  const tab = tabs.all().find(({ id }) => entries.get(id) === entry);
  if (tab) closeTab(tab.id);
}

const closeTabAction = (entry, primary = false) => ({ label: t('state.closeTab'), primary, run: () => closeEntry(entry) });

function showInFolderAction(entry) {
  return { label: t('state.showInFolder'), run: () => invoke('show_in_folder', { path: entry.path }) };
}

/** What can be done about a file that did not open, by the reason it did not. */
function actionsFor(entry, id, code) {
  if (code === CODE_NOT_FOUND) {
    return [
      { label: t('state.openAnother'), primary: true, run: pickFiles },
      {
        label: t('state.removeRecent'),
        run: async () => {
          await invoke('state_remove_recent', { path: entry.path });
          closeEntry(entry);
        },
      },
    ];
  }
  if (code === CODE_TIMEOUT) {
    return [
      { label: t('state.retry'), primary: true, run: () => openPath(entry.path) },
      closeTabAction(entry),
    ];
  }
  return [closeTabAction(entry, true), showInFolderAction(entry)];
}

/** In place of the text: what happened and what to do now. `entry.notice` is what it says, for whoever asks. */
function showState(entry, status, state) {
  entry.status = status;
  entry.notice = state.text;
  entry.pane.replaceChildren(statePage(entry.pane, state));
}

function showLoading(entry) {
  entry.status = STATUS_LOADING;
  const message = t('open.loading', { name: fileName(entry.path) });
  entry.notice = message;
  entry.pane.replaceChildren(loadingPage(entry.pane, message));
}

function follow(action, pane) {
  if (action?.type === 'doc') openPath(action.path);
  else if (action?.type === 'external') invoke('open_external', { url: action.url });
  else if (action?.type === 'anchor') pane.querySelector(`#${CSS.escape(action.id)}`)?.scrollIntoView();
}

const openBooks = () => [...entries.values()].filter(({ kind, reader }) => kind === KIND_EPUB && reader);

const currentBookStyle = () => bookStyle(options, matchMedia(DARK_SYSTEM_THEME).matches);

function styleBooks() {
  const books = openBooks();
  if (books.length === 0) return;
  const css = currentBookStyle();
  books.forEach(({ reader }) => reader.setStyle(css));
}

/** A book takes its colours from what is decided here, so it has to hear when Windows changes its mind. */
function followSystemTheme() {
  if (followingSystemTheme) return;
  followingSystemTheme = true;
  matchMedia(DARK_SYSTEM_THEME).addEventListener('change', () => {
    styleBooks();
    paintCaption();
  });
}

function loadSpeech() {
  speechLoading ??= import('../speech/session.js').then(({ createSession }) => {
    speech = createSession({
      invoke,
      save: (entry) => savePosition(entry),
      isInFront: (entry) => activeEntry() === entry,
      nameOf: ({ path }) => fileName(path),
      showMessage: showToast,
      showVoiceHelp,
      sourceMode: () => options.sourceMode,
      showEntry: (entry) => {
        const tab = tabs.all().find(({ id }) => entries.get(id) === entry);
        if (!tab) return;
        tabs.activate(tab.id);
        refresh();
      },
      onReading: () => drawTabBar(),
    });
    return speech;
  });
  return speechLoading;
}

async function readAloud() {
  const entry = activeEntry();
  if (entry?.reader) await (await loadSpeech()).start(entry);
}

function showVoiceHelp(language) {
  panels.show(PANEL_VOICE_HELP);
  placePanel();
  renderVoiceHelp(panelHost, language, {
    onSettings: () => invoke('open_speech_settings'),
    onClose: closePanel,
  });
  panels.focus();
}

/** The menu of the text offers to read from the point it was opened on. The default one of the browser is off. */
async function openReadMenu(entry, event) {
  event.preventDefault();
  const { clientX: x, clientY: y, target } = event;
  const doc = target.ownerDocument;
  const frame = doc.defaultView.frameElement?.getBoundingClientRect();
  const selected = doc.getSelection?.()?.toString() ?? '';
  const { openMenu } = await import('./menu.js');
  openMenu(document, { x: x + (frame?.left ?? 0), y: y + (frame?.top ?? 0) }, [
    {
      label: t('speech.readFromHere'),
      glyph: 'speaker',
      run: async () => (await loadSpeech()).readFromScreen(entry, doc, x, y),
    },
    {
      label: t('menu.bookmarkHere'),
      glyph: 'bookmark',
      keys: 'Ctrl+D',
      disabled: !entry.restored || !entry.key,
      run: () => {
        focusText();
        addBookmarkAt(entry, doc, x, y);
      },
    },
    {
      label: t('menu.copy'),
      glyph: 'copy',
      keys: 'Ctrl+C',
      disabled: !selected,
      run: () => {
        focusText();
        navigator.clipboard.writeText(selected);
      },
    },
  ]);
}

/** A key pressed in a book stays in its frame, so it comes here from the reader. */
function onBookInput(entry, event) {
  if (event.type === KEY_DOWN) onKeyDown(event);
  else if (event.type === CONTEXT_MENU) openReadMenu(entry, event);
  else if (event.type === CLICK) speech?.textClicked(entry, event);
}

async function showBook(doc, host, savedPosition) {
  const { openEpub } = await import('../readers/epub.js');
  return openEpub(doc.fileUrl, host, {
    flow: options.epubView,
    style: currentBookStyle(),
    hash: () => invoke('file_hash', { path: doc.path }),
    savedPosition,
    openExternal: (url) => invoke('open_external', { url }),
    unreadableSection: t('epub.sectionError'),
  });
}

async function openBook(doc, id, entry, savedPosition) {
  // The pane stays empty for as long as the book is not ready to take its place, and only then is the message safe.
  const slow = setTimeout(() => {
    if (entry.pane.childElementCount === 0) showLoading(entry);
  }, SLOW_OPEN_MS);
  try {
    return await showBook(doc, entry.pane, savedPosition);
  } catch (error) {
    console.warn(error);
    if (entries.get(id) === entry) {
      showState(entry, STATUS_ERROR, {
        glyph: 'lock',
        title: t('epub.errorTitle'),
        text: t('epub.error', { name: fileName(entry.path) }),
        actions: [closeTabAction(entry, true), showInFolderAction(entry)],
      });
    }
    return null;
  } finally {
    clearTimeout(slow);
  }
}

/** The head, the arrows and the foot, around the frame of a book. Nothing here waits for them. */
async function dressBook(entry, reader) {
  try {
    const { mountBookChrome } = await import('./book-chrome.js');
    if (entry.reader !== reader) return;
    entry.chrome?.destroy();
    entry.chrome = mountBookChrome(entry.pane, reader, {
      title: entry.title,
      onChapter: (chapter, chapters) => {
        if (entry.restored) invoke('state_recent_progress', { path: entry.path, chapter, chapters });
      },
    });
  } catch (error) {
    // The book can be read without them.
    console.warn(error);
  }
}

function adoptBook(doc, entry, reader) {
  entry.reader = reader;
  entry.key = reader.key;
  entry.title = reader.title || doc.name;
  entry.notice = '';
  reader.onInput((event) => onBookInput(entry, event));
  reader.onMove((position) => savePosition(entry, position));
  entry.status = STATUS_OK;
  entry.restored = true;
  invoke('state_move_bookmarks', { key: entry.key, path: entry.path });
  dressBook(entry, reader);
  if (activeEntry() === entry && !panels.current()) focusText();
}

/** @param {(key: string) => Promise<object|null>} savedPosition Where the book opens: it opens right there. */
async function mountBook(doc, id, entry, savedPosition) {
  const reader = await openBook(doc, id, entry, savedPosition);
  if (!reader) return;
  if (entries.get(id) !== entry) {
    reader.destroy();
    return;
  }
  adoptBook(doc, entry, reader);
}

function mountMarkdown(doc, entry) {
  entry.reader = openMarkdown(doc, entry.pane);
  entry.reader.onInput((event) => {
    if (event.type === CONTEXT_MENU) {
      openReadMenu(entry, event);
      return;
    }
    const link = event.target.closest(LINK_SELECTOR);
    if (!link) {
      speech?.textClicked(entry, event);
      return;
    }
    event.preventDefault();
    follow(linkAction(link.getAttribute('href')), entry.pane);
  });
  entry.reader.onMove((position) => savePosition(entry, position));
  entry.status = STATUS_OK;
  if (!doc.rendered.html.trim()) {
    entry.pane.replaceChildren(entry.pane.firstElementChild, statePage(entry.pane, {
      title: t('empty.title'),
      text: t('empty.text', { name: doc.name }),
      actions: [closeTabAction(entry)],
    }));
  }
}

async function mount(doc, id, entry, savedPosition) {
  entry.kind = doc.kind;
  entry.key = doc.key ?? null;
  entry.title = doc.name;
  entry.modified = doc.modifiedMs ?? null;
  entry.restored = false;
  if (doc.kind === KIND_EPUB) await mountBook(doc, id, entry, savedPosition);
  else mountMarkdown(doc, entry);
}

/** Takes the reader of the tab to `position`, if any. From then on its position is worth saving. */
async function settle(id, entry, position) {
  const { reader } = entry;
  if (position) await reader.goTo(position);
  if (entries.get(id) === entry && entry.reader === reader) entry.restored = true;
}

const savedPositionOf = (key) => invoke('state_get_position', { key });

async function restorePosition(id, entry) {
  if (entry.restored) return;
  const saved = await savedPositionOf(entry.key);
  if (entries.get(id) === entry) await settle(id, entry, saved);
}

/**
 * Opening the file is only the start for a book: whether it can be read shows once it has a page. Until then the book
 * on screen stays, so a file that is broken or still being copied takes nothing away. It keeps the old date, so the
 * next look at the file tries again. A frame cannot move without loading again, so the new book opens where it stays.
 */
async function reloadBook(doc, id, entry) {
  const stage = document.createElement('div');
  stage.className = 'book-stage waiting';
  entry.pane.append(stage);
  let reader;
  try {
    reader = await showBook(doc, stage, async () => entry.reader.position());
    if (reader.unreadablePage()) {
      reader.destroy();
      throw new Error('the new file is damaged at the place being read');
    }
  } catch (error) {
    console.warn(error);
    stage.remove();
    if (entries.get(id) === entry) setFileNotice(entry, t('file.notReloaded'));
    return;
  }
  if (entries.get(id) !== entry) {
    reader.destroy();
    return;
  }
  setFileNotice(entry, '');
  entry.reader.destroy();
  entry.chrome?.destroy();
  entry.chrome = null;
  [...entry.pane.children].filter((child) => child !== stage).forEach((child) => child.remove());
  stage.classList.remove('waiting');
  entry.kind = doc.kind;
  entry.modified = doc.modifiedMs ?? null;
  adoptBook(doc, entry, reader);
  await speech?.readerMoved(entry);
}

async function reload(id, entry) {
  const doc = await invoke('open_document', { path: entry.path });
  if (entries.get(id) !== entry) return;
  if (doc.kind === KIND_EPUB) {
    await reloadBook(doc, id, entry);
    return;
  }
  const position = entry.reader.position();
  entry.reader.destroy();
  entry.reader = null;
  setFileNotice(entry, '');
  await mount(doc, id, entry);
  await settle(id, entry, position);
  await speech?.readerMoved(entry);
}

/** Text already open stays readable whatever the disk says. A drive that does not answer says nothing about the file. */
async function checkFile(id, entry) {
  if (entry.status !== STATUS_OK || !entry.restored || entry.checking) return;
  entry.checking = true;
  try {
    const modified = await invoke('file_modified', { path: entry.path });
    if (entries.get(id) !== entry) return;
    if (modified === entry.modified) setFileNotice(entry, '');
    else await reload(id, entry);
  } catch (error) {
    if (error?.code === CODE_NOT_FOUND && entries.get(id) === entry) setFileNotice(entry, t('file.deleted'));
  } finally {
    entry.checking = false;
  }
}

function addEntry(id, path) {
  const entry = {
    path,
    pane: document.createElement('section'),
    status: STATUS_LOADING,
    kind: null,
    reader: null,
    notice: '',
    fileNotice: null,
    key: null,
    title: '',
    modified: null,
    restored: false,
    checking: false,
    opening: null,
    chrome: null,
  };
  entry.pane.className = 'pane';
  entry.pane.setAttribute('tabindex', PANE_TAB_INDEX);
  panes.append(entry.pane);
  entries.set(id, entry);
  return entry;
}

/** @returns {Promise<number|null>} The tab of `path` once its content is on the page; null if the file has no tab. */
async function openPath(path) {
  if (!isSupported(path)) {
    showToast(t('app.unsupported', { name: fileName(path) }), { glyph: 'alert' });
    return null;
  }
  const { id, created } = tabs.open(path);
  const entry = created ? addEntry(id, path) : entries.get(id);
  refresh();
  if (created || RETRIED_STATUSES.includes(entry.status)) entry.opening = load(id, entry, path);
  else checkFile(id, entry);
  await entry.opening;
  return id;
}

/** Reads the file of a tab and puts it on the page, or a message if it cannot. */
async function load(id, entry, path) {
  entry.status = STATUS_LOADING;
  entry.notice = '';
  entry.pane.replaceChildren();
  const slow = setTimeout(() => showLoading(entry), SLOW_OPEN_MS);
  let doc;
  try {
    doc = await invoke('open_document', { path });
  } catch (error) {
    if (entries.get(id) === entry) {
      const code = error?.code ?? CODE_UNREADABLE;
      showState(entry, code === CODE_NOT_FOUND ? STATUS_MISSING : STATUS_ERROR, {
        glyph: 'doc',
        title: t(`open.title.${code}`),
        text: t(`open.error.${code}`, { name: fileName(path) }),
        path: code === CODE_NOT_FOUND ? path : undefined,
        actions: actionsFor(entry, id, code),
      });
    }
    return;
  } finally {
    clearTimeout(slow);
  }
  entry.pane.replaceChildren();
  entry.notice = '';
  if (entries.get(id) !== entry) return;
  await mount(doc, id, entry, savedPositionOf);
  if (entries.get(id) === entry && entry.status === STATUS_OK) {
    invoke('state_touch_recent', { path: doc.path, kind: doc.kind, title: entry.title });
    await restorePosition(id, entry);
  }
}

const openPaths = (paths) => Promise.all(paths.map(openPath));

function closePanel() {
  panels.close();
  const opener = panelOpener;
  panelOpener = null;
  if (opener?.isConnected) opener.focus();
  else focusText();
}

/**
 * Under the button that opened it, right edges together. With a key there is no button: under the bar, at the right.
 * @param {Element} [opener]
 */
function placePanel(opener) {
  const bar = tabRow.hidden ? home.querySelector('.home-head') : tabRow;
  const under = (opener ?? bar)?.getBoundingClientRect();
  const page = document.documentElement.clientWidth;
  panelHost.style.setProperty('--panel-top', `${(under?.bottom ?? 0) + GAP_PX}px`);
  panelHost.style.setProperty('--panel-right', opener ? `${Math.max(page - under.right, GAP_PX)}px` : '');
}

async function drawRecentsPanel(row) {
  const draw = (recents, leaving) => {
    const refocus = keepFocus(panelHost, leaving);
    renderRecents(panelHost, recents, {
      labels: recentsLabels(),
      onOpenFile: () => {
        closePanel();
        pickFiles();
      },
      onClear: clearRecents,
      onOpen: openingRow((path) => {
        closePanel();
        openPath(path);
      }),
      onRemove: rowGuard.remove(async (path, removed) => {
        await removeRecent(path);
        await drawRecentsPanel(removed);
      }),
    });
    refocus();
  };
  const { recents } = await invoke('state_get');
  if (panels.current() !== PANEL_RECENTS) return;
  draw(recents, row);
  // Asks the drives, which can take a while: the list is already on screen.
  invoke('state_check_recents').then((checked) => {
    if (panels.current() === PANEL_RECENTS && JSON.stringify(checked) !== JSON.stringify(recents)) draw(checked);
  });
}

/** The file a bookmark names is only the last one its book was seen in: the book can be open from another. */
const pathOfOpenDocument = (key) => [...entries.values()].find((entry) => entry.reader && entry.key === key)?.path;

async function openBookmark({ key, path, position, title }) {
  closePanel();
  const id = await openPath(pathOfOpenDocument(key) ?? path);
  const entry = entries.get(id);
  if (entry?.status === STATUS_MISSING) {
    closeTab(id);
    showToast(t('bookmarks.missingFile', { name: title }));
    await showPanel(PANEL_BOOKMARKS);
    return;
  }
  await entry?.reader?.goTo(position);
  await speech?.readerMoved(entry);
}

async function drawBookmarksPanel(row) {
  const { bookmarks } = await invoke('state_get');
  if (panels.current() !== PANEL_BOOKMARKS) return;
  const refocus = keepFocus(panelHost, row);
  renderBookmarks(panelHost, bookmarks, {
    labels: { title: t('bookmarks.title'), empty: t('bookmarks.empty'), remove: t('recents.remove') },
    dateOf: (ms) => new Date(ms).toLocaleDateString(getLang(), { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }),
    onOpen: openingRow(openBookmark),
    onRemove: rowGuard.remove(async (bookmark, removed) => {
      await invoke('state_toggle_bookmark', { bookmark });
      await drawBookmarksPanel(removed);
    }),
  });
  refocus();
}

function drawTabsPanel() {
  const readingEntry = speech?.reading();
  const active = tabs.active();
  renderTabList(panelHost, tabs.all().map(({ id, path }) => ({
    id,
    path,
    name: fileName(path),
    active: id === active?.id,
    reading: entries.get(id) === readingEntry,
  })), {
    onGo: (id) => {
      closePanel();
      tabs.activate(id);
      refresh();
    },
  });
}

function drawTocPanel() {
  const reader = activeEntry()?.reader;
  const toc = reader?.toc() ?? [];
  const isBook = activeEntry()?.kind === KIND_EPUB;
  const count = isBook ? toc.filter(({ level }) => level === 1).length : toc.length;
  const progress = reader?.progress?.();
  renderToc(panelHost, toc, {
    labels: {
      title: t('toc.title'),
      empty: t('toc.empty'),
      here: progress?.page ? t('book.page', { n: progress.page, total: progress.pages }) : t('toc.here'),
      count: t(isBook ? 'toc.chapters' : 'toc.headings', { n: count }),
    },
    current: reader?.currentToc?.() ?? -1,
    numbered: isBook,
    onGo: openingRow(async (target) => {
      const entry = activeEntry();
      closePanel();
      await entry.reader.goTo(target);
      await speech?.readerMoved(entry);
    }),
  });
}

/** The title bar goes by the theme of the app, not of Windows. Null is Windows again, which the page then follows too. */
async function followAppTheme() {
  await getCurrentWindow().setTheme(options.theme === THEME_SYSTEM ? null : options.theme);
  paintCaption();
}

/** Where Windows lets a title bar have a colour, it has the colour of the page under it. */
function paintCaption() {
  const dark = options.theme === THEME_SYSTEM ? matchMedia(DARK_SYSTEM_THEME).matches : options.theme === 'dark';
  invoke('window_caption', { dark });
}

/** The options are on the page first, so that the first frame already has them. */
function useOptions(next) {
  const themeChanged = next.theme !== options.theme;
  options = next;
  applyOptions(options, document.documentElement);
  if (themeChanged) followAppTheme();
  document.documentElement.setAttribute('lang', getLocale());
  styleBooks();
}

/** The language of the interface comes with its table, which may take a moment the first time. */
async function useLanguage(next) {
  await loadLang(interfaceLang(next, navigator.language));
  useOptions(next);
}

/** The text changes length with its size: each tab stays where it was reading. */
function setTextSize(size) {
  const places = [...entries.values()]
    .filter((entry) => entry.reader && entry.restored && !holdsItsPlace(entry))
    .map(({ reader }) => ({ reader, place: reader.position() }));
  useOptions({ ...options, textSize: size });
  places.forEach(({ reader, place }) => reader.goTo(place));
}

async function changeOption(name, value) {
  if (name === 'textSize') setTextSize(value);
  else if (name === 'language') await useLanguage({ ...options, [name]: value });
  else useOptions({ ...options, [name]: value });
  invoke('state_set_option', { name, value });
  if (name === 'epubView') openBooks().forEach(({ reader }) => reader.setFlow(value));
  if (name === 'language') {
    speech?.redraw();
    refresh();
    if (!tabs.active()) showRecents();
  }
  if (panels.current() === PANEL_OPTIONS) {
    const focused = focusedOption(document);
    drawOptionsPanel();
    focusOption(panelHost, focused);
  }
}

function chooseDefaultVoice(lang, voiceId) {
  invoke('state_set_voice', { lang, voiceId });
  speech?.defaultVoiceChanged(lang, voiceId);
}

/** Asks for what only reading aloud needs, so they come a moment after the rest of the panel. */
async function drawVoiceOptions() {
  const { languageName, voiceGroups, WebSpeechEngine } = await import('../speech/engine-web.js');
  const [voices, { voices: saved }] = await Promise.all([new WebSpeechEngine().voices(), invoke('state_get')]);
  if (!panelHost.querySelector('.voice-options')) return;
  if (panels.current() !== PANEL_OPTIONS) return;
  const groups = voiceGroups(voices, saved).map((group) => ({ ...group, name: languageName(group.lang) }));
  renderVoiceOptions(panelHost, groups, chooseDefaultVoice);
}

function drawOptionsPanel() {
  renderOptions(panelHost, options, {
    version: appVersion,
    onChange: changeOption,
    onLicenses: () => showPanel(PANEL_LICENSES),
  });
  drawVoiceOptions();
}

async function drawLicensesPanel() {
  const text = await invoke('licenses_text');
  if (panels.current() !== PANEL_LICENSES) return;
  renderLicenses(panelHost, text, {
    title: t('licenses.title'),
    notice: t('about.notice'),
    sourceLabel: t('licenses.source'),
    sourceUrl: SOURCE_URL,
    backLabel: t('licenses.back'),
    onBack: () => showPanel(PANEL_OPTIONS),
    onSource: () => invoke('open_external', { url: SOURCE_URL }),
  });
}

function stepTextSize(delta) {
  const size = nextTextSize(options.textSize, delta);
  if (size !== options.textSize) changeOption('textSize', size);
}

const PANELS = {
  [PANEL_RECENTS]: drawRecentsPanel,
  [PANEL_BOOKMARKS]: drawBookmarksPanel,
  [PANEL_TOC]: drawTocPanel,
  [PANEL_OPTIONS]: drawOptionsPanel,
  [PANEL_LICENSES]: drawLicensesPanel,
  [PANEL_TABS]: drawTabsPanel,
  [PANEL_SHORTCUTS]: () => renderShortcuts(panelHost),
};

async function showPanel(name, opener) {
  if (name === PANEL_OPTIONS) appVersion ||= await getVersion();
  panels.show(name);
  placePanel(opener);
  await PANELS[name]();
  if (panels.current() === name) panels.focus();
}

function togglePanel(name, opener) {
  panelOpener = opener && lastInputWasKey ? opener : null;
  if (panels.current() === name) closePanel();
  else showPanel(name, opener);
}

/** The same call takes it back: a bookmark is known by its document and its place. */
async function switchBookmark(bookmark) {
  const added = await invoke('state_toggle_bookmark', { bookmark });
  showToast(t(added ? 'bookmarks.added' : 'bookmarks.removed'), {
    glyph: added ? 'check' : 'info',
    action: { label: t('action.undo'), run: () => switchBookmark(bookmark) },
  });
  if (panels.current() === PANEL_BOOKMARKS) await drawBookmarksPanel();
}

const bookmarkOf = (entry, position, excerpt) => ({
  key: entry.key,
  path: entry.path,
  title: entry.title,
  position,
  excerpt,
  createdAt: Date.now(),
});

/** Until the saved position has been applied, the reader is still at the top, which is not where a bookmark goes. */
async function toggleBookmark() {
  const entry = activeEntry();
  if (!entry?.reader || !entry.restored || !entry.key) return;
  await switchBookmark(bookmarkOf(entry, entry.reader.position(), entry.reader.excerpt()));
}

/** From the menu of the text: the place it was opened on. */
async function addBookmarkAt(entry, doc, x, y) {
  const caret = caretAt(doc, x, y);
  const place = caret && entry.reader?.placeAt?.(caret.node, caret.offset);
  if (place) await switchBookmark(bookmarkOf(entry, place.position, place.excerpt));
  else await toggleBookmark();
}

async function pickFiles() {
  const paths = await openDialog({
    title: t('dialog.open'),
    multiple: true,
    filters: [{ name: t('dialog.filter'), extensions: OPENABLE_EXTENSIONS }],
  });
  if (paths) await openPaths(paths);
}

const SHORTCUTS = {
  'file.open': pickFiles,
  'tab.close': () => {
    const active = tabs.active();
    if (active) closeTab(active.id);
  },
  'tab.next': () => {
    tabs.next();
    refresh();
  },
  'panel.recents': () => togglePanel(PANEL_RECENTS),
  'panel.bookmarks': () => togglePanel(PANEL_BOOKMARKS),
  'panel.toc': () => togglePanel(PANEL_TOC),
  'panel.options': () => togglePanel(PANEL_OPTIONS),
  'panel.shortcuts': () => togglePanel(PANEL_SHORTCUTS),
  'panel.close': closePanel,
  'bookmark.toggle': toggleBookmark,
  'text.bigger': () => stepTextSize(FORWARD),
  'text.smaller': () => stepTextSize(BACK),
  'block.next': () => activeEntry()?.reader?.moveBlock?.(FORWARD),
  'block.prev': () => activeEntry()?.reader?.moveBlock?.(BACK),
  'section.next': () => activeEntry()?.reader?.moveSection?.(FORWARD),
  'section.prev': () => activeEntry()?.reader?.moveSection?.(BACK),
  'page.next': () => activeEntry()?.reader?.goRight?.(),
  'page.prev': () => activeEntry()?.reader?.goLeft?.(),
  'scroll.page': () => activeEntry()?.reader?.next?.(),
  'speech.start': readAloud,
  ...Object.fromEntries(SPEECH_COMMANDS.map((action) => [action, () => speech?.command(action)])),
};

/**
 * A shortcut is the shell's alone: the reader must not take it for the reader moving on, which would let go of the
 * point it is holding, and that point is what `Ctrl+D` saves. So this listens on the way down, before the reader.
 */
function onKeyDown(event) {
  lastInputWasKey = true;
  const chord = { key: event.key, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey };
  const kind = activeEntry()?.kind ?? '';
  const speaking = speech?.active() ?? false;
  const action = resolveKey(chord, { speaking, kind });
  if (!action || (PAGE_ACTIONS.has(action) && kind !== KIND_EPUB)) return;
  if (!event.ctrlKey && CONTROL_KEYS.has(event.key) && event.target.closest?.(CONTROLS)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat && !REPEATING_ACTIONS.has(action)) return;
  // Windows may tell of the same press through the media session too, and that goes through the same place.
  if (speaking && event.key.startsWith(MEDIA_KEY_PREFIX)) speech.pressKey(action);
  else SHORTCUTS[action]?.();
}

async function measureOpen(path) {
  const id = await openPath(path);
  // No time for a file that did not open: the measure then fails for lack of a result.
  if (entries.get(id)?.status !== STATUS_OK) return;
  await twoFrames();
  await invoke('measure_open_done');
  closeTab(id);
}

async function dumpTabs(out) {
  const rows = await Promise.all(tabs.all().map(async ({ id, path }) => {
    const entry = entries.get(id);
    const { status, kind, key, title, reader, notice } = entry;
    const report = speech?.report(entry) ?? null;
    const position = reader ? reader.position() : null;
    const roots = reader ? await reader.speechRoots() : [];
    return {
      path,
      kind,
      key,
      title,
      status,
      notice,
      firstPageRendered: status === STATUS_OK && (reader?.pageOnScreen?.() ?? true),
      panel: panels.current(),
      licensesText: panels.current() === PANEL_LICENSES ? panelHost.textContent : null,
      focused: document.activeElement?.localName ?? null,
      focusedText: document.activeElement?.textContent ?? '',
      position,
      screenLine: reader?.screenLine?.() ?? null,
      text: roots.map(({ root }) => root.textContent).join('\n'),
      excerpt: reader?.excerpt() ?? null,
      speech: report,
      speechBar: report && document.getElementById('speechbar').textContent,
      panelText: panels.current() ? panelHost.textContent : null,
      textMenu: document.querySelector('.text-menu')?.textContent ?? null,
      toast: toast.hidden ? null : toast.querySelector('.toast-text').textContent,
    };
  }));
  await invoke('smoke_write_dump', { out, json: JSON.stringify(rows) });
}

/** Only the smoke build sends these two. Reading is started the way a key starts it. */
async function onSpeechTest({ action, command, volume, log }) {
  const [session, hooks] = await Promise.all([loadSpeech(), import('../speech/test-hooks.js')]);
  if (action === 'speech-test') {
    hooks.applySpeechTest(session, { volume, log }, invoke);
  } else if (command === 'speech.start') {
    hooks.markRestart();
    readAloud();
  } else if (command === 'tab.close') {
    SHORTCUTS[command]();
  } else {
    hooks.runSpeechTest(command, session);
  }
}

function onShellCommand(command) {
  const { action, path, out, panel } = command;
  if (action === 'measure-open') measureOpen(path);
  else if (action === 'dump-tabs') dumpTabs(out);
  else if (action === 'show-panel') showPanel(panel);
  else if (action === 'speech' || action === 'speech-test') onSpeechTest(command);
}

function onWindowFocus({ payload: focused }) {
  if (!focused) return;
  if (tabs.active()) for (const [id, entry] of entries) checkFile(id, entry);
  else checkRecents();
}

async function onAppClosing() {
  speech?.stop();
  await Promise.allSettled([...entries.values()].map((entry) => savePosition(entry)));
  await invoke('close_ready');
}

/** The whole window takes the file, and says before the drop whether it will open it. */
function showDropZone(paths) {
  const refused = paths.find((path) => !isSupported(path));
  const accepted = paths.some(isSupported);
  dropZone?.remove();
  dropZone = document.createElement('div');
  dropZone.className = accepted ? 'dropzone' : 'dropzone refused';
  const title = document.createElement('strong');
  title.textContent = accepted ? t('drop.title') : t('drop.refusedTitle', { name: fileName(refused ?? '') });
  const text = document.createElement('span');
  text.textContent = accepted ? t('drop.text') : t('drop.refusedText');
  dropZone.append(accepted ? mascot(document, DROP_MASCOT_PX) : icon(document, 'alert', 40), title, text);
  document.body.append(dropZone);
}

function hideDropZone() {
  dropZone?.remove();
  dropZone = null;
}

/** Not needed for the first frame, so they do not delay it. */
function listenAfterFirstPaint() {
  getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === 'enter') showDropZone(payload.paths);
    if (payload.type === 'leave' || payload.type === 'drop') hideDropZone();
    if (payload.type === 'drop') openPaths(payload.paths);
  });
  document.addEventListener('mousedown', () => {
    lastInputWasKey = false;
  }, { capture: true });
  getCurrentWindow().onFocusChanged(onWindowFocus);
  listen('app-closing', onAppClosing);
}

async function boot() {
  document.addEventListener('keydown', onKeyDown, { capture: true });
  const [saved] = await Promise.all([
    invoke('state_get_options'),
    listen('open-paths', ({ payload }) => openPaths(payload)),
    listen('shell-command', ({ payload }) => onShellCommand(payload)),
  ]);
  await useLanguage(readOptions(saved));
  followSystemTheme();
  paintCaption();
  const paths = await invoke('take_pending_paths');
  await Promise.race([openPaths(paths), delay(SLOW_OPEN_MS)]);
  if (!tabs.active()) await showRecents();
  await twoFrames();
  await invoke('first_paint', { ms: performance.timeOrigin + performance.now() });
  listenAfterFirstPaint();
}

boot();
