// SPDX-License-Identifier: GPL-3.0-or-later
//
// Lists the licenses of everything MochiReader distributes.
//   node tools/licenses.mjs           writes app/licenses.txt
//   node tools/licenses.mjs --check   fails on an AGPL or unknown license
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './is-entry-point.mjs';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const OUTPUT_FILE = join(REPO_ROOT, 'app', 'licenses.txt');
const CARGO_MANIFEST = join(REPO_ROOT, 'src-tauri', 'Cargo.toml');
const TARGET_PLATFORM = 'x86_64-pc-windows-msvc';
const CARGO_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;
const LICENSE_FILE_NAME = /^(licen[cs]e|copying|notice|unlicense)/i;
const NORMAL_DEPENDENCY = null;

// Files under app/vendor/, which cargo metadata cannot see.
export const VENDORED = [
  {
    name: 'foliate-js',
    version: '78914aef',
    license: 'MIT',
    licenseFile: 'app/vendor/foliate/LICENSE',
  },
  {
    name: 'zip.js',
    version: 'vendored by foliate-js',
    license: 'BSD-3-Clause',
    licenseFile: 'tools/vendored-licenses/zip.js-LICENSE',
  },
  {
    name: 'fflate',
    version: 'vendored by foliate-js',
    license: 'MIT',
    licenseFile: 'tools/vendored-licenses/fflate-LICENSE',
  },
];

// Licenses that can be part of a GPL-3.0-or-later work. Anything else is unknown
// until someone reads it and adds it here.
const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'Zlib',
]);
const ALLOWED_EXCEPTIONS = new Set(['LLVM-exception']);

// Evaluates an SPDX expression. `/` is the old cargo spelling of OR. Malformed
// expressions throw, and the caller treats them as refused.
function expressionIsAllowed(expression) {
  const tokens = expression.match(/[()/]|[^\s()/]+/g) ?? [];
  let position = 0;
  const peek = () => tokens[position]?.toUpperCase();

  const parseAtom = () => {
    const token = tokens[position++];
    if (token === undefined || [')', '/', 'AND', 'OR', 'WITH'].includes(token.toUpperCase())) {
      throw new Error('expected a license');
    }
    if (token === '(') {
      const inner = parseOr();
      if (tokens[position++] !== ')') throw new Error('expected a closing parenthesis');
      return inner;
    }
    if (peek() !== 'WITH') return ALLOWED_LICENSES.has(token);
    position++;
    return ALLOWED_LICENSES.has(token) && ALLOWED_EXCEPTIONS.has(tokens[position++]);
  };
  const parseAnd = () => {
    let allowed = parseAtom();
    while (peek() === 'AND') {
      position++;
      allowed = parseAtom() && allowed;
    }
    return allowed;
  };
  const parseOr = () => {
    let allowed = parseAnd();
    while (peek() === 'OR' || peek() === '/') {
      position++;
      allowed = parseAnd() || allowed;
    }
    return allowed;
  };

  const allowed = parseOr();
  if (position !== tokens.length) throw new Error('unexpected text after the expression');
  return allowed;
}

function licenseIsAllowed(license) {
  // An AGPL dependency is an error even when offered as one choice among others.
  if (typeof license !== 'string' || /agpl/i.test(license)) return false;
  try {
    return expressionIsAllowed(license);
  } catch {
    return false;
  }
}

export function checkLicenses(components) {
  const refused = components.filter(({ license }) => !licenseIsAllowed(license));
  if (refused.length > 0) {
    const lines = refused.map(({ name, license }) => `  ${name}: ${license ?? 'no license'}`);
    throw new Error(`AGPL or unknown licenses:\n${lines.join('\n')}`);
  }
}

// The crates reachable from the app through normal dependencies. Development and
// build dependencies never reach the installed app.
export function distributedCrates(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const members = new Set(metadata.workspace_members);
  const seen = new Set();
  const pending = [...members];
  while (pending.length > 0) {
    for (const { pkg, dep_kinds: kinds } of nodes.get(pending.pop()).deps) {
      const isNormal = kinds.some(({ kind }) => kind === NORMAL_DEPENDENCY);
      if (isNormal && !seen.has(pkg) && !members.has(pkg)) {
        seen.add(pkg);
        pending.push(pkg);
      }
    }
  }
  return [...seen]
    .map((id) => packages.get(id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const normalizeText = (text) => text.replace(/\r\n/g, '\n').trim();

const RULE_WIDTH = 72;

// Most crates carry the same license text, so each distinct text appears once,
// after the list of components it belongs to.
export function renderLicenses(components) {
  const blocks = new Map();
  for (const component of components) {
    const body =
      component.texts.map(normalizeText).join('\n\n') ||
      `No license text ships with this component. Its declared license is ${component.license}.`;
    blocks.set(body, [...(blocks.get(body) ?? []), component]);
  }
  const ordered = [...blocks].map(([body, owners]) => {
    const names = owners
      .map(({ name, version, license }) => `${name} ${version} (${license})`)
      .sort((a, b) => a.localeCompare(b));
    return { names, body };
  });
  ordered.sort((a, b) => a.names[0].localeCompare(b.names[0]));
  const sections = ordered.map(
    ({ names, body }) => `${names.join('\n')}\n${'-'.repeat(RULE_WIDTH)}\n${body}`,
  );
  return `${sections.join(`\n\n${'='.repeat(RULE_WIDTH)}\n\n`)}\n`;
}

function cargoMetadata() {
  const output = execFileSync(
    'cargo',
    [
      'metadata',
      '--format-version=1',
      '--locked',
      `--filter-platform=${TARGET_PLATFORM}`,
      `--manifest-path=${CARGO_MANIFEST}`,
    ],
    { encoding: 'utf8', maxBuffer: CARGO_OUTPUT_LIMIT_BYTES, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(output);
}

function crateLicenseTexts({ manifest_path: manifestPath, license_file: licenseFile }) {
  const folder = dirname(manifestPath);
  if (licenseFile) return [readFileSync(resolve(folder, licenseFile), 'utf8')];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(join(folder, name), 'utf8'));
}

function main(args) {
  const crates = distributedCrates(cargoMetadata());
  checkLicenses([...VENDORED, ...crates]);
  if (args.includes('--check')) return;

  const components = [
    ...VENDORED.map((component) => ({
      ...component,
      texts: [readFileSync(join(REPO_ROOT, component.licenseFile), 'utf8')],
    })),
    ...crates.map((crate) => ({ ...crate, texts: crateLicenseTexts(crate) })),
  ];
  writeFileSync(OUTPUT_FILE, renderLicenses(components));
}

if (isEntryPoint(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
