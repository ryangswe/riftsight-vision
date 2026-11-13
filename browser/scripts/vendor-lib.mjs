// SPDX-License-Identifier: Apache-2.0
// Vendoring a built runtime into a product, and checking it. One manifest, one toolkit commit.
//
// vendorInto() copies the files a product ships from a toolkit build (dist/, written by
// scripts/build.mjs) into one folder, with the toolkit's license files, and writes
// cardvision-vendor.json beside them: the toolkit version, the commit, and every file's size and
// SHA-256. The folder is staged next to the target and swapped in by rename, so a run that fails
// leaves the old folder, manifest included, as it was.
//
// checkVendor() reads the manifest and reports what is wrong, as a list of messages: a file that
// changed, is missing or is extra; a file that does not match the build of the manifest's commit
// (when that build is at hand); OpenCV.js that does not match the toolkit's lock; a missing
// license file. Nothing here uses the network.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

export const MANIFEST = "cardvision-vendor.json";
export const SPEC_FILE = "hover-spec.json";
export const OPENCV_FILES = ["opencv.mjs", "opencv_js.wasm", "opencv.mjs.LEGAL.txt"];
export const LICENSE_FILES = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.txt"];
/** The runtime files every product gets, beside the worker (worker-relative paths: one flat folder). */
export const RUNTIME_FILES = [
  "cardvision.js",
  "worker.js",
  "compute-session.js",
  "page-capture.js",
  "remote-release.js",
  "cardvision.js.LEGAL.txt",
  "worker.js.LEGAL.txt",
  "compute-session.js.LEGAL.txt",
  "page-capture.js.LEGAL.txt",
  "remote-release.js.LEGAL.txt",
];
export const NODE_TOOLS = ["node/verify-release.mjs", "node/package-zip.mjs", "node/store-upload.mjs"];
/** Left alone by the tool: a name ending in "/" is a folder, one starting with "." is a suffix. */
export const DEFAULT_UNMANAGED = ["types/", ".d.ts"];

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf-8"));

/** True when the folder-relative path is one the tool does not manage. */
export function isUnmanaged(path, unmanaged) {
  return unmanaged.some((rule) => (rule.endsWith("/") ? path.startsWith(rule) : rule.startsWith(".") ? path.endsWith(rule) : path === rule));
}

/** Every file under `dir` (forward slashes), sorted, but the manifest, the tool's own staging and hidden names. */
export function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map((n) => String(n).split(sep).join("/"))
    .filter((n) => n !== MANIFEST && !n.split("/").some((part) => part.startsWith(".")) && !statSync(join(dir, n)).isDirectory())
    .sort();
}

/** The ONNX Runtime files the built worker loads, by name. */
export function ortFilesOf(dist) {
  const worker = readFileSync(join(dist, "worker.js"), "utf-8");
  return [...new Set(worker.match(/ort-wasm-[a-z-]+(?:\.[a-z]+)*\.(?:wasm|mjs)/g) ?? [])].sort();
}

/** The version in pyproject.toml, the toolkit's one version. */
export function toolkitVersion(root) {
  const m = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, "pyproject.toml"), "utf-8"));
  if (!m) throw new Error("pyproject.toml has no version");
  return m[1];
}

/** What the lock pins for OpenCV, in the form the manifest keeps. */
function lockSummary(lock) {
  return { tag: lock.opencv.tag, commit: lock.opencv.commit, emsdk: lock.emsdk.tag, files: lock.built.files };
}

/**
 * Copy the runtime from a toolkit build into `into`.
 *   root       the toolkit checkout (holds browser/opencv.lock.json, docs/, LICENSE, NOTICE, pyproject.toml)
 *   dist       the build of that commit (browser/dist)
 *   commit     the toolkit commit the build was made from
 *   opencv     false to leave OpenCV.js out (a product with no geometric stage)
 *   ortWasm    false to leave ONNX Runtime's WebAssembly files out (a product that copies its own)
 *   nodeTools  true to add dist/node/*.mjs
 *   unmanaged  rules for what the product keeps in the folder itself (types, say); kept across a run
 *   hooks      test seams: { beforeSwap(stage) }
 */
