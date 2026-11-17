// SPDX-License-Identifier: Apache-2.0
// Uploading an extension release to the Chrome Web Store and addons.mozilla.org from a workflow.
// Two commands, one per job (docs/store-uploads.md):
//
//   node store-upload.mjs check --config store/store.config.json --release store/releases/<v>.json
//        --tag <tag> --permissions store/permissions.json [--previous-permissions FILE]
//        [--chrome-zip Z] [--firefox-zip Z] [--firefox-source S] --workflow FILE...
//        [--lint REPORT [--lint-baseline FILE]] [--hashes-out FILE] [--summary FILE]
//        [--load-unpacked-zip Z] [--record-out FILE.json --vendor-manifest FILE [--facts FILE]
//        [--commit SHA] [--run-id ID] [--ci-results FILE] [--runtimes FILE]]
//        [--pull-request release|released]
//
//     The build job's last step, with no store access: the files agree with each other and with
//     the tag, the permission surface is the one committed (and a change is acknowledged), the
//     notes exist, the "before upload" addresses answer, the workflow mentions no CDN
//     credential, and the Firefox lint has no error and no warning outside the product's
//     baseline. A Chrome zip may keep its files in one top-level folder; a Firefox zip may not.
//     Writes the packages' sha256 to --hashes-out and a summary for the run page. With
//     --record-out it also writes the release record (machine facts only: versions, hashes, the
//     vendored toolkit commit, permissions, the lint result, a digest of each package's files, and
//     with --ci-results the commit's check runs) as FILE.json and FILE.md. With --runtimes the
//     facts file's modelRelease must be the version's row in the product's cdn/RUNTIMES.json. It
//     refuses a record whose text names a credential or a local path. It also refuses a workflow
//     in which a job names an environment without its own permissions, or write permission sits
//     beside an environment (see workflowGuardProblems in store-record.ts).
//
//     --pull-request runs it on a pull request, before any tag (templates/store-check.yml).
//     `release`, when the pull request is the version's release or changes it: everything is
//     checked, but a "before upload" address that is not live yet is a warning. `released`, when
//     the version is already tagged: only the version is read from the release file, the packages
//     are checked against the committed permissions, and a permission change since the tag
//     (--previous-permissions given the tag's file) or a runtime row that no longer matches is a
//     warning for the next version. Warnings never fail the run; in a workflow they are printed
//     as ::warning commands.
//
//   node store-upload.mjs assets --record FILE.json --dir DIR --out-dir DIR
//
//     The release-assets job, with no store access: copies the load-unpacked, Chrome and Firefox
//     packages the record names (each checked against its recorded hash) and the record's two
//     files into --out-dir and writes SHA256SUMS. The Firefox source archive is never copied.
//
//   node store-upload.mjs status --config store/store.config.json --releases store/releases
//        [--state-in FILE] [--state-out FILE] [--summary FILE]
//
//     The daily check, with no credentials: the newest release file's version against the version
//     each store shows the public (see store-status.ts), and the release file's `expect`
//     addresses. Exit 0 when nothing is wrong, "in review" included (it is noted); 1 on a store
//     that shows a newer version, a version that went back since the previous run, an address
//     whose bytes differ or a store that cannot be read.
//
//   node store-upload.mjs upload --config … --release … --targets chrome,firefox --hashes FILE
//        [--chrome-zip Z] [--firefox-zip Z] [--firefox-source S] [--precheck-only] [--summary FILE]
//        [--env-file FILE]
//
//     The upload job, after the account holder's approval. Refuses if its environment holds a CDN
//     credential or a package differs from the hashes the build job wrote. Checks every target
//     first (a Chrome submission pending review or staged, a Firefox version awaiting review, the
//     "before upload" addresses) and uploads nothing if one is blocked; skips a store that already
//     has this version, so a re-run finishes what a failed run left. Credentials come from the
//     environment: CWS_ACCESS_TOKEN (an OAuth access token for the Chrome Web Store) or
//     CWS_SERVICE_ACCOUNT_KEY_FILE (a service account's JSON key, from which it mints the token),
//     AMO_JWT_ISSUER and AMO_JWT_SECRET. On the account holder's own machine, --env-file reads
//     them from a file of KEY=VALUE lines; the environment wins over the file. The key file and
//     the env file must be mode 600 or stricter (chmod 600).
//
// Exit codes: 0 done, 1 a check or a store refused, 2 a usage error.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { type AmoAddon, amoCreateVersion, amoDecision, amoListed, amoSetNotes, amoValidate } from "./store-amo.js";
import {
  beforeProblems,
  deniedEnvNames,
  denyFindings,
  type PermissionSurface,
  permissionSurface,
  lintProblems,
  manifestEntry,
  readLintBaseline,
  readLintReport,
  readNotes,
  readReleaseFile,
  readStoreConfig,
  type ReleaseFile,
  sha256,
  type StoreConfig,
  surfaceChanges,
} from "./store-checks.js";
import { chromeDecision, type ChromeItem, chromePublish, chromeStatus, chromeUpload, StoreError } from "./store-chrome.js";
import { readEnvFile, serviceAccountToken } from "./store-google.js";
import { readState, runStatus, writeState } from "./store-status.js";
import {
  type PackageFact,
  RECORD_SCHEMA,
  readFactsFile,
  readVendorFacts,
  recordJson,
  recordMarkdown,
  recordProblems,
  type ReleaseRecord,
  releaseAssets,
  workflowGuardProblems,
  contentsDigest,
  readCiResults,
  readRuntimesRow,
} from "./store-record.js";

