// SPDX-License-Identifier: Apache-2.0
// node/store-record.ts and the release-assets job of the template: the release record, the files a
// release carries, and the rule that the job holding `contents: write` never runs in `store`.
// Nothing here reaches the network; every address, id and package is made up.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../node/store-checks.js";
import { readFactsFile, readVendorFacts, recordProblems, releaseAssets, writeJobsInEnvironments } from "../node/store-record.js";
import { type Deps, main } from "../node/store-upload.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TEMPLATES = join(HERE, "..", "templates");
const FIXTURES = join(HERE, "fixtures", "store-record");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The fixture is a Markdown file of this repository, so it starts with the license line the record has not.
const LICENSE_LINE = "<!-- SPDX-License-Identifier: Apache-2.0 -->\n\n";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TOOLKIT_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";

const CHROME_MANIFEST = { version: "1.0.0", manifest_version: 3, permissions: ["storage"], optional_host_permissions: ["https://www.example.org/*"] };
const FIREFOX_MANIFEST = {
  ...CHROME_MANIFEST,
  browser_specific_settings: { gecko: { id: "{00000000-0000-0000-0000-000000000001}", data_collection_permissions: { required: ["none"] } } },
};

/** The template's store/ folder, made-up packages, a vendor manifest and a facts file. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "store-record-test-"));
  dirs.push(dir);
  cpSync(join(TEMPLATES, "store"), join(dir, "store"), { recursive: true });
  cpSync(join(TEMPLATES, "store-release.yml"), join(dir, "store-release.yml"));
  writeFileSync(join(dir, "chrome.zip"), "chrome package bytes");
  writeFileSync(join(dir, "firefox.zip"), "firefox package bytes");
  writeFileSync(join(dir, "firefox-source.zip"), "firefox source bytes");
  writeFileSync(join(dir, "load-unpacked.zip"), "load-unpacked package bytes");
  writeFileSync(join(dir, "lint.json"), JSON.stringify({ errors: [], warnings: [], notices: [{ code: "N" }] }));
  writeFileSync(
    join(dir, "cardvision-vendor.json"),
    JSON.stringify({
      schemaVersion: 1,
      toolkit: { version: "0.14.1", commit: TOOLKIT_COMMIT },
      options: {},
      ort: { version: "1.29.0", files: ["ort-wasm-simd.wasm"] },
      opencv: { tag: "4.12.0", commit: "fedcba9876543210fedcba9876543210fedcba98", emsdk: "4.0.0", files: {} },
      files: {},
    }),
  );
  return dir;
}

function deps(log: string[] = []): Deps {
  return {
    env: {},
    fetchFn: (async () => new Response("details", { status: 200 })) as typeof fetch,
    readFile: (p) => new Uint8Array(readFileSync(p)),
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
    "--firefox-source", join(dir, "firefox-source.zip"),
    "--load-unpacked-zip", join(dir, "load-unpacked.zip"),
    "--workflow", join(dir, "store-release.yml"),
    "--lint", join(dir, "lint.json"),
    "--lint-baseline", join(dir, "store/lint-baseline.json"),
    "--hashes-out", join(dir, "hashes.json"),
    "--record-out", join(dir, "record.json"),
    "--vendor-manifest", join(dir, "cardvision-vendor.json"),
    "--facts", join(dir, "store/record-facts.json"),
    "--commit", COMMIT,
    "--run-id", "123456789",
    ...extra,
  ];
}

const template = (): string => readFileSync(join(TEMPLATES, "store-release.yml"), "utf-8");
const job = (text: string, name: string): string => {
  const at = text.indexOf(`\n  ${name}:\n`);
  const rest = text.slice(at + 1);
  const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

describe("the release record", () => {
  it("for a made-up release is the fixture, in JSON and in Markdown", async () => {
    const dir = workspace();
    const log: string[] = [];
    expect(await main(checkArgv(dir), deps(log)), log.join("\n")).toBe(0);
    expect(readFileSync(join(dir, "record.json"), "utf-8")).toBe(readFileSync(join(FIXTURES, "release-record.json"), "utf-8"));
    expect(readFileSync(join(dir, "record.md"), "utf-8")).toBe(readFileSync(join(FIXTURES, "release-record.md"), "utf-8").replace(LICENSE_LINE, ""));
    expect(log.join("\n")).toMatch(/Release record written/);
  });

  it("holds no path outside the release and no secret or denied name", async () => {
    const dir = workspace();
    expect(await main(checkArgv(dir), deps())).toBe(0);
    const text = `${readFileSync(join(dir, "record.json"), "utf-8")}${readFileSync(join(dir, "record.md"), "utf-8")}`;
    expect(text).not.toContain(dir);
    expect(text).not.toContain(tmpdir());
    expect(text).not.toMatch(/\/(?:Users|home|tmp|private|var)\//);
    const config = JSON.parse(readFileSync(join(dir, "store/store.config.json"), "utf-8")) as { deny: string[] };
    for (const word of config.deny) expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    expect(text).not.toMatch(/AMO_|CWS_|SECRET|TOKEN/);
    expect(recordProblems([text], config.deny)).toEqual([]);
  });

  it("is refused, and not written, when a fact names a local path or a credential", async () => {
    for (const [value, expected] of [
      [["", "Users", "someone", "out"].join("/"), /local path/],
      [["~", "work", "out"].join("/"), /local path/],
      ["C:\\build\\out", /local path/],
      ["EXAMPLE_CDN_SECRET", /denied name/],
      ["AWS_SECRET_KEY", /credential/],
    ] as const) {
      const dir = workspace();
      writeFileSync(join(dir, "store/record-facts.json"), JSON.stringify({ facts: { note: value } }));
      const log: string[] = [];
      expect(await main(checkArgv(dir), deps(log)), value).toBe(1);
      expect(log.join("\n")).toMatch(expected);
      expect(existsSync(join(dir, "record.json"))).toBe(false);
    }
  });

  it("reads only plain facts and a real vendor manifest", () => {
    const dir = workspace();
    const facts = (o: unknown): string => {
      writeFileSync(join(dir, "f.json"), JSON.stringify(o));
      return join(dir, "f.json");
    };
    expect(readFactsFile(facts({ facts: { b: 2, a: "x", c: true } }))).toEqual({ a: "x", b: 2, c: true });
    expect(() => readFactsFile(facts({ facts: { "a b": 1 } }))).toThrow(/plain name/);
    expect(() => readFactsFile(facts({ facts: { a: { nested: 1 } } }))).toThrow(/short text/);
    expect(() => readFactsFile(facts({ facts: {}, other: 1 }))).toThrow(/must be/);
    expect(readVendorFacts(join(dir, "cardvision-vendor.json"))).toEqual({
      toolkit: { version: "0.14.1", commit: TOOLKIT_COMMIT },
      ort: "1.29.0",
      opencv: { tag: "4.12.0", commit: "fedcba9876543210fedcba9876543210fedcba98" },
    });
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ schemaVersion: 1, toolkit: { commit: "abc" } }));
    expect(() => readVendorFacts(join(dir, "bad.json"))).toThrow(/vendor manifest/);
  });

  it("needs a vendor manifest, a .json name, a full commit and digits for the run", async () => {
    const dir = workspace();
    const base = checkArgv(dir).filter((_, i, all) => all[i] !== "--vendor-manifest" && all[i - 1] !== "--vendor-manifest");
    expect(await main(base, deps())).toBe(2);
    for (const extra of [["--commit", "abc"], ["--run-id", "12x"]]) expect(await main([...checkArgv(dir), ...extra], deps())).toBe(2);
    expect(await main([...checkArgv(dir), "--record-out", join(dir, "record.txt")], deps())).toBe(2);
  });
});

describe("the release assets", () => {
  async function recorded(): Promise<string> {
    const dir = workspace();
    expect(await main(checkArgv(dir), deps())).toBe(0);
    return dir;
  }

  it("are the three packages, the record and SHA256SUMS, and never the source archive", async () => {
    const dir = await recorded();
    const out = join(dir, "release-assets");
    const log: string[] = [];
    expect(await main(["assets", "--record", join(dir, "record.json"), "--dir", dir, "--out-dir", out], deps(log))).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["SHA256SUMS", "chrome.zip", "firefox.zip", "load-unpacked.zip", "release-record.json", "release-record.md"]);
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf-8").trim().split("\n");
    expect(sums).toHaveLength(5);
    for (const line of sums) {
      const [hash, name] = line.split("  ") as [string, string];
      expect(sha256(new Uint8Array(readFileSync(join(out, name))))).toBe(hash);
    }
    expect(readFileSync(join(out, "SHA256SUMS"), "utf-8")).not.toContain("firefox-source");
    // The source archive is in the record, as a hash, so a reader can match it, but not attached.
    expect(readFileSync(join(out, "release-record.json"), "utf-8")).toContain("firefox-source.zip");
  });

  it("refuse a package that is not the one the build job checked", async () => {
    const dir = await recorded();
    writeFileSync(join(dir, "chrome.zip"), "another package");
    const log: string[] = [];
    expect(await main(["assets", "--record", join(dir, "record.json"), "--dir", dir, "--out-dir", join(dir, "o")], deps(log))).toBe(1);
    expect(log.join("\n")).toMatch(/chrome\.zip is not the package the build job checked/);
    expect(existsSync(join(dir, "o", "SHA256SUMS"))).toBe(false);
  });

  it("refuse a record that names a path", async () => {
    const dir = await recorded();
    const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf-8")) as { packages: { chrome: { file: string } } };
    record.packages.chrome.file = "../chrome.zip";
    mkdirSync(join(dir, "x"));
    writeFileSync(join(dir, "x", "record.json"), JSON.stringify(record));
    writeFileSync(join(dir, "x", "record.md"), "");
    const log: string[] = [];
    expect(await main(["assets", "--record", join(dir, "x", "record.json"), "--dir", dir, "--out-dir", join(dir, "o")], deps(log))).toBe(1);
    expect(log.join("\n")).toMatch(/a path, not a file name/);
  });

  it("need their three arguments", async () => {
    expect(await main(["assets", "--record", "r.json"], deps())).toBe(2);
  });
});

describe("the template's release-assets job", () => {
  it("has contents: write and no store access: no environment, no identity token, only the run's own token", () => {
    const text = template();
    const j = job(text, "release-assets");
    expect(j).toMatch(/\n {4}permissions:\n {6}contents: write\n(?! {6}\S)/);
    expect(j).not.toMatch(/\n {4}environment:/);
    expect(j).not.toMatch(/id-token|secrets\.|vars\.|CWS_|AMO_|google-github-actions/);
    expect(j).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    expect(j).toMatch(/needs: build/);
    // No other job writes to the repository, and the one with the store has no write.
    expect(job(text, "upload")).not.toMatch(/contents: write/);
    expect(job(text, "build")).not.toMatch(/contents: write/);
    expect(text).toMatch(/\npermissions:\n {2}contents: read\n/);
  });

  it("attaches the files the tool collected, never the source archive or the out folder", () => {
    const j = job(template(), "release-assets");
    expect(j).toMatch(/assets --record out\/record\.json --dir out --out-dir release-assets/);
    expect(j).toMatch(/gh release upload "\$TAG" release-assets\/\* --clobber/);
    expect(j).not.toMatch(/firefox-source|out\/\*/);
  });

  it("is refused by `check` when it names an environment, and the store job is not", () => {
    const text = template();
    expect(writeJobsInEnvironments(text)).toEqual([]);
    const broken = text.replace("    permissions:\n      contents: write\n", "    environment: store\n    permissions:\n      contents: write\n");
    expect(broken).not.toBe(text);
    expect(writeJobsInEnvironments(broken)).toEqual(["release-assets"]);
    expect(writeJobsInEnvironments(text.replace("      contents: write\n", "      contents: write\n      id-token: write\n").replace("    permissions:\n      contents: write", "    environment: store\n    permissions:\n      contents: write"))).toEqual(["release-assets"]);
  });

  it("makes check fail a workflow whose write job names the store environment", async () => {
    const dir = workspace();
    writeFileSync(join(dir, "store-release.yml"), template().replace("    permissions:\n      contents: write\n", "    environment: store\n    permissions:\n      contents: write\n"));
    const log: string[] = [];
    expect(await main(checkArgv(dir), deps(log))).toBe(1);
    expect(log.join("\n")).toMatch(/the job release-assets can write to the repository and names an environment/);
  });

  it("runs after the build, from a tag push or a dispatch that asks for it", () => {
    const text = template();
    expect(job(text, "release-assets")).toMatch(/if: github\.event_name == 'push' \|\| inputs\.attach\n/);
    expect(text).toMatch(/\n {6}attach:\n(?: {8}.*\n)*? {8}default: false\n/);
    // The record is built by the build job and carried in its artifact.
    expect(job(text, "build")).toMatch(/--record-out out\/record\.json --vendor-manifest /);
    expect(job(text, "build")).toMatch(/out\/record\.json\n\s+out\/record\.md/);
  });
});

describe("every workflow template", () => {
  it("pins each `uses:` to a full commit", () => {
    const uses = [...template().matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(8);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });
});
