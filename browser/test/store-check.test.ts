// SPDX-License-Identifier: Apache-2.0
// `store-upload.mjs check --pull-request` and templates/store-check.yml: the store check on a pull
// request, before any tag. Every address goes to a fake in this file; nothing here reaches the
// network. Made-up ids, packages and addresses only.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { type Deps, main, runCheck, warningLine } from "../node/store-upload.js";

const TEMPLATES = join(fileURLToPath(new URL(".", import.meta.url)), "..", "templates");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CHROME_MANIFEST = { version: "1.0.0", manifest_version: 3, permissions: ["storage"], optional_host_permissions: ["https://www.example.org/*"] };
const FIREFOX_MANIFEST = {
  ...CHROME_MANIFEST,
  browser_specific_settings: { gecko: { id: "{00000000-0000-0000-0000-000000000001}", data_collection_permissions: { required: ["none"] } } },
};

/** The template's store/ folder and both workflows, made-up packages, a vendor manifest and a runtime table. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "store-check-test-"));
  dirs.push(dir);
  cpSync(join(TEMPLATES, "store"), join(dir, "store"), { recursive: true });
  cpSync(join(TEMPLATES, "store-release.yml"), join(dir, "store-release.yml"));
  cpSync(join(TEMPLATES, "store-check.yml"), join(dir, "store-check.yml"));
  writeFileSync(join(dir, "chrome.zip"), "chrome package bytes");
  writeFileSync(join(dir, "firefox.zip"), "firefox package bytes");
  mkdirSync(join(dir, "cdn"));
  writeFileSync(join(dir, "cdn/RUNTIMES.json"), JSON.stringify({ "1.0.0": { ortWeb: "1.29.0", bundledRelease: { id: "example-1" } } }));
  writeFileSync(
    join(dir, "cardvision-vendor.json"),
    JSON.stringify({
      schemaVersion: 1,
      toolkit: { version: "0.15.0", commit: "89abcdef0123456789abcdef0123456789abcdef" },
      options: {},
      ort: { version: "1.29.0", files: ["ort-wasm-simd.wasm"] },
      opencv: { tag: "4.12.0", commit: "fedcba9876543210fedcba9876543210fedcba98", emsdk: "4.0.0", files: {} },
      files: {},
    }),
  );
  return dir;
}

/** Deps whose fetch answers every address with `status` and counts the calls. */
function deps(status: number, log: string[] = [], env: Record<string, string | undefined> = {}): Deps & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    env,
    fetched,
    fetchFn: (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response("details", { status });
    }) as typeof fetch,
    readFile: (p) => new Uint8Array(readFileSync(p)),
    zipFiles: () => [{ name: "manifest.json", sha256: "0".repeat(64) }],
    zipManifest: (p) => ({ path: "manifest.json", manifest: (p.endsWith("firefox.zip") ? FIREFOX_MANIFEST : CHROME_MANIFEST) as Record<string, unknown> }),
    log: (line) => log.push(line),
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
    "--workflow", join(dir, "store-release.yml"),
    "--workflow", join(dir, "store-check.yml"),
    ...extra,
  ];
}

const args = (dir: string, extra: Partial<Parameters<typeof runCheck>[0]> = {}): Parameters<typeof runCheck>[0] => ({
  config: join(dir, "store/store.config.json"),
  release: join(dir, "store/releases/1.0.0.json"),
  tag: "v1.0.0",
  tagPrefix: "v",
  permissions: join(dir, "store/permissions.json"),
  chromeZip: join(dir, "chrome.zip"),
  firefoxZip: join(dir, "firefox.zip"),
  workflows: [join(dir, "store-release.yml"), join(dir, "store-check.yml")],
  ...extra,
});

/** A permissions file in which Chrome had no permissions (so the packages' surface differs from it). */
function olderPermissions(dir: string): string {
  const previous = JSON.parse(readFileSync(join(dir, "store/permissions.json"), "utf-8")) as Record<string, { permissions: string[] }>;
  previous.chrome!.permissions = [];
  writeFileSync(join(dir, "previous.json"), JSON.stringify(previous));
  return join(dir, "previous.json");
}

