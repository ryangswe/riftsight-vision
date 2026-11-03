// SPDX-License-Identifier: Apache-2.0
// node/store-*.ts: the store-upload tool. Every store call goes to a fake in this file; nothing
// here reaches the network. Made-up ids, packages and addresses only.

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { amoJwt } from "../node/store-amo.js";
import { chromeDecision } from "../node/store-chrome.js";
import {
  DENY_PATTERNS,
  denyFindings,
  deniedEnvNames,
  lintProblems,
  manifestEntry,
  notesText,
  permissionSurface,
  readReleaseFile,
  surfaceChanges,
} from "../node/store-checks.js";
import { DEFAULT_DEPS, type Deps, main, runCheck } from "../node/store-upload.js";

const TEMPLATES = join(fileURLToPath(new URL(".", import.meta.url)), "..", "templates");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the template's store/ folder plus made-up packages, in a scratch folder. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "store-upload-test-"));
  dirs.push(dir);
  cpSync(join(TEMPLATES, "store"), join(dir, "store"), { recursive: true });
  cpSync(join(TEMPLATES, "store-release.yml"), join(dir, "store-release.yml"));
  writeFileSync(join(dir, "chrome.zip"), "chrome package bytes");
  writeFileSync(join(dir, "firefox.zip"), "firefox package bytes");
  writeFileSync(join(dir, "firefox-source.zip"), "firefox source bytes");
  return dir;
}

const CHROME_MANIFEST = { version: "1.0.0", manifest_version: 3, permissions: ["storage"], optional_host_permissions: ["https://www.example.org/*"] };
const FIREFOX_MANIFEST = {
  ...CHROME_MANIFEST,
  browser_specific_settings: { gecko: { id: "{00000000-0000-0000-0000-000000000001}", data_collection_permissions: { required: ["none"] } } },
};

interface Call {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}

/** A fake of both stores (and of the "before upload" address). */
function fakeStores(
  options: {
    chromePending?: boolean;
    chromeSubmitted?: { state: string; version: string };
    amoPending?: boolean;
    amoHas?: string;
    amoPaged?: boolean;
    uploadInProgress?: boolean;
    amoValid?: boolean;
    detailsStatus?: number;
    publishStatus?: number;
  } = {},
) {
  const calls: Call[] = [];
  let asyncState = options.uploadInProgress ? "IN_PROGRESS" : "SUCCEEDED";
  let amoPolls = 0;
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    calls.push({ method, url, body: init?.body, headers });
    if (url.startsWith("https://cdn.example.org/")) return new Response("details", { status: options.detailsStatus ?? 200 });
    if (url.startsWith("https://cws.test/")) {
      if (url.endsWith(":fetchStatus")) {
        const status: Record<string, unknown> = { lastAsyncUploadState: asyncState };
        if (options.chromePending) status.submittedItemRevisionStatus = { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: "0.9.0" }] };
        if (options.chromeSubmitted) {
          status.submittedItemRevisionStatus = { state: options.chromeSubmitted.state, distributionChannels: [{ crxVersion: options.chromeSubmitted.version }] };
        }
        if (options.uploadInProgress) asyncState = "SUCCEEDED";
        return json(200, status);
      }
      if (url.endsWith(":upload")) return json(200, { uploadState: options.uploadInProgress ? "IN_PROGRESS" : "SUCCEEDED", crxVersion: "1.0.0" });
      if (url.endsWith(":publish")) {
        if (options.publishStatus) return json(options.publishStatus, { error: "publish refused" });
        return json(200, { state: "PENDING_REVIEW", warningInfo: { warnings: [{ reason: "W", description: "a warning" }] } });
      }
    }
    if (url.startsWith("https://amo.test/api/v5/")) {
      const path = url.slice("https://amo.test/api/v5/".length);
      if (method === "GET" && path.includes("/versions/?filter=")) {
        if (options.amoPaged && !path.includes("page=2")) {
          return json(200, { results: [{ id: 5, version: "0.8.0", channel: "listed", file: { status: "public" } }], next: `https://amo.test/api/v5/${path}&page=2` });
        }
        const results = [
          options.amoPending ? { id: 7, version: "0.9.0", channel: "listed", file: { status: "unreviewed" } } : { id: 6, version: "0.9.0", channel: "listed", file: { status: "public" } },
          { id: 3, version: "1.0.0", channel: "unlisted", file: { status: "public" } },
        ];
        if (options.amoHas) results.push({ id: 8, version: options.amoHas, channel: "listed", file: { status: "unreviewed" } });
        return json(200, { results, next: null });
      }
      if (method === "POST" && path === "addons/upload/") return json(201, { uuid: "u-1", processed: false });
      if (method === "GET" && path === "addons/upload/u-1/") {
        amoPolls += 1;
        return json(200, { uuid: "u-1", processed: amoPolls >= 2, valid: options.amoValid ?? true, validation: { errors: 1 } });
      }
      if (method === "POST" && path.endsWith("/versions/")) return json(201, { id: 42, version: "1.0.0" });
      if (method === "PATCH" && /\/versions\/(42|8)\/$/.test(path)) return json(200, { id: 42 });
    }
    return json(404, { error: `no fake for ${method} ${url}` });
  }) as typeof fetch;
  return { calls, fetchFn };
}