export interface Deps {
  env: Record<string, string | undefined>;
  fetchFn: typeof fetch;
  readFile: (path: string) => Uint8Array;
  /** Every file of a zip with its sha256 (the release record's contents digest). */
  zipFiles?: (zipPath: string) => Array<{ name: string; sha256: string }>;
  /** A zip's manifest.json and where it is in the zip (`manifestEntry`). */
  zipManifest: (zipPath: string) => { path: string; manifest: Record<string, unknown> };
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Origins of the store APIs (tests). */
  chromeBase?: string;
  amoBase?: string;
  /** The update service's address (tests). */
  chromeUpdateBase?: string;
  /** Google's token address (tests). */
  googleTokenUrl?: string;
}

function defaultZipManifest(zipPath: string): { path: string; manifest: Record<string, unknown> } {
  const entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf-8", maxBuffer: 64 << 20 }).split("\n");
  const path = manifestEntry(entries);
  if (!path) throw new StoreError(`${basename(zipPath)} has no manifest.json at its root or in a single top-level folder`);
  // unzip reads its file argument as a pattern.
  if (/[*?[\]\\]/.test(path)) throw new StoreError(`${basename(zipPath)}: rename the folder ${path.slice(0, path.indexOf("/"))}: no * ? [ ] or \\ in it`);
  const text = execFileSync("unzip", ["-p", zipPath, path], { encoding: "utf-8" });
  return { path, manifest: JSON.parse(text) as Record<string, unknown> };
}

export function defaultZipFiles(zipPath: string): Array<{ name: string; sha256: string }> {
  const names = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf-8", maxBuffer: 64 << 20 }).split("\n").filter((n) => n !== "" && !n.endsWith("/"));
  // unzip reads its file argument as a pattern, and an option when it starts with `-`: refuse both.
  return names.map((name) => {
    if (name.startsWith("-") || /[*?[\]\\]/.test(name)) throw new StoreError(`${basename(zipPath)}: a file name starts with - or holds * ? [ ] or \\ (${name.slice(0, 40)})`);
    return { name, sha256: sha256(new Uint8Array(execFileSync("unzip", ["-p", zipPath, name], { maxBuffer: 1 << 30 }))) };
  });
}

export const DEFAULT_DEPS: Deps = {
  env: process.env,
  fetchFn: fetch,
  readFile: (p) => new Uint8Array(readFileSync(p)),
  zipManifest: defaultZipManifest,
  zipFiles: defaultZipFiles,
  log: (line) => console.log(line),
};

class Usage extends Error {}

function surfaceFile(path: string): Record<string, PermissionSurface> {
  const o = JSON.parse(readFileSync(path, "utf-8")) as Record<string, PermissionSurface>;
  if (typeof o !== "object" || o === null) throw new StoreError(`${path}: must be an object`);
  return o;
}

const sameSurface = (a: PermissionSurface | undefined, b: PermissionSurface): boolean => !!a && surfaceChanges(a, b).length === 0;

// ---------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------

export interface CheckArgs {
  config: string;
  release: string;
  tag: string;
  tagPrefix: string;
  permissions: string;
  previousPermissions?: string;
  chromeZip?: string;
  firefoxZip?: string;
  firefoxSource?: string;
  workflows: string[];
  hashesOut?: string;
  /** `web-ext lint --output json` of the Firefox package, and the product's known warnings. */
  lint?: string;
  lintBaseline?: string;
  /** A package people load unpacked (its version is checked, its hash recorded). */
  loadUnpackedZip?: string;
  /** Where to write the release record (`FILE.json`; the Markdown goes to `FILE.md`). */
  recordOut?: string;
  vendorManifest?: string;
  facts?: string;
  commit?: string;
  runId?: string;
  /** The commit's check runs (`gh api …/check-runs` output). */
  ciResults?: string;
  /** The product's cdn/RUNTIMES.json: the record's model release must be the version's row. */
  runtimes?: string;
  /**
   * A pull request's check (`--pull-request`), not a tag's. `release`: the pull request is the
   * release or changes it (the version is not tagged yet, or the pull request changes its release
   * file, notes or runtime row); everything is checked, but a `before` address that is not live
   * yet is a warning, since it is published after the merge. `released`: the version is already
   * tagged and this commit will never ship as it; only the version is read from the release file,
   * and what describes the release (notes, `before`, `permissionsChanged`, the runtime row) is not
   * checked. A permission change since the release (`previousPermissions`, the tag's file) and a
   * runtime row that no longer matches are warnings for the next version.
   */
  pullRequest?: "release" | "released";
}

