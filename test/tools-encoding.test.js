import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page,
// so "è" in a UTF-8 script reaches the program as "Ã¨".
test("PowerShell scripts stay ASCII, whatever code page reads them", () => {
  const tools = join(import.meta.dirname, "..", "tools");
  const offending = readdirSync(tools)
    .filter((name) => name.endsWith(".ps1"))
    .flatMap((name) =>
      readFileSync(join(tools, name), "utf8")
        .split("\n")
        .flatMap((line, index) => (/[^\x00-\x7F]/.test(line) ? [`${name}:${index + 1}`] : [])),
    );
  assert.deepEqual(offending, []);
});