export function vendorInto({ root, dist, into, commit, opencv = true, ortWasm = true, nodeTools = false, unmanaged = DEFAULT_UNMANAGED, hooks = {} }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`commit must be a full 40-character SHA, not "${commit}"`);
  const lockPath = join(root, "browser", "opencv.lock.json");
  const lock = readJson(lockPath);
  const from = []; // [folder-relative name, source path]
  const need = (name, source) => {
    if (!existsSync(source)) throw new Error(`${source} is missing (build the toolkit first: npm run build in browser/)`);
    from.push([name, source]);
  };
  for (const name of RUNTIME_FILES) {
    // The LEGAL files exist only when the bundle had license comments.
    if (name.endsWith(".LEGAL.txt") && !existsSync(join(dist, name))) continue;
    need(name, join(dist, name));
  }
  need("LICENSE", join(root, "LICENSE"));
  need("NOTICE", join(root, "NOTICE"));
  need("THIRD-PARTY-NOTICES.txt", join(dist, "THIRD-PARTY-NOTICES.txt"));
  if (ortWasm) {
    const ort = ortFilesOf(dist);
    if (ort.length === 0) throw new Error("the built worker names no ONNX Runtime file");
    for (const name of ort) need(name, join(dist, name));
  }
  if (nodeTools) for (const name of NODE_TOOLS) need(name, join(dist, name));
  let opencvPart = null;
  if (opencv) {
    for (const name of OPENCV_FILES) {
      need(name, join(dist, name));
      const pinned = lock.built.files[name];
      if (pinned) {
        const bytes = readFileSync(join(dist, name));
        if (sha256(bytes) !== pinned.sha256 || bytes.length !== pinned.bytes) throw new Error(`${name} in the build does not match opencv.lock.json`);
      }
    }
    opencvPart = { ...lockSummary(lock), lockSha256: sha256(readFileSync(lockPath)) };
  }
  const specPath = join(root, "docs", "hover-spec.json");
  if (existsSync(specPath)) from.push([SPEC_FILE, specPath]);

  mkdirSync(dirname(into), { recursive: true });
  const stage = mkdtempSync(join(dirname(into), `.${basename(into)}-stage-`));
  const old = `${stage}-old`;
  let swapped = false;
  try {
    const files = {};
    for (const [name, source] of from) {
      const bytes = readFileSync(source);
      mkdirSync(dirname(join(stage, name)), { recursive: true });
      writeFileSync(join(stage, name), bytes, { mode: 0o644 });
      files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
    }
    // What the product keeps in the folder itself goes across.
    if (existsSync(into)) {
      for (const name of filesUnder(into)) {
        if (isUnmanaged(name, unmanaged) && !(name in files)) {
          mkdirSync(dirname(join(stage, name)), { recursive: true });
          cpSync(join(into, name), join(stage, name));
        }
      }
    }
    const manifest = {
      schemaVersion: 1,
      toolkit: { version: toolkitVersion(root), commit },
      unmanaged,
      opencv: opencvPart,
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    const tmp = join(stage, `.${MANIFEST}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(tmp, join(stage, MANIFEST));
    hooks.beforeSwap?.(stage);
    if (existsSync(into)) renameSync(into, old);
    try {
      renameSync(stage, into);
      swapped = true;
    } catch (e) {
      if (existsSync(old)) renameSync(old, into);
      throw e;
    }
    rmSync(old, { recursive: true, force: true });
    return manifest;
  } finally {
    if (!swapped) rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * What is wrong with a vendored folder; an empty list when nothing is.
 *   toolkit  optional { root, dist, commit }: the checkout, its build and the commit of that build.
 *            The build is compared only when `commit` is the manifest's commit.
 */
export function checkVendor(dir, toolkit) {
  const problems = [];
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) return [`${MANIFEST} is missing from ${dir} (vendor with npm run vendor)`];
  let m;
  try {
    m = readJson(manifestPath);
  } catch {
    return [`${MANIFEST} is not valid JSON`];
  }
  if (m.schemaVersion !== 1 || !m.files || typeof m.files !== "object" || !/^[0-9a-f]{40}$/.test(m.toolkit?.commit ?? "")) {
    return [`${MANIFEST} is not a version 1 manifest with a toolkit commit and a file list`];
  }
  const unmanaged = Array.isArray(m.unmanaged) ? m.unmanaged : DEFAULT_UNMANAGED;
  const listed = Object.keys(m.files);
  const present = filesUnder(dir).filter((n) => !isUnmanaged(n, unmanaged));

  for (const n of present) if (!listed.includes(n)) problems.push(`${n} is in the folder but not in ${MANIFEST}`);
  for (const n of listed) {
    if (!present.includes(n)) problems.push(`${n} is listed in ${MANIFEST} but missing`);
    else if (sha256(readFileSync(join(dir, n))) !== m.files[n].sha256) {
      problems.push(`${n} differs from the SHA-256 in ${MANIFEST} (all files must come from commit ${m.toolkit.commit.slice(0, 12)}; was one updated alone?)`);
    }
  }

  // Licenses: the toolkit's, and the OpenCV text when OpenCV.js is there.
  const required = [...LICENSE_FILES, ...(m.opencv ? ["opencv.mjs.LEGAL.txt"] : [])];
  for (const n of required) {
    if (!listed.includes(n)) problems.push(`license file ${n} is not listed in ${MANIFEST}`);
    else if (present.includes(n) && statSync(join(dir, n)).size === 0) problems.push(`license file ${n} is empty`);
  }

  // OpenCV: the files against the lock recorded for this commit, and against the toolkit's lock when at hand.
  if (m.opencv) {
    for (const n of OPENCV_FILES) if (!listed.includes(n)) problems.push(`OpenCV file ${n} is not listed in ${MANIFEST}`);
    const pins = m.opencv.files ?? {};
    for (const [n, pin] of Object.entries(pins)) {
      if (listed.includes(n) && m.files[n].sha256 !== pin.sha256) problems.push(`${n} does not match the OpenCV lock recorded in ${MANIFEST}`);
    }
    if (toolkit && toolkit.commit === m.toolkit.commit) {
      const lockPath = join(toolkit.root, "browser", "opencv.lock.json");
      if (existsSync(lockPath)) {
        const lock = readJson(lockPath);
        if (sha256(readFileSync(lockPath)) !== m.opencv.lockSha256) problems.push(`the OpenCV lock of commit ${m.toolkit.commit.slice(0, 12)} differs from the one recorded in ${MANIFEST}`);
        for (const [n, pin] of Object.entries(lock.built.files)) {
          if (listed.includes(n) && m.files[n].sha256 !== pin.sha256) problems.push(`${n} does not match opencv.lock.json of the toolkit`);
        }
      }
    }
  }

  // The build of the manifest's commit, when at hand.
  if (toolkit && toolkit.commit === m.toolkit.commit) {
    for (const n of listed) {
      const source = n === SPEC_FILE ? join(toolkit.root, "docs", SPEC_FILE) : n === "LICENSE" || n === "NOTICE" ? join(toolkit.root, n) : join(toolkit.dist, n);
      if (!existsSync(source)) problems.push(`${n} is not in the build of commit ${m.toolkit.commit.slice(0, 12)}`);
      else if (present.includes(n) && sha256(readFileSync(source)) !== sha256(readFileSync(join(dir, n)))) {
        problems.push(`${n} differs from the build of commit ${m.toolkit.commit.slice(0, 12)}`);
      }
    }
  }
  return problems;
}
