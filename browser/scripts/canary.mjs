// SPDX-License-Identifier: Apache-2.0
// The helper behind .github/workflows/canary.yml, the downstream check. It reads the
// list of products to try, from the repository variable CANARY_TARGETS, and does nothing a
// workflow's own YAML would make hard to test:
//
//   node scripts/canary.mjs plan TOOLKIT_ROOT     check the list; print the matrix, the marker key and whether to run
//   node scripts/canary.mjs marker-note FILE      read an earlier passing run's note from the marker folder
//   node scripts/canary.mjs seed-opencv TOOLKIT_ROOT PRODUCT_ROOT VENDOR_DIR
//                                                 put the product's vendored OpenCV.js where the build looks for it
//   node scripts/canary.mjs vendor TOOLKIT_ROOT PRODUCT_ROOT VENDOR_DIR
//                                                 vendor this checkout's build into the product with the options
//                                                 its own manifest records
//   node scripts/canary.mjs run PRODUCT_ROOT      run the product's steps (JSON list in $STEPS), report each. When one
//                                                 fails, the steps also run in $BASELINE_DIR, a copy of the product from
//                                                 before vendoring: a step that fails there too is a warning, not a
//                                                 failure. Each step sees CARDVISION_CANARY=1
//
// CANARY_TARGETS is a JSON list of { repo, branch | sha, vendorDir, steps, chrome? }: the product's
// repository ("account/name"), the branch whose current commit to try (the plan looks it up on each
// run) or one full commit, the folder it vendors the runtime into, the shell commands to run in the
// product after vendoring (in order, each reported), and whether the job installs a headless Chrome
// first ($CHROME names it). An empty variable, or an empty list, is a neutral skip: the job summary
// says so and the run ends green. Results go to $GITHUB_STEP_SUMMARY and, for the workflow,
// $GITHUB_OUTPUT. Nothing here reads a secret.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const KEYS = new Set(["repo", "branch", "sha", "vendorDir", "steps", "chrome"]);
const LOOKUP_TRIES = 3;
const LOOKUP_WAIT_MS = 2000;
const LOOKUP_TIMEOUT_MS = 20_000;
const LOOKUP_BUDGET_MS = 150_000; // all lookups together, well inside the plan job's five minutes

const validBranch = (name) => typeof name === "string" && BRANCH.test(name) && !name.includes("..") && !name.includes("//") && !name.endsWith("/") && !name.endsWith(".") && !name.endsWith(".lock");

/** The targets in a variable's text, or { problems } when it is malformed; an empty text or list is []. */
export function parseTargets(text) {
  if (text === undefined || text.trim() === "") return { targets: [] };
  let list;
  try {
    list = JSON.parse(text);
  } catch (e) {
    return { problems: [`CANARY_TARGETS is not JSON: ${e.message}`] };
  }
  if (!Array.isArray(list)) return { problems: ["CANARY_TARGETS must be a JSON list"] };
  const problems = [];
  const targets = [];
  list.forEach((t, i) => {
    const at = `target ${i + 1}`;
    if (t === null || typeof t !== "object" || Array.isArray(t)) return problems.push(`${at} is not an object`);
    for (const key of Object.keys(t)) if (!KEYS.has(key)) problems.push(`${at} has an unknown field "${key}"`);
    if (typeof t.repo !== "string" || !REPO.test(t.repo)) problems.push(`${at}: repo must be "account/name"`);
    if ((t.sha === undefined) === (t.branch === undefined)) problems.push(`${at}: give exactly one of branch and sha`);
    if (t.sha !== undefined && (typeof t.sha !== "string" || !SHA.test(t.sha))) problems.push(`${at}: sha must be a full 40-character commit`);
    if (t.branch !== undefined && !validBranch(t.branch)) problems.push(`${at}: branch must be a plain branch name`);
    const dir = t.vendorDir;
    if (typeof dir !== "string" || dir === "" || isAbsolute(dir) || dir.includes("\\") || dir.split("/").some((p) => p === ".." || p === ".")) problems.push(`${at}: vendorDir must be a relative folder inside the product`);
    if (!Array.isArray(t.steps) || t.steps.length === 0 || t.steps.some((s) => typeof s !== "string" || s.trim() === "")) problems.push(`${at}: steps must be a non-empty list of commands`);
    if (t.chrome !== undefined && typeof t.chrome !== "boolean") problems.push(`${at}: chrome must be true or false`);
    targets.push({ repo: t.repo, ...(t.branch === undefined ? { sha: t.sha } : { branch: t.branch }), vendorDir: t.vendorDir, steps: t.steps, chrome: t.chrome === true });
  });
  return problems.length > 0 ? { problems } : { targets };
}

