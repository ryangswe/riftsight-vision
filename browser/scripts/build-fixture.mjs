// SPDX-License-Identifier: Apache-2.0
// Build the toy fixture extension (fixture-extension/) into an unpacked folder, against the BUILT
// host files in dist/ (run `npm run build` first):
//
//   node scripts/build-fixture.mjs --release-dir DEMO/release --art-dir DEMO/art --out FOLDER
//        [--idle-unload-ms N] [--version X.Y.Z]
//
// DEMO is the folder `python tests/test_browser_fixtures.py --demo DEMO` writes (README, "Write the
// toy release"); it holds the toy release and the toy game's card pictures. The fixture imports
// only the host's three public files, bundled in: the content script as one IIFE, the pages and the
// background as ES modules. The analysis worker and ONNX Runtime's WebAssembly files are copied to
// runtime/, the release to release/ and the pictures to art/. With --idle-unload-ms the compute page
// unloads after that many idle milliseconds, for the harness's idle checks (a second build).
// --version sets the manifest's version (default 0.0.1): the rollback check needs its two builds to
// differ in it. --out is required and is removed and written again: give a folder outside the
// checkout, so that no build output lands in the tree.

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const fixture = join(root, "fixture-extension");

const { values } = parseArgs({
  options: { "release-dir": { type: "string" }, "art-dir": { type: "string" }, out: { type: "string" }, "idle-unload-ms": { type: "string" }, version: { type: "string" } },
});
const fail = (message) => {
  console.error(`build-fixture: ${message}`);
  process.exit(2);
};
if (!values["release-dir"] || !values["art-dir"] || !values.out) fail("usage: node scripts/build-fixture.mjs --release-dir DEMO/release --art-dir DEMO/art --out FOLDER [--idle-unload-ms N] [--version X.Y.Z]");
if (values.version !== undefined && !/^\d+\.\d+\.\d+$/.test(values.version)) fail(`--version is three whole numbers with dots (got "${values.version}")`);
const idleUnloadMs = values["idle-unload-ms"] === undefined ? null : Number(values["idle-unload-ms"]);
if (idleUnloadMs !== null && !(Number.isInteger(idleUnloadMs) && idleUnloadMs > 0)) fail(`--idle-unload-ms is a positive whole number of milliseconds (got "${values["idle-unload-ms"]}")`);
const out = resolve(values.out);
// --out is removed before the build writes it: never the toolkit's own folders or a folder above them.
if ([root, fixture, dist].some((own) => own === out || own.startsWith(`${out}/`))) fail(`--out ${out} holds the toolkit's own files: give a folder of its own`);
const releaseDir = resolve(values["release-dir"]);
const artDir = resolve(values["art-dir"]);

const hosts = ["host-content", "host-compute", "host-settings"];
const needed = [...hosts.map((name) => `${name}.js`), ...hosts.map((name) => `${name}.d.ts`), "worker.js"];
const missing = needed.filter((name) => !existsSync(join(dist, name)));
if (missing.length > 0) fail(`dist/ lacks ${missing.join(", ")}: run npm run build first`);
if (!existsSync(join(releaseDir, "release.json"))) fail(`no release.json in ${releaseDir}`);
if (!existsSync(artDir)) fail(`no card pictures at ${artDir}`);

const config = JSON.parse(readFileSync(join(fixture, "config.json"), "utf-8"));
const manifest = JSON.parse(readFileSync(join(fixture, "manifest.json"), "utf-8"));
const settingsHost = new URL(config.settingsUrl).origin;
const csp = manifest.content_security_policy?.extension_pages ?? "";
if (!csp.includes(`connect-src 'self' ${settingsHost};`) && !csp.includes(`connect-src 'self' ${settingsHost}`)) fail(`manifest.json's connect-src does not name the settings host ${settingsHost}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The host files are the fixture's only imports of the toolkit, by their built paths.
const alias = Object.fromEntries(hosts.map((name) => [`@cardvision/${name}`, join(dist, `${name}.js`)]));
const shared = {
  bundle: true,
  platform: "browser",
  target: "es2022",
  minify: false,
  sourcemap: false,
  logLevel: "warning",
  alias,
  define: { __SETTINGS_URL__: JSON.stringify(config.settingsUrl), __IDLE_UNLOAD_MS__: JSON.stringify(idleUnloadMs) },
};
const src = (name) => join(fixture, "src", name);
await build({ ...shared, format: "iife", entryPoints: { content: src("content.ts") }, outdir: out });
await build({ ...shared, format: "esm", entryPoints: { compute: src("compute.ts"), view: src("view.ts"), background: src("background.ts") }, outdir: out });

if (values.version !== undefined) manifest.version = values.version;
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const page of ["compute.html", "view.html", "wake.html"]) copyFileSync(join(fixture, page), join(out, page));

// The analysis worker, beside the WebAssembly files it fetches from its own folder.
mkdirSync(join(out, "runtime"));
const runtime = readdirSync(dist).filter((name) => name === "worker.js" || name === "worker.js.LEGAL.txt" || /^ort-wasm-.*\.(wasm|mjs)$/.test(name));
for (const name of runtime) copyFileSync(join(dist, name), join(out, "runtime", name));
cpSync(releaseDir, join(out, "release"), { recursive: true });
cpSync(artDir, join(out, "art"), { recursive: true });

console.log(`fixture extension: ${out}${idleUnloadMs === null ? "" : ` (idle unload after ${idleUnloadMs} ms)`}; ${runtime.length} runtime files`);
