// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fills the `kokoro` section of app/speech/voices.json: the one Kokoro-82M model the app uses (q8) and the voices listed
// below, at one commit of huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX, with SHA-256 and size, and the
// vocabulary of its tokenizer as [phoneme, id] pairs. The rest of the catalog (the Piper voices) is left as it is.
// Usage: node tools/kokoro-catalog.mjs [--write] [--commit <40 hex>]
// Without --commit it takes the current commit of the repository.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './is-entry-point.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(REPO_ROOT, 'app', 'speech', 'voices.json');
const HF = 'https://huggingface.co';
const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MODEL = 'onnx/model_quantized.onnx';

// The voices of hexgrad/Kokoro-82M VOICES.md (read on 2026-11-23 at commit f3ff3571791e39611d31c381e3a41a3af07b4987)
// in the languages the app offers with Kokoro, with an Overall Grade of C or better. Left out: every voice graded C- or
// lower (af_sky, af_jessica, af_river, am_adam, am_echo, am_eric, am_liam, am_onyx, am_santa, bf_alice, bf_lily,
// bm_daniel, bm_lewis), the "santa" voices, and Japanese and Chinese (their phonemes need misaki, not eSpeak).
// Spanish and Brazilian Portuguese voices have no grade there: they go in with an empty grade.
export const VOICES = [
  { id: 'af_heart', grade: 'A' },
  { id: 'af_bella', grade: 'A-' },
  { id: 'af_nicole', grade: 'B-' },
  { id: 'af_aoede', grade: 'C+' },
  { id: 'af_kore', grade: 'C+' },
  { id: 'af_sarah', grade: 'C+' },
  { id: 'af_alloy', grade: 'C' },
  { id: 'af_nova', grade: 'C' },
  { id: 'am_fenrir', grade: 'C+' },
  { id: 'am_michael', grade: 'C+' },
  { id: 'am_puck', grade: 'C+' },
  { id: 'bf_emma', grade: 'B-' },
  { id: 'bf_isabella', grade: 'C' },
  { id: 'bm_fable', grade: 'C' },
  { id: 'bm_george', grade: 'C' },
  { id: 'if_sara', grade: 'C' },
  { id: 'im_nicola', grade: 'C' },
  { id: 'ff_siwis', grade: 'B-' },
  { id: 'hf_alpha', grade: 'C' },
  { id: 'hf_beta', grade: 'C' },
  { id: 'hm_omega', grade: 'C' },
  { id: 'hm_psi', grade: 'C' },
  { id: 'ef_dora', grade: '' },
  { id: 'em_alex', grade: '' },
  { id: 'pf_dora', grade: '' },
  { id: 'pm_alex', grade: '' },
];

/** The first letter of a Kokoro voice is its language. */
const LANGS = { a: 'en-US', b: 'en-GB', i: 'it-IT', e: 'es-ES', f: 'fr-FR', p: 'pt-BR', h: 'hi-IN' };

export const langOf = (id) => LANGS[id[0]];
/** `if_sara` → `Sara`. */
export const nameOf = (id) => id.slice(3, 4).toUpperCase() + id.slice(4);
const fileUrl = (commit, path) => `${HF}/${REPO}/resolve/${commit}/${encodeURI(path)}`;

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

/** A file as the catalog lists it: LFS files carry their SHA-256; the voices are small, plain git files. */
async function describe(commit, tree, path) {
  const entry = tree.find((file) => file.path === path);
  if (!entry) throw new Error(`no ${path}`);
  const url = fileUrl(commit, path);
  if (entry.lfs) return { url, sha256: entry.lfs.oid, bytes: entry.lfs.size };
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { url, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

export async function kokoroSection(commit) {
  const tree = await json(`${HF}/api/models/${REPO}/tree/${commit}?recursive=true`);
  const tokenizer = await json(fileUrl(commit, 'tokenizer.json'));
  const voices = [];
  for (const { id, grade } of VOICES) {
    voices.push({ id, name: nameOf(id), lang: langOf(id), grade, file: await describe(commit, tree, `voices/${id}.bin`) });
    console.error(`${id}: ok`);
  }
  return {
    commit,
    license: 'Apache-2.0',
    card: `${HF}/${REPO}/blob/${commit}/README.md`,
    model: await describe(commit, tree, MODEL),
    // pairs, not an object: PowerShell's ConvertFrom-Json refuses keys that differ only in case ('A', 'a')
    vocab: Object.entries(tokenizer.model.vocab).sort(([, one], [, other]) => one - other),
    voices,
  };
}

async function main(args) {
  const at = args.indexOf('--commit');
  const commit = at >= 0 ? args[at + 1] : (await json(`${HF}/api/models/${REPO}`)).sha;
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
  catalog.kokoro = await kokoroSection(commit);
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
