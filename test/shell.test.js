// SPDX-License-Identifier: GPL-3.0-or-later
// Elements are compared with ===: a failed assert.equal would print the whole linkedom page, which takes minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const PATH_A = 'C:/x/a.md';
const PATH_B = 'C:/x/b.md';
const INDEX_HTML = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const APP_CSS = readFileSync(new URL('../app/css/app.css', import.meta.url), 'utf8');

const CHANGED_AT = 1000;
const SAVE_WAIT_MS = 600;

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
async function startShell(openDocument, { pending = [], positions = {}, recents = [], fileModified } = {}) {
  const { window, document, HTMLElement } = parseHTML(INDEX_HTML);
  const focused = [];
  HTMLElement.prototype.focus = function focus() {
    focused.push(this);
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
  };
  const commands = {
    take_pending_paths: () => pending,
    first_paint: () => painted(),
    open_document: ({ path }) => {
      calls.push(path);
      return openDocument(path);
    },
    state_get: () => {
      state.asked.push('state_get');
      return { recents: state.recents };
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
        onFocusChanged: async (callback) => {
          onFocus = callback;
        },
      }),
    },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: () => {} }) },
  };
  Object.assign(globalThis, {
    window,
    document,
    CSS: { escape: (text) => text },
    requestAnimationFrame: (callback) => setTimeout(callback),
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
    assert.ok(shell.panes()[0].querySelector('.notice'));

    open = async (path) => markdownDoc(path, 'Ora esiste');
    await shell.openPaths([PATH_A]);

    assert.deepEqual(shell.calls, [PATH_A, PATH_A]);
    assert.equal(shell.panes().length, 1);
    assert.ok(!shell.panes()[0].querySelector('.notice'));
    assert.ok(shell.panes()[0].textContent.includes('Ora esiste'));
  });
}

test('a retry that fails again shows the new message and can be retried', async () => {
  let open = failure('not_found');
  const shell = await startShell((path) => open(path));
  await shell.openPaths([PATH_A]);
  const missing = shell.panes()[0].textContent;
  open = failure('timeout');
  await shell.openPaths([PATH_A]);
  assert.notEqual(shell.panes()[0].textContent, missing);
  assert.equal(shell.panes()[0].querySelectorAll('.notice').length, 1);
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
  assert.equal(pane.querySelector('.notice'), null);
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
  assert.equal(pane.querySelector('.notice'), null);

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
  assert.ok(shell.panes()[0].querySelector('.notice'));
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
});
