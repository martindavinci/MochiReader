// SPDX-License-Identifier: GPL-3.0-or-later
//
// Writes app/translate/models.json: the translation models of Firefox Translations (Mozilla, MPL-2.0), one entry per
// language pair at its newest released version, each file with its address, SHA-256 and size. The app reads only this
// list, built into it: listing the models never asks anything of the network.
// Usage: node tools/translation-catalog.mjs [--write] [--from-file <records.json>]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './is-entry-point.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(REPO_ROOT, 'app', 'translate', 'models.json');
const RECORDS = 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records';
const CDN = 'https://firefox-settings-attachments.cdn.mozilla.net/';
const CATALOG_VERSION = 1;
// What the engine reads. A pair has one vocabulary, or one for each side.
const KINDS = new Set(['model', 'lex', 'vocab', 'srcvocab', 'trgvocab']);
const REQUIRED = ['model', 'lex'];
// 2.1 is released; 2.1a1 is a pre-release Firefox gives only to some.
const RELEASED = /^\d+(\.\d+)*$/;

const compareVersions = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const complete = (files) => REQUIRED.every((kind) => files[kind])
  && (files.vocab ? !files.srcvocab && !files.trgvocab : Boolean(files.srcvocab && files.trgvocab));

/**
 * @param {object[]} records The records of the Remote Settings collection translations-models.
 * @param {{cdn: string}} options Where the attachments are served from.
 * @returns {{version: number, pairs: {from: string, to: string, version: string,
 *   files: Record<string, {url: string, sha256: string, bytes: number}>}[]}}
 */
export function buildCatalog(records, { cdn }) {
  const sets = new Map();
  for (const record of records) {
    if (!KINDS.has(record.fileType) || record.filter_expression || !RELEASED.test(record.version)) continue;
    const id = `${record.fromLang}-${record.toLang}\u0000${record.version}`;
    if (!sets.has(id)) sets.set(id, { from: record.fromLang, to: record.toLang, version: record.version, files: {} });
    const { hash, size, location } = record.attachment;
    sets.get(id).files[record.fileType] = { url: `${cdn}${location}`, sha256: hash, bytes: size };
  }
  const newest = new Map();
  for (const set of sets.values()) {
    if (!complete(set.files)) continue;
    const pair = `${set.from}-${set.to}`;
    const kept = newest.get(pair);
    if (!kept || compareVersions(set.version, kept.version) > 0) newest.set(pair, set);
  }
  const pairs = [...newest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, set]) => set);
  return { version: CATALOG_VERSION, pairs };
}

async function main(args) {
  const at = args.indexOf('--from-file');
  const body = at >= 0
    ? JSON.parse(readFileSync(args[at + 1], 'utf8'))
    : await fetch(RECORDS).then((response) => {
      if (!response.ok) throw new Error(`${RECORDS}: ${response.status}`);
      return response.json();
    });
  const text = `${JSON.stringify(buildCatalog(body.data, { cdn: CDN }), null, 2)}\n`;
  if (args.includes('--write')) writeFileSync(CATALOG, text);
  else console.log(text);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
