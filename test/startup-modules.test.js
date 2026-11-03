// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = new URL('../app/', import.meta.url);
const ENTRY_POINT = 'ui/shell.js';
// Only what is imported at the top of a module loads with it. `import()` waits until it is needed.
const STATIC_IMPORT = /^(?:import|export)\s[^;'"]*?['"](\.[^'"]+)['"]/gm;
// What only reading aloud or a book needs. Each file of the first frame adds to the start of the app.
const NOT_AT_START = ['speech/lang-profiles.js', 'readers/epub.js', 'vendor/foliate/view.js'];

function modulesFrom(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const url = new URL(file, APP);
    for (const [, target] of readFileSync(url, 'utf8').matchAll(STATIC_IMPORT)) {
      visit(new URL(target, url).href.slice(APP.href.length));
    }
  };
  visit(entry);
  return seen;
}

test('the search finds what a module imports, through other modules too', () => {
  assert.ok(modulesFrom('speech/lang.js').has('speech/lang-profiles.js'));
  const atStart = modulesFrom(ENTRY_POINT);
  assert.ok(atStart.has('core/i18n.js'));
  assert.ok(atStart.has('lang/it.js'));
  assert.ok(atStart.has('core/position.js'));
});

test('the first frame loads nothing that only reading aloud or a book needs', () => {
  const atStart = modulesFrom(ENTRY_POINT);
  for (const file of NOT_AT_START) assert.ok(!atStart.has(file), `${file} loads at start`);
});
