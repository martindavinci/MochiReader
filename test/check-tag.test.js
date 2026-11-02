// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTag, readVersions } from '../tools/check-tag.mjs';

test('tag must match every version', () => {
  assert.doesNotThrow(() => checkTag('v0.1.0', ['0.1.0', '0.1.0', '0.1.0']));
  assert.throws(() => checkTag('v0.1.1', ['0.1.0', '0.1.0', '0.1.0']));
  assert.throws(() => checkTag('0.1.0', ['0.1.0', '0.1.0', '0.1.0']));
});

test('one version out of step fails the tag', () => {
  assert.throws(() => checkTag('v0.1.0', ['0.1.0', '0.1.1', '0.1.0']), /0\.1\.1/);
});

test('no versions at all fail the tag', () => {
  assert.throws(() => checkTag('v0.1.0', []));
});

test('versions are read from package.json, tauri.conf.json and Cargo.toml', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mochi-check-tag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src-tauri'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '2.0.0' }));
  writeFileSync(
    join(root, 'src-tauri', 'Cargo.toml'),
    [
      '[workspace]',
      'resolver = "2"',
      '',
      '[package]',
      'name = "mochireader"',
      'authors = ["Martin DaVinci"]',
      'version = "3.0.0"',
      '',
      '[dependencies]',
      'tauri = { version = "2.12" }',
      'comrak = "0.59.0"',
    ].join('\r\n'),
  );
  assert.deepEqual(readVersions(root), ['1.0.0', '2.0.0', '3.0.0']);
});
