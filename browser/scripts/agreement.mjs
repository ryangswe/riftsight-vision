// SPDX-License-Identifier: Apache-2.0
// Bundle node/agreement.ts and run it: `node scripts/agreement.mjs [--runtime all|wasm] JOB.json`.
// ONNX Runtime Web is left out of the bundle, so that under Node it finds its own `.wasm` files.
// `--runtime wasm` imports ONNX Runtime's WebAssembly-only entry in place of the default one, as
// the dist/wasm/ build does (scripts/ort-entry.mjs).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { pluginsFor } from "./ort-entry.mjs";

const args = process.argv.slice(2);
let runtime = "all";
if (args[0] === "--runtime") {
  runtime = args[1];
  args.splice(0, 2);
}
const root = fileURLToPath(new URL("..", import.meta.url));
const outfile = `${root}dist/agreement${runtime === "all" ? "" : `-${runtime}`}.mjs`;
await build({
  entryPoints: [`${root}node/agreement.ts`],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["onnxruntime-web", "onnxruntime-web/*"],
  plugins: pluginsFor(runtime),
  logLevel: "warning",
});
const run = spawnSync(process.execPath, [outfile, ...args], { stdio: "inherit" });
process.exit(run.status ?? 1);
