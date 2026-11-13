// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fills app/speech/voices.json with the Piper voices listed below: their files at one commit of
// huggingface.co/rhasspy/piper-voices, with SHA-256 and size. The list is kept by hand: a voice goes in only after its
// MODEL_CARD was read, and only with a license the app can offer (see test/voices-catalog.test.js).
// Usage: node tools/piper-catalog.mjs [--write] [--commit <40 hex>]
// Without --commit it takes the current commit of the repository.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './is-entry-point.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(REPO_ROOT, 'app', 'speech', 'voices.json');
const HF = 'https://huggingface.co';
const REPO = 'rhasspy/piper-voices';
const SAMPLE = 'samples/speaker_0.mp3';

// What each MODEL_CARD says, read on 2026-11-13 at commit 6b9cfaacb4fb2e02a9621227e3c1a48bec9710c3.
// Left out on purpose: lessac (Blizzard license), ryan, hfc_*, semaine, l2arctic, ja_JP-hi_fi_captain, ko_KR-kss
// (non-commercial), northern_english_male, upmc, daniela (share-alike), tom (AGPL), alan, amy, jenny_dioco, kusal
// (no clear license), zh_CN-huayan (unknown), zh_CN-xiao_ya (non-commercial), zh_CN-chaowen (pinyin phonemes, which
// the app does not make), es_ES-sharvard (CC-BY-3.0), es_MX-ald (Unlicense).
export const VOICES = [
  { id: 'en_US-ljspeech-medium', name: 'Linda', license: 'public-domain' },
  { id: 'en_US-kristin-medium', name: 'Kristin', license: 'public-domain' },
  { id: 'en_US-john-medium', name: 'John', license: 'public-domain' },
  { id: 'en_GB-cori-medium', name: 'Cori', license: 'CC-BY-4.0' },
  { id: 'en_GB-alba-medium', name: 'Alba', license: 'CC-BY-4.0' },
  { id: 'it_IT-paola-medium', name: 'Paola', license: 'CC0-1.0' },
  { id: 'it_IT-serena-medium', name: 'Serena', license: 'CC-BY-4.0' },
  { id: 'de_DE-thorsten-medium', name: 'Thorsten', license: 'CC0-1.0' },
  { id: 'de_DE-kerstin-medium', name: 'Kerstin', license: 'CC0-1.0' },
  { id: 'es_ES-davefx-medium', name: 'David', license: 'CC0-1.0' },
  { id: 'fr_FR-siwis-medium', name: 'Siwis', license: 'CC-BY-4.0' },
  { id: 'pt_BR-faber-medium', name: 'Faber', license: 'CC0-1.0' },
  { id: 'pt_BR-cadu-medium', name: 'Cadu', license: 'CC0-1.0' },
];

/** Interface languages with no voice the app can offer: Windows and Edge stay. */
export const UNAVAILABLE = ['ja', 'ko', 'zh'];

/** `en_US-ljspeech-medium` → `en/en_US/ljspeech/medium`. */
export function folderOf(id) {
  const [locale, name, quality] = id.split('-');
  return `${locale.split('_')[0]}/${locale}/${name}/${quality}`;
}

export const langOf = (id) => id.split('-')[0].replace('_', '-');
export const qualityOf = (id) => id.split('-').at(-1);
const fileUrl = (commit, path) => `${HF}/${REPO}/resolve/${commit}/${encodeURI(path)}`;

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

async function sha256Of(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

/** A file as the catalog lists it: LFS files carry their SHA-256, small ones are downloaded and hashed. */
async function describe(commit, entry) {
  const url = fileUrl(commit, entry.path);
  if (entry.lfs) return { url, sha256: entry.lfs.oid, bytes: entry.lfs.size };
  return { url, ...(await sha256Of(url)) };
}

async function voiceEntry(commit, { id, name, license }) {
  const folder = folderOf(id);
  const tree = await json(`${HF}/api/models/${REPO}/tree/${commit}/${encodeURI(folder)}?recursive=true`);
  const find = (path) => {
    const entry = tree.find((file) => file.path === `${folder}/${path}`);
    if (!entry) throw new Error(`${id}: no ${path}`);
    return entry;
  };
  return {
    id,
    name,
    lang: langOf(id),
    quality: qualityOf(id),
    license,
    card: `${HF}/${REPO}/blob/${commit}/${encodeURI(`${folder}/MODEL_CARD`)}`,
    sample: fileUrl(commit, `${folder}/${SAMPLE}`),
    speaker: 0,
    model: await describe(commit, find(`${id}.onnx`)),
    config: await describe(commit, find(`${id}.onnx.json`)),
  };
}

async function main(args) {
  const at = args.indexOf('--commit');
  const commit = at >= 0 ? args[at + 1] : (await json(`${HF}/api/models/${REPO}`)).sha;
  const voices = [];
  for (const voice of VOICES) {
    voices.push(await voiceEntry(commit, voice));
    console.log(`${voice.id}: ok`);
  }
  const catalog = { version: 1, unavailable: UNAVAILABLE, voices };
  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  if (args.includes('--write')) writeFileSync(CATALOG, text);
  else console.log(text);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
