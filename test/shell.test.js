// SPDX-License-Identifier: GPL-3.0-or-later
// Elements are compared with ===: a failed assert.equal would print the whole linkedom page, which takes minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import en from '../app/lang/en.js';
import it from '../app/lang/it.js';
import { MEDIA_PRESS_WINDOW_MS } from '../app/speech/media-keys.js';
import { withHighlights } from './speech-fakes.js';

const PATH_A = 'C:/x/a.md';
const PATH_B = 'C:/x/b.md';
const PATH_BOOK = 'C:/x/b.epub';
// Turns of the page that a failed import of foliate may take.
const BOOK_TURNS = 50;
const INDEX_HTML = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const APP_CSS = readFileSync(new URL('../app/css/app.css', import.meta.url), 'utf8');

const CHANGED_AT = 1000;
const SAVE_WAIT_MS = 600;
// Past the second click of a double click.
const DOUBLE_CLICK_OVER_MS = 600;
const MEDIA_WINDOW_OVER_MS = MEDIA_PRESS_WINDOW_MS + 50;

const keyOf = (path) => `md:${path.toLowerCase()}`;

const markdownDoc = (path, text, modifiedMs = CHANGED_AT) => ({
  path,
  name: path,
  kind: 'markdown',
  key: keyOf(path),
  modifiedMs,
  rendered: { html: `<p data-sourcepos="1:1-1:9">${text}</p>`, lang: null, headings: [] },
});

const longDoc = (path, text = 'Testo', modifiedMs = CHANGED_AT) => ({
  ...markdownDoc(path, text, modifiedMs),
  rendered: {
    html: [1, 5, 9].map((line) => `<p data-sourcepos="${line}:1-${line}:9">${text} ${line}</p>`).join(''),
    lang: null,
    headings: [],
  },
});

const atLine = (line) => ({ kind: 'md', line, sentence: 0 });

let run = 0;

/** Starts a fresh copy of the real shell on the real page, with a fake Tauri around it. */
async function startShell(openDocument, {
  pending = [], positions = {}, recents = [], fileModified, bookmarks = [], options = {}, picked = null, voices = {},
} = {}) {
  const { window, document, HTMLElement } = parseHTML(INDEX_HTML);
  const focused = [];
  HTMLElement.prototype.focus = function focus(options) {
    focused.push(this);
    this.focusedWith = options;
  };
  // An emptied list is laid out while the answer comes, and a list with nothing in it has no scroll to keep.
  const panelHost = document.getElementById('panel');
  const fillPanel = panelHost.replaceChildren.bind(panelHost);
  panelHost.replaceChildren = (...nodes) => {
    if (nodes.length === 0) panelHost.scrollTop = 0;
    fillPanel(...nodes);
  };
  const scrolled = [];
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    scrolled.push(this);
  };
  const listeners = new Map();
  const calls = [];
  let painted;
  const firstPaint = new Promise((resolve) => {
    painted = resolve;
  });
  const state = {
    recents,
    checked: null,
    positions: new Map(Object.entries(positions)),
    touched: [],
    saved: [],
    asked: [],
    closed: 0,
    dump: null,
    fileModified: fileModified ?? (async () => CHANGED_AT),
    bookmarks,
    options,
    optionWrites: [],
    voiceWrites: [],
    dialogs: [],
    picked,
    themeAtFirstPaint: undefined,
  };
  const commands = {
    take_pending_paths: () => pending,
    first_paint: () => {
      state.themeAtFirstPaint = document.documentElement.getAttribute('data-theme');
      painted();
    },
    open_document: ({ path }) => {
      calls.push(path);
      return openDocument(path);
    },
    state_get: () => {
      state.asked.push('state_get');
      return { recents: state.recents, bookmarks: state.bookmarks, voices, options: state.options };
    },
    state_get_options: () => state.options,
    licenses_text: () => 'the license text',
    state_set_voice: (args) => {
      state.voiceWrites.push(args);
    },
    state_set_option: ({ name, value }) => {
      state.optionWrites.push([name, value]);
      state.options[name] = value;
    },
    state_toggle_bookmark: ({ bookmark }) => {
      const same = (kept) => kept.key === bookmark.key && JSON.stringify(kept.position) === JSON.stringify(bookmark.position);
      const added = !state.bookmarks.some(same);
      state.bookmarks = added ? [...state.bookmarks, bookmark] : state.bookmarks.filter((kept) => !same(kept));
      return added;
    },
    state_check_recents: () => state.checked ?? state.recents,
    state_touch_recent: (args) => {
      state.touched.push(args);
    },
    state_remove_recent: ({ path }) => {
      state.recents = state.recents.filter((recent) => recent.path !== path);
      state.checked = null;
    },
    state_get_position: ({ key }) => state.positions.get(key) ?? null,
    state_save_position: ({ key, position }) => {
      state.saved.push({ key, position });
      state.positions.set(key, position);
    },
    file_modified: ({ path }) => state.fileModified(path),
    close_ready: () => {
      state.closed += 1;
    },
    smoke_write_dump: ({ json }) => {
      state.dump = JSON.parse(json);
    },
  };
  let onFocus = () => {};
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
          onFocus = callback;
        },
      }),
    },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: () => {} }) },
    app: { getVersion: async () => '1.2.3' },
    dialog: {
      open: async (dialogOptions) => {
        state.dialogs.push(dialogOptions);
        return state.picked;
      },
    },
  };
  Object.assign(globalThis, {
    window,
    document,
    CSS: { escape: (text) => text },
    requestAnimationFrame: (callback) => setTimeout(callback),
    getComputedStyle: () => ({ scrollPaddingTop: 'auto' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class {
      observe() {}

      disconnect() {}
    },
  });
  run += 1;
  await import(`../app/ui/shell.js?run=${run}`);
  await firstPaint;

  const settled = () => new Promise((resolve) => {
    setTimeout(resolve);
  });
  return {
    document,
    window,
    calls,
    focused,
    scrolled,
    state,
    settled,
    focusWindow: async (focused = true) => {
      onFocus({ payload: focused });
      await settled();
    },
    emit: async (name, payload) => {
      listeners.get(name)({ payload });
      await settled();
    },
    panes: () => [...document.querySelectorAll('section.pane:not(#home)')],
    openPaths: async (paths) => {
      listeners.get('open-paths')({ payload: paths });
      await settled();
    },
    panel: () => document.getElementById('panel'),
    toast: () => document.getElementById('toast'),
    press: async (key, { ctrl = false, shift = false, alt = false, repeat = false, target = document.body } = {}) => {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(event, { key, ctrlKey: ctrl, shiftKey: shift, altKey: alt, repeat });
      event.stopPropagation = () => {
        event.stopped = true;
      };
      target.dispatchEvent(event);
      await settled();
      return event;
    },
    click: async (element) => {
      element.dispatchEvent(new window.Event('click'));
      await settled();
    },
    clickTab: async (index) => {
      document.querySelectorAll('.tab-name')[index].dispatchEvent(new window.Event('click'));
      await settled();
    },
  };
}

const failure = (code) => async () => {
  throw { code };
};

for (const code of ['not_found', 'timeout', 'unreadable']) {
  test(`a tab that failed with ${code} tries again when the file is opened again`, async () => {
    let open = failure(code);
    const shell = await startShell((path) => open(path));
    await shell.openPaths([PATH_A]);
    assert.ok(shell.panes()[0].querySelector('.state'));

    open = async (path) => markdownDoc(path, 'Ora esiste');
    await shell.openPaths([PATH_A]);

    assert.deepEqual(shell.calls, [PATH_A, PATH_A]);
    assert.equal(shell.panes().length, 1);
    assert.ok(!shell.panes()[0].querySelector('.state'));
    assert.ok(shell.panes()[0].textContent.includes('Ora esiste'));
  });
}

test('a book that cannot be shown gets a message in its tab, and opening it again tries again', async () => {
  const opened = [];
  const shell = await startShell(async (path) => {
    opened.push(path);
    return { path, name: 'b.epub', kind: 'epub', fileUrl: 'http://mochi.localhost/file/x', modifiedMs: CHANGED_AT };
  }, { pending: [PATH_BOOK], options: { language: 'en' } });
  // foliate cannot load outside the page, which here stands for every other way a book fails.
  const notice = async () => {
    for (let turn = 0; turn < BOOK_TURNS; turn += 1) {
      const found = shell.panes()[0].querySelector('.state');
      if (found?.querySelector('.state-text').textContent === en['epub.error'].replace('{name}', 'b.epub')) return found;
      await shell.settled();
    }
    return null;
  };
  assert.ok(await notice(), 'a message');
  await shell.emit('shell-command', { action: 'dump-tabs', out: 'x' });
  const [row] = shell.state.dump;
  assert.equal(row.status, 'error');
  assert.equal(row.firstPageRendered, false);
  assert.deepEqual(shell.state.touched, []);

  await shell.openPaths([PATH_BOOK]);
  assert.ok(await notice(), 'a message again');
  assert.equal(opened.length, 2);
});

test('a retry that fails again shows the new message and can be retried', async () => {
  let open = failure('not_found');
  const shell = await startShell((path) => open(path));
  await shell.openPaths([PATH_A]);
  const missing = shell.panes()[0].textContent;
  open = failure('timeout');
  await shell.openPaths([PATH_A]);
  assert.notEqual(shell.panes()[0].textContent, missing);
  assert.equal(shell.panes()[0].querySelectorAll('.state').length, 1);
  open = async (path) => markdownDoc(path, 'Ora esiste');
  await shell.openPaths([PATH_A]);
  assert.ok(shell.panes()[0].textContent.includes('Ora esiste'));
});

test('a tab that opened is only activated, not read again', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  await shell.openPaths([PATH_A]);
  await shell.openPaths([PATH_A]);
  assert.deepEqual(shell.calls, [PATH_A]);
});

