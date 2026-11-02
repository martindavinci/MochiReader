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

const markdownDoc = (path, text) => ({
  path,
  name: path,
  kind: 'markdown',
  rendered: { html: `<p data-sourcepos="1:1-1:9">${text}</p>`, lang: null, headings: [] },
});

let run = 0;

/** Starts a fresh copy of the real shell on the real page, with a fake Tauri around it. */
async function startShell(openDocument) {
  const { window, document, HTMLElement } = parseHTML(INDEX_HTML);
  const focused = [];
  HTMLElement.prototype.focus = function focus() {
    focused.push(this);
  };
  const listeners = new Map();
  const calls = [];
  let painted;
  const firstPaint = new Promise((resolve) => {
    painted = resolve;
  });
  const commands = {
    take_pending_paths: () => [],
    first_paint: () => painted(),
    open_document: ({ path }) => {
      calls.push(path);
      return openDocument(path);
    },
  };
  window.__TAURI__ = {
    core: { invoke: async (command, args) => commands[command]?.(args) },
    event: {
      listen: async (name, callback) => {
        listeners.set(name, callback);
      },
    },
    window: { getCurrentWindow: () => ({ setTitle: () => {} }) },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: () => {} }) },
  };
  Object.assign(globalThis, { window, document, requestAnimationFrame: (callback) => setTimeout(callback) });
  run += 1;
  await import(`../app/ui/shell.js?run=${run}`);
  await firstPaint;

  const settled = () => new Promise((resolve) => {
    setTimeout(resolve);
  });
  return {
    document,
    calls,
    focused,
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
