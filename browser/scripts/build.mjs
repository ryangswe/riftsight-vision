// SPDX-License-Identifier: Apache-2.0
// Build the package into dist/ (which is not kept in the repository):
//
//   dist/cardvision.js   the public API (src/index.ts), one ES module, ONNX Runtime Web included
//   dist/worker.js       the analysis worker a session starts (src/worker.ts)
//   dist/remote-release.js  remote releases for an extension (src/remote/index.ts, experimental;
//                        not part of the public API): no ONNX Runtime, no browser globals
//   dist/node/verify-release.mjs, dist/node/package-zip.mjs  Node tools for an extension's release
//                        scripts (node/): check a release folder or URL with the runtime above,
//                        and write the store or release-page zip; platform node, ONNX Runtime external
//   dist/ort-wasm-*      ONNX Runtime Web's WebAssembly files and their loaders, copied from
//                        node_modules; the worker fetches the pair it needs from its own folder
//   dist/opencv.mjs,     OpenCV.js for the geometric stage, its WebAssembly and its license
//   dist/opencv_js.wasm, texts, copied from vendor/opencv/ when scripts/build-opencv.mjs has
//   dist/opencv.mjs.LEGAL.txt  written them; the worker imports them only when a geometric
//                        stage is asked for. Without them the stage reports itself off.
//   dist/THIRD-PARTY-NOTICES.txt  the full license texts of the bundled third-party code
//                        (scripts/notices.mjs); the *.LEGAL.txt files hold its short comments
//   dist/demo/           the demo page, and beside it the scoring page (score.html) and their
//                        style sheets (theme.css holds the colors, demo.css the rest)
//
// Run it with `npm run build`.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { NOTICES_NAME, noticesFor } from "./notices.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "demo"), { recursive: true });

const shared = { bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, sourcemap: false, logLevel: "warning", legalComments: "linked" };
await build({ ...shared, entryPoints: { cardvision: join(root, "src/index.ts"), worker: join(root, "src/worker.ts") }, outdir: dist });
await build({ ...shared, entryPoints: { "remote-release": join(root, "src/remote/index.ts") }, outdir: dist });
// Node tools for a product's release scripts. ONNX Runtime Web is left out of the bundles, as in
// scripts/agreement.mjs; verify-release imports the built cardvision.js beside it at run time.
await build({
  entryPoints: { "verify-release": join(root, "node/verify-release.ts"), "package-zip": join(root, "node/package-zip.ts") },
  outdir: join(dist, "node"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["onnxruntime-web", "onnxruntime-web/*"],
  logLevel: "warning",
});
await build({ ...shared, entryPoints: { demo: join(root, "demo/demo.ts"), score: join(root, "demo/score.ts") }, outdir: join(dist, "demo") });
for (const name of ["index.html", "score.html", "theme.css", "demo.css"]) copyFileSync(join(root, "demo", name), join(dist, "demo", name));
writeFileSync(join(dist, NOTICES_NAME), noticesFor(root));

// The package's entry point sits in its dist folder, beside the WebAssembly files.
const ortDist = dirname(createRequire(import.meta.url).resolve("onnxruntime-web"));
const wasm = readdirSync(ortDist).filter((name) => /^ort-wasm-.*\.(wasm|mjs)$/.test(name));
for (const name of wasm) copyFileSync(join(ortDist, name), join(dist, name));

// OpenCV.js for the geometric stage, beside the worker that imports it.
const opencvFiles = ["opencv.mjs", "opencv_js.wasm", "opencv.mjs.LEGAL.txt"];
const vendor = join(root, "vendor", "opencv");
const opencvMissing = opencvFiles.filter((name) => !existsSync(join(vendor, name)));
if (opencvMissing.length === 0) for (const name of opencvFiles) copyFileSync(join(vendor, name), join(dist, name));

const size = (name) => `${(statSync(join(dist, name)).size / 1024).toFixed(0)} KB`;
console.log(`dist/cardvision.js ${size("cardvision.js")}, dist/worker.js ${size("worker.js")}, dist/remote-release.js ${size("remote-release.js")}, dist/demo/demo.js ${size("demo/demo.js")}, dist/demo/score.js ${size("demo/score.js")}, ${wasm.length} ONNX Runtime files copied`);
if (opencvMissing.length === 0) console.log(`OpenCV.js copied: dist/opencv.mjs, dist/opencv_js.wasm ${size("opencv_js.wasm")}, dist/opencv.mjs.LEGAL.txt`);
else {
  console.log(
    `OpenCV.js NOT copied: vendor/opencv/ lacks ${opencvMissing.join(", ")} (build it with node scripts/build-opencv.mjs --work FOLDER). ` +
      "This build runs without the geometric stage: asked for, it reports itself off.",
  );
}