test('a tab still opening is not read a second time', async () => {
  let finish;
  const shell = await startShell(() => new Promise((resolve) => {
    finish = resolve;
  }));
  await shell.openPaths([PATH_A]);
  await shell.openPaths([PATH_A]);
  assert.deepEqual(shell.calls, [PATH_A]);
  finish(markdownDoc(PATH_A, 'Testo'));
});

test('the pane of the active tab takes the focus, because the keys scroll what has it', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  await shell.openPaths([PATH_A]);
  const [first] = shell.panes();
  assert.equal(first.getAttribute('tabindex'), '-1');
  assert.ok(shell.focused.at(-1) === first);

  await shell.openPaths([PATH_B]);
  const second = shell.panes()[1];
  assert.ok(shell.focused.at(-1) === second);

  await shell.clickTab(0);
  assert.ok(shell.focused.at(-1) === first);
});

test('focus does not depend on the file opening', async () => {
  const shell = await startShell(failure('not_found'));
  await shell.openPaths([PATH_A]);
  assert.ok(shell.focused.at(-1) === shell.panes()[0]);
});

test('a hidden tab stays laid out, because Chromium drops the scroll of a pane it stops laying out', () => {
  const rule = /(^|\n)\.pane \{[^}]*\}/.exec(APP_CSS)[0];
  assert.match(rule, /visibility: hidden/);
  assert.doesNotMatch(rule, /content-visibility|display: none/);
});

test('a focused pane draws no focus ring', () => {
  assert.match(APP_CSS, /\.pane:focus \{\s*outline: none;/);
});

test('a file that opens goes to the top of the recents', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  await shell.openPaths([PATH_A]);
  assert.deepEqual(shell.state.touched, [{ path: PATH_A, kind: 'markdown', title: PATH_A }]);
});

test('a file that does not open is not added to the recents', async () => {
  const shell = await startShell(failure('not_found'));
  await shell.openPaths([PATH_A]);
  assert.deepEqual(shell.state.touched, []);
});

test('a file with a saved position opens at that block', async () => {
  const shell = await startShell(async (path) => longDoc(path), { positions: { [keyOf(PATH_A)]: atLine(5) } });
  await shell.openPaths([PATH_A]);
  assert.equal(shell.scrolled.length, 1);
  assert.equal(shell.scrolled[0].getAttribute('data-sourcepos'), '5:1-5:9');
});

// With no layout in linkedom every block counts as above the fold, so what is on screen is the last block: not line 5.
test('closing a tab that nobody scrolled keeps the saved line, whatever is on screen', async () => {
  const shell = await startShell(async (path) => longDoc(path), { positions: { [keyOf(PATH_A)]: atLine(5) } });
  await shell.openPaths([PATH_A]);
  shell.document.querySelector('.tab-close').dispatchEvent(new shell.window.Event('click'));
  await shell.settled();
  assert.deepEqual(shell.state.saved, [{ key: keyOf(PATH_A), position: atLine(5) }]);
});

test('a scroll that nobody asked for keeps the saved line, whatever is on screen', async () => {
  const shell = await startShell(async (path) => longDoc(path), { positions: { [keyOf(PATH_A)]: atLine(5) } });
  await shell.openPaths([PATH_A]);
  shell.panes()[0].dispatchEvent(new shell.window.Event('scroll'));
  await new Promise((resolve) => {
    setTimeout(resolve, SAVE_WAIT_MS);
  });
  assert.deepEqual(shell.state.saved, [{ key: keyOf(PATH_A), position: atLine(5) }]);
});

test('a key scrolling a tab makes what is on screen the position again', async () => {
  const shell = await startShell(async (path) => longDoc(path), { positions: { [keyOf(PATH_A)]: atLine(5) } });
  await shell.openPaths([PATH_A]);
  const [pane] = shell.panes();
  pane.dispatchEvent(new shell.window.Event('keydown'));
  pane.dispatchEvent(new shell.window.Event('scroll'));
  await new Promise((resolve) => {
    setTimeout(resolve, SAVE_WAIT_MS);
  });
  assert.deepEqual(shell.state.saved, [{ key: keyOf(PATH_A), position: atLine(9) }]);
});

test('a saved line past the end of a file that shrank goes to the nearest block', async () => {
  const shell = await startShell(async (path) => longDoc(path), { positions: { [keyOf(PATH_A)]: atLine(100) } });
  await shell.openPaths([PATH_A]);
  assert.equal(shell.scrolled[0].getAttribute('data-sourcepos'), '9:1-9:9');
});

test('a file with no saved position stays at the start', async () => {
  const shell = await startShell(async (path) => longDoc(path));
  await shell.openPaths([PATH_A]);
  assert.equal(shell.scrolled.length, 0);
});

test('scrolling saves the position once, after the delay', async () => {
  const shell = await startShell(async (path) => longDoc(path));
  await shell.openPaths([PATH_A]);
  const [pane] = shell.panes();
  pane.dispatchEvent(new shell.window.Event('scroll'));
  pane.dispatchEvent(new shell.window.Event('scroll'));
  assert.equal(shell.state.saved.length, 0);
  await new Promise((resolve) => {
    setTimeout(resolve, SAVE_WAIT_MS);
  });
  assert.equal(shell.state.saved.length, 1);
  assert.equal(shell.state.saved[0].key, keyOf(PATH_A));
  assert.equal(shell.state.saved[0].position.kind, 'md');
});

test('closing a tab saves its position first', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  await shell.openPaths([PATH_A]);
  shell.document.querySelector('.tab-close').dispatchEvent(new shell.window.Event('click'));
  await shell.settled();
  assert.deepEqual(shell.state.saved, [{ key: keyOf(PATH_A), position: atLine(1) }]);
});

test('a tab closed before its position came back does not write over the saved one', async () => {
  let answer;
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  const saved = atLine(40);
  shell.state.positions.set(keyOf(PATH_A), saved);
  const reallyGet = shell.state.positions.get.bind(shell.state.positions);
  shell.state.positions.get = (key) => new Promise((resolve) => {
    answer = () => resolve(reallyGet(key));
  });
  await shell.openPaths([PATH_A]);
  shell.document.querySelector('.tab-close').dispatchEvent(new shell.window.Event('click'));
  await shell.settled();
  answer();
  await shell.settled();
  assert.deepEqual(shell.state.saved, []);
  assert.equal(shell.scrolled.length, 0);
});

test('the app closing saves every open tab, then says it is ready', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  await shell.openPaths([PATH_A, PATH_B]);
  await shell.emit('app-closing');
  assert.deepEqual(shell.state.saved.map(({ key }) => key).sort(), [keyOf(PATH_A), keyOf(PATH_B)].sort());
  assert.equal(shell.state.closed, 1);
});

test('the app closing with no tabs is ready at once', async () => {
  const shell = await startShell(failure('not_found'));
  await shell.emit('app-closing');
  assert.equal(shell.state.closed, 1);
});

