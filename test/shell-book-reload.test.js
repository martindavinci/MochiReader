// SPDX-License-Identifier: GPL-3.0-or-later
// The real shell and the real book reader on the real page, with only foliate and Tauri replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DOMParser, parseHTML } from 'linkedom';
import en from '../app/lang/en.js';

const INDEX_HTML = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const APP_CSS = readFileSync(new URL('../app/css/app.css', import.meta.url), 'utf8');
const PATH_BOOK = 'C:/x/b.epub';
const FIRST_MTIME = 1000;
const SECOND_MTIME = 2000;
const THIRD_MTIME = 3000;
const SAVED_CFI = 'epubcfi(/6/4!/4/2/1:0)';
const WAIT_TURNS = 200;

const FAKE_FOLIATE = 'data:text/javascript,export const makeBook = (file) => globalThis.fakeMakeBook(file);';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('vendor/foliate/view.js')) return { url: FAKE_FOLIATE, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const goodBook = () => ({
  metadata: { identifier: 'id', title: 'T', language: 'en' },
  sections: [{}],
  loadText: async () => null,
});

const brokenBook = async () => {
  throw new Error('the file is cut short');
};

let run = 0;

async function startBookShell() {
  const { window, document, HTMLElement } = parseHTML(INDEX_HTML);
  HTMLElement.prototype.focus = function focus() {};
  const realCreate = document.createElement.bind(document);
  const views = [];
  const state = { modified: FIRST_MTIME, saved: [], dump: null, onFocus: () => {}, holdFirstPage: null };
  document.createElement = (tag) => {
    const element = realCreate(tag);
    if (tag !== 'foliate-view') return element;
    views.push(element);
    return Object.assign(element, {
      inits: [],
      renderer: { setAttribute() {}, setStyles() {}, getContents: () => [] },
      open: async (book) => {
        element.book = book;
      },
      init: async ({ lastLocation }) => {
        element.inits.push(lastLocation);
        await state.holdFirstPage;
        element.lastLocation = { cfi: lastLocation ?? SAVED_CFI, range: null };
      },
      goTo: async () => {},
      close: () => {
        element.closed = true;
        element.lastLocation = null;
      },
    });
  };
  let painted;
  const firstPaint = new Promise((resolve) => {
    painted = resolve;
  });
  const commands = {
    first_paint: () => painted(),
    take_pending_paths: () => [PATH_BOOK],
    state_get_options: () => ({ language: 'en' }),
    state_get: () => ({ recents: [], bookmarks: [] }),
    state_check_recents: () => [],
    state_get_position: () => null,
    state_save_position: (args) => state.saved.push(args),
    open_document: ({ path }) => ({
      path,
      name: 'b.epub',
      kind: 'epub',
      fileUrl: 'http://mochi.localhost/file/x',
      modifiedMs: state.modified,
    }),
    file_modified: () => state.modified,
    smoke_write_dump: ({ json }) => {
      state.dump = JSON.parse(json);
    },
  };
  const listeners = new Map();
  window.__TAURI__ = {
    core: { invoke: async (command, args) => commands[command]?.(args) },
    event: {
      listen: async (name, callback) => {
        listeners.set(name, callback);
      },
    },
    window: {
      getCurrentWindow: () => ({
        setTitle: () => {},
        onFocusChanged: async (callback) => {
          state.onFocus = callback;
        },
      }),
    },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: () => {} }) },
    dialog: { open: async () => null },
  };
  Object.assign(globalThis, {
    window,
    document,
    DOMParser,
    CSS: { escape: (text) => text },
    requestAnimationFrame: (callback) => setTimeout(callback),
    getComputedStyle: () => ({ scrollPaddingTop: 'auto' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async () => new Response('a book', { status: 200 }),
    fakeMakeBook: async () => goodBook(),
  });
  run += 1;
  await import(`../app/ui/shell.js?book=${run}`);
  await firstPaint;

  const settled = () => new Promise((resolve) => {
    setTimeout(resolve);
  });
  const until = async (done, what) => {
    for (let turn = 0; turn < WAIT_TURNS; turn += 1) {
      if (done()) return;
      await settled();
    }
    assert.fail(what);
  };
  const pane = () => document.querySelector('section.pane:not(#home)');
  await until(() => views[0]?.lastLocation, 'the book did not open');
  return {
    pane,
    views,
    state,
    until,
    focusWindow: () => state.onFocus({ payload: true }),
    shownViews: () => [...pane().querySelectorAll('foliate-view')],
    closeTab: () => {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(event, { key: 'w', ctrlKey: true, shiftKey: false, altKey: false });
      document.body.dispatchEvent(event);
    },
    dump: async () => {
      listeners.get('shell-command')({ payload: { action: 'dump-tabs', out: 'x' } });
      await until(() => state.dump, 'no report of the tabs');
      return state.dump[0];
    },
  };
}

/** Makes the file of the book change on disk into `makeBook`, and brings the window back to the front. */
function changeFile(shell, modified, makeBook) {
  shell.state.modified = modified;
  globalThis.fakeMakeBook = makeBook;
  shell.focusWindow();
}

const noticeShown = (shell) => shell.until(() => shell.pane().querySelector('.file-notice'), 'no message about the file');

test('a book that turns unreadable on disk stays on screen and says so', async () => {
  const shell = await startBookShell();
  const [view] = shell.views;
  changeFile(shell, SECOND_MTIME, brokenBook);
  await noticeShown(shell);

  assert.equal(shell.pane().querySelector('.file-notice').textContent, en['file.notReloaded']);
  assert.equal(shell.pane().querySelector('.notice'), null);
  assert.equal(shell.shownViews().length, 1);
  assert.ok(shell.shownViews()[0] === view);
  assert.equal(view.closed, undefined);
  assert.equal(shell.pane().querySelector('.book-stage'), null);
  const row = await shell.dump();
  assert.equal(row.status, 'ok');
  assert.equal(row.position.cfi, SAVED_CFI);
});

test('once the file can be read again it comes back by itself, at the same place', async () => {
  const shell = await startBookShell();
  const [old] = shell.views;
  changeFile(shell, SECOND_MTIME, brokenBook);
  await noticeShown(shell);

  changeFile(shell, THIRD_MTIME, async () => goodBook());
  await shell.until(() => old.closed, 'the old book stayed');

  assert.equal(shell.shownViews().length, 1);
  const [fresh] = shell.shownViews();
  assert.ok(fresh !== old);
  assert.deepEqual(fresh.inits, [SAVED_CFI]);
  assert.equal(shell.pane().querySelector('.file-notice'), null);
  assert.equal(shell.pane().querySelector('.book-stage.waiting'), null);
});

test('a file that comes back unchanged takes the message away', async () => {
  const shell = await startBookShell();
  const [view] = shell.views;
  changeFile(shell, SECOND_MTIME, brokenBook);
  await noticeShown(shell);

  shell.state.modified = FIRST_MTIME;
  shell.focusWindow();
  await shell.until(() => !shell.pane().querySelector('.file-notice'), 'the message stayed');
  assert.ok(shell.shownViews()[0] === view);
  assert.equal(view.closed, undefined);
});

test('the old book stays until the new one has a page to show, which waits out of sight', async () => {
  const shell = await startBookShell();
  const [old] = shell.views;
  let release;
  shell.state.holdFirstPage = new Promise((resolve) => {
    release = resolve;
  });
  changeFile(shell, SECOND_MTIME, async () => goodBook());
  await shell.until(() => shell.views[1]?.inits.length === 1, 'the new book did not start');

  assert.equal(old.closed, undefined);
  assert.equal(old.parentElement.classList.contains('waiting'), false);
  assert.ok(shell.views[1].parentElement.classList.contains('waiting'));

  release();
  await shell.until(() => old.closed, 'the old book stayed');
  assert.equal(shell.shownViews().length, 1);
  assert.ok(shell.shownViews()[0] === shell.views[1]);
  assert.equal(shell.views[1].parentElement.classList.contains('waiting'), false);
});

test('a tab closed while its book reloads leaves nothing open', async () => {
  const shell = await startBookShell();
  let release;
  shell.state.holdFirstPage = new Promise((resolve) => {
    release = resolve;
  });
  changeFile(shell, SECOND_MTIME, async () => goodBook());
  await shell.until(() => shell.views[1]?.inits.length === 1, 'the new book did not start');
  shell.closeTab();
  release();
  await shell.until(() => shell.views[1].closed, 'the new book stayed open');
  assert.ok(shell.views[0].closed);
});

test('the book waiting for its page has the room of the real one, and cannot be seen', () => {
  assert.match(APP_CSS, /\.book-stage\.waiting \{[^}]*position: absolute;[^}]*inset: 0;[^}]*visibility: hidden;/);
});
