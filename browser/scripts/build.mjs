// SPDX-License-Identifier: Apache-2.0
// Build the package into dist/ (which is not kept in the repository):
//
//   dist/cardvision.js   the public API (src/index.ts), one ES module, ONNX Runtime Web included
//   dist/worker.js       the analysis worker a session starts (src/worker.ts)
//   dist/remote-release.js  remote releases for an extension (src/remote/index.ts, experimental;
//                        not part of the public API): no ONNX Runtime, no browser globals
//   dist/compute-session.js, dist/page-capture.js  experimental entries an extension vendors
//                        (src/compute-session.ts, src/page-capture-entry.ts): no ONNX Runtime,
//                        no WebAssembly, no OpenCV; test/bundle-purity.test.ts checks it
//   dist/host-content.js, dist/host-compute.js, dist/host-settings.js  the shared hover host, one
//                        self-contained file per realm (src/host/*-entry.ts, experimental; not part
//                        of the public API): same purity as the two entries above, and no splitting
//   dist/node/verify-release.mjs, package-zip.mjs, store-upload.mjs, realm-check.mjs, release-decide.mjs  Node tools for an extension's release
//                        scripts (node/): check a release folder or URL with the runtime above,
//                        write the store or release-page zip, and count the realm marks in a
//                        product build (one runtime per realm); platform node, ONNX Runtime external
//   dist/ort-wasm-*      ONNX Runtime Web's WebAssembly files and their loaders, copied from
//                        node_modules; the worker fetches the pair it needs from its own folder
//   dist/wasm/           the same cardvision.js and worker.js built on ONNX Runtime's WebAssembly-only
//                        entry (scripts/ort-entry.mjs), with their license texts and the one
//                        ONNX Runtime file they load, about half the size of the default's: for a
//                        page whose host has a per-file limit (npm run vendor -- --runtime wasm). Models
//                        run on WebAssembly only.
//   dist/opencv.mjs,     OpenCV.js for the geometric stage, its WebAssembly and its license
//   dist/opencv_js.wasm, texts, copied from vendor/opencv/ when scripts/build-opencv.mjs has
//   dist/opencv.mjs.LEGAL.txt  written them; the worker imports them only when a geometric
//                        stage is asked for. Without them the stage reports itself off.
//   dist/types/, dist/*.d.ts  declarations of src/ and the entry shims for a product's type check
//   dist/build-info.json  the commit of this build and whether the tree had changes; scripts/vendor.mjs
//                        refuses a build that is not of a clean HEAD
//   dist/THIRD-PARTY-NOTICES.txt  the full license texts of the bundled third-party code
//                        (scripts/notices.mjs); the *.LEGAL.txt files hold its short comments
//   dist/demo/           the demo page, and beside it the scoring page (score.html) and their
//                        style sheets (theme.css holds the colors, demo.css the rest)
//
// Run it with `npm run build`.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { buildInfoOf } from "./build-info.mjs";
import { NOTICES_NAME, noticesFor } from "./notices.mjs";
import { pluginsFor } from "./ort-entry.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "demo"), { recursive: true });