test('the window coming back with the same date reads nothing again', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  await shell.openPaths([PATH_A]);
  await shell.focusWindow();
  assert.deepEqual(shell.calls, [PATH_A]);
});

test('the window losing the focus checks nothing', async () => {
  let checks = 0;
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), {
    fileModified: async () => {
      checks += 1;
      return CHANGED_AT;
    },
  });
  await shell.openPaths([PATH_A]);
  await shell.focusWindow(false);
  assert.equal(checks, 0);
});

test('a file changed on disk is read again when the window comes back, keeping the position', async () => {
  let open = async (path) => longDoc(path, 'Prima');
  const shell = await startShell((path) => open(path));
  await shell.openPaths([PATH_A]);
  const [pane] = shell.panes();

  open = async (path) => longDoc(path, 'Dopo', CHANGED_AT + 1);
  shell.state.fileModified = async () => CHANGED_AT + 1;
  await shell.focusWindow();

  assert.deepEqual(shell.calls, [PATH_A, PATH_A]);
  assert.ok(pane.textContent.includes('Dopo'));
  assert.ok(!pane.textContent.includes('Prima'));
  assert.equal(pane.querySelectorAll('article').length, 1);
  // With no layout in linkedom every block counts as above the fold, so the position is the last block.
  assert.equal(shell.scrolled.at(-1).getAttribute('data-sourcepos'), '9:1-9:9');

  await shell.focusWindow();
  assert.equal(shell.calls.length, 2, 'the new date is remembered');
});

test('the links of a file read again still work', async () => {
  let open = async (path) => markdownDoc(path, '<a href="#x">uno</a>');
  const shell = await startShell((path) => open(path));
  await shell.openPaths([PATH_A]);
  open = async (path) => markdownDoc(path, '<a href="#x">due</a><span id="x"></span>', CHANGED_AT + 1);
  shell.state.fileModified = async () => CHANGED_AT + 1;
  await shell.focusWindow();
  const [pane] = shell.panes();
  pane.querySelector('a').dispatchEvent(new shell.window.Event('click', { bubbles: true }));
  assert.ok(shell.scrolled.at(-1) === pane.querySelector('#x'));
});

test('a file deleted on disk keeps its text and gets a message, until it comes back', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Il testo'));
  await shell.openPaths([PATH_A]);
  const [pane] = shell.panes();
  shell.state.fileModified = failure('not_found');
  await shell.focusWindow();

  assert.ok(pane.textContent.includes('Il testo'));
  const notice = pane.querySelector('.file-notice');
  assert.ok(notice?.textContent.length > 0);
  assert.equal(pane.querySelector('.state'), null);
  assert.ok(pane.firstElementChild === notice, 'above the text');

  await shell.focusWindow();
  assert.equal(pane.querySelectorAll('.file-notice').length, 1);

  await shell.emit('shell-command', { action: 'dump-tabs', out: 'x' });
  const [row] = shell.state.dump;
  assert.equal(row.status, 'ok');
  assert.ok(row.notice.length > 0);
  assert.ok(row.text.includes('Il testo'));
  assert.ok(!row.text.includes(row.notice), 'the message is not part of what is read aloud');

  shell.state.fileModified = async () => CHANGED_AT;
  await shell.focusWindow();
  assert.equal(pane.querySelector('.file-notice'), null);
  assert.deepEqual(shell.calls, [PATH_A]);
});

test('a message that appears does not cover the point of the reader', async () => {
  const shell = await startShell(async (path) => longDoc(path), { positions: { [keyOf(PATH_A)]: atLine(5) } });
  await shell.openPaths([PATH_A]);
  const before = shell.scrolled.length;
  shell.state.fileModified = failure('not_found');
  await shell.focusWindow();
  assert.equal(shell.scrolled.length, before + 1);
  assert.equal(shell.scrolled.at(-1).getAttribute('data-sourcepos'), '5:1-5:9');

  await shell.focusWindow();
  assert.equal(shell.scrolled.length, before + 1, 'the message was already there: nothing moves');
});

test('the message keeps one line, of a height the scroll of the pane allows for', () => {
  const notice = /(^|\n)\.file-notice \{[^}]*\}/.exec(APP_CSS)[0];
  const words = /(^|\n)\.file-notice-text \{[^}]*\}/.exec(APP_CSS)[0];
  assert.match(notice, /height: var\(--file-notice-height\)/);
  assert.match(words, /white-space: nowrap/);
  assert.match(words, /text-overflow: ellipsis/);
  assert.match(APP_CSS, /\.pane:has\(> \.file-notice\) \{\s*scroll-padding-top: var\(--file-notice-height\);/);
});

test('a message cut by a narrow window can still be read whole', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Il testo'));
  await shell.openPaths([PATH_A]);
  shell.state.fileModified = failure('not_found');
  await shell.focusWindow();
  const notice = shell.panes()[0].querySelector('.file-notice');
  assert.equal(notice.getAttribute('title'), notice.querySelector('.file-notice-text').textContent);
});

test('a drive that does not answer the check changes nothing', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Il testo'));
  await shell.openPaths([PATH_A]);
  shell.state.fileModified = failure('timeout');
  await shell.focusWindow();
  const [pane] = shell.panes();
  assert.ok(pane.textContent.includes('Il testo'));
  assert.equal(pane.querySelector('.file-notice'), null);
  assert.deepEqual(shell.calls, [PATH_A]);
});

test('a file that cannot be read again keeps the text on screen', async () => {
  let open = async (path) => markdownDoc(path, 'Il testo');
  const shell = await startShell((path) => open(path));
  await shell.openPaths([PATH_A]);
  open = failure('timeout');
  shell.state.fileModified = async () => CHANGED_AT + 1;
  await shell.focusWindow();
  const [pane] = shell.panes();
  assert.ok(pane.textContent.includes('Il testo'));
  assert.equal(pane.querySelector('.state'), null);

  open = async (path) => markdownDoc(path, 'Nuovo', CHANGED_AT + 1);
  await shell.focusWindow();
  assert.ok(pane.textContent.includes('Nuovo'), 'the next time tries again');
});

test('a file deleted while it was being read again says so and keeps the text', async () => {
  let open = async (path) => markdownDoc(path, 'Il testo');
  const shell = await startShell((path) => open(path));
  await shell.openPaths([PATH_A]);
  open = failure('not_found');
  shell.state.fileModified = async () => CHANGED_AT + 1;
  await shell.focusWindow();
  const [pane] = shell.panes();
  assert.ok(pane.textContent.includes('Il testo'));
  assert.ok(pane.querySelector('.file-notice'));
});

test('opening a file already open checks it again', async () => {
  let open = async (path) => markdownDoc(path, 'Prima');
  const shell = await startShell((path) => open(path));
  await shell.openPaths([PATH_A]);
  open = async (path) => markdownDoc(path, 'Dopo', CHANGED_AT + 1);
  shell.state.fileModified = async () => CHANGED_AT + 1;
  await shell.openPaths([PATH_A]);
  assert.ok(shell.panes()[0].textContent.includes('Dopo'));
});

test('a tab closed during a check is left alone', async () => {
  let answer;
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  await shell.openPaths([PATH_A]);
  shell.state.fileModified = () => new Promise((resolve, reject) => {
    answer = () => reject({ code: 'not_found' });
  });
  await shell.focusWindow();
  shell.document.querySelector('.tab-close').dispatchEvent(new shell.window.Event('click'));
  await shell.settled();
  answer();
  await shell.settled();
  assert.equal(shell.panes().length, 0);
});

test('only one check per tab runs at a time', async () => {
  let checks = 0;
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  await shell.openPaths([PATH_A]);
  shell.state.fileModified = () => new Promise(() => {
    checks += 1;
  });
  await shell.focusWindow();
  await shell.focusWindow();
  assert.equal(checks, 1);
});

test('a tab that failed to open is not checked', async () => {
  let checks = 0;
  const shell = await startShell(failure('not_found'), {
    fileModified: async () => {
      checks += 1;
      return CHANGED_AT;
    },
  });
  await shell.openPaths([PATH_A]);
  await shell.focusWindow();
  assert.equal(checks, 0);
});

const RECENT_A = { path: PATH_A, kind: 'markdown', title: 'a.md', openedAt: 1, exists: true };
const RECENT_B = { path: PATH_B, kind: 'markdown', title: 'b.md', openedAt: 2, exists: true };