function deps(fetchFn: typeof fetch, env: Record<string, string | undefined> = {}, log: string[] = [], omit: string[] = []): Deps {
  const all: Record<string, string | undefined> = { CWS_ACCESS_TOKEN: "token", AMO_JWT_ISSUER: "user:1:2", AMO_JWT_SECRET: "secret", ...env };
  for (const name of omit) delete all[name];
  return {
    env: all,
    fetchFn,
    readFile: (p) => new Uint8Array(readFileSync(p)),
    zipManifest: (p) => ({ path: "manifest.json", manifest: (p.endsWith("firefox.zip") ? FIREFOX_MANIFEST : CHROME_MANIFEST) as Record<string, unknown> }),
    log: (line) => log.push(line),
    sleep: async () => undefined,
    chromeBase: "https://cws.test",
    amoBase: "https://amo.test",
  };
}

function checkArgv(dir: string, extra: string[] = []): string[] {
  return [
    "check",
    "--config", join(dir, "store/store.config.json"),
    "--release", join(dir, "store/releases/1.0.0.json"),
    "--tag", "v1.0.0",
    "--permissions", join(dir, "store/permissions.json"),
    "--chrome-zip", join(dir, "chrome.zip"),
    "--firefox-zip", join(dir, "firefox.zip"),
    "--firefox-source", join(dir, "firefox-source.zip"),
    "--workflow", join(dir, "store-release.yml"),
    "--hashes-out", join(dir, "hashes.json"),
    ...extra,
  ];
}

function uploadArgv(dir: string, extra: string[] = []): string[] {
  return [
    "upload",
    "--config", join(dir, "store/store.config.json"),
    "--release", join(dir, "store/releases/1.0.0.json"),
    "--targets", "chrome,firefox",
    "--hashes", join(dir, "hashes.json"),
    "--chrome-zip", join(dir, "chrome.zip"),
    "--firefox-zip", join(dir, "firefox.zip"),
    "--firefox-source", join(dir, "firefox-source.zip"),
    ...extra,
  ];
}

/** A workspace that has passed `check` (so hashes.json exists). */
async function checked(): Promise<string> {
  const dir = workspace();
  const log: string[] = [];
  expect(await main(checkArgv(dir), deps(fakeStores().fetchFn, {}, log)), log.join("\n")).toBe(0);
  return dir;
}

const uploads = (calls: Call[]): Call[] => calls.filter((c) => c.method !== "GET" && !c.url.startsWith("https://cdn.example.org/"));

