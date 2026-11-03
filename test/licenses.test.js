// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRATE_LICENSE_FILES,
  REPO_ROOT,
  VENDORED,
  checkLicenses,
  checkLicenseTexts,
  crateLicenseTexts,
  distributedCrates,
  renderLicenses,
  runLicenses,
} from '../tools/licenses.mjs';

const accepts = (license) => assert.doesNotThrow(() => checkLicenses([{ name: 'c', license }]));
const refuses = (license) => assert.throws(() => checkLicenses([{ name: 'c', license }]));

test('AGPL and unknown licenses are refused', () => {
  assert.throws(() => checkLicenses([{ name: 'x', license: 'AGPL-3.0' }]));
  assert.throws(() => checkLicenses([{ name: 'y', license: null }]));
  assert.doesNotThrow(() => checkLicenses([{ name: 'z', license: 'MIT OR Apache-2.0' }]));
});

test('every refused component is named in the error', () => {
  assert.throws(
    () =>
      checkLicenses([
        { name: 'good', license: 'MIT' },
        { name: 'bad-one', license: 'AGPL-3.0-only' },
        { name: 'bad-two', license: 'Proprietary' },
      ]),
    (error) =>
      error.message.includes('bad-one') &&
      error.message.includes('bad-two') &&
      !error.message.includes('good'),
  );
});

test('an AGPL choice is refused even next to an allowed license', () => {
  refuses('AGPL-3.0-or-later OR MIT');
  refuses('MIT OR agpl-3.0');
});

test('licenses that cannot join a GPL-3.0-or-later work are refused', () => {
  refuses('GPL-2.0-only');
  refuses('SSPL-1.0');
});

test('license expressions follow their operators', () => {
  accepts('(MIT OR Apache-2.0) AND Unicode-3.0');
  accepts('MIT/Apache-2.0');
  accepts('Apache-2.0 WITH LLVM-exception OR MIT');
  accepts('Unknown-1.0 OR MIT');
  refuses('Unknown-1.0 AND MIT');
  refuses('(MIT OR Unknown-1.0) AND Unknown-2.0');
  refuses('Apache-2.0 WITH Unknown-exception');
});

test('malformed license expressions are refused', () => {
  refuses('');
  refuses('MIT OR');
  refuses('(MIT');
  refuses('MIT Apache-2.0');
});

test('the vendored list is allowed and its license files exist', () => {
  assert.doesNotThrow(() => checkLicenses(VENDORED));
  assert.deepEqual(
    VENDORED.map(({ name }) => name),
    ['foliate-js', 'zip.js', 'fflate', 'WebView2 loader'],
  );
  for (const { licenseFile } of VENDORED) {
    assert.ok(existsSync(join(REPO_ROOT, licenseFile)), licenseFile);
  }
});

test('only normal dependencies reachable from the app are distributed', () => {
  const pkg = (name, license) => ({ id: name, name, version: '1.0.0', license });
  const normal = [{ kind: null, target: null }];
  const metadata = {
    packages: [
      pkg('app', 'GPL-3.0-or-later'),
      pkg('runtime', 'MIT'),
      pkg('transitive', 'ISC'),
      pkg('dev-only', 'AGPL-3.0'),
      pkg('build-only', 'AGPL-3.0'),
      pkg('both', 'Zlib'),
      pkg('unreachable', 'AGPL-3.0'),
    ],
    workspace_members: ['app'],
    resolve: {
      root: 'app',
      nodes: [
        {
          id: 'app',
          deps: [
            { pkg: 'runtime', dep_kinds: normal },
            { pkg: 'dev-only', dep_kinds: [{ kind: 'dev', target: null }] },
            { pkg: 'build-only', dep_kinds: [{ kind: 'build', target: null }] },
            { pkg: 'both', dep_kinds: [{ kind: 'dev', target: null }, ...normal] },
          ],
        },
        { id: 'runtime', deps: [{ pkg: 'transitive', dep_kinds: normal }] },
        { id: 'transitive', deps: [] },
        { id: 'both', deps: [] },
        { id: 'dev-only', deps: [{ pkg: 'unreachable', dep_kinds: normal }] },
        { id: 'build-only', deps: [] },
        { id: 'unreachable', deps: [] },
      ],
    },
  };
  assert.deepEqual(
    distributedCrates(metadata).map(({ name }) => name),
    ['both', 'runtime', 'transitive'],
  );
});