test('without a file the first screen shows the recents', async () => {
  const shell = await startShell(failure('not_found'), { recents: [RECENT_A] });
  await shell.settled();
  assert.equal(shell.document.querySelector('#home .recent-name').textContent, 'a.md');
});

test('with a file at the start the recents are not even asked for', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A] });
  await shell.settled();
  assert.deepEqual(shell.state.asked, []);
});

test('the check of the recents greys a missing file on the screen already drawn', async () => {
  const shell = await startShell(failure('not_found'), { recents: [RECENT_A] });
  await shell.settled();
  shell.state.checked = [{ ...RECENT_A, exists: false }];
  await shell.focusWindow();
  assert.ok(shell.document.querySelector('#home .recent').classList.contains('missing'));
});

test('a check that finds nothing new leaves the list as it is, focus included', async () => {
  const shell = await startShell(failure('not_found'), { recents: [RECENT_A] });
  await shell.settled();
  const before = shell.document.querySelector('.recent');
  await shell.focusWindow();
  assert.ok(shell.document.querySelector('.recent') === before);
});

test('a recent opens in a tab, and one that is gone gets its message there', async () => {
  const shell = await startShell(failure('not_found'), { recents: [{ ...RECENT_A, exists: false }] });
  await shell.settled();
  shell.document.querySelector('.recent-open').dispatchEvent(new shell.window.Event('click'));
  await shell.settled();
  assert.deepEqual(shell.calls, [PATH_A]);
  assert.ok(shell.panes()[0].querySelector('.state'));
});

test('taking away a missing recent removes it from the screen', async () => {
  const shell = await startShell(failure('not_found'), { recents: [{ ...RECENT_A, exists: false }] });
  await shell.settled();
  shell.document.querySelector('.recent-remove').dispatchEvent(new shell.window.Event('click'));
  await shell.settled();
  assert.equal(shell.document.querySelector('.recent'), null);
  assert.deepEqual(shell.state.recents, []);
});

test('closing the last tab shows the recents again', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A] });
  await shell.settled();
  shell.state.recents = [RECENT_A];
  shell.document.querySelector('.tab-close').dispatchEvent(new shell.window.Event('click'));
  await shell.settled();
  assert.equal(shell.document.querySelector('#home .recent-name').textContent, 'a.md');
});

test('closing a tab with others open asks for no recents', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A, PATH_B] });
  await shell.settled();
  shell.document.querySelector('.tab-close').dispatchEvent(new shell.window.Event('click'));
  await shell.settled();
  assert.deepEqual(shell.state.asked, []);
});

test('the report of the tabs says where each one is', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  await shell.openPaths([PATH_A]);
  await shell.emit('shell-command', { action: 'dump-tabs', out: 'x' });
  assert.deepEqual(shell.state.dump[0].position, atLine(1));
  assert.equal(shell.state.dump[0].screenLine, 1);
});

test('the report of the tabs tells what is on screen apart from the position', async () => {
  const shell = await startShell(async (path) => longDoc(path), { positions: { [keyOf(PATH_A)]: atLine(5) } });
  await shell.openPaths([PATH_A]);
  await shell.emit('shell-command', { action: 'dump-tabs', out: 'x' });
  assert.deepEqual(shell.state.dump[0].position, atLine(5));
  assert.equal(shell.state.dump[0].screenLine, 9);
});

test('the report of a tab with no reader has no line on screen', async () => {
  const shell = await startShell(failure('not_found'));
  await shell.openPaths([PATH_A]);
  await shell.emit('shell-command', { action: 'dump-tabs', out: 'x' });
  assert.equal(shell.state.dump[0].screenLine, null);
});

const CTRL = { ctrl: true };
const headedDoc = (path) => ({
  ...markdownDoc(path, 'Testo'),
  rendered: {
    html: '<h1 data-sourcepos="1:1-1:5">Uno</h1><p data-sourcepos="3:1-3:5">Testo</p><h2 data-sourcepos="5:1-5:5">Due</h2>',
    lang: null,
    headings: [{ level: 1, text: 'Uno', line: 1 }, { level: 2, text: 'Due', line: 5 }],
  },
});
const bookmarkOf = (path, line) => ({
  key: keyOf(path),
  path,
  title: path.split('/').at(-1),
  position: atLine(line),
  excerpt: `Brano ${line}`,
  createdAt: line,
});

test('no panel is visible until one is asked for', async () => {
  const shell = await startShell(async (path) => headedDoc(path), { pending: [PATH_A] });
  await shell.settled();
  assert.equal(shell.panel().hidden, true);
});

test('ctrl+t lists the headings, and a click goes there and closes the panel', async () => {
  const shell = await startShell(async (path) => headedDoc(path), { pending: [PATH_A] });
  await shell.settled();
  await shell.press('t', CTRL);
  assert.equal(shell.panel().hidden, false);
  const items = [...shell.panel().querySelectorAll('.toc-entry')];
  assert.deepEqual(items.map((item) => item.querySelector('.toc-label').textContent), ['Uno', 'Due']);
  await shell.click(items[1]);
  assert.equal(shell.panel().hidden, true);
  assert.equal(shell.scrolled.at(-1).getAttribute('data-sourcepos'), '5:1-5:5');
  assert.ok(shell.focused.at(-1) === shell.panes()[0]);
});

test('escape closes a panel and gives the focus back to the text', async () => {
  const shell = await startShell(async (path) => headedDoc(path), { pending: [PATH_A] });
  await shell.settled();
  await shell.press('t', CTRL);
  await shell.press('Escape');
  assert.equal(shell.panel().hidden, true);
  assert.equal(shell.panel().children.length, 0);
  assert.ok(shell.focused.at(-1) === shell.panes()[0]);
});

test('the options lead to the licenses, read from the app, and escape closes them', async () => {
  const shell = await startShell(async (path) => headedDoc(path), { pending: [PATH_A] });
  await shell.settled();
  await shell.press(',', CTRL);
  shell.panel().querySelector('.about button').dispatchEvent(new shell.window.Event('click'));
  await shell.settled();
  assert.equal(shell.panel().querySelector('pre').textContent, 'the license text');
  assert.equal(shell.panel().querySelector('select'), null);
  assert.ok(shell.focused.at(-1) === shell.panel(), 'the keys scroll the text of the panel');
  await shell.press('Escape');
  assert.equal(shell.panel().hidden, true);
});

test('a test can open a panel without the keys, which reach only a window in front', async () => {
  const shell = await startShell(async (path) => headedDoc(path), { pending: [PATH_A] });
  await shell.settled();
  await shell.emit('shell-command', { action: 'show-panel', panel: 'licenses' });
  await shell.settled();
  assert.equal(shell.panel().querySelector('pre').textContent, 'the license text');
});

test('the same shortcut closes its panel and another one replaces it', async () => {
  const shell = await startShell(async (path) => headedDoc(path), { pending: [PATH_A] });
  await shell.settled();
  await shell.press('t', CTRL);
  await shell.press('b', CTRL);
  assert.equal(shell.panel().querySelector('.toc-entry'), null);
  assert.equal(shell.panel().hidden, false);
  await shell.press('b', CTRL);
  assert.equal(shell.panel().hidden, true);
});

test('the contents with no document open say there are none', async () => {
  const shell = await startShell(failure('not_found'));
  await shell.press('t', CTRL);
  assert.equal(shell.panel().hidden, false);
  assert.equal(shell.panel().querySelector('.toc-entry'), null);
  assert.ok(shell.panel().textContent.length > 0);
});

test('changing tab closes a panel that spoke of the other one', async () => {
  const shell = await startShell(async (path) => headedDoc(path), { pending: [PATH_A, PATH_B] });
  await shell.settled();
  await shell.press('t', CTRL);
  await shell.press('Tab', CTRL);
  assert.equal(shell.panel().hidden, true);
});

test('ctrl+d adds a bookmark at the current point and says so, and again takes it away', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Il brano'), { pending: [PATH_A] });
  await shell.settled();
  await shell.press('d', CTRL);
  assert.equal(shell.state.bookmarks.length, 1);
  const [bookmark] = shell.state.bookmarks;
  assert.equal(bookmark.key, keyOf(PATH_A));
  assert.equal(bookmark.path, PATH_A);
  assert.equal(bookmark.title, PATH_A);
  assert.deepEqual(bookmark.position, atLine(1));
  assert.equal(bookmark.excerpt, 'Il brano');
  assert.ok(bookmark.createdAt > 0);
  const added = shell.toast().textContent;
  assert.equal(shell.toast().hidden, false);

  await shell.press('d', CTRL);
  assert.deepEqual(shell.state.bookmarks, []);
  assert.notEqual(shell.toast().textContent, added);
});

