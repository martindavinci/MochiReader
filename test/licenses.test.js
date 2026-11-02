// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  VENDORED,
  checkLicenses,
  distributedCrates,
  renderLicenses,
} from '../tools/licenses.mjs';

const accepts = (license) => assert.doesNotThrow(() => checkLicenses([{ name: 'c', license }]));
const refuses = (license) => assert.throws(() => checkLicenses([{ name: 'c', license }]));

test('AGPL and unknown licenses are refused', () => {
  assert.throws(() => checkLicenses([{ name: 'x', license: 'AGPL-3.0' }]));
  assert.throws(() => checkLicenses([{ name: 'y', license: null }]));
  assert.doesNotThrow(() => checkLicenses([{ name: 'z', license: 'MIT OR Apache-2.0' }]));
});

test('every refused component is named in the error', () => {
  assert.throws(
    () =>
      checkLicenses([
        { name: 'good', license: 'MIT' },
        { name: 'bad-one', license: 'AGPL-3.0-only' },
        { name: 'bad-two', license: 'Proprietary' },
      ]),
    (error) =>
      error.message.includes('bad-one') &&
      error.message.includes('bad-two') &&
      !error.message.includes('good'),
  );
});

test('an AGPL choice is refused even next to an allowed license', () => {
  refuses('AGPL-3.0-or-later OR MIT');
  refuses('MIT OR agpl-3.0');
});

test('licenses that cannot join a GPL-3.0-or-later work are refused', () => {
  refuses('GPL-2.0-only');
  refuses('SSPL-1.0');
});

test('license expressions follow their operators', () => {
  accepts('(MIT OR Apache-2.0) AND Unicode-3.0');
  accepts('MIT/Apache-2.0');
  accepts('Apache-2.0 WITH LLVM-exception OR MIT');
  accepts('Unknown-1.0 OR MIT');
  refuses('Unknown-1.0 AND MIT');
  refuses('(MIT OR Unknown-1.0) AND Unknown-2.0');
  refuses('Apache-2.0 WITH Unknown-exception');
});

test('malformed license expressions are refused', () => {
  refuses('');
  refuses('MIT OR');
  refuses('(MIT');
  refuses('MIT Apache-2.0');
});

test('the vendored list is allowed and its license files exist', () => {
  assert.doesNotThrow(() => checkLicenses(VENDORED));
  assert.deepEqual(
    VENDORED.map(({ name }) => name),
    ['foliate-js', 'zip.js', 'fflate'],
  );
  for (const { licenseFile } of VENDORED) {
    assert.ok(existsSync(join(REPO_ROOT, licenseFile)), licenseFile);
  }
});

test('only normal dependencies reachable from the app are distributed', () => {
  const pkg = (name, license) => ({ id: name, name, version: '1.0.0', license });
  const normal = [{ kind: null, target: null }];
  const metadata = {
    packages: [
      pkg('app', 'GPL-3.0-or-later'),
      pkg('runtime', 'MIT'),
      pkg('transitive', 'ISC'),
      pkg('dev-only', 'AGPL-3.0'),
      pkg('build-only', 'AGPL-3.0'),
      pkg('both', 'Zlib'),
      pkg('unreachable', 'AGPL-3.0'),
    ],
    workspace_members: ['app'],
    resolve: {
      root: 'app',
      nodes: [
        {
          id: 'app',
          deps: [
            { pkg: 'runtime', dep_kinds: normal },
            { pkg: 'dev-only', dep_kinds: [{ kind: 'dev', target: null }] },
            { pkg: 'build-only', dep_kinds: [{ kind: 'build', target: null }] },
            { pkg: 'both', dep_kinds: [{ kind: 'dev', target: null }, ...normal] },
          ],
        },
        { id: 'runtime', deps: [{ pkg: 'transitive', dep_kinds: normal }] },
        { id: 'transitive', deps: [] },
        { id: 'both', deps: [] },
        { id: 'dev-only', deps: [{ pkg: 'unreachable', dep_kinds: normal }] },
        { id: 'build-only', deps: [] },
        { id: 'unreachable', deps: [] },
      ],
    },
  };
  assert.deepEqual(
    distributedCrates(metadata).map(({ name }) => name),
    ['both', 'runtime', 'transitive'],
  );
});

test('components with the same license text share one block', () => {
  const text = renderLicenses([
    { name: 'b', version: '2.0.0', license: 'MIT', texts: ['same text'] },
    { name: 'a', version: '1.0.0', license: 'MIT', texts: ['same text\r\n'] },
    { name: 'c', version: '3.0.0', license: 'ISC', texts: [] },
  ]);
  assert.equal(text.match(/same text/g).length, 1);
  assert.ok(text.indexOf('a 1.0.0 (MIT)') < text.indexOf('b 2.0.0 (MIT)'));
  assert.match(text, /c 3\.0\.0 \(ISC\)\n-+\nNo license text ships with this component/);
  assert.ok(!text.includes('\r'));
});
