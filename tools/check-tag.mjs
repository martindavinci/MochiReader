// SPDX-License-Identifier: GPL-3.0-or-later
//
// Refuses a release tag that differs from the version in any of the three files
// that declare it. Usage: node tools/check-tag.mjs v1.2.3
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './is-entry-point.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG_PREFIX = 'v';
const MISSING_VERSION = '(missing)';
const CATALOG_FILE = 'app/speech/voices.json';
/** The hash of the engine pack before it is published: a release with it could never install Piper. */
export const ENGINE_PENDING = 'pending-engine-1';

/** Refuses a catalog whose engine pack has no hash yet. */
export function checkEngine(catalog) {
  if (catalog.engine?.sha256 === ENGINE_PENDING) {
    throw new Error(`${CATALOG_FILE}: the engine pack has no hash yet; publish engine-1 and fill it in`);
  }
}

export function checkTag(tag, declared) {
  if (!tag.startsWith(TAG_PREFIX)) {
    throw new Error(`tag ${tag} does not start with "${TAG_PREFIX}"`);
  }
  if (declared.length === 0) {
    throw new Error('no versions to compare with the tag');
  }
  const expected = tag.slice(TAG_PREFIX.length);
  const different = declared.filter(({ version }) => version !== expected);
  if (different.length > 0) {
    const lines = different.map(({ file, version }) => `  ${file}: ${version || MISSING_VERSION}`);
    throw new Error([`tag ${tag} does not match:`, ...lines].join('\n'));
  }
}

function jsonVersion(text) {
  return JSON.parse(text).version;
}

function cargoPackageVersion(toml) {
  let inPackage = false;
  for (const line of toml.split(/\r?\n/)) {
    if (line.startsWith('[')) inPackage = line.trim() === '[package]';
    const match = inPackage && line.match(/^version\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  return undefined;
}

const VERSION_FILES = [
  { file: 'package.json', parse: jsonVersion },
  { file: 'src-tauri/tauri.conf.json', parse: jsonVersion },
  { file: 'src-tauri/Cargo.toml', parse: cargoPackageVersion },
];

export function readVersions(root) {
  return VERSION_FILES.map(({ file, parse }) => ({
    file,
    version: parse(readFileSync(join(root, file), 'utf8')),
  }));
}

if (isEntryPoint(import.meta.url)) {
  try {
    checkTag(process.argv[2] ?? '', readVersions(REPO_ROOT));
    checkEngine(JSON.parse(readFileSync(join(REPO_ROOT, CATALOG_FILE), 'utf8')));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