test('ctrl+d with no text does nothing', async () => {
  const shell = await startShell(failure('not_found'), { pending: [PATH_A] });
  await shell.settled();
  await shell.press('d', CTRL);
  assert.deepEqual(shell.state.bookmarks, []);
  assert.equal(shell.toast().hidden, true);
});

test('holding ctrl+d or ctrl+w down acts once', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A, PATH_B] });
  await shell.settled();
  await shell.press('d', CTRL);
  const repeated = await shell.press('d', { ...CTRL, repeat: true });
  assert.equal(repeated.defaultPrevented, true);
  assert.equal(shell.state.bookmarks.length, 1);
  await shell.press('w', CTRL);
  await shell.press('w', { ...CTRL, repeat: true });
  assert.equal(shell.panes().length, 1);
});

test('ctrl+b groups the bookmarks by file, and a click goes to the point', async () => {
  const bookmarks = [bookmarkOf(PATH_A, 5), bookmarkOf(PATH_B, 1), bookmarkOf(PATH_A, 9)];
  const shell = await startShell(async (path) => longDoc(path), { bookmarks });
  await shell.press('b', CTRL);
  assert.deepEqual(
    [...shell.panel().querySelectorAll('.bookmark-file')].map((file) => file.textContent),
    ['a.md', 'b.md'],
  );
  assert.equal(shell.panel().querySelectorAll('.bookmark').length, 3);
  await shell.click(shell.panel().querySelector('.bookmark-open'));
  assert.equal(shell.panel().hidden, true);
  assert.deepEqual(shell.calls, [PATH_A]);
  assert.equal(shell.scrolled.at(-1).getAttribute('data-sourcepos'), '5:1-5:9');
});

test('a bookmark in a file already open goes there without reading it again', async () => {
  const shell = await startShell(async (path) => longDoc(path), { pending: [PATH_A], bookmarks: [bookmarkOf(PATH_A, 9)] });
  await shell.settled();
  await shell.press('b', CTRL);
  await shell.click(shell.panel().querySelector('.bookmark-open'));
  assert.deepEqual(shell.calls, [PATH_A]);
  assert.equal(shell.scrolled.at(-1).getAttribute('data-sourcepos'), '9:1-9:9');
});

test('a bookmark in a file still opening goes there once it has opened', async () => {
  let finish;
  const shell = await startShell(() => new Promise((resolve) => {
    finish = resolve;
  }), { pending: [PATH_A], bookmarks: [bookmarkOf(PATH_A, 9)] });
  await shell.settled();
  await shell.press('b', CTRL);
  await shell.click(shell.panel().querySelector('.bookmark-open'));
  finish(longDoc(PATH_A));
  await shell.settled();
  assert.equal(shell.scrolled.at(-1).getAttribute('data-sourcepos'), '9:1-9:9');
});

test('a bookmark in a missing file gets a message, no tab, and the panel to take it away', async () => {
  const shell = await startShell(failure('not_found'), { bookmarks: [bookmarkOf(PATH_A, 5)] });
  await shell.press('b', CTRL);
  await shell.click(shell.panel().querySelector('.bookmark-open'));
  assert.equal(shell.toast().hidden, false);
  assert.ok(shell.toast().textContent.includes('a.md'));
  assert.equal(shell.panes().length, 0);
  assert.equal(shell.panel().hidden, false);
  await shell.click(shell.panel().querySelector('.bookmark-remove'));
  assert.deepEqual(shell.state.bookmarks, []);
  assert.equal(shell.panel().querySelector('.bookmark'), null);
});

test('a bookmark on a drive that does not answer keeps the message of its tab', async () => {
  const shell = await startShell(failure('timeout'), { bookmarks: [bookmarkOf(PATH_A, 5)] });
  await shell.press('b', CTRL);
  await shell.click(shell.panel().querySelector('.bookmark-open'));
  assert.equal(shell.panes().length, 1);
  assert.ok(shell.panes()[0].querySelector('.state'));
  assert.equal(shell.panel().hidden, true);
});

test('adding a bookmark with the panel open shows it there', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A] });
  await shell.settled();
  await shell.press('b', CTRL);
  assert.equal(shell.panel().querySelector('.bookmark'), null);
  await shell.press('d', CTRL);
  assert.ok(shell.panel().querySelector('.bookmark'));
});

test('a bookmark opened just as its file turns out to be gone is not left under the message', async () => {
  const shell = await startShell(async (path) => longDoc(path), { pending: [PATH_A], bookmarks: [bookmarkOf(PATH_A, 5)] });
  await shell.settled();
  await shell.press('b', CTRL);
  // The answer of the drive takes a turn of the page at least, and the jump to the bookmark does not.
  let gone;
  shell.state.fileModified = () => new Promise((resolve, reject) => {
    gone = () => reject({ code: 'not_found' });
  });
  const before = shell.scrolled.length;
  await shell.click(shell.panel().querySelector('.bookmark-open'));
  assert.equal(shell.scrolled.length, before + 1);
  gone();
  await shell.settled();
  assert.ok(shell.panes()[0].querySelector('.file-notice'));
  assert.equal(shell.scrolled.at(-1).getAttribute('data-sourcepos'), '5:1-5:9');
  assert.equal(shell.scrolled.length, before + 2, 'once to the point, once more when the message came');
});

const bookmarkLines = (shell) => shell.state.bookmarks.map(({ position }) => position.line);
const doubleClickOver = () => new Promise((resolve) => {
  setTimeout(resolve, DOUBLE_CLICK_OVER_MS);
});

test('taking a bookmark away leaves the list where it was, with the focus on the row now in its place', async () => {
  const bookmarks = [1, 5, 9].map((line) => bookmarkOf(PATH_A, line));
  const shell = await startShell(async (path) => longDoc(path), { bookmarks });
  await shell.press('b', CTRL);
  const panel = shell.panel();
  panel.scrollTop = 742;
  await shell.click(panel.querySelectorAll('.bookmark-remove')[1]);
  assert.deepEqual(bookmarkLines(shell), [1, 9]);
  assert.equal(panel.scrollTop, 742);
  assert.ok(shell.focused.at(-1) === panel.querySelectorAll('.bookmark-open')[1]);
  assert.deepEqual(shell.focused.at(-1).focusedWith, { preventScroll: true });
});

test('the second click of a double click takes away nothing else, and a later one does', async () => {
  const bookmarks = [1, 5, 9].map((line) => bookmarkOf(PATH_A, line));
  const shell = await startShell(async (path) => longDoc(path), { bookmarks });
  await shell.press('b', CTRL);
  const panel = shell.panel();
  await shell.click(panel.querySelectorAll('.bookmark-remove')[1]);
  await shell.click(panel.querySelectorAll('.bookmark-remove')[1]);
  assert.deepEqual(bookmarkLines(shell), [1, 9]);

  await doubleClickOver();
  await shell.click(panel.querySelectorAll('.bookmark-remove')[1]);
  assert.deepEqual(bookmarkLines(shell), [1]);
});

test('the second click of a double click opens no bookmark either', async () => {
  const bookmarks = [1, 5].map((line) => bookmarkOf(PATH_A, line));
  const shell = await startShell(async (path) => longDoc(path), { bookmarks });
  await shell.press('b', CTRL);
  const panel = shell.panel();
  await shell.click(panel.querySelector('.bookmark-remove'));
  await shell.click(panel.querySelector('.bookmark-open'));
  assert.equal(panel.hidden, false);
  assert.deepEqual(shell.calls, []);
});

const shieldUp = (shell) => shell.document.querySelector('.click-shield')?.hidden === false;

// Hit testing is the browser's, so tools/smoke.ps1 clicks for real. Here: what opens from a list raises it, before it opens.
for (const [what, open, row] of [
  ['the contents', ['t', CTRL], '.toc-entry'],
  ['the bookmarks', ['b', CTRL], '.bookmark-open'],
  ['the recents', ['r', CTRL], '.recent-open'],
]) {
  test(`a row of ${what} that opens something covers the window until a double click is over`, async () => {
    const shell = await startShell(async (path) => headedDoc(path), {
      pending: [PATH_A],
      bookmarks: [bookmarkOf(PATH_A, 5)],
      recents: [RECENT_B],
    });
    await shell.settled();
    assert.equal(shieldUp(shell), false);
    await shell.press(...open);
    await shell.click(shell.panel().querySelector(row));
    assert.equal(shell.panel().hidden, true);
    assert.equal(shieldUp(shell), true);
    await doubleClickOver();
    assert.equal(shieldUp(shell), false);
  });
}