describe("check --pull-request release (the version pull request)", () => {
  it("a 'before upload' address that is not live yet is a warning, not a problem", async () => {
    const dir = workspace();
    const tag = await runCheck(args(dir), deps(404));
    expect(tag.problems.join("\n")).toMatch(/before upload: https:\/\/cdn.example.org\/data\/details-1.json: HTTP 404/);
    const pr = await runCheck(args(dir, { pullRequest: "release" }), deps(404));
    expect(pr.problems).toEqual([]);
    expect(pr.warnings).toEqual([
      "before upload (checked again on the tag): https://cdn.example.org/data/details-1.json: HTTP 404 (the details file this version reads)",
    ]);
    expect(pr.summary.join("\n")).toMatch(/1 warning\(s\)/);
    const live = await runCheck(args(dir, { pullRequest: "release" }), deps(200));
    expect(live.warnings).toEqual([]);
  });

  it("still checks everything else that describes the release", async () => {
    const dir = workspace();
    const release = JSON.parse(readFileSync(join(dir, "store/releases/1.0.0.json"), "utf-8")) as Record<string, unknown>;
    writeFileSync(join(dir, "store/releases/1.0.0.json"), JSON.stringify({ ...release, firefox: { approvalNotes: "1.0.0/missing.md" } }));
    const res = await runCheck(args(dir, { pullRequest: "release", previousPermissions: olderPermissions(dir) }), deps(200));
    const text = res.problems.join("\n");
    expect(text).toMatch(/missing\.md/);
    expect(text).toMatch(/the permissions changed: set permissionsChanged/);
    writeFileSync(join(dir, "store/releases/1.0.0.json"), JSON.stringify({ ...release, surprise: true }));
    await expect(runCheck(args(dir, { pullRequest: "release" }), deps(200))).rejects.toThrow(/surprise/);
  });

  it("a runtime row that does not match is a problem", async () => {
    const dir = workspace();
    writeFileSync(join(dir, "facts.json"), JSON.stringify({ facts: { modelRelease: "example-0" } }));
    const res = await runCheck(
      args(dir, { pullRequest: "release", recordOut: join(dir, "record.json"), vendorManifest: join(dir, "cardvision-vendor.json"), facts: join(dir, "facts.json"), runtimes: join(dir, "cdn/RUNTIMES.json") }),
      deps(200),
    );
    expect(res.problems).toEqual(["the bundled model release example-0 is not example-1, the row of 1.0.0 in RUNTIMES.json"]);
    expect(res.warnings).toEqual([]);
  });
});