/** The release file of a version already released: only its version is read (see `pullRequest`). */
function releasedVersion(path: string): ReleaseFile {
  let o: unknown;
  try {
    o = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new StoreError(`${path}: ${(error as Error).message}`);
  }
  const version = (o as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || version === "") throw new StoreError(`${path}: version is required`);
  return { version };
}

/** Everything the build job verifies. Returns the problems (empty: pass) and the summary. */
export async function runCheck(
  a: CheckArgs,
  deps: Deps,
): Promise<{ problems: string[]; warnings: string[]; summary: string[]; hashes: Record<string, string> }> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];
  const config: StoreConfig = readStoreConfig(a.config);
  const released = a.pullRequest === "released";
  const release: ReleaseFile = released ? releasedVersion(a.release) : readReleaseFile(a.release);
  if (!a.pullRequest) summary.push(`## Store release ${release.version}`, "");
  else if (released) {
    summary.push(
      `## Store check: ${a.tag} is already released`,
      "",
      "This pull request will not ship as that version, so what describes the release (notes, before-upload addresses, permissionsChanged, the runtime row) is not checked. The packages are checked against the committed permissions; a difference from the release is a warning for the next version.",
      "",
    );
  } else summary.push(`## Store check: ${release.version}, a pull request before its tag`, "");

  if (a.tag !== `${a.tagPrefix}${release.version}`) problems.push(`the tag ${a.tag} is not ${a.tagPrefix}${release.version}`);

  // No CDN credential or flag tool in any workflow file.
  for (const w of a.workflows) {
    const text = readFileSync(w, "utf-8");
    for (const f of denyFindings(text, config.deny)) problems.push(`${w} mentions a denied name (${f})`);
    for (const p of workflowGuardProblems(text)) problems.push(`${w}: ${p}`);
  }

  const committed = surfaceFile(a.permissions);
  const previous = a.previousPermissions ? surfaceFile(a.previousPermissions) : null;
  const hashes: Record<string, string> = {};
  const targets: Array<["chrome" | "firefox", string | undefined]> = [
    ["chrome", a.chromeZip],
    ["firefox", a.firefoxZip],
  ];
  let changed = false;
  const facts: Record<"chrome" | "firefox" | "firefoxSource" | "loadUnpacked", PackageFact | undefined> = { chrome: undefined, firefox: undefined, firefoxSource: undefined, loadUnpacked: undefined };
  const surfaces: ReleaseRecord["permissions"] = {};
  for (const [target, zip] of targets) {
    if (!zip) continue;
    if (!config[target]) problems.push(`a ${target} package was given but ${a.config} names no ${target} item`);
    const { path: manifestPath, manifest } = deps.zipManifest(zip);
    if (target === "firefox" && manifestPath !== "manifest.json") problems.push(`${basename(zip)}: addons.mozilla.org needs manifest.json at the zip's root, not ${manifestPath}`);
    if (manifest.version !== release.version) problems.push(`${basename(zip)} is version ${String(manifest.version)}, the release is ${release.version}`);
    const gecko = (manifest.browser_specific_settings as { gecko?: unknown } | undefined)?.gecko;
    if (target === "chrome" && manifest.key !== undefined) problems.push(`${basename(zip)} carries a key (a store package must not)`);
    if (target === "firefox" && !gecko) problems.push(`${basename(zip)} has no gecko settings`);
    const surface = permissionSurface(manifest);
    if (!sameSurface(committed[target], surface)) {
      const diff = committed[target] ? surfaceChanges(committed[target]!, surface) : ["(no entry)"];
      problems.push(`${target}: the package's permissions differ from ${a.permissions}: ${diff.join("; ")}`);
    }
    if (previous) {
      const diff = previous[target] ? surfaceChanges(previous[target]!, surface) : [];
      if (diff.length > 0 && released) {
        warnings.push(`${target}: the permissions changed since ${a.tag} (${diff.join("; ")}): the next version's release file sets permissionsChanged`);
      } else if (diff.length > 0) {
        changed = true;
        summary.push(`**${target} permission change:** ${diff.join("; ")}`, "");
      }
    }
    const bytes = deps.readFile(zip);
    hashes[basename(zip)] = sha256(bytes);
    facts[target] = { file: basename(zip), bytes: bytes.length, sha256: hashes[basename(zip)]!, manifestVersion: String(manifest.version) };
    if (a.recordOut) Object.assign(facts[target]!, contentsDigest((deps.zipFiles ?? defaultZipFiles)(zip)));
    surfaces[target] = surface;
    const folder = manifestPath === "manifest.json" ? "" : `, files in \`${manifestPath.slice(0, -"manifest.json".length)}\``;
    summary.push(`- ${target}: \`${basename(zip)}\` ${bytes.length} bytes${folder}, sha256 \`${hashes[basename(zip)]}\``);
  }
  if (a.firefoxSource) {
    const bytes = deps.readFile(a.firefoxSource);
    hashes[basename(a.firefoxSource)] = sha256(bytes);
    facts.firefoxSource = { file: basename(a.firefoxSource), bytes: bytes.length, sha256: hashes[basename(a.firefoxSource)]! };
    summary.push(`- firefox source: \`${basename(a.firefoxSource)}\` sha256 \`${hashes[basename(a.firefoxSource)]}\``);
  } else if (a.firefoxZip) {
    summary.push("- firefox source: none (the add-on's code is not minified or generated)");
  }
  if (a.loadUnpackedZip) {
    const { manifest } = deps.zipManifest(a.loadUnpackedZip);
    const name = basename(a.loadUnpackedZip);
    if (manifest.version !== release.version) problems.push(`${name} is version ${String(manifest.version)}, the release is ${release.version}`);
    const bytes = deps.readFile(a.loadUnpackedZip);
    hashes[name] = sha256(bytes);
    facts.loadUnpacked = { file: name, bytes: bytes.length, sha256: hashes[name], manifestVersion: String(manifest.version) };
    if (a.recordOut) Object.assign(facts.loadUnpacked, contentsDigest((deps.zipFiles ?? defaultZipFiles)(a.loadUnpackedZip)));
    summary.push(`- load-unpacked: \`${name}\` ${bytes.length} bytes, sha256 \`${hashes[name]}\``);
  }
  let lintFact: ReleaseRecord["lint"] = null;
  if (a.lintBaseline && !a.lint) problems.push("--lint-baseline needs --lint (the web-ext lint JSON report)");
  if (!a.lint && a.firefoxZip) summary.push("- firefox lint: no report given (--lint), not checked");
  if (a.lint) {
    const baseline = a.lintBaseline ? readLintBaseline(a.lintBaseline) : [];
    const report = readLintReport(a.lint);
    const lint = lintProblems(report, baseline);
    problems.push(...lint.problems);
    const known = report.warnings.length - lint.problems.filter((p) => p.startsWith("new lint warning")).length;
    lintFact = { errors: report.errors.length, warnings: report.warnings.length, inBaseline: known };
    summary.push(`- firefox lint: ${report.errors.length} errors, ${report.warnings.length} warnings (${known} in the baseline)`);
    if (lint.gone.length > 0) {
      summary.push(`- firefox lint: no longer warned, can leave the baseline: ${lint.gone.map((f) => `${f.code} in ${f.file}`).join("; ")}`);
    }
  }
  if (!previous && (a.chromeZip || a.firefoxZip)) {
    summary.push("", released ? `No permissions of ${a.tag}: not compared.` : "No previous release's permissions: not compared.");
  }
  if (previous && !released) {
    if (changed && !release.permissionsChanged) problems.push("the permissions changed: set permissionsChanged in the release file once the store justifications are updated");
    if (!changed && release.permissionsChanged) problems.push("permissionsChanged is set but nothing changed since the previous release");
  }

  if (release.chrome) {
    summary.push(
      "",
      release.chrome.submit === "auto"
        ? `Chrome: upload, then submit for review (${release.chrome.publish === "staged" ? "publish by hand after approval" : "live once approved"}).`
        : "Chrome: upload only. Paste the listing text in the dashboard, then submit.",
    );
  }
  if (!released) {
    try {
      const notes = readNotes(a.release, release);
      for (const [locale, text] of Object.entries(notes.releaseNotes ?? {})) summary.push("", `Firefox release notes (${locale}):`, "", ...text.split("\n").map((l) => `> ${l}`));
      if (notes.approvalNotes) summary.push("", "Firefox notes to reviewers:", "", ...notes.approvalNotes.split("\n").map((l) => `> ${l}`));
    } catch (error) {
      problems.push((error as Error).message);
    }

    // On a pull request, an address that is not live yet is published after the merge: the tag's
    // build job checks it again (bytes included), and the upload refuses while it is not live.
    const notLive = await beforeProblems(release, deps.fetchFn);
    if (a.pullRequest) for (const p of notLive) warnings.push(`before upload (checked again on the tag): ${p}`);
    else for (const p of notLive) problems.push(`before upload: ${p}`);
    if ((release.before ?? []).length > 0) summary.push("", `Before upload: ${(release.before ?? []).length} address(es) checked.`);
  }

  if ((a.ciResults || a.runtimes) && !a.recordOut) throw new Usage("--ci-results and --runtimes go with --record-out");
  if (a.recordOut) {
    if (!a.recordOut.endsWith(".json")) throw new Usage("--record-out names a .json file (the Markdown is written beside it)");
    if (!a.vendorManifest) throw new Usage("--record-out needs --vendor-manifest");
    if (a.commit !== undefined && !/^[0-9a-f]{40}$/.test(a.commit)) throw new Usage("--commit must be a full 40-character SHA");
    if (a.runId !== undefined && !/^[0-9]{1,20}$/.test(a.runId)) throw new Usage("--run-id must be digits");
    const vendor = readVendorFacts(a.vendorManifest);
    const productFacts = a.facts ? readFactsFile(a.facts) : {};
    if (productFacts.modelRelease !== undefined && typeof productFacts.modelRelease !== "string") throw new StoreError(`${basename(a.facts!)}: modelRelease must be text (a release id), not ${typeof productFacts.modelRelease}`);
    const record: ReleaseRecord = {
      schemaVersion: RECORD_SCHEMA,
      version: release.version,
      tag: a.tag,
      commit: a.commit ?? null,
      runId: a.runId ?? null,
      ...vendor,
      modelRelease: typeof productFacts.modelRelease === "string" ? productFacts.modelRelease : null,
      ci: a.ciResults ? readCiResults(a.ciResults, a.runId) : null,
      packages: Object.fromEntries(Object.entries(facts).filter(([, v]) => v)) as ReleaseRecord["packages"],
      permissions: surfaces,
      permissionsChanged: release.permissionsChanged === true,
      chrome: release.chrome ? { submit: release.chrome.submit, publish: release.chrome.publish } : null,
      lint: lintFact,
      beforeUpload: { checked: (release.before ?? []).length },
      facts: Object.fromEntries(Object.entries(productFacts).filter(([k]) => k !== "modelRelease")),
    };
    if (a.runtimes) {
      // On a released version the row describes that release: a difference is for the next one.
      const rowProblems: string[] = [];
      try {
        const row = readRuntimesRow(a.runtimes, release.version);
        if (record.modelRelease === null) rowProblems.push(`the record names no model release: set modelRelease in the facts file (${basename(a.runtimes)} says ${row.releaseId})`);
        else if (record.modelRelease !== row.releaseId) rowProblems.push(`the bundled model release ${record.modelRelease} is not ${row.releaseId}, the row of ${release.version} in ${basename(a.runtimes)}`);
        if (row.ortWeb && record.ort && row.ortWeb !== record.ort) rowProblems.push(`the vendored ONNX Runtime ${record.ort} is not ${row.ortWeb}, the row of ${release.version} in ${basename(a.runtimes)}`);
      } catch (error) {
        rowProblems.push((error as Error).message);
      }
      if (released) for (const p of rowProblems) warnings.push(`${p} (${a.tag} is released: the next version's row)`);
      else problems.push(...rowProblems);
    }
    const json = recordJson(record);
    const markdown = recordMarkdown(record);
    const refused = recordProblems([json, markdown], config.deny ?? []);
    problems.push(...refused);
    if (refused.length === 0) {
      writeFileSync(a.recordOut, json);
      writeFileSync(a.recordOut.replace(/\.json$/, ".md"), markdown);
      summary.push("", `Release record written (${basename(a.recordOut)}, ${basename(a.recordOut.replace(/\.json$/, ".md"))}).`);
    }
  }
  if (a.hashesOut) writeFileSync(a.hashesOut, `${JSON.stringify(hashes, null, 2)}\n`);
  if (warnings.length > 0) summary.push("", `**${warnings.length} warning(s):**`, ...warnings.map((w) => `- ${w}`));
  summary.push("", problems.length === 0 ? "**All checks passed.**" : `**${problems.length} problem(s):**`, ...problems.map((p) => `- ${p}`));
  return { problems, warnings, summary, hashes };
}