test('a recent opened from the first screen covers the window too', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { recents: [RECENT_A] });
  await shell.settled();
  await shell.click(shell.document.querySelector('#home .recent-open'));
  assert.equal(shieldUp(shell), true);
  assert.deepEqual(shell.calls, [PATH_A]);
});

test('the shield lies over the whole window and over every panel', () => {
  const rule = /(^|\n)\.click-shield \{[^}]*\}/.exec(APP_CSS)[0];
  assert.match(rule, /position: fixed/);
  assert.match(rule, /inset: 0/);
  const layers = [...APP_CSS.matchAll(/z-index: (\d+)/g)].map(([, layer]) => Number(layer));
  assert.equal(Number(/z-index: (\d+)/.exec(rule)[1]), Math.max(...layers));
});

test('ctrl+d with the panel open leaves the list where it was', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A], bookmarks: [bookmarkOf(PATH_B, 3)] });
  await shell.settled();
  await shell.press('b', CTRL);
  const panel = shell.panel();
  panel.scrollTop = 300;
  await shell.press('d', CTRL);
  assert.equal(panel.querySelectorAll('.bookmark').length, 2);
  assert.equal(panel.scrollTop, 300);
});

test('taking a recent away in the panel leaves the list where it was, with the focus on the row now in its place', async () => {
  const gone = [RECENT_A, RECENT_B].map((recent) => ({ ...recent, exists: false }));
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A], recents: gone });
  await shell.settled();
  await shell.press('r', CTRL);
  const panel = shell.panel();
  panel.scrollTop = 484;
  await shell.click(panel.querySelector('.recent-remove'));
  assert.deepEqual(shell.state.recents.map(({ path }) => path), [PATH_B]);
  assert.equal(panel.scrollTop, 484);
  assert.ok(shell.focused.at(-1) === panel.querySelector('.recent-open'));
  assert.deepEqual(shell.focused.at(-1).focusedWith, { preventScroll: true });
});

test('the second click of a double click on a recent opens nothing that moved under it', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), {
    pending: [PATH_A],
    recents: [{ ...RECENT_A, exists: false }, RECENT_B],
  });
  await shell.settled();
  await shell.press('r', CTRL);
  const panel = shell.panel();
  await shell.click(panel.querySelector('.recent-remove'));
  await shell.click(panel.querySelector('.recent-open'));
  assert.equal(panel.hidden, false);
  assert.deepEqual(shell.calls, [PATH_A]);
});

test('on the first screen too a recent taken away hands on the focus and stops the second click', async () => {
  const shell = await startShell(failure('not_found'), { recents: [{ ...RECENT_A, exists: false }, RECENT_B] });
  await shell.settled();
  const home = shell.document.getElementById('home');
  await shell.click(home.querySelector('.recent-remove'));
  assert.deepEqual(shell.state.recents.map(({ path }) => path), [PATH_B]);
  assert.ok(shell.focused.at(-1) === home.querySelector('.recent-open'));
  await shell.click(home.querySelector('.recent-open'));
  assert.deepEqual(shell.calls, []);
});

test('a late check of the drives moves neither the recents panel nor its focus', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A], recents: [RECENT_A, RECENT_B] });
  await shell.settled();
  let answer;
  shell.state.checked = new Promise((resolve) => {
    answer = resolve;
  });
  await shell.press('r', CTRL);
  const panel = shell.panel();
  assert.ok(shell.focused.at(-1) === panel);
  panel.scrollTop = 300;
  shell.document.activeElement = panel.querySelectorAll('.recent-open')[1];
  answer([RECENT_A, { ...RECENT_B, exists: false }]);
  await shell.settled();
  assert.ok(panel.querySelector('.recent.missing'));
  assert.equal(panel.scrollTop, 300);
  assert.ok(shell.focused.at(-1) === panel.querySelectorAll('.recent-open')[1]);
});

test('ctrl+r lists the recents over the text, and a click opens one', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A], recents: [RECENT_B] });
  await shell.settled();
  await shell.press('r', CTRL);
  assert.equal(shell.panel().querySelector('.recent-name').textContent, 'b.md');
  assert.equal(shell.panel().querySelector('.home-hint'), null);
  await shell.click(shell.panel().querySelector('.recent-open'));
  assert.equal(shell.panel().hidden, true);
  assert.deepEqual(shell.calls, [PATH_A, PATH_B]);
});

test('the recents panel marks what a check of the drives finds missing, and can take it away', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A], recents: [RECENT_B] });
  await shell.settled();
  shell.state.checked = [{ ...RECENT_B, exists: false }];
  await shell.press('r', CTRL);
  assert.ok(shell.panel().querySelector('.recent.missing'));
  await shell.click(shell.panel().querySelector('.recent-remove'));
  assert.deepEqual(shell.state.recents, []);
  assert.equal(shell.panel().hidden, false);
  assert.equal(shell.panel().querySelector('.recent'), null);
});

test('ctrl+comma opens the options, with their saved values', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { options: { theme: 'dark' } });
  await shell.press(',', CTRL);
  assert.equal(shell.panel().querySelector('input[name="theme"][checked]').getAttribute('value'), 'dark');
});

const changeOption = async (shell, name, value) => {
  shell.panel().querySelector(`input[name="${name}"][value="${value}"]`).dispatchEvent(new shell.window.Event('change'));
  await shell.settled();
};

test('a theme chosen in the options applies at once and is saved', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  await shell.press(',', CTRL);
  await changeOption(shell, 'theme', 'dark');
  assert.equal(shell.document.documentElement.getAttribute('data-theme'), 'dark');
  assert.deepEqual(shell.state.optionWrites, [['theme', 'dark']]);
});

test('saved options apply before the first frame', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { options: { theme: 'dark', language: 'it' } });
  assert.equal(shell.state.themeAtFirstPaint, 'dark');
  assert.equal(shell.document.querySelector('#home h1').textContent, it['home.welcome']);
});

test('the language of the options changes the panel, the tabs and the first screen', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { options: { language: 'it' } });
  await shell.press(',', CTRL);
  assert.ok(shell.panel().textContent.includes(it['options.title']));
  await changeOption(shell, 'language', 'en');
  assert.ok(shell.panel().textContent.includes(en['options.title']));
  assert.equal(shell.document.querySelector('#home h1').textContent, en['home.welcome']);
});

test('ctrl plus and minus change the text, keep the place in every tab and are saved', async () => {
  const shell = await startShell(async (path) => longDoc(path), {
    pending: [PATH_A, PATH_B],
    positions: { [keyOf(PATH_A)]: atLine(9), [keyOf(PATH_B)]: atLine(5) },
  });
  await shell.settled();
  const before = shell.scrolled.length;
  await shell.press('+', CTRL);
  const root = shell.document.documentElement;
  const bigger = root.style.getPropertyValue('--text-size');
  assert.equal(shell.state.optionWrites[0][0], 'textSize');
  assert.equal(`${shell.state.optionWrites[0][1]}px`, bigger);
  assert.deepEqual(shell.scrolled.slice(before).map((block) => block.getAttribute('data-sourcepos')), ['9:1-9:9', '5:1-5:9']);
  await shell.press('-', CTRL);
  assert.notEqual(root.style.getPropertyValue('--text-size'), bigger);
});

test('at the end of the sizes ctrl plus saves nothing', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { options: { textSize: 32 } });
  const event = await shell.press('+', CTRL);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(shell.state.optionWrites, []);
});

test('ctrl plus with the options open shows the new size there', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { options: { textSize: 17 } });
  await shell.press(',', CTRL);
  await shell.press('+', CTRL);
  assert.equal(shell.panel().querySelector('.stepper output').textContent, String(shell.state.options.textSize));
});

test('ctrl+o asks for Markdown and EPUB files and opens each chosen one', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { picked: [PATH_A, PATH_B] });
  await shell.press('o', CTRL);
  await shell.settled();
  assert.equal(shell.state.dialogs.length, 1);
  assert.equal(shell.state.dialogs[0].multiple, true);
  assert.deepEqual(shell.state.dialogs[0].filters[0].extensions, ['md', 'markdown', 'epub']);
  assert.deepEqual(shell.calls, [PATH_A, PATH_B]);
});

