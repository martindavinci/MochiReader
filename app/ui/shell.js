// SPDX-License-Identifier: GPL-3.0-or-later
import { setLang, t } from '../core/i18n.js';
import { linkAction } from '../core/links.js';
import { fileName, isSupported } from '../core/paths.js';
import { Tabs } from '../core/tabs.js';
import { openMarkdown } from '../readers/markdown.js';
import { renderRecents } from './recents.js';
import { renderTabBar } from './tabbar.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const { getCurrentWebview } = window.__TAURI__.webview;

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

const tabs = new Tabs();
/**
 * @type {Map<number, {path: string, pane: HTMLElement, status: string, kind: string|null, reader: object|null,
 *   notice: string, fileNotice: HTMLElement|null, key: string|null, modified: number|null, restored: boolean,
 *   checking: boolean}>}
 */
const entries = new Map();
const tabBar = document.getElementById('tabbar');
const panes = document.getElementById('panes');
const home = document.getElementById('home');
const toast = document.getElementById('toast');
let shownTitle = APP_NAME;
let toastTimer = null;
let drawnRecents = null;

const twoFrames = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

function refresh() {
  const active = tabs.active();
  for (const [id, entry] of entries) entry.pane.classList.toggle('active', id === active?.id);
  home.classList.toggle('active', !active);
  // The body does not scroll, so the keys only move the text while its pane has the focus.
  if (active) entries.get(active.id)?.pane.focus({ preventScroll: true });
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

function drawRecents(recents) {
  drawnRecents = JSON.stringify(recents);
  renderRecents(home, recents, {
    labels: {
      hint: t('app.noFile'),
      title: t('recents.title'),
      empty: t('recents.empty'),
      missing: t('recents.missing'),
      remove: t('recents.remove'),
    },
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
    modified: null,
    restored: false,
    checking: false,
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
  if (!created && !RETRIED_STATUSES.includes(entry.status)) {
    checkFile(id, entry);
    return id;
  }
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
    return id;
  } finally {
    clearTimeout(slow);
  }
  entry.pane.replaceChildren();
  entry.notice = '';
  if (entries.get(id) !== entry) return id;
  mount(doc, entry);
  if (entry.status === STATUS_OK) {
    invoke('state_touch_recent', { path: doc.path, kind: doc.kind, title: doc.name });
    await restorePosition(id, entry);
  }
  return id;
}

const openPaths = (paths) => Promise.all(paths.map(openPath));

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
  await Promise.all([
    listen('open-paths', ({ payload }) => openPaths(payload)),
    listen('shell-command', ({ payload }) => onShellCommand(payload)),
  ]);
  const paths = await invoke('take_pending_paths');
  await Promise.race([openPaths(paths), delay(SLOW_OPEN_MS)]);
  if (!tabs.active()) await showRecents();
  await twoFrames();
  await invoke('first_paint', { ms: performance.timeOrigin + performance.now() });
  listenAfterFirstPaint();
}

boot();
