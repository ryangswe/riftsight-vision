// SPDX-License-Identifier: Apache-2.0
// Uploading an extension release to the Chrome Web Store and addons.mozilla.org from a workflow.
// Two commands, one per job (docs/store-uploads.md):
//
//   node store-upload.mjs check --config store/store.config.json --release store/releases/<v>.json
//        --tag <tag> --permissions store/permissions.json [--previous-permissions FILE]
//        [--chrome-zip Z] [--firefox-zip Z] [--firefox-source S] --workflow FILE...
//        [--lint REPORT [--lint-baseline FILE]] [--hashes-out FILE] [--summary FILE]
//
//     The build job's last step, with no store access: the files agree with each other and with
//     the tag, the permission surface is the one committed (and a change is acknowledged), the
//     notes exist, the "before upload" addresses answer, the workflow mentions no CDN
//     credential, and the Firefox lint has no error and no warning outside the product's
//     baseline. A Chrome zip may keep its files in one top-level folder; a Firefox zip may not.
//     Writes the packages' sha256 to --hashes-out and a summary for the run page.
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

export interface Deps {
  env: Record<string, string | undefined>;
  fetchFn: typeof fetch;
  readFile: (path: string) => Uint8Array;
  /** A zip's manifest.json and where it is in the zip (`manifestEntry`). */
  zipManifest: (zipPath: string) => { path: string; manifest: Record<string, unknown> };
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Origins of the store APIs (tests). */
  chromeBase?: string;
  amoBase?: string;
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

export const DEFAULT_DEPS: Deps = {
  env: process.env,
  fetchFn: fetch,
  readFile: (p) => new Uint8Array(readFileSync(p)),
  zipManifest: defaultZipManifest,
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
}

/** Everything the build job verifies. Returns the problems (empty: pass) and the summary. */
export async function runCheck(a: CheckArgs, deps: Deps): Promise<{ problems: string[]; summary: string[]; hashes: Record<string, string> }> {
  const problems: string[] = [];
  const summary: string[] = [];
  const config: StoreConfig = readStoreConfig(a.config);
  const release: ReleaseFile = readReleaseFile(a.release);
  summary.push(`## Store release ${release.version}`, "");

  if (a.tag !== `${a.tagPrefix}${release.version}`) problems.push(`the tag ${a.tag} is not ${a.tagPrefix}${release.version}`);

  // No CDN credential or flag tool in any workflow file.
  for (const w of a.workflows) {
    for (const f of denyFindings(readFileSync(w, "utf-8"), config.deny)) problems.push(`${w} mentions a denied name (${f})`);
  }

  const committed = surfaceFile(a.permissions);
  const previous = a.previousPermissions ? surfaceFile(a.previousPermissions) : null;
  const hashes: Record<string, string> = {};
  const targets: Array<["chrome" | "firefox", string | undefined]> = [
    ["chrome", a.chromeZip],
    ["firefox", a.firefoxZip],
  ];
  let changed = false;
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
      if (diff.length > 0) {
        changed = true;
        summary.push(`**${target} permission change:** ${diff.join("; ")}`, "");
      }
    }
    const bytes = deps.readFile(zip);
    hashes[basename(zip)] = sha256(bytes);
    const folder = manifestPath === "manifest.json" ? "" : `, files in \`${manifestPath.slice(0, -"manifest.json".length)}\``;
    summary.push(`- ${target}: \`${basename(zip)}\` ${bytes.length} bytes${folder}, sha256 \`${hashes[basename(zip)]}\``);
  }
  if (a.firefoxSource) {
    const bytes = deps.readFile(a.firefoxSource);
    hashes[basename(a.firefoxSource)] = sha256(bytes);
    summary.push(`- firefox source: \`${basename(a.firefoxSource)}\` sha256 \`${hashes[basename(a.firefoxSource)]}\``);
  } else if (a.firefoxZip) {
    summary.push("- firefox source: none (the add-on's code is not minified or generated)");
  }
  if (a.lintBaseline && !a.lint) problems.push("--lint-baseline needs --lint (the web-ext lint JSON report)");
  if (!a.lint && a.firefoxZip) summary.push("- firefox lint: no report given (--lint), not checked");
  if (a.lint) {
    const baseline = a.lintBaseline ? readLintBaseline(a.lintBaseline) : [];
    const report = readLintReport(a.lint);
    const lint = lintProblems(report, baseline);
    problems.push(...lint.problems);
    const known = report.warnings.length - lint.problems.filter((p) => p.startsWith("new lint warning")).length;
    summary.push(`- firefox lint: ${report.errors.length} errors, ${report.warnings.length} warnings (${known} in the baseline)`);
    if (lint.gone.length > 0) {
      summary.push(`- firefox lint: no longer warned, can leave the baseline: ${lint.gone.map((f) => `${f.code} in ${f.file}`).join("; ")}`);
    }
  }
  if (!previous && (a.chromeZip || a.firefoxZip)) {
    summary.push("", "No previous release's permissions: not compared.");
  }
  if (previous) {
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
  try {
    const notes = readNotes(a.release, release);
    for (const [locale, text] of Object.entries(notes.releaseNotes ?? {})) summary.push("", `Firefox release notes (${locale}):`, "", ...text.split("\n").map((l) => `> ${l}`));
    if (notes.approvalNotes) summary.push("", "Firefox notes to reviewers:", "", ...notes.approvalNotes.split("\n").map((l) => `> ${l}`));
  } catch (error) {
    problems.push((error as Error).message);
  }

  for (const p of await beforeProblems(release, deps.fetchFn)) problems.push(`before upload: ${p}`);
  if ((release.before ?? []).length > 0) summary.push("", `Before upload: ${(release.before ?? []).length} address(es) checked.`);

  if (a.hashesOut) writeFileSync(a.hashesOut, `${JSON.stringify(hashes, null, 2)}\n`);
  summary.push("", problems.length === 0 ? "**All checks passed.**" : `**${problems.length} problem(s):**`, ...problems.map((p) => `- ${p}`));
  return { problems, summary, hashes };
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
  const notes = readNotes(a.release, release);

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
       [--hashes-out FILE] [--summary FILE]
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
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help || !command) {
      deps.log(USAGE);
      return command ? 0 : 2;
    }
    if (!values.config || !values.release) throw new Usage("--config and --release are required");
    summaryPath = values.summary;
    const writeSummary = (lines: string[]): void => {
      if (values.summary) appendFileSync(values.summary, `${lines.join("\n")}\n`);
    };
    if (command === "check") {
      if (values["env-file"]) throw new Usage("--env-file is for upload: check uses no credentials");
      if (!values.tag || !values.permissions || !values.workflow?.length) throw new Usage("check needs --tag, --permissions and --workflow");
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
        },
        deps,
      );
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
