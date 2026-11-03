// SPDX-License-Identifier: GPL-3.0-or-later
import { getLang, setLang, t } from '../core/i18n.js';
import { resolveKey } from '../core/keys.js';
import { linkAction } from '../core/links.js';
import { fileName, isSupported, OPENABLE_EXTENSIONS } from '../core/paths.js';
import { Tabs } from '../core/tabs.js';
import { openMarkdown } from '../readers/markdown.js';
import { applyOptions, interfaceLang, nextTextSize, readOptions, renderOptions } from './options.js';
import { createPanels, renderBookmarks, renderToc } from './panels.js';
import { renderRecents } from './recents.js';
import { renderTabBar } from './tabbar.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const { getCurrentWebview } = window.__TAURI__.webview;
const { open: openDialog } = window.__TAURI__.dialog;

const APP_NAME = 'MochiReader';
// A file that takes longer than this no longer keeps the window hidden, and its tab says it is opening.
const SLOW_OPEN_MS = 400;
const TOAST_MS = 4000;
const STATUS_LOADING = 'loading';
const STATUS_OK = 'ok';
const STATUS_ERROR = 'error';
const STATUS_MISSING = 'missing';
const CODE_NOT_FOUND = 'not_found';
// The file may be back by now, so opening it again tries again.
const RETRIED_STATUSES = [STATUS_ERROR, STATUS_MISSING];
// Focusable from code and by click, but not one more stop for the Tab key.
const PANE_TAB_INDEX = '-1';
const PANEL_RECENTS = 'recents';
const PANEL_BOOKMARKS = 'bookmarks';
const PANEL_TOC = 'toc';
const PANEL_OPTIONS = 'options';
const FORWARD = 1;
const BACK = -1;
// The page scrolls the text on its own, as long as the key reaches it.
const PAGE_ACTIONS = new Set(['scroll.page']);
// What a focused button or list answers to itself, and so must not also act on the text behind it.
const CONTROLS = 'button, select, input, #panel';
const CONTROL_KEYS = new Set([' ', '+', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
// A key held down repeats. For these that is still what the reader wants; closing every tab is not.
const REPEATING_ACTIONS = new Set([
  'tab.next', 'text.bigger', 'text.smaller', 'block.prev', 'block.next', 'section.prev', 'section.next',
]);

const tabs = new Tabs();
/**
 * @type {Map<number, {path: string, pane: HTMLElement, status: string, kind: string|null, reader: object|null,
 *   notice: string, fileNotice: HTMLElement|null, key: string|null, title: string, modified: number|null,
 *   restored: boolean, checking: boolean, opening: Promise<void>|null}>}
 */
const entries = new Map();
const tabBar = document.getElementById('tabbar');
const panes = document.getElementById('panes');
const home = document.getElementById('home');
const toast = document.getElementById('toast');
const panelHost = document.getElementById('panel');
const panels = createPanels(panelHost);
let options = readOptions({});
let shownTabId = null;
let shownTitle = APP_NAME;
let toastTimer = null;
let drawnRecents = null;

const twoFrames = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const activeEntry = () => entries.get(tabs.active()?.id) ?? null;

/** The body does not scroll, so the keys only move the text while its pane has the focus. */
function focusText() {
  activeEntry()?.pane.focus({ preventScroll: true });
}

function refresh() {
  const active = tabs.active();
  // What a panel shows can be about the tab that was in front.
  if ((active?.id ?? null) !== shownTabId) panels.close();
  shownTabId = active?.id ?? null;
  for (const [id, entry] of entries) entry.pane.classList.toggle('active', id === active?.id);
  home.classList.toggle('active', !active);
  if (!panels.current()) focusText();
  renderTabBar(tabBar, tabs.all(), active?.id, {
    closeLabel: t('tabs.close'),
    onActivate: (id) => {
      tabs.activate(id);
      refresh();
    },
    onClose: closeTab,
  });
  const title = active ? fileName(active.path) : APP_NAME;
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

function drawRecents(recents) {
  drawnRecents = JSON.stringify(recents);
  renderRecents(home, recents, {
    labels: { hint: t('app.noFile'), ...recentsLabels() },
    onOpen: openPath,
    onRemove: removeRecent,
  });
}

/** Asks the drives, which can take a while: the list is already on screen, and changes only if the answer differs. */
async function checkRecents() {
  const recents = await invoke('state_check_recents');
  if (JSON.stringify(recents) !== drawnRecents) drawRecents(recents);
}

async function showRecents() {
  const { recents } = await invoke('state_get');
  drawRecents(recents);
  checkRecents();
}

async function removeRecent(path) {
  await invoke('state_remove_recent', { path });
  await showRecents();
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, TOAST_MS);
}

/** A message above text that stays readable. An empty one takes it away. */
function setFileNotice(entry, message) {
  entry.notice = message;
  entry.fileNotice?.remove();
  entry.fileNotice = null;
  if (!message) return;
  entry.fileNotice = document.createElement('p');
  entry.fileNotice.className = 'file-notice';
  entry.fileNotice.setAttribute('role', 'status');
  entry.fileNotice.textContent = message;
  entry.pane.prepend(entry.fileNotice);
}

function showNotice(entry, status, message) {
  entry.status = status;
  entry.notice = message;
  const notice = document.createElement('p');
  notice.className = 'notice';
  notice.textContent = message;
  entry.pane.replaceChildren(notice);
}

function follow(action, pane) {
  if (action?.type === 'doc') openPath(action.path);
  else if (action?.type === 'external') invoke('open_external', { url: action.url });
  else if (action?.type === 'anchor') pane.querySelector(`#${CSS.escape(action.id)}`)?.scrollIntoView();
}

function mount(doc, entry) {
  entry.kind = doc.kind;
  entry.key = doc.key ?? null;
  entry.title = doc.name;
  entry.modified = doc.modifiedMs ?? null;
  entry.restored = false;
  // The book reader arrives with the EPUB work: until then a book only gets this message.
  if (doc.kind !== 'markdown') {
    showNotice(entry, STATUS_ERROR, t('epub.error'));
    return;
  }
  entry.reader = openMarkdown(doc, entry.pane);
  entry.reader.onInput((event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    follow(linkAction(link.getAttribute('href')), entry.pane);
  });
  entry.reader.onMove((position) => savePosition(entry, position));
  entry.status = STATUS_OK;
}

/** Takes the reader of the tab to `position`, if any. From then on its position is worth saving. */
async function settle(id, entry, position) {
  const { reader } = entry;
  if (position) await reader.goTo(position);
  if (entries.get(id) === entry && entry.reader === reader) entry.restored = true;
}

async function restorePosition(id, entry) {
  const saved = await invoke('state_get_position', { key: entry.key });
  if (entries.get(id) === entry) await settle(id, entry, saved);
}

async function reload(id, entry) {
  const doc = await invoke('open_document', { path: entry.path });
  if (entries.get(id) !== entry) return;
  const position = entry.reader.position();
  entry.reader.destroy();
  mount(doc, entry);
  setFileNotice(entry, '');
  await settle(id, entry, position);
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
    showToast(t('app.unsupported', { name: fileName(path) }));
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
  const slow = setTimeout(() => showNotice(entry, STATUS_LOADING, t('open.loading')), SLOW_OPEN_MS);
  let doc;
  try {
    doc = await invoke('open_document', { path });
  } catch (error) {
    if (entries.get(id) === entry) {
      const status = error?.code === CODE_NOT_FOUND ? STATUS_MISSING : STATUS_ERROR;
      showNotice(entry, status, t(`open.error.${error?.code ?? 'unreadable'}`));
    }
    return;
  } finally {
    clearTimeout(slow);
  }
  entry.pane.replaceChildren();
  entry.notice = '';
  if (entries.get(id) !== entry) return;
  mount(doc, entry);
  if (entry.status === STATUS_OK) {
    invoke('state_touch_recent', { path: doc.path, kind: doc.kind, title: doc.name });
    await restorePosition(id, entry);
  }
}

const openPaths = (paths) => Promise.all(paths.map(openPath));

function closePanel() {
  panels.close();
  focusText();
}

async function drawRecentsPanel() {
  const draw = (recents) => {
    renderRecents(panelHost, recents, {
      labels: recentsLabels(),
      onOpen: (path) => {
        closePanel();
        openPath(path);
      },
      onRemove: async (path) => {
        await removeRecent(path);
        await showPanel(PANEL_RECENTS);
      },
    });
    panels.focus();
  };
  const { recents } = await invoke('state_get');
  if (panels.current() !== PANEL_RECENTS) return;
  draw(recents);
  // Asks the drives, which can take a while: the list is already on screen.
  invoke('state_check_recents').then((checked) => {
    if (panels.current() === PANEL_RECENTS && JSON.stringify(checked) !== JSON.stringify(recents)) draw(checked);
  });
}

async function openBookmark({ path, position, title }) {
  closePanel();
  const id = await openPath(path);
  const entry = entries.get(id);
  if (entry?.status === STATUS_MISSING) {
    closeTab(id);
    showToast(t('bookmarks.missingFile', { name: title }));
    await showPanel(PANEL_BOOKMARKS);
    return;
  }
  await entry?.reader?.goTo(position);
}

async function drawBookmarksPanel() {
  const { bookmarks } = await invoke('state_get');
  if (panels.current() !== PANEL_BOOKMARKS) return;
  renderBookmarks(panelHost, bookmarks, {
    labels: { title: t('bookmarks.title'), empty: t('bookmarks.empty'), remove: t('recents.remove') },
    dateOf: (ms) => new Date(ms).toLocaleDateString(getLang()),
    onOpen: openBookmark,
    onRemove: async (bookmark) => {
      await invoke('state_toggle_bookmark', { bookmark });
      await showPanel(PANEL_BOOKMARKS);
    },
  });
}

function drawTocPanel() {
  renderToc(panelHost, activeEntry()?.reader?.toc() ?? [], {
    labels: { title: t('toc.title'), empty: t('toc.empty') },
    onGo: (target) => {
      const { reader } = activeEntry();
      closePanel();
      reader.goTo(target);
    },
  });
}

/** The options are on the page first, so that the first frame already has them. */
function useOptions(next) {
  options = next;
  applyOptions(options, document.documentElement);
  setLang(interfaceLang(options, navigator.language));
}

/** The text changes length with its size: each tab stays where it was reading. */
function setTextSize(size) {
  const places = [...entries.values()]
    .filter(({ reader, restored }) => reader && restored)
    .map(({ reader }) => ({ reader, place: reader.position() }));
  useOptions({ ...options, textSize: size });
  places.forEach(({ reader, place }) => reader.goTo(place));
}

function changeOption(name, value) {
  if (name === 'textSize') setTextSize(value);
  else useOptions({ ...options, [name]: value });
  invoke('state_set_option', { name, value });
  if (name === 'language') {
    refresh();
    if (!tabs.active()) showRecents();
  }
  if (panels.current() === PANEL_OPTIONS) {
    drawOptionsPanel();
    panelHost.querySelector(`select[name="${name}"]`).focus();
  }
}

function drawOptionsPanel() {
  renderOptions(panelHost, options, { onChange: changeOption });
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
};

async function showPanel(name) {
  panels.show(name);
  await PANELS[name]();
  if (panels.current() === name) panels.focus();
}

function togglePanel(name) {
  if (panels.current() === name) closePanel();
  else showPanel(name);
}

/** Until the saved position has been applied, the reader is still at the top, which is not where a bookmark goes. */
async function toggleBookmark() {
  const entry = activeEntry();
  if (!entry?.reader || !entry.restored || !entry.key) return;
  const bookmark = {
    key: entry.key,
    path: entry.path,
    title: entry.title,
    position: entry.reader.position(),
    excerpt: entry.reader.excerpt(),
    createdAt: Date.now(),
  };
  const added = await invoke('state_toggle_bookmark', { bookmark });
  showToast(t(added ? 'bookmarks.added' : 'bookmarks.removed'));
  if (panels.current() === PANEL_BOOKMARKS) await showPanel(PANEL_BOOKMARKS);
}

async function pickFiles() {
  const paths = await openDialog({
    title: t('dialog.open'),
    multiple: true,
    filters: [{ name: t('dialog.filter'), extensions: OPENABLE_EXTENSIONS }],
  });
  if (paths) await openPaths(paths);
}

// Speech has no actions here yet: its keys still stay away from the browser.
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
  'panel.close': closePanel,
  'bookmark.toggle': toggleBookmark,
  'text.bigger': () => stepTextSize(FORWARD),
  'text.smaller': () => stepTextSize(BACK),
  'block.next': () => activeEntry()?.reader?.moveBlock?.(FORWARD),
  'block.prev': () => activeEntry()?.reader?.moveBlock?.(BACK),
  'section.next': () => activeEntry()?.reader?.moveSection?.(FORWARD),
  'section.prev': () => activeEntry()?.reader?.moveSection?.(BACK),
};

/**
 * A shortcut is the shell's alone: the reader must not take it for the reader moving on, which would let go of the
 * point it is holding, and that point is what `Ctrl+D` saves. So this listens on the way down, before the reader.
 */
function onKeyDown(event) {
  const chord = { key: event.key, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey };
  const action = resolveKey(chord, { speaking: false, kind: activeEntry()?.kind ?? '' });
  if (!action || PAGE_ACTIONS.has(action)) return;
  if (!event.ctrlKey && CONTROL_KEYS.has(event.key) && event.target.closest?.(CONTROLS)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat || REPEATING_ACTIONS.has(action)) SHORTCUTS[action]?.();
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
    const { status, kind, reader, notice } = entries.get(id);
    const position = reader ? reader.position() : null;
    const roots = reader ? await reader.speechRoots() : [];
    return {
      path,
      kind,
      status,
      notice,
      firstPageRendered: status === STATUS_OK,
      position,
      screenLine: reader?.screenLine?.() ?? null,
      text: roots.map(({ root }) => root.textContent).join('\n'),
    };
  }));
  await invoke('smoke_write_dump', { out, json: JSON.stringify(rows) });
}