/** A warning line: a GitHub workflow command in a workflow (%, CR and LF escaped), plain text elsewhere. */
export function warningLine(text: string, env: Record<string, string | undefined>): string {
  if (env.GITHUB_ACTIONS !== "true") return `warning: ${text}`;
  return `::warning title=Store check::${text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;
}

// ---------------------------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------------------------

export interface UploadArgs {
  config: string;
  release: string;
  targets: Array<"chrome" | "firefox">;
  hashes: string;
  chromeZip?: string;
  firefoxZip?: string;
  firefoxSource?: string;
  precheckOnly: boolean;
}

function need(env: Deps["env"], name: string): string {
  const v = env[name];
  if (!v) throw new StoreError(`${name} is not set`);
  return v;
}

/** The Chrome Web Store token: CWS_ACCESS_TOKEN, or one minted from CWS_SERVICE_ACCOUNT_KEY_FILE. */
async function chromeToken(deps: Deps): Promise<string> {
  const token = deps.env.CWS_ACCESS_TOKEN;
  const keyFile = deps.env.CWS_SERVICE_ACCOUNT_KEY_FILE;
  if (token && keyFile) throw new StoreError("both CWS_ACCESS_TOKEN and CWS_SERVICE_ACCOUNT_KEY_FILE are set: keep one");
  if (keyFile) return serviceAccountToken(keyFile, { fetchFn: deps.fetchFn, tokenUrl: deps.googleTokenUrl });
  if (!token) throw new StoreError("CWS_ACCESS_TOKEN is not set, nor CWS_SERVICE_ACCOUNT_KEY_FILE");
  return token;
}

/**
 * The upload job. Reports each step through `report` as it happens; throws a StoreError on a
 * refusal or a store error, whose message lists what had already been done.
 *
 * Order: every store is checked first (and the "before upload" addresses again: the approval can
 * come days after the build). Then the Firefox package is uploaded and validated, which creates
 * nothing on the listing; then the Chrome upload and submission; then the Firefox version. A
 * store that already has this version submitted or published is skipped, so a re-run after one
 * store failed finishes the other.
 */
export async function runUpload(a: UploadArgs, deps: Deps, report: (line: string) => void = () => undefined): Promise<string[]> {
  const config = readStoreConfig(a.config);
  const release = readReleaseFile(a.release);
  const out: string[] = [];
  const say = (line: string): void => {
    out.push(line);
    report(line);
  };

  const denied = deniedEnvNames(deps.env, config.deny);
  if (denied.length > 0) throw new StoreError(`the upload job's environment holds denied names: ${denied.join(", ")}`);

  // The packages are the ones the build job checked.
  const expected = JSON.parse(readFileSync(a.hashes, "utf-8")) as Record<string, string>;
  const files: Array<[string | undefined, string]> = [
    [a.chromeZip, "chrome package"],
    [a.firefoxZip, "firefox package"],
    [a.firefoxSource, "firefox source"],
  ];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, what] of files) {
    if (!path) continue;
    const b = deps.readFile(path);
    const want = expected[basename(path)];
    if (!want) throw new StoreError(`the build job recorded no hash for the ${what} ${basename(path)}`);
    if (sha256(b) !== want) throw new StoreError(`the ${what} ${basename(path)} is not the one the build job checked`);
    bytes.set(path, b);
  }
  // The Firefox notes are read, and their limits checked, only when Firefox is a target.
  const notes = a.targets.includes("firefox") ? readNotes(a.release, release) : {};

  let chrome: ChromeItem | null = null;
  let amo: AmoAddon | null = null;
  if (a.targets.includes("chrome")) {
    if (!config.chrome || !release.chrome || !a.chromeZip) throw new StoreError("chrome needs a config item, a release-file chrome block and --chrome-zip");
    chrome = { ...config.chrome, accessToken: await chromeToken(deps), fetchFn: deps.fetchFn, base: deps.chromeBase };
  }
  if (a.targets.includes("firefox")) {
    if (!config.firefox || !a.firefoxZip) throw new StoreError("firefox needs a config item and --firefox-zip");
    amo = {
      addon: config.firefox.addon,
      issuer: need(deps.env, "AMO_JWT_ISSUER"),
      secret: need(deps.env, "AMO_JWT_SECRET"),
      fetchFn: deps.fetchFn,
      base: deps.amoBase,
    };
  }

  // Every store is checked before any upload.
  const blockers: string[] = [];
  for (const p of await beforeProblems(release, deps.fetchFn)) blockers.push(`before upload: ${p}`);
  if (chrome) {
    const d = chromeDecision(await chromeStatus(chrome), release.version);
    if (d.kind === "block") blockers.push(`Chrome Web Store: ${d.reason}`);
    if (d.kind === "skip") {
      say(`Chrome Web Store: skipped, ${d.reason}.`);
      chrome = null;
    }
  }
  // A version already on AMO (a re-run) still gets its notes set: a failure between creating the
  // version and setting them would otherwise leave them unset.
  let amoNotesOnly: { addon: AmoAddon; versionId: number } | null = null;
  if (amo) {
    const d = amoDecision(await amoListed(amo), release.version);
    if (d.kind === "block") blockers.push(`addons.mozilla.org: ${d.reason}`);
    if (d.kind === "skip") {
      say(`addons.mozilla.org: skipped, ${d.reason}.`);
      if (d.versionId !== undefined) amoNotesOnly = { addon: amo, versionId: d.versionId };
      amo = null;
    }
  }
  if (blockers.length > 0) throw new StoreError(`nothing was uploaded: ${blockers.join("; ")}`);
  say(`Prechecks passed: ${a.targets.join(", ")}.`);
  if (a.precheckOnly) return out;

  const done = (): string => (out.length > 0 ? ` Done before this: ${out.join(" ")}` : "");
  try {
    const submission = amo
      ? {
          zip: bytes.get(a.firefoxZip!)!,
          zipName: basename(a.firefoxZip!),
          source: a.firefoxSource ? { bytes: bytes.get(a.firefoxSource)!, name: basename(a.firefoxSource) } : undefined,
          releaseNotes: notes.releaseNotes,
          approvalNotes: notes.approvalNotes,
          sleep: deps.sleep,
        }
      : null;
    const amoUpload = amo ? await amoValidate(amo, submission!) : null;
    if (amoUpload) say("addons.mozilla.org: the package passed validation.");
    if (chrome) {
      const up = await chromeUpload(chrome, bytes.get(a.chromeZip!)!, { sleep: deps.sleep });
      say(`Chrome Web Store: uploaded (${up.uploadState}${up.crxVersion ? `, version ${up.crxVersion}` : ""}).`);
      if (release.chrome!.submit === "auto") {
        const pub = await chromePublish(chrome, release.chrome!.publish === "staged" ? "STAGED_PUBLISH" : "DEFAULT_PUBLISH");
        say(`Chrome Web Store: submitted for review (${pub.state ?? "state not reported"}).`);
        for (const w of pub.warnings) say(`Chrome Web Store warning: ${w}`);
      } else {
        say("Chrome Web Store: not submitted. Paste the listing text in the dashboard, then submit.");
      }
    }
    if (amo && amoUpload) {
      const res = await amoCreateVersion(amo, amoUpload, submission!);
      say(`addons.mozilla.org: version ${res.version} submitted for review${a.firefoxSource ? " with its source code" : ""}.`);
      if (await amoSetNotes(amo, res.versionId, notes)) say("addons.mozilla.org: notes set.");
    }
    if (amoNotesOnly && (await amoSetNotes(amoNotesOnly.addon, amoNotesOnly.versionId, notes))) {
      say("addons.mozilla.org: notes set again on the existing version.");
    }
  } catch (error) {
    throw new StoreError(`${(error as Error).message}.${done()}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------

const USAGE = `usage:
  node store-upload.mjs check --config FILE --release FILE --tag TAG [--tag-prefix v] --permissions FILE
       [--previous-permissions FILE] [--chrome-zip Z] [--firefox-zip Z] [--firefox-source S]
       --workflow FILE [--workflow FILE…] [--lint REPORT [--lint-baseline FILE]]
       [--hashes-out FILE] [--summary FILE] [--load-unpacked-zip Z]
       [--record-out FILE.json --vendor-manifest FILE [--facts FILE] [--commit SHA] [--run-id ID]
       [--ci-results FILE] [--runtimes FILE]] [--pull-request release|released]
  node store-upload.mjs status --config FILE --releases DIR [--state-in FILE] [--state-out FILE] [--summary FILE]
  node store-upload.mjs assets --record FILE.json --dir DIR --out-dir DIR
  node store-upload.mjs upload --config FILE --release FILE --targets chrome,firefox --hashes FILE
       [--chrome-zip Z] [--firefox-zip Z] [--firefox-source S] [--precheck-only] [--summary FILE]
       [--env-file FILE]`;

export async function main(argv: string[], deps: Deps = DEFAULT_DEPS): Promise<number> {
  const [command, ...rest] = argv;
  let summaryPath: string | undefined;
  if (command === "--help" || command === "-h") {
    deps.log(USAGE);
    return 0;
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        config: { type: "string" },
        release: { type: "string" },
        tag: { type: "string" },
        "tag-prefix": { type: "string", default: "v" },
        permissions: { type: "string" },
        "previous-permissions": { type: "string" },
        "chrome-zip": { type: "string" },
        "firefox-zip": { type: "string" },
        "firefox-source": { type: "string" },
        workflow: { type: "string", multiple: true },
        "hashes-out": { type: "string" },
        lint: { type: "string" },
        "lint-baseline": { type: "string" },
        hashes: { type: "string" },
        targets: { type: "string" },
        "precheck-only": { type: "boolean", default: false },
        summary: { type: "string" },
        "env-file": { type: "string" },
        "load-unpacked-zip": { type: "string" },
        "record-out": { type: "string" },
        "vendor-manifest": { type: "string" },
        facts: { type: "string" },
        commit: { type: "string" },
        "run-id": { type: "string" },
        "ci-results": { type: "string" },
        runtimes: { type: "string" },
        "pull-request": { type: "string" },
        record: { type: "string" },
        releases: { type: "string" },
        "state-in": { type: "string" },
        "state-out": { type: "string" },
        dir: { type: "string" },
        "out-dir": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help || !command) {
      deps.log(USAGE);
      return command ? 0 : 2;
    }
    if (command === "status") {
      if (values["env-file"]) throw new Usage("--env-file is for upload: status uses no credentials");
      if (!values.config || !values.releases) throw new Usage("status needs --config and --releases");
      summaryPath = values.summary;
      const { state, note, read } = readState(values["state-in"]);
      const res = await runStatus({ config: readStoreConfig(values.config), releasesDir: values.releases, state, stateRead: read }, deps);
      if (note) res.lines.splice(2, 0, `Note: ${note}`, "");
      for (const line of res.lines) deps.log(line);
      if (values.summary) appendFileSync(values.summary, `${res.lines.join("\n")}\n`);
      if (values["state-out"]) writeState(values["state-out"], res.state);
      return res.problems.length === 0 ? 0 : 1;
    }
    if (command === "assets") {
      if (!values.record || !values.dir || !values["out-dir"]) throw new Usage("assets needs --record, --dir and --out-dir");
      for (const name of releaseAssets({ recordJson: values.record, dir: values.dir, outDir: values["out-dir"] }, deps.readFile)) deps.log(`asset: ${name}`);
      return 0;
    }
    if (!values.config || !values.release) throw new Usage("--config and --release are required");
    summaryPath = values.summary;
    const writeSummary = (lines: string[]): void => {
      if (values.summary) appendFileSync(values.summary, `${lines.join("\n")}\n`);
    };
    if (command === "check") {
      if (values["env-file"]) throw new Usage("--env-file is for upload: check uses no credentials");
      if (!values.tag || !values.permissions || !values.workflow?.length) throw new Usage("check needs --tag, --permissions and --workflow");
      const pullRequest = values["pull-request"];
      if (pullRequest !== undefined && pullRequest !== "release" && pullRequest !== "released") {
        throw new Usage(`--pull-request is "release" or "released", not "${pullRequest}"`);
      }
      const res = await runCheck(
        {
          config: values.config,
          release: values.release,
          tag: values.tag,
          tagPrefix: values["tag-prefix"] as string,
          permissions: values.permissions,
          previousPermissions: values["previous-permissions"],
          chromeZip: values["chrome-zip"],
          firefoxZip: values["firefox-zip"],
          firefoxSource: values["firefox-source"],
          workflows: values.workflow,
          hashesOut: values["hashes-out"],
          lint: values.lint,
          lintBaseline: values["lint-baseline"],
          loadUnpackedZip: values["load-unpacked-zip"],
          recordOut: values["record-out"],
          vendorManifest: values["vendor-manifest"],
          facts: values.facts,
          commit: values.commit,
          runId: values["run-id"],
          ciResults: values["ci-results"],
          runtimes: values.runtimes,
          pullRequest,
        },
        deps,
      );
      for (const w of res.warnings) deps.log(warningLine(w, deps.env));
      for (const line of res.summary) deps.log(line);
      writeSummary(res.summary);
      return res.problems.length === 0 ? 0 : 1;
    }
    if (command === "upload") {
      if (!values.hashes || !values.targets) throw new Usage("upload needs --hashes and --targets");
      // The environment wins over the file.
      if (values["env-file"]) deps = { ...deps, env: { ...readEnvFile(values["env-file"]), ...deps.env } };
      const targets = values.targets.split(",").map((t) => t.trim()).filter(Boolean);
      for (const t of targets) if (t !== "chrome" && t !== "firefox") throw new Usage(`unknown target ${t}`);
      const report = (line: string): void => {
        deps.log(line);
        writeSummary([`- ${line}`]);
      };
      await runUpload(
        {
          config: values.config,
          release: values.release,
          targets: targets as Array<"chrome" | "firefox">,
          hashes: values.hashes,
          chromeZip: values["chrome-zip"],
          firefoxZip: values["firefox-zip"],
          firefoxSource: values["firefox-source"],
          precheckOnly: values["precheck-only"] as boolean,
        },
        deps,
        report,
      );
      return 0;
    }
    throw new Usage(`unknown command ${command}`);
  } catch (error) {
    if (error instanceof Usage || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      deps.log(`${(error as Error).message}\n${USAGE}`);
      return 2;
    }
    deps.log(`refused: ${(error as Error).message}`);
    if (summaryPath) appendFileSync(summaryPath, `\n**Refused:** ${(error as Error).message}\n`);
    return 1;
  }
}

/** True when this module is the script Node was started on (not imported by a test). */
function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) process.exit(await main(process.argv.slice(2)));