describe("check --pull-request released (a pull request after the release)", () => {
  it("reads only the version: notes, before addresses and store settings describe the release", async () => {
    const dir = workspace();
    // A release file a later toolkit would refuse, with notes that are gone: none of it is read.
    writeFileSync(join(dir, "store/releases/1.0.0.json"), JSON.stringify({ version: "1.0.0", firefox: { approvalNotes: "gone.md" }, retired: true, before: [{ url: "https://cdn.example.org/x" }] }));
    const d = deps(404);
    const res = await runCheck(args(dir, { pullRequest: "released" }), d);
    expect(res.problems).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(d.fetched).toEqual([]);
    expect(res.summary.join("\n")).toMatch(/v1\.0\.0 is already released/);
  });

  it("still checks the packages: the version, the committed permissions, a key, the workflows", async () => {
    const dir = workspace();
    writeFileSync(join(dir, "store-check.yml"), `${readFileSync(join(dir, "store-check.yml"), "utf-8")}\n# EXAMPLE_CDN_SECRET\n`);
    const d = deps(200);
    d.zipManifest = (p) => ({
      path: "manifest.json",
      manifest: (p.endsWith("firefox.zip") ? { ...FIREFOX_MANIFEST, version: "1.0.1" } : { ...CHROME_MANIFEST, key: "k", permissions: ["storage", "tabs"] }) as Record<string, unknown>,
    });
    const text = (await runCheck(args(dir, { pullRequest: "released" }), d)).problems.join("\n");
    expect(text).toMatch(/firefox.zip is version 1.0.1, the release is 1.0.0/);
    expect(text).toMatch(/carries a key/);
    expect(text).toMatch(/chrome: the package's permissions differ from .*permissions.json/);
    expect(text).toMatch(/store-check.yml mentions a denied name/);
    const tag = await runCheck(args(dir, { pullRequest: "released", tag: "v1.0.1" }), deps(200));
    expect(tag.problems.join("\n")).toMatch(/the tag v1.0.1 is not v1.0.0/);
    writeFileSync(join(dir, "store/releases/1.0.0.json"), JSON.stringify({ firefox: {} }));
    await expect(runCheck(args(dir, { pullRequest: "released" }), deps(200))).rejects.toThrow(/version is required/);
  });

  it("a permission change since the tag is a warning for the next version, and permissionsChanged is not compared", async () => {
    const dir = workspace();
    const previous = olderPermissions(dir);
    const res = await runCheck(args(dir, { pullRequest: "released", previousPermissions: previous }), deps(200));
    expect(res.problems).toEqual([]);
    expect(res.warnings).toEqual([
      "chrome: the permissions changed since v1.0.0 (permissions: + storage): the next version's release file sets permissionsChanged",
    ]);
    const same = await runCheck(args(dir, { pullRequest: "released", previousPermissions: join(dir, "store/permissions.json") }), deps(200));
    expect(same.problems).toEqual([]);
    expect(same.warnings).toEqual([]);
  });

  it("a runtime row that no longer matches is a warning for the next version", async () => {
    const dir = workspace();
    writeFileSync(join(dir, "facts.json"), JSON.stringify({ facts: { modelRelease: "example-2" } }));
    const vendor = JSON.parse(readFileSync(join(dir, "cardvision-vendor.json"), "utf-8")) as { ort: { version: string } };
    vendor.ort.version = "1.30.0";
    writeFileSync(join(dir, "cardvision-vendor.json"), JSON.stringify(vendor));
    const res = await runCheck(
      args(dir, { pullRequest: "released", recordOut: join(dir, "record.json"), vendorManifest: join(dir, "cardvision-vendor.json"), facts: join(dir, "facts.json"), runtimes: join(dir, "cdn/RUNTIMES.json") }),
      deps(200),
    );
    expect(res.problems).toEqual([]);
    expect(res.warnings).toEqual([
      "the bundled model release example-2 is not example-1, the row of 1.0.0 in RUNTIMES.json (v1.0.0 is released: the next version's row)",
      "the vendored ONNX Runtime 1.30.0 is not 1.29.0, the row of 1.0.0 in RUNTIMES.json (v1.0.0 is released: the next version's row)",
    ]);
  });
});

describe("the command line", () => {
  it("prints warnings as workflow commands in a workflow and exits 0", async () => {
    const dir = workspace();
    const log: string[] = [];
    expect(await main(checkArgv(dir, ["--pull-request", "release"]), deps(404, log, { GITHUB_ACTIONS: "true" })), log.join("\n")).toBe(0);
    expect(log[0]).toBe(
      "::warning title=Store check::before upload (checked again on the tag): https://cdn.example.org/data/details-1.json: HTTP 404 (the details file this version reads)",
    );
    const plain: string[] = [];
    expect(await main(checkArgv(dir, ["--pull-request", "release"]), deps(404, plain))).toBe(0);
    expect(plain[0]).toMatch(/^warning: before upload \(checked again on the tag\)/);
    expect(await main(checkArgv(dir), deps(404))).toBe(1);
  });

  it("refuses another mode with a usage error", async () => {
    const dir = workspace();
    const log: string[] = [];
    expect(await main(checkArgv(dir, ["--pull-request", "maybe"]), deps(200, log))).toBe(2);
    expect(log.join("\n")).toMatch(/--pull-request is "release" or "released", not "maybe"/);
  });

  it("escapes a warning's percent signs and line breaks in a workflow command", () => {
    expect(warningLine("50% done\nnext\rline", { GITHUB_ACTIONS: "true" })).toBe("::warning title=Store check::50%25 done%0Anext%0Dline");
    expect(warningLine("50% done", {})).toBe("warning: 50% done");
  });
});

describe("templates/store-check.yml", () => {
  const text = readFileSync(join(TEMPLATES, "store-check.yml"), "utf-8");

  /** The `run: |` body of the step named `name`, unindented. */
  function stepBody(name: string): string {
    const lines = text.slice(text.indexOf(`- name: ${name}`)).split("\n");
    const start = lines.findIndex((l) => l.trim() === "run: |") + 1;
    const body: string[] = [];
    for (const l of lines.slice(start)) {
      if (l.trim() !== "" && !l.startsWith("          ")) break;
      body.push(l.slice(10));
    }
    return body.join("\n");
  }

  it("runs on pull requests with read access only, no environment, and the same pinned actions as store-release.yml", () => {
    expect(text).toMatch(/^on:\n {2}pull_request:\n/m);
    expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(text).not.toMatch(/environment:|write|secrets\./);
    const pins = (t: string) => [...t.matchAll(/uses: (\S+)/g)].map((m) => m[1]).sort();
    const release = pins(readFileSync(join(TEMPLATES, "store-release.yml"), "utf-8"));
    expect(pins(text).length).toBeGreaterThan(0);
    for (const u of pins(text)) expect(release).toContain(u);
    for (const u of pins(text)) expect(u).toMatch(/@[0-9a-f]{40}$/);
    expect(stepBody("Check the packages and the release")).toMatch(/node "\$STORE_TOOL" check \$pr --config/); // which flags: the test below
  });

  it("decides release or released from the tag and the pull request's own changes", () => {
    const repo = mkdtempSync(join(tmpdir(), "store-check-git-"));
    dirs.push(repo);
    // No global git settings (signing, hooks), and a made-up identity.
    const email = ["t", "invalid"].join("@");
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: email, GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf-8", env: gitEnv }).trim();
    const write = (path: string, body: string): void => {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), body);
    };
    git("init", "-q", "-b", "main");
    write("package.json", JSON.stringify({ version: "1.0.0" }));
    write("store/releases/1.0.0.json", "{}");
    write("store/releases/1.0.0/notes.md", "notes");
    write("cdn/RUNTIMES.json", "{}");
    write("src/a.js", "a");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    const envDir = mkdtempSync(join(tmpdir(), "store-check-env-"));
    dirs.push(envDir);
    const mode = (base: string): string => {
      const env = join(envDir, "github-env");
      writeFileSync(env, "");
      execFileSync("bash", ["-c", stepBody("The would-be tag, and whether this pull request is its release")], {
        cwd: repo,
        env: { PATH: process.env.PATH, TAG_PREFIX: "v", BASE_SHA: base, GITHUB_ENV: env },
        stdio: ["ignore", "ignore", "inherit"],
      });
      const lines = readFileSync(env, "utf-8");
      expect(lines).toMatch(/^TAG=v1\.0\.0$/m);
      return /^STORE_CHECK_MODE=(\S+)$/m.exec(lines)![1]!;
    };
    const head = git("rev-parse", "HEAD");
    expect(mode(head)).toBe("release"); // not tagged yet
    git("tag", "v1.0.0");
    const change = (path: string): string => {
      git("checkout", "-q", "--detach", "v1.0.0");
      write(path, `changed ${path}`);
      git("add", "-A");
      git("commit", "-q", "-m", `change ${path}`);
      return mode(git("rev-parse", "v1.0.0"));
    };
    expect(change("src/a.js")).toBe("released");
    expect(change("store/releases/1.0.0.json")).toBe("release");
    expect(change("store/releases/1.0.0/notes.md")).toBe("release");
    expect(change("cdn/RUNTIMES.json")).toBe("release"); // unreadable now, so the row differs
    git("checkout", "-q", "--detach", "v1.0.0");
    write("cdn/RUNTIMES.json", JSON.stringify({ "1.0.0": { ortWeb: "1.29.0" } }));
    git("add", "-A");
    git("commit", "-q", "-m", "the row of 1.0.0");
    git("tag", "-f", "v1.0.0");
    const withRow = git("rev-parse", "HEAD");
    const rows = (body: object): string => {
      git("checkout", "-q", "--detach", withRow);
      write("cdn/RUNTIMES.json", JSON.stringify(body));
      git("add", "-A");
      git("commit", "-q", "-m", "rows");
      return mode(withRow);
    };
    expect(rows({ "1.0.0": { ortWeb: "1.29.0" }, "1.0.1": { ortWeb: "1.30.0" } })).toBe("released"); // the next row only
    expect(rows({ "1.0.0": { ortWeb: "1.30.0" } })).toBe("release"); // this version's row
    expect(change("store/releases/1.0.1.json")).toBe("released");
    // A base the clone does not have is an error, not "changed": the step fails and picks no mode.
    const env = join(envDir, "github-env");
    writeFileSync(env, "");
    let failed: { status?: number; stdout?: string } | undefined;
    try {
      execFileSync("bash", ["-c", stepBody("The would-be tag, and whether this pull request is its release")], {
        cwd: repo,
        env: { PATH: process.env.PATH, TAG_PREFIX: "v", BASE_SHA: "0".repeat(40), GITHUB_ENV: env },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      failed = error as { status?: number; stdout?: string };
    }
    expect(failed?.status).toBe(1);
    expect(failed?.stdout).toContain("::error::git diff against the pull request's base failed (exit 128)");
    expect(readFileSync(env, "utf-8")).not.toMatch(/STORE_CHECK_MODE=/);
  });

  it("passes --pull-request, or runs the tag's own checks when a release pull request must wait for its before addresses", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-check-step-"));
    dirs.push(dir);
    // A stand-in for the tool that prints its arguments.
    writeFileSync(join(dir, "tool.mjs"), "console.log(process.argv.slice(2).join(' '));\n");
    const run = (mode: string, before: string): string =>
      // As GitHub runs a step: bash -e -o pipefail.
      execFileSync("bash", ["-eo", "pipefail", "-c", stepBody("Check the packages and the release")], {
        cwd: dir,
        env: { PATH: process.env.PATH, TAG: "v1.0.0", TAG_PREFIX: "v", STORE_TOOL: join(dir, "tool.mjs"), STORE_CHECK_MODE: mode, BEFORE_ON_PULL_REQUEST: before, GITHUB_STEP_SUMMARY: join(dir, "summary.md") },
        encoding: "utf-8",
      });
    expect(run("release", "warn")).toMatch(/^check --pull-request release --config /);
    expect(run("released", "warn")).toMatch(/^check --pull-request released --config /);
    expect(run("release", "fail")).toMatch(/^check --config /);
    expect(run("released", "fail")).toMatch(/^check --pull-request released --config /);
    let bad: { status?: number; stdout?: string } | undefined;
    try {
      run("release", "maybe");
    } catch (error) {
      bad = error as { status?: number; stdout?: string };
    }
    expect(bad?.status).toBe(1);
    expect(bad?.stdout).toContain("::error::BEFORE_ON_PULL_REQUEST is warn or fail, not 'maybe'");
    expect(text).toMatch(/^ {2}BEFORE_ON_PULL_REQUEST: warn$/m);
  });

  it("both templates pass --runtimes only with a facts file to check the row against", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-check-step-"));
    dirs.push(dir);
    writeFileSync(join(dir, "tool.mjs"), "console.log(process.argv.slice(2).join(' '));\n");
    const step = (template: string, name: string): string => {
      const body = readFileSync(join(TEMPLATES, template), "utf-8");
      const lines = body.slice(body.indexOf(`- name: ${name}`)).split("\n");
      const start = lines.findIndex((l) => l.trim() === "run: |") + 1;
      const out: string[] = [];
      for (const l of lines.slice(start)) {
        if (l.trim() !== "" && !l.startsWith("          ")) break;
        out.push(l.slice(10));
      }
      return out.join("\n");
    };
    const run = (template: string, name: string): string =>
      execFileSync("bash", ["-eo", "pipefail", "-c", step(template, name)], {
        cwd: dir,
        env: { PATH: process.env.PATH, TAG: "v1.0.0", TAG_PREFIX: "v", STORE_TOOL: join(dir, "tool.mjs"), STORE_CHECK_MODE: "release", BEFORE_ON_PULL_REQUEST: "warn", GITHUB_STEP_SUMMARY: join(dir, "summary.md"), GITHUB_SHA: "0".repeat(40), GITHUB_RUN_ID: "1" },
        encoding: "utf-8",
      });
    const both = (): string[] => [run("store-check.yml", "Check the packages and the release"), run("store-release.yml", "Check the release")];
    mkdirSync(join(dir, "cdn"));
    writeFileSync(join(dir, "cdn/RUNTIMES.json"), "{}");
    for (const args of both()) {
      expect(args).not.toContain("--runtimes");
      expect(args).not.toContain("--facts");
    }
    mkdirSync(join(dir, "store"));
    writeFileSync(join(dir, "store/record-facts.json"), "{}");
    for (const args of both()) expect(args).toContain("--facts store/record-facts.json --runtimes cdn/RUNTIMES.json");
    rmSync(join(dir, "cdn"), { recursive: true });
    for (const args of both()) {
      expect(args).toContain("--facts store/record-facts.json");
      expect(args).not.toContain("--runtimes");
    }
  });

  it("compares with the tag's own permissions when released, and with the release before it otherwise", () => {
    const repo = mkdtempSync(join(tmpdir(), "store-check-git-"));
    dirs.push(repo);
    const email = ["t", "invalid"].join("@");
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: email, GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...a: string[]): void => {
      execFileSync("git", a, { cwd: repo, env: gitEnv, stdio: "ignore" });
    };
    const release = (version: string, permissions: string): void => {
      mkdirSync(join(repo, "store"), { recursive: true });
      writeFileSync(join(repo, "store/permissions.json"), permissions);
      git("add", "-A");
      git("commit", "-q", "-m", version);
      git("tag", `v${version}`);
    };
    git("init", "-q", "-b", "main");
    release("0.9.0", "permissions of 0.9.0");
    release("1.0.0-rc1", "permissions of 1.0.0-rc1");
    release("1.0.0", "permissions of 1.0.0");
    const compared = (mode: string): string => {
      const env = join(repo, "..", `${repo.split("/").pop()}-env`);
      dirs.push(env);
      writeFileSync(env, "");
      rmSync(join(repo, "out"), { recursive: true, force: true });
      mkdirSync(join(repo, "out"));
      execFileSync("bash", ["-c", stepBody("The permissions to compare with")], {
        cwd: repo,
        env: { PATH: process.env.PATH, TAG: "v1.0.0", TAG_PREFIX: "v", STORE_CHECK_MODE: mode, GITHUB_ENV: env },
        stdio: ["ignore", "ignore", "inherit"],
      });
      expect(readFileSync(env, "utf-8")).toBe("PREVIOUS=--previous-permissions out/previous-permissions.json\n");
      return readFileSync(join(repo, "out/previous-permissions.json"), "utf-8").trim();
    };
    expect(compared("released")).toBe("permissions of 1.0.0");
    expect(compared("release")).toBe("permissions of 0.9.0");
  });
});
