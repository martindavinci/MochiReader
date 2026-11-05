// SPDX-License-Identifier: GPL-3.0-or-later
// The real shell and the real book reader on the real page, with only foliate and Tauri replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveObjectURL } from 'node:buffer';
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

async function startBookShell({ bookmarks = [], makeBook = async () => goodBook() } = {}) {
  const { window, document, HTMLElement } = parseHTML(INDEX_HTML);
  HTMLElement.prototype.focus = function focus() {};
  const realCreate = document.createElement.bind(document);
  const views = [];
  const state = {
    modified: FIRST_MTIME, saved: [], dump: null, onFocus: () => {}, holdFirstPage: null, bookmarks, moved: [], opened: [],
    contents: [],
  };
  document.createElement = (tag) => {
    const element = realCreate(tag);
    if (tag !== 'foliate-view') return element;
    views.push(element);
    return Object.assign(element, {
      inits: [],
      goes: [],
      styles: [],
      renderer: {
        setAttribute() {},
        setStyles: (css) => element.styles.push(css),
        getContents: () => state.contents,
        addEventListener() {},
        removeEventListener() {},
      },
      open: async (book) => {
        element.book = book;
      },
      init: async ({ lastLocation }) => {
        element.inits.push(lastLocation);
        await state.holdFirstPage;
        element.lastLocation = { cfi: lastLocation ?? SAVED_CFI, range: null };
      },
      goTo: async (target) => {
        element.goes.push(target);
      },
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
    state_get: () => ({ recents: [], bookmarks: state.bookmarks }),
    state_move_bookmarks: (args) => state.moved.push(args),
    state_check_recents: () => [],
    state_get_position: () => null,
    state_save_position: (args) => state.saved.push(args),
    open_document: ({ path }) => {
      state.opened.push(path);
      return {
        path,
        name: 'b.epub',
        kind: 'epub',
        fileUrl: 'http://mochi.localhost/file/x',
        modifiedMs: state.modified,
      };
    },
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
        setTheme: async () => {},
        onFocusChanged: async (callback) => {
          state.onFocus = callback;
        },
      }),
    },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: () => {} }) },
    app: { getVersion: async () => '1.2.3' },
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
    ResizeObserver: class {
      observe() {}

      disconnect() {}
    },
    fetch: async () => new Response('a book', { status: 200 }),
    fakeMakeBook: makeBook,
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
    document,
    window,
    views,
    state,
    until,
    focusWindow: () => state.onFocus({ payload: true }),
    press: (key, ctrlKey = false) => {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(event, { key, ctrlKey, shiftKey: false, altKey: false });
      document.body.dispatchEvent(event);
    },
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

  assert.equal(shell.pane().querySelector('.file-notice-text').textContent, en['file.notReloaded']);
  assert.ok(![...shell.pane().children].some((child) => child.classList.contains('state')));
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

test('a change of text size leaves the place to foliate, which holds it through the reflow', async () => {
  const shell = await startBookShell();
  const [view] = shell.views;
  await shell.until(() => view.styles.length > 0, 'the book got no style');
  const styled = view.styles.length;
  shell.press('+', true);
  shell.press('-', true);
  await shell.until(() => view.styles.length === styled + 2, 'the size did not reach the book');
  assert.deepEqual(view.goes, [], 'going to the start of the page would give up the place, a little more each time');
});

test('a message about the file leaves the place to foliate too', async () => {
  const shell = await startBookShell();
  const [view] = shell.views;
  changeFile(shell, SECOND_MTIME, brokenBook);
  await noticeShown(shell);
  assert.deepEqual(view.goes, []);
});

test('the book waiting for its page has the room of the real one, and cannot be seen', () => {
  assert.match(APP_CSS, /\.book-stage\.waiting \{[^}]*position: absolute;[^}]*inset: 0;[^}]*visibility: hidden;/);
});

test('a section that cannot be read gets the message of this interface', async () => {
  const load = async () => {
    throw new Error('damaged');
  };
  const shell = await startBookShell({ makeBook: async () => ({ ...goodBook(), sections: [{ load }] }) });
  const url = await shell.views[0].book.sections[0].load();
  assert.ok((await resolveObjectURL(url).text()).includes(en['epub.sectionError']));
});

test('a new file that is damaged at the place being read leaves the book on screen', async () => {
  const shell = await startBookShell();
  const [view] = shell.views;
  shell.state.contents = [{ doc: parseHTML('<html><head></head><body><p data-unreadable-section="">x</p></body></html>').document }];
  changeFile(shell, SECOND_MTIME, async () => goodBook());
  await noticeShown(shell);
  assert.equal(shell.pane().querySelector('.file-notice-text').textContent, en['file.notReloaded']);
  assert.ok(shell.shownViews()[0] === view);
  assert.equal(shell.shownViews().length, 1);
  assert.equal(view.closed, undefined);
  assert.ok(shell.views[1].closed, 'the new book is let go');
  assert.equal(shell.pane().querySelector('.book-stage'), null);
});

const KEY_OF_BOOK = 'epub:id|T|1';
const PATH_BEFORE = 'C:/x/prima.epub';
const movedBookmark = {
  key: KEY_OF_BOOK,
  path: PATH_BEFORE,
  title: 'T',
  position: { kind: 'epub', cfi: SAVED_CFI, sentence: 0 },
  excerpt: 'Brano',
  createdAt: 1,
};

test('a book open from a new file takes its bookmarks along', async () => {
  const shell = await startBookShell();
  await shell.until(() => shell.state.moved.length > 0, 'the bookmarks stayed behind');
  assert.deepEqual(shell.state.moved, [{ key: KEY_OF_BOOK, path: PATH_BOOK }]);
});

test('a bookmark goes to its book where it is open, whichever file the bookmark last saw', async () => {
  const shell = await startBookShell({ bookmarks: [movedBookmark] });
  const [view] = shell.views;
  shell.press('b', true);
  await shell.until(() => shell.document.querySelector('.bookmark-open'), 'no bookmark in the panel');
  shell.document.querySelector('.bookmark-open').dispatchEvent(new shell.window.Event('click'));
  await shell.until(() => view.goes.length > 0, 'the book did not move');

  assert.deepEqual(view.goes, [SAVED_CFI]);
  assert.deepEqual(shell.state.opened, [PATH_BOOK]);
  assert.equal(shell.document.getElementById('toast').hidden, true);
  assert.equal(shell.document.getElementById('panel').hidden, true);
});
