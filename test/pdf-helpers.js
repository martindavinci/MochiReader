// SPDX-License-Identifier: GPL-3.0-or-later
// pdf.js for the tests: the same version as app/vendor/pdfjs, in the build made for Node.
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export { pdfjs };

/** The bytes of a PDF in test/fixtures. */
export const fixtureBytes = (name) => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));

/** A fixture opened as the app opens a PDF: no WebAssembly, no eval. */
export function openFixture(name) {
  return pdfjs.getDocument({ data: fixtureBytes(name), useWasm: false, isEvalSupported: false, verbosity: 0 }).promise;
}