test('a cancelled file dialog opens nothing', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { picked: null });
  await shell.press('o', CTRL);
  await shell.settled();
  assert.deepEqual(shell.calls, []);
  assert.equal(shell.panes().length, 0);
});

test('ctrl+w closes the active tab, and with none it does nothing', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A, PATH_B] });
  await shell.settled();
  await shell.press('w', CTRL);
  await shell.press('w', CTRL);
  assert.equal(shell.panes().length, 0);
  await shell.press('w', CTRL);
  assert.equal(shell.panes().length, 0);
});

test('ctrl+tab goes to the next tab and wraps', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A, PATH_B] });
  await shell.settled();
  const active = () => shell.panes().findIndex((pane) => pane.classList.contains('active'));
  assert.equal(active(), 1);
  await shell.press('Tab', CTRL);
  assert.equal(active(), 0);
  await shell.press('Tab', CTRL);
  assert.equal(active(), 1);
});

test('shift and ctrl arrows move through the text', async () => {
  const shell = await startShell(async (path) => headedDoc(path), { pending: [PATH_A], positions: { [keyOf(PATH_A)]: atLine(1) } });
  await shell.settled();
  await shell.press('ArrowRight', { shift: true });
  assert.equal(shell.scrolled.at(-1).getAttribute('data-sourcepos'), '3:1-3:5');
  await shell.press('ArrowRight', CTRL);
  assert.equal(shell.scrolled.at(-1).getAttribute('data-sourcepos'), '5:1-5:5');
  await shell.press('ArrowLeft', { shift: true, repeat: true });
  assert.equal(shell.scrolled.at(-1).getAttribute('data-sourcepos'), '3:1-3:5');
});

test('a shortcut keeps the key from the browser, and from the reader, which would take it for moving on', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A] });
  await shell.settled();
  for (const [key, mods] of [['F5', {}], ['s', { ctrl: true, shift: true }], ['r', CTRL], ['Escape', {}], ['ArrowLeft', { shift: true }]]) {
    const event = await shell.press(key, mods);
    assert.equal(event.defaultPrevented, true, key);
    assert.equal(event.stopped, true, key);
  }
});

test('space, with nothing reading, is left to the page, which scrolls the text', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A] });
  await shell.settled();
  assert.equal((await shell.press(' ')).defaultPrevented, false);
});

test('keys that are not shortcuts are left alone', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { pending: [PATH_A] });
  await shell.settled();
  for (const key of ['x', 'ArrowDown', 'PageDown', 'ArrowRight']) {
    assert.equal((await shell.press(key)).defaultPrevented, false, key);
  }
});

test('a focused control keeps the keys it answers to', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'), { recents: [RECENT_A] });
  await shell.settled();
  const button = shell.document.querySelector('.recent-open');
  for (const key of [' ', '+', '-', 'ArrowLeft']) {
    assert.equal((await shell.press(key, { target: button })).defaultPrevented, false, key);
  }
  assert.equal((await shell.press('F5', { target: button })).defaultPrevented, true);
  assert.equal((await shell.press('+', { ...CTRL, target: button })).defaultPrevented, true);
});

test('escape in a list of the options still closes the panel', async () => {
  const shell = await startShell(async (path) => markdownDoc(path, 'Testo'));
  await shell.press(',', CTRL);
  await shell.press('Escape', { target: shell.panel().querySelector('input') });
  assert.equal(shell.panel().hidden, true);
});

// Reading aloud, through the real shell, session, player and extraction. Only speechSynthesis and the media session are fake.
const speechShellStop = async (shell) => {
  shell.bar().querySelector('[data-action="speech.stop"]').dispatchEvent(new shell.window.Event('click'));
  await shell.wait();
};

const speechShellDown = () => {
  delete globalThis.navigator.mediaSession;
  delete globalThis.speechSynthesis;
};

const FAKE_VOICES = [
  { voiceURI: 'uri:elsa', name: 'Elsa', lang: 'it-IT', localService: true },
  { voiceURI: 'uri:cosimo', name: 'Cosimo', lang: 'it-IT', localService: true },
  { voiceURI: 'uri:zira', name: 'Zira', lang: 'en-US', localService: true },
];

const speechDoc = (path, { lang = 'it' } = {}) => ({
  ...markdownDoc(path, ''),
  rendered: {
    html: '<p data-sourcepos="1:1-1:9">Uno è qui. Due è qui.</p><p data-sourcepos="3:1-3:9">Tre è qui. <a href="https://e.org/a">Vai</a>.</p>',
    lang,
    headings: [],
  },
});

async function startReadingShell(openDocument = async (path) => speechDoc(path), shellOptions = {}, voices = FAKE_VOICES) {
  const spoken = [];
  const synth = {
    getVoices: () => voices,
    speak: (utterance) => spoken.push(utterance),
    cancel: () => {
      const last = spoken.at(-1);
      if (last && !last.settled) {
        last.settled = true;
        last.onerror?.({ error: 'canceled' });
      }
    },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.speechSynthesis = synth;
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  const handlers = new Map();
  const mediaSession = {
    setActionHandler: (name, handler) => (handler ? handlers.set(name, handler) : handlers.delete(name)),
    metadata: null,
    playbackState: 'none',
  };
  Object.defineProperty(globalThis.navigator, 'mediaSession', { configurable: true, value: mediaSession });
  globalThis.MediaMetadata = class {
    constructor(data) {
      Object.assign(this, data);
    }
  };
  // linkedom has no layout, so every block would count as at the top: each tab starts on the first line.
  const atTop = { [keyOf(PATH_A)]: atLine(1), [keyOf(PATH_B)]: atLine(1) };
  const shell = await startShell(openDocument, { positions: atTop, options: { language: 'en' }, ...shellOptions });
  const { document, window } = shell;
  withHighlights(document);
  window.HTMLElement.prototype.play = async function play() {
    this.isPlaying = true;
  };
  window.HTMLElement.prototype.pause = function pause() {
    this.isPlaying = false;
  };
  window.HTMLElement.prototype.load = function load() {};
  const wait = async () => {
    for (let turn = 0; turn < 60; turn += 1) await shell.settled();
  };
  const finishSentence = async () => {
    const last = spoken.at(-1);
    last.settled = true;
    last.onend();
    await wait();
  };
  const bar = () => document.getElementById('speechbar');
  const pressReady = async (key, options) => {
    const event = await shell.press(key, options);
    await wait();
    return event;
  };
  return { ...shell, spoken, said: () => spoken.map(({ text }) => text), wait, finishSentence, bar, pressReady, handlers, mediaSession };
}

test('F5 starts reading from where the reader is, with a bar that was not there before', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  assert.equal(shell.bar(), null);
  const event = await shell.pressReady('F5');
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(shell.said(), ['Uno è qui.']);
  assert.equal(shell.bar().hidden, false);
  assert.ok(shell.bar().textContent.includes('a.md'));
  assert.deepEqual(shell.state.saved.at(-1), { key: keyOf(PATH_A), position: { kind: 'md', line: 1, sentence: 0 } });
  await shell.pressReady('Escape');
  await speechShellStop(shell);
});

test('each sentence saves its place, and a tab closed while reading stops and keeps it', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  await shell.finishSentence();
  assert.deepEqual(shell.said(), ['Uno è qui.', 'Due è qui.']);
  assert.deepEqual(shell.state.saved.at(-1).position, { kind: 'md', line: 1, sentence: 1 });
  await shell.pressReady('w', { ctrl: true });
  assert.deepEqual(shell.state.saved.at(-1).position, { kind: 'md', line: 1, sentence: 1 });
  assert.equal(shell.bar().hidden, true);
  assert.equal(shell.spoken.at(-1).settled, true);
});

test('space pauses and resumes while reading, and scrolls otherwise', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  const paused = await shell.pressReady(' ');
  assert.equal(paused.defaultPrevented, true);
  assert.equal(shell.bar().querySelector('[data-action="speech.toggle"]').getAttribute('aria-label'), en['speech.resume']);
  await shell.pressReady(' ');
  assert.deepEqual(shell.said(), ['Uno è qui.', 'Uno è qui.']);
  await speechShellStop(shell);
  const scroll = await shell.pressReady(' ');
  assert.equal(scroll.defaultPrevented, false);
});

