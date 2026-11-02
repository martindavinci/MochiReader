// SPDX-License-Identifier: GPL-3.0-or-later
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Whether the module at `moduleUrl` is the script node was started with. Node
// resolves links in a module's URL but not in argv[1], so the same must be done to
// argv[1] or a script reached through a junction never runs and still exits 0.
export function isEntryPoint(moduleUrl) {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === moduleUrl;
  } catch {
    return false; // argv[1] is not a file when the code runs under `node -e`
  }
}