test('the order of the crates does not depend on the locale', () => {
  const pkg = (name) => ({ id: name, name, version: '1.0.0' });
  const normal = [{ kind: null, target: null }];
  const metadata = {
    packages: [pkg('app'), pkg('apple'), pkg('Zebra')],
    workspace_members: ['app'],
    resolve: {
      root: 'app',
      nodes: [
        {
          id: 'app',
          deps: [
            { pkg: 'apple', dep_kinds: normal },
            { pkg: 'Zebra', dep_kinds: normal },
          ],
        },
        { id: 'apple', deps: [] },
        { id: 'Zebra', deps: [] },
      ],
    },
  };
  assert.deepEqual(
    distributedCrates(metadata).map(({ name }) => name),
    ['Zebra', 'apple'],
  );
});

test('the order of the licenses does not depend on the locale', () => {
  const component = (name, text) => ({ name, version: '1.0.0', license: 'MIT', texts: [text] });
  const text = renderLicenses([
    component('apple', 'one'),
    component('Zebra', 'two'),
    component('Yak', 'one'),
  ]);
  assert.ok(text.indexOf('Yak 1.0.0') < text.indexOf('apple 1.0.0'), 'inside a block');
  assert.ok(text.indexOf('Yak 1.0.0') < text.indexOf('Zebra 1.0.0'), 'between blocks');
});

const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';
const mplCrate = (over = {}) => ({
  name: 'cssparser',
  version: '0.38.0',
  license: 'MPL-2.0',
  source: CRATES_IO,
  repository: 'https://github.com/servo/rust-cssparser',
  texts: ['the license text'],
  ...over,
});

test('the licenses say where the source of each MPL-2.0 component is', () => {
  const text = renderLicenses([
    mplCrate(),
    mplCrate({ name: 'dtoa-short', version: '0.3.5', repository: undefined }),
    { name: 'plain', version: '1.0.0', license: 'MIT', texts: ['mit text'] },
  ]);
  const notice = text.slice(0, text.indexOf('='.repeat(72)));
  assert.ok(notice.includes('MPL-2.0'));
  assert.ok(
    notice.includes(
      'cssparser 0.38.0\n' +
        '  https://static.crates.io/crates/cssparser/cssparser-0.38.0.crate\n' +
        '  https://github.com/servo/rust-cssparser\n',
    ),
  );
  assert.ok(
    notice.includes(
      'dtoa-short 0.3.5\n  https://static.crates.io/crates/dtoa-short/dtoa-short-0.3.5.crate\n',
    ),
  );
  assert.ok(!notice.includes('plain 1.0.0'));
  assert.ok(text.includes('cssparser 0.38.0 (MPL-2.0)'), 'the component keeps its license block');
});

test('an MPL-2.0 component offered as one choice is named too', () => {
  const text = renderLicenses([mplCrate({ license: 'MIT OR MPL-2.0' })]);
  assert.ok(text.includes('crates/cssparser/cssparser-0.38.0.crate'));
});

test('without an MPL-2.0 component there is no source notice', () => {
  const text = renderLicenses([{ name: 'a', version: '1.0.0', license: 'MIT', texts: ['text'] }]);
  assert.ok(!text.includes('MPL-2.0'));
  assert.ok(text.startsWith('a 1.0.0 (MIT)'));
});

test('an MPL-2.0 component from outside crates.io is refused, not given a false address', () => {
  const fromGit = mplCrate({ source: 'git+https://example.test/fork' });
  assert.throws(() => renderLicenses([fromGit]), /cssparser 0\.38\.0/);
  assert.throws(() => renderLicenses([mplCrate({ source: null })]), /cssparser 0\.38\.0/);
});

test('components with the same license text share one block', () => {
  const text = renderLicenses([
    { name: 'b', version: '2.0.0', license: 'MIT', texts: ['same text'] },
    { name: 'a', version: '1.0.0', license: 'MIT', texts: ['same text\r\n'] },
  ]);
  assert.equal(text.match(/same text/g).length, 1);
  assert.ok(text.indexOf('a 1.0.0 (MIT)') < text.indexOf('b 2.0.0 (MIT)'));
  assert.ok(!text.includes('\r'));
});

// A temporary package folder for a crate, removed when the test ends. The output
// stays out of it: a file named licenses.txt in there would count as a license text.
function crateIn(t, name, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mochi-licenses-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'crate');
  mkdirSync(folder);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(folder, file), content);
  return {
    crate: { name, version: '1.0.0', license: 'MIT', manifest_path: join(folder, 'Cargo.toml') },
    output: join(root, 'licenses.txt'),
  };
}