/** The commit a repository's branch is at now, or { problem }. A failed lookup is tried again; a branch that is not there is not. */
export function branchCommit(repo, branch, deadline = Infinity, base = process.env.CANARY_REPO_BASE ?? "https://github.com") {
  const ref = `refs/heads/${branch}`;
  let failure = "the time for lookups ran out";
  for (let attempt = 1; attempt <= LOOKUP_TRIES && Date.now() < deadline; attempt += 1) {
    const timeout = Math.min(LOOKUP_TIMEOUT_MS, deadline - Date.now());
    const done = spawnSync("git", ["ls-remote", `${base}/${repo}.git`, ref], { encoding: "utf-8", timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (done.status === 0) {
      const found = done.stdout.split("\n").map((line) => line.split("\t")).filter(([sha, name]) => SHA.test(sha ?? "") && name === ref);
      return found.length === 1 ? { sha: found[0][0] } : { problem: `${repo} has no branch ${branch}` };
    }
    failure = (done.stderr ?? "").trim().split("\n").at(-1) || (done.error?.message ?? "git ls-remote failed");
    if (attempt < LOOKUP_TRIES) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOOKUP_WAIT_MS);
  }
  return { problem: `could not read branch ${branch} of ${repo}: ${failure}` };
}

/** The targets with every branch replaced by the commit it is at now, and what could not be read.
 *  A pull request cannot fix an unreadable product, so that target is left out, not failed. */
export function resolveTargets(targets, lookup = branchCommit) {
  const deadline = Date.now() + LOOKUP_BUDGET_MS;
  const skipped = [];
  const resolved = [];
  targets.forEach((t, i) => {
    if (t.branch === undefined) return void resolved.push(t);
    const { branch, ...rest } = t;
    const { sha, problem } = lookup(t.repo, branch, deadline);
    if (problem) return void skipped.push(`target ${i + 1}: ${problem}`);
    console.log(`${t.repo}: ${branch} is at ${sha}`);
    resolved.push({ ...rest, sha });
  });
  return { targets: resolved, skipped };
}

/** The marker key: the tracked files that decide a run (browser/**, docs/hover-spec.*, the workflow file) and the targets. */
export function markerKey(root, targets) {
  const listed = execFileSync("git", ["-C", root, "ls-files", "-s", "--", "browser", "docs/hover-spec.*", ".github/workflows/canary.yml"], { encoding: "utf-8", maxBuffer: 1 << 28 });
  return createHash("sha256").update(listed).update("\0").update(JSON.stringify(targets)).digest("hex");
}

/** The vendor.mjs flags that reproduce a vendored folder's recorded options. */
export function vendorFlags(manifest) {
  const o = manifest.options ?? {};
  const flags = [];
  if (o.opencv === false) flags.push("--no-opencv");
  if (o.ortWasm === false) flags.push("--no-ort-wasm");
  if (o.nodeTools === true) flags.push("--node-tools");
  if (o.host === true) flags.push("--host");
  if (o.harness === true) flags.push("--harness");
  if (typeof o.runtime === "string" && o.runtime !== "all") flags.push("--runtime", o.runtime);
  for (const rule of manifest.unmanaged ?? []) flags.push("--unmanaged", rule);
  return flags;
}

/** A step's command as one cell of the summary's Markdown table: inside <code>, with every
 *  character that HTML, the table or a backslash escape could read written as a numeric entity,
 *  and line breaks as spaces. */
export function stepCell(step) {
  return `<code>${step.replace(/\r?\n/g, " ").replace(/[&<>"'|\\`]/g, (c) => `&#${c.charCodeAt(0)};`)}</code>`;
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  else console.log(text);
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

function plan(root) {
  const parsed = parseTargets(process.env.CANARY_TARGETS);
  if (parsed.problems) {
    for (const p of parsed.problems) console.error(p);
    summary(`## Downstream canary\n\nThe list of products is malformed:\n\n${parsed.problems.map((p) => `- ${p}`).join("\n")}`);
    return 1;
  }
  const { targets, skipped } = resolveTargets(parsed.targets);
  if (skipped.length > 0) {
    for (const p of skipped) console.log(`::warning title=Downstream canary::${p}`);
    summary(`## Downstream canary\n\nNot tried, for a reason outside this pull request:\n\n${skipped.map((p) => `- ${p}`).join("\n")}`);
  }
  if (targets.length === 0) {
    if (skipped.length === 0) summary("## Downstream canary\n\nSkipped (neutral): the repository variable `CANARY_TARGETS` is empty, so there is no product to try.");
    output("run", "false");
    output("matrix", JSON.stringify({ include: [] }));
    return 0;
  }
  const key = markerKey(root, targets);
  output("run", "true");
  output("count", String(targets.length));
  output("key", key);
  output("matrix", JSON.stringify({ include: targets }));
  return 0;
}

function markerNote(file) {
  if (!existsSync(file)) {
    output("skip", "false");
    return 0;
  }
  const note = readFileSync(file, "utf-8").trim();
  summary(`## Downstream canary\n\nSkipped (neutral): the same toolkit files and products were already tried.\n\nEarlier run: ${note}`);
  output("skip", "true");
  return 0;
}

