// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../tools/licenses.mjs';

const UNMATCHED_TAG = 'v9.9.9';
const EXIT_FAILURE = 1;

// No PATH, so tools/licenses.mjs fails when it looks for cargo instead of running it.
const ENV_WITHOUT_CARGO = { PATH: '', SystemRoot: process.env.SystemRoot };

// A copy of the layout the tools expect, so that removing it, junction included,
// can never reach the repository.
function makeRepoCopy(t) {
  const root = mkdtempSync(join(tmpdir(), 'mochi-entry-point-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  mkdirSync(join(real, 'src-tauri'), { recursive: true });
  cpSync(join(REPO_ROOT, 'tools'), join(real, 'tools'), { recursive: true });
  writeFileSync(join(real, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(real, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(real, 'src-tauri', 'Cargo.toml'), '[package]\nversion = "0.1.0"\n');
  const junction = join(root, 'junction');
  symlinkSync(real, junction, 'junction');
  return { real, junction };
}

const runScript = (repo, script, ...args) =>
  spawnSync(process.execPath, [join(repo, 'tools', script), ...args], {
    encoding: 'utf8',
    env: ENV_WITHOUT_CARGO,
  });

test('check-tag rejects a wrong tag when reached through a junction', (t) => {
  const { junction } = makeRepoCopy(t);
  const { status, stderr } = runScript(junction, 'check-tag.mjs', UNMATCHED_TAG);
  assert.equal(status, EXIT_FAILURE);
  assert.match(stderr, /v9\.9\.9/);
});

test('check-tag rejects a wrong tag on its real path', (t) => {
  const { real } = makeRepoCopy(t);
  assert.equal(runScript(real, 'check-tag.mjs', UNMATCHED_TAG).status, EXIT_FAILURE);
});

test('licenses --check runs when reached through a junction', (t) => {
  const { junction } = makeRepoCopy(t);
  const { status, stderr } = runScript(junction, 'licenses.mjs', '--check');
  assert.equal(status, EXIT_FAILURE);
  assert.match(stderr, /cargo/);
});

test('licenses --check runs on its real path', (t) => {
  const { real } = makeRepoCopy(t);
  assert.equal(runScript(real, 'licenses.mjs', '--check').status, EXIT_FAILURE);
});

test('importing a tool does not run it, whatever the first argument is', (t) => {
  const { real } = makeRepoCopy(t);
  const url = pathToFileURL(join(real, 'tools', 'check-tag.mjs')).href;
  const { status, stderr } = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`, 'not-a-file'],
    { encoding: 'utf8', env: ENV_WITHOUT_CARGO },
  );
  assert.equal(stderr, '');
  assert.equal(status, 0);
});