test('while reading, the arrows move by sentence and plus and minus change the speed, which is kept', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  await shell.pressReady('ArrowRight');
  assert.equal(shell.said().at(-1), 'Due è qui.');
  await shell.pressReady('ArrowLeft');
  assert.equal(shell.said().at(-1), 'Uno è qui.');
  await shell.pressReady('ArrowRight', { shift: true });
  assert.equal(shell.said().at(-1), 'Tre è qui.');
  await shell.pressReady('+');
  assert.equal(shell.spoken.at(-1).rate, 1.3);
  assert.deepEqual(shell.state.optionWrites.at(-1), ['speechRate', 1.3]);
  await shell.pressReady('-');
  assert.equal(shell.spoken.at(-1).rate, 1);
  await speechShellStop(shell);
});

test('a key held down goes on moving the sentence, but does not pause again and again', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  await shell.pressReady('ArrowRight', { repeat: true });
  assert.equal(shell.said().at(-1), 'Due è qui.');
  await shell.pressReady(' ', { repeat: true });
  assert.equal(shell.bar().querySelector('[data-action="speech.toggle"]').getAttribute('aria-label'), en['speech.pause']);
  await speechShellStop(shell);
});

test('a media key in front counts once, however it arrives, and starts the reading from idle', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  await shell.pressReady('MediaPlayPause');
  assert.deepEqual(shell.said(), ['Uno è qui.']);
  const toggle = () => shell.bar().querySelector('[data-action="speech.toggle"]').getAttribute('aria-label');
  await shell.press('MediaPlayPause');
  shell.handlers.get('pause')();
  await shell.wait();
  assert.equal(toggle(), en['speech.resume']);
  await new Promise((resolve) => {
    setTimeout(resolve, MEDIA_WINDOW_OVER_MS);
  });
  shell.handlers.get('play')();
  await shell.press('MediaPlayPause');
  await shell.wait();
  assert.equal(toggle(), en['speech.pause']);
  await speechShellStop(shell);
});

test('a click on a sentence jumps there while reading; from idle it makes no sound', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  const [, second] = shell.panes()[0].querySelectorAll('p');
  shell.document.caretPositionFromPoint = () => ({ offsetNode: second.firstChild, offset: 2 });
  second.dispatchEvent(new shell.window.Event('click', { bubbles: true }));
  await shell.wait();
  assert.deepEqual(shell.spoken, []);
  await shell.pressReady('F5');
  second.dispatchEvent(new shell.window.Event('click', { bubbles: true }));
  await shell.wait();
  assert.equal(shell.said().at(-1), 'Tre è qui.');
  await speechShellStop(shell);
});

test('a link clicked while reading is followed, and the voice stays', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  const link = shell.panes()[0].querySelector('a');
  link.dispatchEvent(new shell.window.Event('click', { bubbles: true, cancelable: true }));
  await shell.wait();
  assert.deepEqual(shell.said(), ['Uno è qui.']);
  await speechShellStop(shell);
});

test('the menu of the text reads from where it was opened', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  const [, second] = shell.panes()[0].querySelectorAll('p');
  shell.document.caretPositionFromPoint = () => ({ offsetNode: second.firstChild, offset: 1 });
  const event = new shell.window.Event('contextmenu', { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 30, clientY: 40 });
  second.dispatchEvent(event);
  await shell.wait();
  assert.equal(event.defaultPrevented, true);
  const menu = shell.document.querySelector('.text-menu');
  assert.equal(menu.style.left, '30px');
  menu.querySelector('button').dispatchEvent(new shell.window.Event('click'));
  await shell.wait();
  assert.deepEqual(shell.said(), ['Tre è qui.']);
  await speechShellStop(shell);
});

test('another tab goes on reading the first until it is asked to read, and the bar says which', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  await shell.openPaths([PATH_B]);
  await shell.wait();
  assert.deepEqual(shell.said(), ['Uno è qui.']);
  assert.ok(shell.bar().textContent.includes('a.md'));
  await shell.pressReady('F5');
  assert.equal(shell.spoken.length, 2);
  assert.ok(shell.bar().textContent.includes('b.md'));
  await speechShellStop(shell);
});

test('a document with nothing to read says so', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell(async (path) => ({
    ...markdownDoc(path, ''),
    rendered: { html: '<pre data-sourcepos="1:1-1:9">codice</pre>', lang: 'it', headings: [] },
  }));
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  assert.equal(shell.toast().textContent, en['speech.nothingToRead']);
  assert.deepEqual(shell.spoken, []);
});

test('with no voice for the language, a panel says how to add one in Windows and Esc closes it', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell(async (path) => speechDoc(path, { lang: 'fr' }));
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  assert.deepEqual(shell.spoken, []);
  const text = shell.panel().textContent;
  assert.ok(text.includes('Add voices'));
  assert.ok(text.includes('French'));
  assert.ok(text.includes(en['speech.hiddenVoice'].replace('{lang}', 'French')));
  await shell.pressReady('Escape');
  assert.equal(shell.panel().hidden, true);
});

test('the options offer a voice for each language, the last used selected, and keep a new choice', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell(undefined, { voices: { it: 'uri:cosimo' } });
  await shell.pressReady(',', { ctrl: true });
  const it = shell.panel().querySelector('select[name="voice-it"]');
  assert.ok(it);
  assert.equal(it.querySelector('option[selected]').getAttribute('value'), 'uri:cosimo');
  assert.ok(shell.panel().querySelector('select[name="voice-en"]'));
  it.querySelectorAll('option').forEach((option) => option.toggleAttribute('selected', option.getAttribute('value') === 'uri:elsa'));
  it.dispatchEvent(new shell.window.Event('change'));
  await shell.wait();
  assert.deepEqual(shell.state.voiceWrites, [{ lang: 'it', voiceId: 'uri:elsa' }]);
});

test('the voice chosen in the options is the one the reading uses', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell(undefined, { voices: { it: 'uri:cosimo' } });
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  assert.equal(shell.spoken[0].voice.voiceURI, 'uri:cosimo');
  await speechShellStop(shell);
});

test('going to an entry of the contents while reading takes the voice there', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell(async (path) => ({
    ...speechDoc(path),
    rendered: { ...speechDoc(path).rendered, headings: [{ level: 1, text: 'Tre', line: 3 }] },
  }));
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  await shell.pressReady('t', { ctrl: true });
  shell.panel().querySelector('.toc-entry').dispatchEvent(new shell.window.Event('click'));
  await shell.wait();
  assert.equal(shell.said().at(-1), 'Tre è qui.');
  await speechShellStop(shell);
});

test('a file changed while reading goes on in the new text', async (t) => {
  t.after(() => speechShellDown());
  let text = speechDoc;
  let modified = CHANGED_AT;
  const shell = await startReadingShell(async (path) => ({ ...text(path), modifiedMs: modified }), { fileModified: async () => modified });
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  await shell.state.settle;
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  text = (path) => ({
    ...markdownDoc(path, 'Testo nuovo.'),
  });
  modified = CHANGED_AT + 1;
  await shell.focusWindow();
  await shell.wait();
  assert.equal(shell.said().at(-1), 'Testo nuovo.');
  await speechShellStop(shell);
});

test('closing the app stops the voice and saves its sentence', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  await shell.finishSentence();
  await shell.emit('app-closing');
  await shell.wait();
  assert.equal(shell.bar().hidden, true);
  assert.deepEqual(shell.state.saved.at(-1).position, { kind: 'md', line: 1, sentence: 1 });
  assert.equal(shell.state.closed, 1);
});

test('the report of the tabs says how the reading goes', async (t) => {
  t.after(() => speechShellDown());
  const shell = await startReadingShell();
  await shell.openPaths([PATH_A]);
  await shell.pressReady('F5');
  await shell.emit('shell-command', { action: 'dump-tabs', out: 'x' });
  await shell.wait();
  const [row] = shell.state.dump;
  assert.equal(row.speech.state, 'playing');
  assert.equal(row.speech.sentence, 'Uno è qui.');
  assert.equal(row.speechBar.includes('a.md'), true);
  assert.equal(row.speech.audioPlaying, true);
  await speechShellStop(shell);
  await shell.emit('shell-command', { action: 'dump-tabs', out: 'x' });
  await shell.wait();
  assert.equal(shell.state.dump[0].speech, null);
  assert.equal(shell.state.dump[0].speechBar, null);
});