describe("the pieces", () => {
  it("Chrome: a pending or staged other version blocks; this version skips; nothing pending goes", () => {
    const sub = (state: "PENDING_REVIEW" | "STAGED", v: string) => ({ submittedItemRevisionStatus: { state, distributionChannels: [{ crxVersion: v }] } });
    expect(chromeDecision(sub("PENDING_REVIEW", "0.9.0"), "1.0.0")).toEqual({ kind: "block", reason: expect.stringMatching(/pending review/) });
    expect(chromeDecision(sub("STAGED", "0.9.0"), "1.0.0")).toEqual({ kind: "block", reason: expect.stringMatching(/staged/) });
    expect(chromeDecision(sub("PENDING_REVIEW", "1.0.0"), "1.0.0").kind).toBe("skip");
    expect(chromeDecision({ publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "1.0.0" }] } }, "1.0.0").kind).toBe("skip");
    expect(chromeDecision({ lastAsyncUploadState: "IN_PROGRESS" }, "1.0.0")).toEqual({ kind: "block", reason: expect.stringMatching(/still being processed/) });
    expect(chromeDecision({ takenDown: true }, "1.0.0").kind).toBe("block");
    expect(chromeDecision({ submittedItemRevisionStatus: { state: "PUBLISHED" } }, "1.0.0")).toEqual({ kind: "go" });
    expect(chromeDecision({}, "1.0.0")).toEqual({ kind: "go" });
  });

  it("signs an addons.mozilla.org JWT with HS256, valid one minute", () => {
    const token = amoJwt("user:1:2", "secret", 1000, "jti-1");
    const [h, p, s] = token.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iss: "user:1:2", jti: "jti-1", iat: 1000, exp: 1060 });
    expect(s).toBe(createHmac("sha256", "secret").update(`${h}.${p}`).digest("base64url"));
  });

  it("reads the permission surface and names each change", () => {
    const a = permissionSurface(FIREFOX_MANIFEST);
    expect(a.data_collection).toEqual(["required:none"]);
    const b = permissionSurface({ ...FIREFOX_MANIFEST, host_permissions: ["https://a.example.org/*"], content_scripts: [{ matches: ["https://b.example.org/*"] }] });
    expect(surfaceChanges(a, b)).toEqual(["host_permissions: + https://a.example.org/*", "content_script_matches: + https://b.example.org/*"]);
    expect(surfaceChanges(b, a)).toEqual(["host_permissions: - https://a.example.org/*", "content_script_matches: - https://b.example.org/*"]);
  });

  it("finds CDN credentials and flag tools in a workflow, and the product's own denied words", () => {
    const text = "env:\n  S3_SECRET_ACCESS_KEY: x\n  run: cardvision cdn publish-release\n  featureFlags: on\n  X: ${{ secrets.MY_CDN_TOKEN }}\n  y: EXAMPLECDN_KEY";
    const found = denyFindings(text, ["EXAMPLECDN_"]);
    expect(found).toEqual(
      expect.arrayContaining(["line 2: S3_SECRET_ACCESS_KEY", "line 3: cardvision cdn", "line 4: featureFlags", "line 5: MY_CDN_TOKEN", "line 6: EXAMPLECDN_"]),
    );
    // Names that only look close are not credentials.
    expect(denyFindings("CWS_ACCESS_TOKEN AMO_JWT_SECRET GITHUB_STEP_SUMMARY STORE_TOOL BAR2_X")).toEqual([]);
    expect(denyFindings("MY_R2_KEY")).toEqual(["line 1: MY_R2_KEY"]);
    expect(deniedEnvNames({ PATH: "/bin", AWS_ACCESS_KEY_ID: "x", CWS_ACCESS_TOKEN: "y", OTHERCDN_SECRET: "z" }, ["OTHERCDN_"])).toEqual(["AWS_ACCESS_KEY_ID", "OTHERCDN_SECRET"]);
    // Older Cloudflare names, dumping every secret, passing them all on, and the Cloudflare CLI.
    for (const line of ["CF_API_TOKEN: x", "CF_ACCOUNT_ID: x", "data: ${{ toJSON(secrets) }}", "    secrets: inherit", "run: wrangler deploy"]) {
      expect(denyFindings(line), line).not.toEqual([]);
    }
    // What a runner and the Google sign-in step set are not credentials.
    expect(
      deniedEnvNames({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x", ACTIONS_RUNTIME_TOKEN: "x", GOOGLE_APPLICATION_CREDENTIALS: "x", CLOUDSDK_CORE_PROJECT: "x", RUNNER_TEMP: "x", AWS_REGION: "x" }),
    ).toEqual([]);
    expect(DENY_PATTERNS.length).toBeGreaterThan(0);
  });

  it("the template workflow names no denied word, runs the upload in the store environment after the build", () => {
    const text = readFileSync(join(TEMPLATES, "store-release.yml"), "utf-8");
    const config = JSON.parse(readFileSync(join(TEMPLATES, "store/store.config.json"), "utf-8")) as { deny: string[] };
    expect(denyFindings(text, config.deny)).toEqual([]);
    expect(text).toMatch(/\n {2}upload:\n(?:.*\n)*? {4}needs: build\n(?:.*\n)*? {4}environment: store\n/);
    expect(text).toMatch(/tags: \["v\*"\]/);
    expect(text).toMatch(/\n {2}TAG_PREFIX: v\n/);
    expect(text).toMatch(/--tag-prefix "\$TAG_PREFIX"/);
    expect(text).toMatch(/--lint out\/lint\.json --lint-baseline store\/lint-baseline\.json/);
    expect(text).not.toMatch(/TAG#v/);
    // A run from a branch is refused, so the workflow checked is the one running.
    expect(text).not.toMatch(/inputs\.tag/);
    expect(text).toMatch(/if: github\.ref_type != 'tag'/);
    expect(text).toMatch(/concurrency:\n {6}group: store-upload\n {6}cancel-in-progress: false/);
    expect(text).toMatch(/create_credentials_file: false/);
    expect(text).toMatch(/export_environment_variables: false/);
    // Store credentials appear only in the upload job.
    const build = text.slice(text.indexOf("\n  build:"), text.indexOf("\n  upload:"));
    expect(build).not.toMatch(/secrets\.|CWS_ACCESS_TOKEN|id-token/);
  });

  it("the template finds the newest earlier release tag of its own prefix, without pre-releases", () => {
    const text = readFileSync(join(TEMPLATES, "store-release.yml"), "utf-8");
    const step = text.slice(text.indexOf("- name: The previous release's permissions"));
    const lines = step.split("\n");
    const start = lines.findIndex((l) => l.trim() === "run: |") + 1;
    const body: string[] = [];
    for (const l of lines.slice(start)) {
      if (l.trim() !== "" && !l.startsWith("          ")) break;
      body.push(l.slice(10));
    }
    const dir = mkdtempSync(join(tmpdir(), "store-upload-test-"));
    dirs.push(dir);
    // A stand-in git: `tag` prints TAGS (newest first, as --sort=-v:refname does) filtered by the
    // --list pattern; `cat-file -e` succeeds; `show` prints what it was asked for.
    const git = `git() { case "$1" in
      tag) for t in $TAGS; do case "$t" in $3) echo "$t" ;; esac; done ;;
      cat-file) return 0 ;;
      show) echo "$2" ;;
    esac; }`;
    const previous = (tag: string, prefix: string, tags: string): string => {
      const env = join(dir, "env");
      writeFileSync(env, "");
      execFileSync("bash", ["-eo", "pipefail", "-c", `${git}\nmkdir -p out\n${body.join("\n")}`], {
        cwd: dir,
        env: { PATH: process.env.PATH, TAG: tag, TAG_PREFIX: prefix, TAGS: tags, GITHUB_ENV: env },
      });
      const chosen = join(dir, "out/previous-permissions.json");
      const text = readFileSync(env, "utf-8") === "" ? "" : readFileSync(chosen, "utf-8").trim();
      rmSync(join(dir, "out"), { recursive: true, force: true });
      return text;
    };
    expect(previous("v1.3.0", "v", "v1.3.0 v1.3.0-rc1 v1.2.0 v1.1.0")).toBe("v1.2.0:store/permissions.json");
    expect(previous("extension-v1.4.0", "extension-v", "extension-v1.4.0 extension-v1.4.0-rc1 extension-v1.3.0 v9.0.0")).toBe("extension-v1.3.0:store/permissions.json");
    // The first release of a prefix has no previous one, even beside other products' tags.
    expect(previous("extension-v1.3.0", "extension-v", "extension-v1.3.0 extension-v1.3.0-rc2 v9.0.0")).toBe("");
  });

  it("finds a package's manifest at the root or in one top-level folder", () => {
    expect(manifestEntry(["manifest.json", "dist/a.js"])).toBe("manifest.json");
    expect(manifestEntry(["ext/", "ext/manifest.json", "ext/dist/", "ext/dist/a.js", ""])).toBe("ext/manifest.json");
    expect(manifestEntry(["ext/manifest.json", "other/a.js"])).toBeNull();
    expect(manifestEntry(["ext/manifest.json", "README.md"])).toBeNull();
    expect(manifestEntry(["ext/sub/manifest.json"])).toBeNull();
    expect(manifestEntry([])).toBeNull();
    expect(manifestEntry(["ext/", "ext/manifest.json", "__MACOSX/", "__MACOSX/ext/._manifest.json"])).toBe("ext/manifest.json");
  });

  it("reads the manifest of a real zip, at its root or in its one folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-upload-test-"));
    dirs.push(dir);
    const make = (name: string, folder: string): string => {
      const src = join(dir, `${name}-src`);
      mkdirSync(join(src, folder, "dist"), { recursive: true });
      writeFileSync(join(src, folder, "manifest.json"), JSON.stringify({ ...CHROME_MANIFEST, name }));
      writeFileSync(join(src, folder, "dist", "a.js"), "export {};");
      execFileSync("zip", ["-q", "-r", join(dir, `${name}.zip`), folder === "" ? "." : folder], { cwd: src });
      return join(dir, `${name}.zip`);
    };
    expect(DEFAULT_DEPS.zipManifest(make("root", ""))).toEqual({ path: "manifest.json", manifest: { ...CHROME_MANIFEST, name: "root" } });
    expect(DEFAULT_DEPS.zipManifest(make("folder", "my-ext"))).toEqual({ path: "my-ext/manifest.json", manifest: { ...CHROME_MANIFEST, name: "folder" } });
    expect(() => DEFAULT_DEPS.zipManifest(make("pattern", "e[x]t"))).toThrow(/rename the folder e\[x\]t/);
  });

  it("lint: errors fail, warnings beyond the baseline fail, baseline entries no longer warned are named", () => {
    const w = (code: string, file: string) => ({ code, file });
    const report = { errors: [], warnings: [w("DANGEROUS_EVAL", "a.js"), w("DANGEROUS_EVAL", "a.js"), w("UNSAFE_VAR_ASSIGNMENT", "b.js")] };
    expect(lintProblems(report, [w("DANGEROUS_EVAL", "a.js"), w("DANGEROUS_EVAL", "a.js"), w("UNSAFE_VAR_ASSIGNMENT", "b.js")])).toEqual({ problems: [], gone: [] });
    const res = lintProblems(report, [w("DANGEROUS_EVAL", "a.js"), w("INCOMPATIBLE_API", "c.js")]);
    expect(res.problems).toEqual(["new lint warning DANGEROUS_EVAL in a.js (not in the baseline)", "new lint warning UNSAFE_VAR_ASSIGNMENT in b.js (not in the baseline)"]);
    expect(res.gone).toEqual([w("INCOMPATIBLE_API", "c.js")]);
    expect(lintProblems({ errors: [w("MANIFEST_FIELD_INVALID", "manifest.json")], warnings: [] }, []).problems).toEqual(["lint error MANIFEST_FIELD_INVALID in manifest.json"]);
  });

  it("a notes file's leading license comment is not part of the notes", () => {
    expect(notesText("<!-- SPDX-License-Identifier: Apache-2.0 -->\n\nCards can be larger.\n")).toBe("Cards can be larger.");
    expect(notesText("Plain notes.\n<!-- SPDX-License-Identifier: Apache-2.0 -->")).toBe("Plain notes.\n<!-- SPDX-License-Identifier: Apache-2.0 -->");
  });

  it("refuses a release file with an unknown key or a bad value", () => {
    const dir = workspace();
    const path = join(dir, "r.json");
    for (const [body, message] of [
      [{ version: "1.0.0", chrome: { submit: "yes", publish: "default" } }, /submit/],
      [{ version: "1.0.0", extra: 1 }, /unknown key "extra"/],
      [{ version: "1.0.0", before: [{ url: "http://x.example.org/" }] }, /https url/],
      [{ version: "1.0.0", before: [{ url: "https://x.example.org/", sha256: "abc" }] }, /64 hex/],
    ] as Array<[unknown, RegExp]>) {
      writeFileSync(path, JSON.stringify(body));
      expect(() => readReleaseFile(path)).toThrow(message);
    }
  });
});