// OpenCV.js is built from source by scripts/build-opencv.mjs, which takes a long time, and is not in
// the repository. A product that vendors it holds the same files, so the build borrows them; the
// vendor step then checks their hashes against opencv.lock.json, and says so if they differ.
function seedOpencv(toolkit, product, vendorDir) {
  const from = join(product, vendorDir);
  const manifestPath = join(from, "cardvision-vendor.json");
  if (!existsSync(manifestPath)) {
    console.error(`${manifestPath} does not exist: the product has no vendored runtime to refresh`);
    return 1;
  }
  if (JSON.parse(readFileSync(manifestPath, "utf-8")).options?.opencv !== true) {
    console.log("The product vendors no OpenCV.js; nothing to borrow.");
    return 0;
  }
  const to = join(toolkit, "browser", "vendor", "opencv");
  mkdirSync(to, { recursive: true });
  for (const name of ["opencv.mjs", "opencv_js.wasm", "opencv.mjs.LEGAL.txt"]) {
    if (!existsSync(join(from, name))) {
      console.error(`${join(from, name)} is missing`);
      return 1;
    }
    copyFileSync(join(from, name), join(to, name));
  }
  console.log(`Borrowed OpenCV.js from ${from}`);
  return 0;
}

function vendor(toolkit, product, vendorDir) {
  const manifestPath = join(product, vendorDir, "cardvision-vendor.json");
  if (!existsSync(manifestPath)) {
    console.error(`${manifestPath} does not exist: the product has no vendored runtime to refresh`);
    return 1;
  }
  const flags = vendorFlags(JSON.parse(readFileSync(manifestPath, "utf-8")));
  const args = ["scripts/vendor.mjs", "--into", resolve(product, vendorDir), ...flags];
  console.log(`node ${args.join(" ")}`);
  return spawnSync("node", args, { cwd: join(toolkit, "browser"), stdio: "inherit" }).status ?? 1;
}

// Each pass gets its own temporary folder, and each step its own process group, stopped when the
// step ends: what a failed run leaves behind must not make the copy's run fail too.
function runSteps(product, steps) {
  const temp = mkdtempSync(join(tmpdir(), "canary-steps-"));
  const results = steps.map((step) => {
    console.log(`::group::${step}`);
    const done = spawnSync("bash", ["-e", "-c", step], { cwd: product, stdio: "inherit", detached: true, env: { ...process.env, CARDVISION_CANARY: "1", TMPDIR: temp } });
    try {
      if (done.pid) process.kill(-done.pid, "SIGKILL");
    } catch {
      // The group has already gone.
    }
    console.log("::endgroup::");
    return done.status === 0 ? "passed" : `failed (${done.status ?? done.signal})`;
  });
  rmSync(temp, { recursive: true, force: true });
  return results;
}

function run(product) {
  const steps = JSON.parse(process.env.STEPS ?? "[]");
  const repo = process.env.TARGET_REPO ?? product;
  const sha = process.env.TARGET_SHA ?? "";
  const results = runSteps(product, steps);
  const bad = results.filter((r) => r !== "passed").length;
  const copy = process.env.BASELINE_DIR;
  const before = bad > 0 && copy && existsSync(copy) ? runSteps(copy, steps) : null;
  const alreadyFailing = bad > 0 && before !== null && results.every((r, i) => r === "passed" || before[i] !== "passed");
  const verdict = bad === 0 ? "passed" : alreadyFailing ? `${bad} of ${steps.length} step(s) already fail without this change, so it could not be checked there` : `${bad} of ${steps.length} step(s) failed`;
  const head = before === null ? "| Step | Result |\n| --- | --- |" : "| Step | Result | Without this change |\n| --- | --- | --- |";
  const table = steps.map((s, i) => `| ${stepCell(s)} | ${results[i]} |${before === null ? "" : ` ${before[i]} |`}`).join("\n");
  summary(`### ${repo} at ${sha.slice(0, 12)}: ${verdict}\n\n${head}\n${table}\n`);
  if (alreadyFailing) console.log(`::warning title=Downstream canary::${repo} at ${sha.slice(0, 12)}: ${verdict}`);
  output("clean", bad === 0 ? "true" : "false");
  return bad === 0 || alreadyFailing ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const usage = () => {
    console.error("Usage: node scripts/canary.mjs plan ROOT | marker-note FILE | seed-opencv TOOLKIT PRODUCT VENDOR_DIR | vendor TOOLKIT PRODUCT VENDOR_DIR | run PRODUCT");
    return 2;
  };
  const table = { plan: [1, plan], "marker-note": [1, markerNote], vendor: [3, vendor], "seed-opencv": [3, seedOpencv], run: [1, run] };
  const entry = table[command];
  process.exit(entry && rest.length === entry[0] ? entry[1](...rest) : usage());
}