const shared = { bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, sourcemap: false, logLevel: "warning", legalComments: "linked" };
await build({ ...shared, entryPoints: { cardvision: join(root, "src/index.ts"), worker: join(root, "src/worker.ts") }, outdir: dist });
await build({ ...shared, entryPoints: { "remote-release": join(root, "src/remote/index.ts") }, outdir: dist });
await build({
  ...shared,
  entryPoints: { "compute-session": join(root, "src/compute-session.ts"), "page-capture": join(root, "src/page-capture-entry.ts") },
  outdir: dist,
});
// The shared hover host: one self-contained file per realm. Each build() call bundles its entries
// independently, so the outputs above do not change while no module in their import graphs does
// (scripts/runtime-hashes.mjs compares them between two builds).
await build({
  ...shared,
  entryPoints: {
    "host-content": join(root, "src/host/content-entry.ts"),
    "host-compute": join(root, "src/host/compute-entry.ts"),
    "host-settings": join(root, "src/host/settings-entry.ts"),
  },
  outdir: dist,
});
// Node tools for a product's release scripts. ONNX Runtime Web is left out of the bundles, as in
// scripts/agreement.mjs; verify-release imports the built cardvision.js beside it at run time.
await build({
  entryPoints: {
    "verify-release": join(root, "node/verify-release.ts"),
    "package-zip": join(root, "node/package-zip.ts"),
    "store-upload": join(root, "node/store-upload.ts"),
    "realm-check": join(root, "node/realm-check.ts"),
    "release-decide": join(root, "node/release-decide.ts"),
  },
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

// The WebAssembly-only runtime: the public API and the worker again, in their own folder, with the
// ONNX Runtime files that worker names beside it. A separate build() call, so the files above do not
// change (scripts/runtime-hashes.mjs). The ONNX Runtime files the default worker loads must not be among them.
const wasmDist = join(dist, "wasm");
await build({ ...shared, entryPoints: { cardvision: join(root, "src/index.ts"), worker: join(root, "src/worker.ts") }, outdir: wasmDist, plugins: pluginsFor("wasm") });
const ortNamed = (folder) => [...new Set(readFileSync(join(folder, "worker.js"), "utf-8").match(/ort-wasm-[a-z-]+(?:\.[a-z]+)*\.(?:wasm|mjs)/g) ?? [])];
const wasmOrt = ortNamed(wasmDist);
const overlap = wasmOrt.filter((name) => ortNamed(dist).includes(name));
if (wasmOrt.length === 0 || overlap.length > 0) throw new Error(`dist/wasm/worker.js should name its own ONNX Runtime file, but names ${wasmOrt.join(", ") || "none"}`);
for (const name of wasmOrt) copyFileSync(join(ortDist, name), join(wasmDist, name));

// OpenCV.js for the geometric stage, beside the worker that imports it.
const opencvFiles = ["opencv.mjs", "opencv_js.wasm", "opencv.mjs.LEGAL.txt"];
const vendor = join(root, "vendor", "opencv");
const opencvMissing = opencvFiles.filter((name) => !existsSync(join(vendor, name)));
if (opencvMissing.length === 0) for (const name of opencvFiles) copyFileSync(join(vendor, name), join(dist, name));

// TypeScript declarations of the sources a product vendors, with the entry shims its imports use:
// dist/types/ and dist/{cardvision,compute-session,page-capture,remote-release,host-*}.d.ts. They are part of
// the vendored set (scripts/vendor.mjs), so a product's type check sees the same commit as its runtime.
{
  // The config lives in a temporary folder, not the tracked tree, so a killed build leaves nothing
  // behind; its paths are absolute.
  const configDir = mkdtempSync(join(tmpdir(), "cardvision-types-"));
  const config = join(configDir, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(root, "tsconfig.json"),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: join(root, "src"),
        outDir: join(dist, "types"),
        typeRoots: [join(root, "node_modules", "@types"), join(root, "node_modules")],
        types: ["@webgpu/types"],
      },
      include: [join(root, "src")],
    }),
  );
  try {
    execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", config], { cwd: root, stdio: "inherit" });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
  const shims = {
    cardvision: "index",
    "compute-session": "compute-session",
    "page-capture": "page-capture-entry",
    "remote-release": "remote/index",
    "host-content": "host/content-entry",
    "host-compute": "host/compute-entry",
    "host-settings": "host/settings-entry",
  };
  for (const [name, target] of Object.entries(shims)) {
    writeFileSync(join(dist, `${name}.d.ts`), `// Declarations of the ${name} module, generated by the toolkit build.\nexport * from "./types/${target}.js";\n`);
  }
}

// Which commit this build is of, so a product's vendoring can refuse a stale or modified build.
const buildInfo = buildInfoOf(root);
writeFileSync(join(dist, "build-info.json"), `${JSON.stringify(buildInfo)}\n`);

const size = (name) => `${(statSync(join(dist, name)).size / 1024).toFixed(0)} KB`;
console.log(`dist/cardvision.js ${size("cardvision.js")}, dist/worker.js ${size("worker.js")}, dist/remote-release.js ${size("remote-release.js")}, dist/demo/demo.js ${size("demo/demo.js")}, dist/demo/score.js ${size("demo/score.js")}, ${wasm.length} ONNX Runtime files copied`);
console.log(`dist/wasm/: cardvision.js ${size("wasm/cardvision.js")}, worker.js ${size("wasm/worker.js")}, ${wasmOrt.map((name) => `${name} ${size(`wasm/${name}`)}`).join(", ")}`);
if (opencvMissing.length === 0) console.log(`OpenCV.js copied: dist/opencv.mjs, dist/opencv_js.wasm ${size("opencv_js.wasm")}, dist/opencv.mjs.LEGAL.txt`);
else {
  console.log(
    `OpenCV.js NOT copied: vendor/opencv/ lacks ${opencvMissing.join(", ")} (build it with node scripts/build-opencv.mjs --work FOLDER). ` +
      "This build runs without the geometric stage: asked for, it reports itself off.",
  );
}
