// SPDX-License-Identifier: Apache-2.0
// The slow-clock report: the runtime's look scheduling on a virtual clock, with a stand-in
// worker whose analysis time is a parameter. It prints tables of how long a viewer waits for a
// name, how old the answer is, and how long a name is missing, for today's rule and two
// candidates, over a range of analysis times.
//
//   npm run slow-clock
//
// It is a model of the policy, not a browser measurement: the times a real computer takes are
// inputs. It needs no browser and no network, and two runs print the same text. The harness is
// test/support/slow-clock.ts; this script bundles it (the tests import it as TypeScript) and
// prints the report.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const entry = fileURLToPath(new URL("../test/support/slow-clock.ts", import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), "slow-clock-"));
try {
  const built = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
  const file = join(outDir, "slow-clock.mjs");
  writeFileSync(file, built.outputFiles[0].text);
  const { renderReport } = await import(pathToFileURL(file).href);
  process.stdout.write(renderReport());
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