function onShellCommand({ action, path, out }) {
  if (action === 'measure-open') measureOpen(path);
  else if (action === 'dump-tabs') dumpTabs(out);
}

function onWindowFocus({ payload: focused }) {
  if (!focused) return;
  if (tabs.active()) for (const [id, entry] of entries) checkFile(id, entry);
  else checkRecents();
}

async function onAppClosing() {
  await Promise.allSettled([...entries.values()].map((entry) => savePosition(entry)));
  await invoke('close_ready');
}

/** Not needed for the first frame, so they do not delay it. */
function listenAfterFirstPaint() {
  getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === 'drop') openPaths(payload.paths);
  });
  getCurrentWindow().onFocusChanged(onWindowFocus);
  listen('app-closing', onAppClosing);
}

async function boot() {
  setLang(navigator.language);
  document.addEventListener('keydown', onKeyDown, { capture: true });
  const [saved] = await Promise.all([
    invoke('state_get_options'),
    listen('open-paths', ({ payload }) => openPaths(payload)),
    listen('shell-command', ({ payload }) => onShellCommand(payload)),
  ]);
  useOptions(readOptions(saved));
  const paths = await invoke('take_pending_paths');
  await Promise.race([openPaths(paths), delay(SLOW_OPEN_MS)]);
  if (!tabs.active()) await showRecents();
  await twoFrames();
  await invoke('first_paint', { ms: performance.timeOrigin + performance.now() });
  listenAfterFirstPaint();
}

boot();
