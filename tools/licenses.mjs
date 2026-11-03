// SPDX-License-Identifier: GPL-3.0-or-later
//
// Lists the licenses of everything MochiReader distributes.
//   node tools/licenses.mjs           writes app/licenses.txt
//   node tools/licenses.mjs --check   only checks, and fails if app/licenses.txt is
//                                     missing or is not what the first form would write
// Both fail on an AGPL or unknown license and on a component with no license text.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const CRATES_IO_SOURCE = 'registry+https://github.com/rust-lang/crates.io-index';
const MPL_LICENSE = /\bMPL-2\.0\b/;
const MPL_SOURCE_NOTICE = `\
These components are used as published, without changes. As section 3.2 of
MPL-2.0 asks, their source code is available: below each one are the published
package of that version and, when it declares one, its project repository.`;

// What cargo metadata cannot see: the files under app/vendor/, and the Microsoft
// loader that webview2-com-sys links statically into the program. That crate holds
// x64/WebView2LoaderStatic.lib from the Microsoft.Web.WebView2 package at this
// version, byte for byte, and the license is LICENSE.txt of that package. Move the
// version when webview2-com-sys moves.
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
  {
    name: 'WebView2 loader',
    version: '1.0.3800.47',
    license: 'BSD-3-Clause',
    licenseFile: 'tools/vendored-licenses/webview2-sdk-LICENSE',
  },
];

// Crates published without a license file, although their license must travel with
// them. These stand in for what the package folder lacks.
//   webview2-rs: github.com/wravery/webview2-rs, LICENSE at edc2caf8
//   alloc-no-stdlib: github.com/dropbox/rust-alloc-no-stdlib, LICENSE at 0a81fd69
//   MPL-2.0: the license text alone, because github.com/servo/stylo has no such file
export const CRATE_LICENSE_FILES = {
  'alloc-stdlib': 'tools/vendored-licenses/alloc-no-stdlib-LICENSE',
  selectors: 'tools/vendored-licenses/MPL-2.0-LICENSE',
  'webview2-com': 'tools/vendored-licenses/webview2-rs-LICENSE',
  'webview2-com-macros': 'tools/vendored-licenses/webview2-rs-LICENSE',
  'webview2-com-sys': 'tools/vendored-licenses/webview2-rs-LICENSE',
};

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

// The file is compared byte for byte on other machines, so its order cannot follow
// the locale of the machine that writes it.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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
    .sort((a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.version, b.version));
}

const toLf = (text) => text.replace(/\r\n/g, '\n');
const normalizeText = (text) => toLf(text).trim();

const RULE_WIDTH = 72;

// A declared license is not enough: MIT and BSD, for two, require their text and
// the copyright notice to ship with the program.
export function checkLicenseTexts(components) {
  const missing = components.filter(({ texts }) => !texts.some((text) => normalizeText(text)));
  if (missing.length > 0) {
    const lines = missing.map(({ name, version }) => `  ${name} ${version}`);
    throw new Error(
      `No license text, add one to CRATE_LICENSE_FILES in tools/licenses.mjs:\n${lines.join('\n')}`,
    );
  }
}

// The section that says where the source of the MPL-2.0 components is, or nothing
// without such a component. Only a package on crates.io has an address known here,
// and a wrong address is worse than a refusal.
function mplSourceSection(components) {
  const covered = components.filter(({ license }) => MPL_LICENSE.test(license));
  if (covered.length === 0) return [];
  const elsewhere = covered.filter(({ source }) => source !== CRATES_IO_SOURCE);
  if (elsewhere.length > 0) {
    const lines = elsewhere.map(({ name, version }) => `  ${name} ${version}`);
    throw new Error(`MPL-2.0 components from outside crates.io:\n${lines.join('\n')}`);
  }
  const entries = covered
    .map(({ name, version, repository }) =>
      [
        `${name} ${version}`,
        `  https://static.crates.io/crates/${name}/${name}-${version}.crate`,
        ...(repository ? [`  ${repository}`] : []),
      ].join('\n'),
    )
    .sort(byCodeUnit);
  const title = `Source code of the MPL-2.0 components\n${'-'.repeat(RULE_WIDTH)}`;
  return [`${title}\n${MPL_SOURCE_NOTICE}\n\n${entries.join('\n\n')}`];
}

// Most crates carry the same license text, so each distinct text appears once,
// after the list of components it belongs to.
export function renderLicenses(components) {
  checkLicenseTexts(components);
  const notice = mplSourceSection(components);
  const blocks = new Map();
  for (const component of components) {
    const body = component.texts.map(normalizeText).join('\n\n');
    blocks.set(body, [...(blocks.get(body) ?? []), component]);
  }
  const ordered = [...blocks].map(([body, owners]) => {
    const names = owners
      .map(({ name, version, license }) => `${name} ${version} (${license})`)
      .sort(byCodeUnit);
    return { names, body };
  });
  ordered.sort((a, b) => byCodeUnit(a.names[0], b.names[0]));
  const sections = ordered.map(
    ({ names, body }) => `${names.join('\n')}\n${'-'.repeat(RULE_WIDTH)}\n${body}`,
  );
  return `${[...notice, ...sections].join(`\n\n${'='.repeat(RULE_WIDTH)}\n\n`)}\n`;
}

// Git may hand out the file with CRLF line ends, which change nothing in it.
function checkLicensesFile(expected, file) {
  if (!existsSync(file)) {
    throw new Error(`${file} is missing, write it with: node tools/licenses.mjs`);
  }
  if (toLf(readFileSync(file, 'utf8')) !== expected) {
    throw new Error(`${file} is out of date, write it again with: node tools/licenses.mjs`);
  }
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

export function crateLicenseTexts(crate) {
  const { name, manifest_path: manifestPath, license_file: licenseFile } = crate;
  const folder = dirname(manifestPath);
  if (licenseFile) return [readFileSync(resolve(folder, licenseFile), 'utf8')];
  const texts = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((file) => readFileSync(join(folder, file), 'utf8'));
  const tracked = CRATE_LICENSE_FILES[name];
  return texts.length === 0 && tracked ? [readFileSync(join(REPO_ROOT, tracked), 'utf8')] : texts;
}

export function runLicenses(args, crates, outputFile = OUTPUT_FILE) {
  checkLicenses([...VENDORED, ...crates]);

  const components = [
    ...VENDORED.map((component) => ({
      ...component,
      texts: [readFileSync(join(REPO_ROOT, component.licenseFile), 'utf8')],
    })),
    ...crates.map((crate) => ({ ...crate, texts: crateLicenseTexts(crate) })),
  ];
  const text = renderLicenses(components);
  if (args.includes('--check')) checkLicensesFile(text, outputFile);
  else writeFileSync(outputFile, text);
}

if (isEntryPoint(import.meta.url)) {
  try {
    runLicenses(process.argv.slice(2), distributedCrates(cargoMetadata()));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
