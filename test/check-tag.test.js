// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTag, readVersions } from '../tools/check-tag.mjs';

const PACKAGE_JSON = 'package.json';
const TAURI_CONF = 'src-tauri/tauri.conf.json';
const CARGO_TOML = 'src-tauri/Cargo.toml';

const declared = (packageJson, tauriConf, cargoToml) => [
  { file: PACKAGE_JSON, version: packageJson },
  { file: TAURI_CONF, version: tauriConf },
  { file: CARGO_TOML, version: cargoToml },
];

function makeRepo(t, { packageJson, tauriConf, cargoToml }) {
  const root = mkdtempSync(join(tmpdir(), 'mochi-check-tag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src-tauri'));
  writeFileSync(join(root, PACKAGE_JSON), JSON.stringify(packageJson));
  writeFileSync(join(root, TAURI_CONF), JSON.stringify(tauriConf));
  writeFileSync(join(root, CARGO_TOML), cargoToml);
  return root;
}

test('tag must match every version', () => {
  const versions = declared('0.1.0', '0.1.0', '0.1.0');
  assert.doesNotThrow(() => checkTag('v0.1.0', versions));
  assert.throws(() => checkTag('v0.1.1', versions));
  assert.throws(() => checkTag('0.1.0', versions));
});

test('one version out of step names its file and value, and only that file', () => {
  assert.throws(
    () => checkTag('v0.1.0', declared('0.1.0', '0.1.1', '0.1.0')),
    (error) => {
      assert.ok(error.message.includes(`${TAURI_CONF}: 0.1.1`), error.message);
      assert.ok(!error.message.includes(PACKAGE_JSON), error.message);
      assert.ok(!error.message.includes(CARGO_TOML), error.message);
      return true;
    },
  );
});

test('every mismatch is listed', () => {
  assert.throws(
    () => checkTag('v0.1.0', declared('0.2.0', '0.1.0', '0.3.0')),
    (error) => {
      assert.ok(error.message.includes(`${PACKAGE_JSON}: 0.2.0`), error.message);
      assert.ok(error.message.includes(`${CARGO_TOML}: 0.3.0`), error.message);
      return true;
    },
  );
});

test('a version that is not declared is reported as missing', () => {
  for (const absent of [undefined, null, '']) {
    assert.throws(
      () => checkTag('v0.1.0', declared('0.1.0', absent, '0.1.0')),
      (error) => {
        assert.ok(error.message.includes(`${TAURI_CONF}: (missing)`), error.message);
        return true;
      },
    );
  }
});

test('no versions at all fail the tag', () => {
  assert.throws(() => checkTag('v0.1.0', []));
});

test('versions are read from package.json, tauri.conf.json and Cargo.toml', (t) => {
  const root = makeRepo(t, {
    packageJson: { version: '1.0.0' },
    tauriConf: { version: '2.0.0' },
    cargoToml: [
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
  });
  assert.deepEqual(readVersions(root), declared('1.0.0', '2.0.0', '3.0.0'));
});

test('a file that declares no literal version is named in the failure', (t) => {
  const root = makeRepo(t, {
    packageJson: { version: '0.1.0' },
    tauriConf: { productName: 'MochiReader' },
    cargoToml: '[package]\nversion.workspace = true\n',
  });
  assert.throws(
    () => checkTag('v0.1.0', readVersions(root)),
    (error) => {
      assert.ok(error.message.includes(`${TAURI_CONF}: (missing)`), error.message);
      assert.ok(error.message.includes(`${CARGO_TOML}: (missing)`), error.message);
      assert.ok(!error.message.includes(PACKAGE_JSON), error.message);
      return true;
    },
  );
});