describe("check (the build job)", () => {
  it("passes the template's own files and records the packages' hashes", async () => {
    const dir = workspace();
    const log: string[] = [];
    expect(await main(checkArgv(dir), deps(fakeStores().fetchFn, {}, log))).toBe(0);
    const hashes = JSON.parse(readFileSync(join(dir, "hashes.json"), "utf-8")) as Record<string, string>;
    expect(Object.keys(hashes).sort()).toEqual(["chrome.zip", "firefox-source.zip", "firefox.zip"]);
    expect(log.join("\n")).toMatch(/All checks passed/);
    expect(log.join("\n")).toMatch(/Cards can be shown larger/);
  });

  it("refuses a tag, a version, a key, a permission change, a down address and a denied word", async () => {
    const dir = workspace();
    writeFileSync(join(dir, "store-release.yml"), `${readFileSync(join(dir, "store-release.yml"), "utf-8")}\n# EXAMPLE_CDN_SECRET\n`);
    const d = deps(fakeStores({ detailsStatus: 404 }).fetchFn);
    d.zipManifest = (p) => ({
      path: "manifest.json",
      manifest: (p.endsWith("firefox.zip")
        ? { ...FIREFOX_MANIFEST, version: "1.0.1" }
        : { ...CHROME_MANIFEST, key: "k", host_permissions: ["https://x.example.org/*"] }) as Record<string, unknown>,
    });
    const res = await runCheck(
      {
        config: join(dir, "store/store.config.json"),
        release: join(dir, "store/releases/1.0.0.json"),
        tag: "v1.0.1",
        tagPrefix: "v",
        permissions: join(dir, "store/permissions.json"),
        chromeZip: join(dir, "chrome.zip"),
        firefoxZip: join(dir, "firefox.zip"),
        workflows: [join(dir, "store-release.yml")],
      },
      d,
    );
    const text = res.problems.join("\n");
    expect(text).toMatch(/the tag v1.0.1 is not v1.0.0/);
    expect(text).toMatch(/firefox.zip is version 1.0.1/);
    expect(text).toMatch(/carries a key/);
    expect(text).toMatch(/chrome: the package's permissions differ.*host_permissions: \+ https:\/\/x.example.org/);
    expect(text).toMatch(/before upload: https:\/\/cdn.example.org\/data\/details-1.json: HTTP 404/);
    expect(text).toMatch(/mentions a denied name \(line \d+: EXAMPLE_CDN_SECRET\)/);
  });

  it("a Chrome zip may keep its files in a folder; a Firefox zip may not", async () => {
    const dir = workspace();
    const d = deps(fakeStores().fetchFn);
    const inFolder = (p: string) => ({ path: "ext/manifest.json", manifest: (p.endsWith("firefox.zip") ? FIREFOX_MANIFEST : CHROME_MANIFEST) as Record<string, unknown> });
    d.zipManifest = (p) => (p.endsWith("chrome.zip") ? inFolder(p) : { path: "manifest.json", manifest: FIREFOX_MANIFEST as Record<string, unknown> });
    const log: string[] = [];
    d.log = (line) => log.push(line);
    expect(await main(checkArgv(dir), d), log.join("\n")).toBe(0);
    expect(log.join("\n")).toMatch(/chrome: `chrome.zip` \d+ bytes, files in `ext\/`/);
    d.zipManifest = inFolder;
    expect(await main(checkArgv(dir), d)).toBe(1);
    const res = await runCheck(
      {
        config: join(dir, "store/store.config.json"),
        release: join(dir, "store/releases/1.0.0.json"),
        tag: "v1.0.0",
        tagPrefix: "v",
        permissions: join(dir, "store/permissions.json"),
        firefoxZip: join(dir, "firefox.zip"),
        workflows: [join(dir, "store-release.yml")],
      },
      d,
    );
    expect(res.problems).toEqual(["firefox.zip: addons.mozilla.org needs manifest.json at the zip's root, not ext/manifest.json"]);
  });

  it("checks a release tag with another prefix", async () => {
    const dir = workspace();
    expect(await main(checkArgv(dir).map((a) => (a === "v1.0.0" ? "extension-v1.0.0" : a)).concat(["--tag-prefix", "extension-v"]), deps(fakeStores().fetchFn))).toBe(0);
    const log: string[] = [];
    expect(await main(checkArgv(dir).map((a) => (a === "v1.0.0" ? "extension-v1.0.0" : a)), deps(fakeStores().fetchFn, {}, log))).toBe(1);
  });

  it("checks the Firefox lint report against the product's baseline", async () => {
    const dir = workspace();
    const report = (warnings: Array<{ code: string; file: string }>, errors: Array<{ code: string; file: string }> = []) => {
      writeFileSync(join(dir, "lint.json"), JSON.stringify({ count: warnings.length + errors.length, summary: {}, errors, notices: [{ code: "N", file: "x" }], warnings }));
    };
    const lint = ["--lint", join(dir, "lint.json"), "--lint-baseline", join(dir, "store/lint-baseline.json")];
    report([]);
    expect(await main(checkArgv(dir, lint), deps(fakeStores().fetchFn))).toBe(0);
    report([{ code: "DANGEROUS_EVAL", file: "dist/a.js" }]);
    const log: string[] = [];
    expect(await main(checkArgv(dir, lint), deps(fakeStores().fetchFn, {}, log))).toBe(1);
    writeFileSync(join(dir, "store/lint-baseline.json"), JSON.stringify({ warnings: [{ code: "DANGEROUS_EVAL", file: "dist/a.js", why: "wasm glue" }] }));
    const ok: string[] = [];
    expect(await main(checkArgv(dir, lint), deps(fakeStores().fetchFn, {}, ok))).toBe(0);
    expect(ok.join("\n")).toMatch(/firefox lint: 0 errors, 1 warnings \(1 in the baseline\)/);
    report([], [{ code: "JSON_INVALID", file: "manifest.json" }]);
    expect(await main(checkArgv(dir, lint), deps(fakeStores().fetchFn))).toBe(1);
    report([]);
    const gone: string[] = [];
    expect(await main(checkArgv(dir, lint), deps(fakeStores().fetchFn, {}, gone))).toBe(0);
    expect(gone.join("\n")).toMatch(/no longer warned, can leave the baseline: DANGEROUS_EVAL in dist\/a.js/);
    writeFileSync(join(dir, "lint.json"), "web-ext crashed");
    expect(await main(checkArgv(dir, lint), deps(fakeStores().fetchFn))).toBe(1);
    expect(await main(checkArgv(dir, ["--lint-baseline", join(dir, "store/lint-baseline.json")]), deps(fakeStores().fetchFn))).toBe(1);
    report([]);
    const missing: string[] = [];
    expect(await main(checkArgv(dir, ["--lint", join(dir, "lint.json"), "--lint-baseline", join(dir, "store/none.json")]), deps(fakeStores().fetchFn, {}, missing))).toBe(1);
    expect(missing.join("\n")).toMatch(/none\.json: .*starts it from the template's store\/lint-baseline\.json/);
    const without: string[] = [];
    expect(await main(checkArgv(dir), deps(fakeStores().fetchFn, {}, without))).toBe(0);
    expect(without.join("\n")).toMatch(/firefox lint: no report given \(--lint\), not checked/);
  });

  it("a change since the previous release needs permissionsChanged, and the flag needs a change", async () => {
    const dir = workspace();
    const previous = JSON.parse(readFileSync(join(dir, "store/permissions.json"), "utf-8")) as Record<string, { permissions: string[] }>;
    previous.chrome!.permissions = [];
    writeFileSync(join(dir, "previous.json"), JSON.stringify(previous));
    const flagged = (await main(checkArgv(dir, ["--previous-permissions", join(dir, "previous.json")]), deps(fakeStores().fetchFn)));
    expect(flagged).toBe(1);
    const release = JSON.parse(readFileSync(join(dir, "store/releases/1.0.0.json"), "utf-8")) as Record<string, unknown>;
    writeFileSync(join(dir, "store/releases/1.0.0.json"), JSON.stringify({ ...release, permissionsChanged: true }));
    expect(await main(checkArgv(dir, ["--previous-permissions", join(dir, "previous.json")]), deps(fakeStores().fetchFn))).toBe(0);
    expect(await main(checkArgv(dir, ["--previous-permissions", join(dir, "store/permissions.json")]), deps(fakeStores().fetchFn))).toBe(1);
  });
});

describe("upload (the approved job)", () => {
  it("checks both stores, then uploads to Chrome, submits it, and submits Firefox with its source and notes", async () => {
    const dir = await checked();
    const stores = fakeStores();
    const log: string[] = [];
    expect(await main(uploadArgv(dir), deps(stores.fetchFn, {}, log)), log.join("\n")).toBe(0);
    const order = uploads(stores.calls).map((c) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+\//, "")}`);
    // Firefox is validated first (nothing on the listing yet), then Chrome, then the Firefox version.
    expect(order).toEqual([
      "POST api/v5/addons/upload/",
      "POST upload/v2/publishers/00000000-0000-0000-0000-000000000000/items/abcdefghijklmnopabcdefghijklmnop:upload",
      "POST v2/publishers/00000000-0000-0000-0000-000000000000/items/abcdefghijklmnopabcdefghijklmnop:publish",
      "POST api/v5/addons/addon/example-addon/versions/",
      "PATCH api/v5/addons/addon/example-addon/versions/42/",
    ]);
    // Both prechecks ran before the first upload.
    const firstUpload = stores.calls.findIndex((c) => c.method === "POST");
    expect(stores.calls.slice(0, firstUpload).map((c) => c.url)).toEqual(
      expect.arrayContaining([expect.stringMatching(/:fetchStatus$/), expect.stringMatching(/versions\/\?filter=all_without_unlisted/)]),
    );
    const publish = stores.calls.find((c) => c.url.endsWith(":publish"))!;
    expect(JSON.parse(String(publish.body))).toEqual({ publishType: "DEFAULT_PUBLISH" });
    expect(publish.headers.Authorization).toBe("Bearer token");
    const create = stores.calls.find((c) => c.url.endsWith("/versions/") && c.method === "POST")!;
    const form = create.body as FormData;
    expect(form.get("upload")).toBe("u-1");
    expect(await (form.get("source") as Blob).text()).toBe("firefox source bytes");
    const patch = stores.calls.find((c) => c.method === "PATCH")!;
    expect(JSON.parse(String(patch.body))).toEqual({
      release_notes: { "en-US": "Cards can be shown larger." },
      approval_notes: "The source archive builds the package with ./build.sh; see its README.",
    });
    expect(patch.headers.Authorization).toMatch(/^JWT [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(log.join("\n")).toMatch(/Chrome Web Store warning: W: a warning/);
  });

  it("uploads nothing when Chrome has a submission pending review", async () => {
    const dir = await checked();
    const stores = fakeStores({ chromePending: true });
    const log: string[] = [];
    expect(await main(uploadArgv(dir), deps(stores.fetchFn, {}, log))).toBe(1);
    expect(uploads(stores.calls)).toEqual([]);
    expect(log.join("\n")).toMatch(/nothing was uploaded: Chrome Web Store: a submission is pending review/);
  });

  it("uploads nothing when a 'before upload' address is no longer live at approval", async () => {
    const dir = await checked();
    const stores = fakeStores({ detailsStatus: 404 });
    const log: string[] = [];
    expect(await main(uploadArgv(dir), deps(stores.fetchFn, {}, log))).toBe(1);
    expect(uploads(stores.calls)).toEqual([]);
    expect(log.join("\n")).toMatch(/nothing was uploaded: before upload: .*HTTP 404/);
  });

  it("a Firefox validation failure leaves Chrome untouched", async () => {
    const dir = await checked();
    const stores = fakeStores({ amoValid: false });
    const log: string[] = [];
    expect(await main(uploadArgv(dir), deps(stores.fetchFn, {}, log))).toBe(1);
    expect(stores.calls.some((c) => c.url.startsWith("https://cws.test/") && c.method === "POST")).toBe(false);
    expect(log.join("\n")).toMatch(/validation failed/);
  });

  it("a failure after a store succeeded says what was done; a re-run skips that store and finishes", async () => {
    const dir = await checked();
    const summary = join(dir, "summary.md");
    const first = fakeStores({ publishStatus: 500 });
    const log: string[] = [];
    expect(await main(uploadArgv(dir, ["--summary", summary]), deps(first.fetchFn, {}, log))).toBe(1);
    const text = log.join("\n");
    expect(text).toMatch(/refused: Chrome Web Store POST .*:publish: HTTP 500.*Done before this: .*the package passed validation\. Chrome Web Store: uploaded/);
    expect(readFileSync(summary, "utf-8")).toMatch(/- Chrome Web Store: uploaded[\s\S]*\n\*\*Refused:\*\*/);
    expect(first.calls.some((c) => c.url.endsWith("/versions/") && c.method === "POST")).toBe(false);

    // The re-run: Chrome has this version already (here, submitted by hand meanwhile), Firefox not.
    const again = fakeStores({ chromeSubmitted: { state: "PENDING_REVIEW", version: "1.0.0" } });
    const log2: string[] = [];
    expect(await main(uploadArgv(dir), deps(again.fetchFn, {}, log2)), log2.join("\n")).toBe(0);
    expect(log2.join("\n")).toMatch(/Chrome Web Store: skipped, version 1.0.0 is already submitted/);
    expect(again.calls.some((c) => c.url.startsWith("https://cws.test/") && c.method === "POST")).toBe(false);
    expect(log2.join("\n")).toMatch(/addons.mozilla.org: version 1.0.0 submitted for review/);
  });

  it("skips Firefox when this version is already on addons.mozilla.org (setting its notes again), and blocks on a staged Chrome revision", async () => {
    const dir = await checked();
    const a = fakeStores({ amoHas: "1.0.0" });
    const log: string[] = [];
    expect(await main(uploadArgv(dir), deps(a.fetchFn, {}, log)), log.join("\n")).toBe(0);
    expect(log.join("\n")).toMatch(/addons.mozilla.org: skipped, version 1.0.0 is already submitted[\s\S]*notes set again on the existing version/);
    const amoWrites = a.calls.filter((c) => c.url.startsWith("https://amo.test/") && c.method !== "GET");
    expect(amoWrites.map((c) => `${c.method} ${c.url}`)).toEqual(["PATCH https://amo.test/api/v5/addons/addon/example-addon/versions/8/"]);

    const b = fakeStores({ chromeSubmitted: { state: "STAGED", version: "0.9.0" } });
    const log2: string[] = [];
    expect(await main(uploadArgv(dir), deps(b.fetchFn, {}, log2))).toBe(1);
    expect(uploads(b.calls)).toEqual([]);
    expect(log2.join("\n")).toMatch(/staged, waiting for its manual publish/);
  });

  it("reads every page of addons.mozilla.org versions, on the same host", async () => {
    const dir = await checked();
    const a = fakeStores({ amoPaged: true, amoPending: true });
    const log: string[] = [];
    expect(await main(uploadArgv(dir, ["--precheck-only"]), deps(a.fetchFn, {}, log))).toBe(1);
    const lists = a.calls.filter((c) => c.url.includes("/versions/?filter="));
    expect(lists.map((c) => c.url)).toEqual([
      "https://amo.test/api/v5/addons/addon/example-addon/versions/?filter=all_without_unlisted&page_size=50",
      "https://amo.test/api/v5/addons/addon/example-addon/versions/?filter=all_without_unlisted&page_size=50&page=2",
    ]);
    // A fresh JWT on each call.
    expect(new Set(lists.map((c) => c.headers.Authorization)).size).toBe(2);
    expect(log.join("\n")).toMatch(/listed version 0.9.0 is awaiting review/);
  });

  it("uploads nothing when a Firefox version awaits review, Chrome included", async () => {
    const dir = await checked();
    const stores = fakeStores({ amoPending: true });
    const log: string[] = [];
    expect(await main(uploadArgv(dir), deps(stores.fetchFn, {}, log))).toBe(1);
    expect(uploads(stores.calls)).toEqual([]);
    expect(log.join("\n")).toMatch(/listed version 0.9.0 is awaiting review/);
  });

  it("refuses a package the build job did not check, and an environment holding a CDN credential", async () => {
    const dir = await checked();
    writeFileSync(join(dir, "chrome.zip"), "other bytes");
    const stores = fakeStores();
    const log: string[] = [];
    expect(await main(uploadArgv(dir), deps(stores.fetchFn, {}, log))).toBe(1);
    expect(log.join("\n")).toMatch(/chrome package chrome.zip is not the one the build job checked/);
    expect(stores.calls).toEqual([]);

    const dir2 = await checked();
    const log2: string[] = [];
    expect(await main(uploadArgv(dir2), deps(stores.fetchFn, { CLOUDFLARE_API_TOKEN: "x" }, log2))).toBe(1);
    expect(log2.join("\n")).toMatch(/environment holds denied names: CLOUDFLARE_API_TOKEN/);
    const log3: string[] = [];
    expect(await main(uploadArgv(dir2), deps(stores.fetchFn, { EXAMPLE_CDN_SECRET: "x" }, log3))).toBe(1);
    expect(log3.join("\n")).toMatch(/EXAMPLE_CDN_SECRET/);
    expect(stores.calls).toEqual([]);
  });

  it("upload-only leaves Chrome unsubmitted; staged asks for a staged publish", async () => {
    const dir = await checked();
    const path = join(dir, "store/releases/1.0.0.json");
    const release = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...release, chrome: { submit: "upload-only", publish: "default" } }));
    const a = fakeStores();
    const log: string[] = [];
    expect(await main(uploadArgv(dir, ["--targets", "chrome"]), deps(a.fetchFn, {}, log))).toBe(0);
    expect(a.calls.some((c) => c.url.endsWith(":publish"))).toBe(false);
    expect(log.join("\n")).toMatch(/not submitted. Paste the listing text/);

    writeFileSync(path, JSON.stringify({ ...release, chrome: { submit: "auto", publish: "staged" } }));
    const b = fakeStores();
    expect(await main(uploadArgv(dir, ["--targets", "chrome"]), deps(b.fetchFn))).toBe(0);
    expect(JSON.parse(String(b.calls.find((c) => c.url.endsWith(":publish"))!.body))).toEqual({ publishType: "STAGED_PUBLISH" });
  });

  it("waits for an upload the store is still processing; stops on a failed validation", async () => {
    const dir = await checked();
    const a = fakeStores({ uploadInProgress: true });
    // The precheck must not see IN_PROGRESS here: the fake reports it only after the upload.
    const log: string[] = [];
    const d = deps(a.fetchFn, {}, log);
    const status = { first: true };
    const inner = d.fetchFn;
    d.fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith(":fetchStatus") && status.first) {
        status.first = false;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return inner(input, init);
    }) as typeof fetch;
    expect(await main(uploadArgv(dir, ["--targets", "chrome"]), d), log.join("\n")).toBe(0);
    expect(log.join("\n")).toMatch(/uploaded \(SUCCEEDED/);

    const b = fakeStores({ amoValid: false });
    const log2: string[] = [];
    expect(await main(uploadArgv(dir, ["--targets", "firefox"]), deps(b.fetchFn, {}, log2))).toBe(1);
    expect(log2.join("\n")).toMatch(/validation failed/);
    expect(b.calls.some((c) => c.url.endsWith("/versions/") && c.method === "POST")).toBe(false);
  });

  it("--precheck-only checks and uploads nothing", async () => {
    const dir = await checked();
    const stores = fakeStores();
    const log: string[] = [];
    expect(await main(uploadArgv(dir, ["--precheck-only"]), deps(stores.fetchFn, {}, log))).toBe(0);
    expect(uploads(stores.calls)).toEqual([]);
    expect(log.join("\n")).toMatch(/Prechecks passed: chrome, firefox/);
  });

  it("needs its credentials from the environment", async () => {
    const dir = await checked();
    const log: string[] = [];
    expect(await main(uploadArgv(dir), deps(fakeStores().fetchFn, {}, log, ["CWS_ACCESS_TOKEN"]))).toBe(1);
    expect(log.join("\n")).toMatch(/CWS_ACCESS_TOKEN is not set/);
  });

  it("usage errors exit 2", async () => {
    const log: string[] = [];
    expect(await main(["upload"], deps(fakeStores().fetchFn, {}, log))).toBe(2);
    expect(await main(["--help"], deps(fakeStores().fetchFn, {}, log))).toBe(0);
    expect(await main([], deps(fakeStores().fetchFn, {}, log))).toBe(2);
    expect(await main(["nope", "--config", "a", "--release", "b"], deps(fakeStores().fetchFn, {}, log))).toBe(2);
  });
});
