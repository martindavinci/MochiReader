// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileName, isSupported, OPENABLE_EXTENSIONS } from '../app/core/paths.js';

test('the name is the last segment of either slash', () => {
  assert.equal(fileName('C:\\x\\Lunaris Essentials_ è, vale.md'), 'Lunaris Essentials_ è, vale.md');
  assert.equal(fileName('C:/x/a.epub'), 'a.epub');
  assert.equal(fileName('\\\\server\\share\\a.md'), 'a.md');
  assert.equal(fileName('a.md'), 'a.md');
});

test('only Markdown and EPUB files can be opened, in any case', () => {
  for (const ok of ['C:\\x\\a.md', 'C:\\x\\a.MD', 'C:\\x\\a.markdown', 'C:\\x\\a.Epub', 'a b, è.md']) {
    assert.equal(isSupported(ok), true, ok);
  }
  for (const no of ['C:\\x\\a.txt', 'C:\\x\\a.md.txt', 'C:\\x\\md', 'C:\\x.md\\a', '.', '']) {
    assert.equal(isSupported(no), false, no);
  }
});

test('the extensions the file dialog offers are the ones that open', () => {
  assert.deepEqual(OPENABLE_EXTENSIONS, ['md', 'markdown', 'epub']);
  for (const extension of OPENABLE_EXTENSIONS) assert.ok(isSupported(`C:\\x\\a.${extension.toUpperCase()}`), extension);
  assert.equal(isSupported('C:\\x\\amd'), false);
});
