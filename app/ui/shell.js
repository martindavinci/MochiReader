// SPDX-License-Identifier: GPL-3.0-or-later
import { setLang, t } from '../core/i18n.js';
import { linkAction } from '../core/links.js';
import { fileName, isSupported } from '../core/paths.js';
import { Tabs } from '../core/tabs.js';
import { openMarkdown } from '../readers/markdown.js';
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
/** @type {Map<number, {pane: HTMLElement, status: string, kind: string|null, reader: object|null, notice: string}>} */
const entries = new Map();
const tabBar = document.getElementById('tabbar');
const panes = document.getElementById('panes');
const home = document.getElementById('home');
const toast = document.getElementById('toast');
let shownTitle = APP_NAME;
let toastTimer = null;

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

function closeTab(id) {
  const entry = entries.get(id);
  entry?.reader?.destroy();
  entry?.pane.remove();
  entries.delete(id);
  tabs.close(id);
  refresh();
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, TOAST_MS);
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
  entry.status = STATUS_OK;
}

function addEntry(id) {
  const entry = { pane: document.createElement('section'), status: STATUS_LOADING, kind: null, reader: null, notice: '' };
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
  const entry = created ? addEntry(id) : entries.get(id);
  refresh();
  if (!created && !RETRIED_STATUSES.includes(entry.status)) return id;
  entry.status = STATUS_LOADING;
  entry.notice = '';
  entry.pane.replaceChildren();
  const slow = setTimeout(() => showNotice(entry, STATUS_LOADING, t('open.loading')), SLOW_OPEN_MS);
  try {
    const doc = await invoke('open_document', { path });
    clearTimeout(slow);
    entry.pane.replaceChildren();
    entry.notice = '';
    if (entries.get(id) === entry) mount(doc, entry);
  } catch (error) {
    clearTimeout(slow);
    if (entries.get(id) === entry) {
      const status = error?.code === CODE_NOT_FOUND ? STATUS_MISSING : STATUS_ERROR;
      showNotice(entry, status, t(`open.error.${error?.code ?? 'unreadable'}`));
    }
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
    const roots = reader ? await reader.speechRoots() : [];
    return {
      path,
      kind,
      status,
      notice,
      firstPageRendered: status === STATUS_OK,
      text: roots.map(({ root }) => root.textContent).join('\n'),
    };
  }));
  await invoke('smoke_write_dump', { out, json: JSON.stringify(rows) });
}

function onShellCommand({ action, path, out }) {
  if (action === 'measure-open') measureOpen(path);
  else if (action === 'dump-tabs') dumpTabs(out);
}

function listenForDrops() {
  getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === 'drop') openPaths(payload.paths);
  });
}

async function boot() {
  setLang(navigator.language);
  home.textContent = t('app.noFile');
  await Promise.all([
    listen('open-paths', ({ payload }) => openPaths(payload)),
    listen('shell-command', ({ payload }) => onShellCommand(payload)),
  ]);
  const paths = await invoke('take_pending_paths');
  await Promise.race([openPaths(paths), delay(SLOW_OPEN_MS)]);
  await twoFrames();
  await invoke('first_paint', { ms: performance.timeOrigin + performance.now() });
  listenForDrops();
}

boot();
