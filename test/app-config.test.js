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

test('the installer puts the licenses on disk, where they can be read without the app', () => {
  assert.deepEqual(conf.bundle.resources, { '../app/licenses.txt': 'licenses.txt' });
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

test('the window takes the focus when it shows, because moving it into the hidden page holds up the first request', () => {
  assert.equal(windowConf.focus, false);
});

test('browser flags keep throttling off, which the Tauri option cannot on Windows, and the runtime off the network', () => {
  assert.equal(windowConf.backgroundThrottling, undefined);
  assert.equal(
    windowConf.additionalBrowserArgs,
    '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion '
      + '--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling '
      + '--disable-renderer-backgrounding --disable-backgrounding-occluded-windows '
      + '--no-proxy-server --disable-background-networking --disable-component-update',
  );
});

test('the browser is told not to look up the hosts of links', () => {
  const html = read('app/index.html');
  assert.match(html, /<meta http-equiv="x-dns-prefetch-control" content="off">/);
  assert.ok(html.indexOf('x-dns-prefetch-control') < html.indexOf('<link'), 'before anything the page loads');
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

test('the page may ask for the file dialog, and for no other dialog', () => {
  const { permissions } = JSON.parse(read('src-tauri/capabilities/default.json'));
  assert.deepEqual(permissions.filter((permission) => permission.startsWith('dialog:')), ['dialog:allow-open']);
});

test('the page has a place for panels, closed until asked for', () => {
  assert.match(read('app/index.html'), /<aside id="panel"[^>]* hidden/);
});

test('a chosen theme overrides the one of Windows', () => {
  const css = read('app/css/app.css');
  assert.match(css, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(css, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
  assert.match(css, /--bg: light-dark\(/);
});

test('the text size only reaches the text', () => {
  assert.match(/\narticle \{[^}]*\}/.exec(read('app/css/app.css'))[0], /font-size: var\(--text-size/);
});