test('every component without license text is refused and named', () => {
  assert.throws(
    () =>
      checkLicenseTexts([
        { name: 'good', version: '1.0.0', texts: ['text'] },
        { name: 'bad-one', version: '1.0.0', texts: [] },
        { name: 'bad-two', version: '2.0.0', texts: [' \r\n'] },
      ]),
    (error) =>
      error.message.includes('bad-one 1.0.0') &&
      error.message.includes('bad-two 2.0.0') &&
      !error.message.includes('good'),
  );
});

test('rendering refuses a component without license text', () => {
  assert.throws(() => renderLicenses([{ name: 'c', version: '1.0.0', license: 'MIT', texts: [] }]));
});

test('a crate without license text fails both modes and writes nothing', (t) => {
  const { crate, output } = crateIn(t, 'no-text-anywhere');
  for (const args of [[], ['--check']]) {
    assert.throws(() => runLicenses(args, [crate], output), /no-text-anywhere 1\.0\.0/);
    assert.ok(!existsSync(output));
  }
});

test('the write mode writes the licenses of a crate with a license file', (t) => {
  const { crate, output } = crateIn(t, 'with-text', { LICENSE: 'the crate text' });
  runLicenses([], [crate], output);
  assert.match(readFileSync(output, 'utf8'), /with-text 1\.0\.0 \(MIT\)\n-+\nthe crate text/);
});

test('the check fails when the licenses file is missing, and does not create it', (t) => {
  const { crate, output } = crateIn(t, 'with-text', { LICENSE: 'the crate text' });
  assert.throws(() => runLicenses(['--check'], [crate], output), /missing.*tools\/licenses\.mjs/s);
  assert.ok(!existsSync(output));
});

test('the check passes on the file the write mode wrote', (t) => {
  const { crate, output } = crateIn(t, 'with-text', { LICENSE: 'the crate text' });
  runLicenses([], [crate], output);
  assert.doesNotThrow(() => runLicenses(['--check'], [crate], output));
});

test('the check treats a file with CRLF line ends as the same file, and leaves it alone', (t) => {
  const { crate, output } = crateIn(t, 'with-text', { LICENSE: 'the crate text' });
  runLicenses([], [crate], output);
  const withCrlf = readFileSync(output, 'utf8').replace(/\n/g, '\r\n');
  writeFileSync(output, withCrlf);
  assert.doesNotThrow(() => runLicenses(['--check'], [crate], output));
  assert.equal(readFileSync(output, 'utf8'), withCrlf);
});

test('the check fails when the licenses file differs, and leaves it alone', (t) => {
  const { crate, output } = crateIn(t, 'with-text', { LICENSE: 'the crate text' });
  runLicenses([], [crate], output);
  const stale = readFileSync(output, 'utf8').replace('the crate text', 'an older text');
  writeFileSync(output, stale);
  assert.throws(
    () => runLicenses(['--check'], [crate], output),
    /out of date.*tools\/licenses\.mjs/s,
  );
  assert.equal(readFileSync(output, 'utf8'), stale);
});

test('the check fails on text the crates do not account for', (t) => {
  const { crate, output } = crateIn(t, 'with-text', { LICENSE: 'the crate text' });
  runLicenses([], [crate], output);
  writeFileSync(output, `${readFileSync(output, 'utf8')}\nextra\n`);
  assert.throws(() => runLicenses(['--check'], [crate], output), /out of date/);
});

test('a listed crate published without a license file takes the tracked text', (t) => {
  const { crate } = crateIn(t, 'webview2-com');
  const [text] = crateLicenseTexts(crate);
  assert.match(text, /Permission is hereby granted/);
  assert.match(text, /Copyright/);
});

test('a license file in the crate wins over the tracked text', (t) => {
  const { crate } = crateIn(t, 'webview2-com', { 'LICENSE-MIT': 'the crate text' });
  assert.deepEqual(crateLicenseTexts(crate), ['the crate text']);
});

test('the tracked crate license files hold the license each crate declares', () => {
  const expected = {
    'alloc-stdlib': /Redistribution and use in source and binary forms/,
    selectors: /Mozilla Public License Version 2\.0/,
    'webview2-com': /Permission is hereby granted/,
    'webview2-com-macros': /Permission is hereby granted/,
    'webview2-com-sys': /Permission is hereby granted/,
  };
  assert.deepEqual(Object.keys(CRATE_LICENSE_FILES).sort(), Object.keys(expected).sort());
  for (const [name, file] of Object.entries(CRATE_LICENSE_FILES)) {
    assert.match(readFileSync(join(REPO_ROOT, file), 'utf8'), expected[name], name);
  }
});
