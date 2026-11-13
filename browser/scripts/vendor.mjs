// SPDX-License-Identifier: Apache-2.0
// Vendor the built runtime into a product's folder, all from this checkout's HEAD:
//
//   npm run build && npm run vendor -- --into ../my-product/vendor/cardvision-browser
//       [--commit SHA] [--no-opencv] [--no-ort-wasm] [--node-tools] [--unmanaged RULE]... [--adopt]
//
// --commit must name HEAD (or be left out): the build in dist/ is of HEAD, and the tool refuses a
// dist/ whose build-info.json names another commit or a tree with changes. --into is relative to the
// folder you ran npm in. See scripts/vendor-lib.mjs.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DEFAULT_UNMANAGED, vendorInto } from "./vendor-lib.mjs";

const USAGE =
  "Usage: npm run vendor -- --into FOLDER [--commit SHA] [--no-opencv] [--no-ort-wasm] [--node-tools] [--unmanaged RULE]... [--adopt]\n" +
  "  --into FOLDER     the product's vendor folder, relative to where you ran npm; replaced whole or not at all\n" +
  "  --commit SHA      the toolkit commit; must be HEAD of this checkout (default)\n" +
  "  --no-opencv       leave OpenCV.js out (no geometric stage)\n" +
  "  --no-ort-wasm     leave ONNX Runtime's WebAssembly files out; the manifest still names the version and files to ship\n" +
  "  --node-tools      add node/verify-release.mjs, node/package-zip.mjs, node/store-upload.mjs\n" +
  "  --unmanaged RULE  what the product owns in FOLDER: a folder (\"notes/\") or one exact file name (\"README.md\"); repeatable\n" +
  "  --adopt           replace a non-empty folder that has no cardvision-vendor.json (a hand-vendored runtime, VENDOR.json)\n" +
  "  The tool refuses a folder that holds other files, a symbolic link, and a folder inside this checkout.";

let values;
try {
  ({ values } = parseArgs({
    options: {
      into: { type: "string" },
      commit: { type: "string" },
      "no-opencv": { type: "boolean", default: false },
      "no-ort-wasm": { type: "boolean", default: false },
      "node-tools": { type: "boolean", default: false },
      unmanaged: { type: "string", multiple: true },
      adopt: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  }));
} catch (e) {
  console.error(`${e.message}\n\n${USAGE}`);
  process.exit(2);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.into) {
  console.error(`--into is required\n\n${USAGE}`);
  process.exit(2);
}

const here = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(here, "..");
// npm runs scripts in browser/; the caller's folder is INIT_CWD.
const callerDir = process.env.INIT_CWD || process.cwd();
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
try {
  const head = git("rev-parse", "HEAD");
  if (values.commit && git("rev-parse", `${values.commit}^{commit}`) !== head) {
    throw new Error(`--commit ${values.commit} is not HEAD (${head.slice(0, 12)}): check that commit out and run npm run build there; the tool does not rebuild`);
  }
  if (git("status", "--porcelain")) throw new Error("the toolkit tree has uncommitted changes: commit or stash them, rebuild, and run again");
  const dist = join(here, "dist");
  const infoPath = join(dist, "build-info.json");
  if (!existsSync(infoPath)) throw new Error("dist/build-info.json is missing: run npm run build in browser/ first");
  const info = JSON.parse(readFileSync(infoPath, "utf-8"));
  if (info.commit !== head || info.dirty) throw new Error(`dist/ was built from ${info.commit?.slice(0, 12)}${info.dirty ? " with changes" : ""}, not clean HEAD ${head.slice(0, 12)}: run npm run build again`);
  const into = resolve(callerDir, values.into);
  const manifest = vendorInto({
    root,
    dist,
    into,
    commit: head,
    opencv: !values["no-opencv"],
    ortWasm: !values["no-ort-wasm"],
    nodeTools: values["node-tools"],
    unmanaged: values.unmanaged?.length ? values.unmanaged : DEFAULT_UNMANAGED,
    adopt: values.adopt,
    warn: (message) => console.warn(`warning: ${message}`),
  });
  console.log(`vendored ${Object.keys(manifest.files).length} files from toolkit ${manifest.toolkit.version} at ${head.slice(0, 12)} into ${into}`);
} catch (e) {
  console.error(`vendor failed: ${e.message}`);
  process.exit(1);
}
