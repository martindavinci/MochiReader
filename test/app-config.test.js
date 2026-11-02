// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const [windowConf] = conf.app.windows;

test('the app has its name, identifier and bundle', () => {
  assert.equal(conf.productName, 'MochiReader');
  assert.equal(conf.identifier, 'io.github.martindavinci.mochireader');
  assert.equal(conf.build.frontendDist, '../app');
  assert.equal(conf.bundle.active, true);
  assert.deepEqual(conf.bundle.targets, ['nsis']);
  assert.deepEqual(conf.bundle.icon, ['icons/icon.ico']);
  assert.equal(conf.app.withGlobalTauri, true);
});

test('the CSP blocks everything the app does not use', () => {
  assert.equal(
    conf.app.security.csp,
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' blob:; "
      + "img-src 'self' data: blob: http://mochi.localhost; font-src 'self' data: blob:; media-src blob:; "
      + 'frame-src blob:; connect-src ipc: http://ipc.localhost http://mochi.localhost',
  );
});

test('the window stays hidden until the first draw', () => {
  assert.equal(windowConf.visible, false);
  assert.equal(windowConf.title, 'MochiReader');
});

test('throttling is turned off with browser flags, because the Tauri option does nothing on Windows', () => {
  assert.equal(windowConf.backgroundThrottling, undefined);
  assert.equal(
    windowConf.additionalBrowserArgs,
    '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion '
      + '--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling '
      + '--disable-renderer-backgrounding --disable-backgrounding-occluded-windows',
  );
});

test('the page loads only its shell and its style', () => {
  const html = read('app/index.html');
  assert.deepEqual([...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['ui/shell.js']);
  assert.deepEqual([...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1]), ['css/app.css']);
  assert.equal(/<style/.test(html), false, 'an inline style would make Tauri add a nonce that disables unsafe-inline');
});

test('the page may set its title', () => {
  const capability = JSON.parse(read('src-tauri/capabilities/default.json'));
  assert.deepEqual(capability.windows, ['main']);
  assert.ok(capability.permissions.includes('core:window:allow-set-title'));
});
