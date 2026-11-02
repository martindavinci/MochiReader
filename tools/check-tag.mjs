// SPDX-License-Identifier: GPL-3.0-or-later
//
// Refuses a release tag that differs from the version in any of the three files
// that declare it. Usage: node tools/check-tag.mjs v1.2.3
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG_PREFIX = 'v';

export function checkTag(tag, versions) {
  if (!tag.startsWith(TAG_PREFIX)) {
    throw new Error(`tag ${tag} does not start with "${TAG_PREFIX}"`);
  }
  if (versions.length === 0) {
    throw new Error('no versions to compare with the tag');
  }
  const expected = tag.slice(TAG_PREFIX.length);
  const different = versions.filter((version) => version !== expected);
  if (different.length > 0) {
    throw new Error(`tag ${tag} does not match version(s) ${different.join(', ')}`);
  }
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

export function readVersions(root) {
  const read = (...path) => readFileSync(join(root, ...path), 'utf8');
  return [
    JSON.parse(read('package.json')).version,
    JSON.parse(read('src-tauri', 'tauri.conf.json')).version,
    cargoPackageVersion(read('src-tauri', 'Cargo.toml')),
  ];
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    checkTag(process.argv[2] ?? '', readVersions(REPO_ROOT));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
