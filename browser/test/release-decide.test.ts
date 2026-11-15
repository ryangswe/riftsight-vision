// SPDX-License-Identifier: Apache-2.0
// node/release-decide.ts: what a push to the main branch does about an extension release. The
// facts are made up; nothing here reaches the network, git or GitHub.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { compareVersions, decide, type Facts, main, notesFor, tagsOf } from "../node/release-decide.js";
import { denyFindings } from "../node/store-checks.js";

const TEMPLATES = join(fileURLToPath(new URL(".", import.meta.url)), "..", "templates");
const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const CHANGELOG = `# Changelog

## [Unreleased]

- Something not out yet.

## [1.3.0] - 2026-11-10

### Added

- A new thing.

## [1.2.0] - 2026-10-01

- An older thing.

## [1.4.0-rc1] - 2026-11-12

- A candidate.

## [1.5.0] - 2026-11-14
`;
const tagLine = (tag: string, sha = OTHER): string => `${sha}\trefs/tags/${tag}`;

function facts(over: Partial<Facts> = {}): Facts {
  return {
    version: "1.3.0",
    tagPrefix: "v",
    commit: COMMIT,
    tags: [tagLine("v1.2.0"), tagLine("v1.1.0")].join("\n"),
    releaseFile: true,
    changelog: CHANGELOG,
    releaseExists: false,
    storeRuns: 0,
    ...over,
  };
}

describe("the three conditions", () => {
  it("releases, with the changelog section as notes, when all three hold", () => {
    const p = decide(facts());
    expect(p).toMatchObject({ action: "release", tag: "v1.3.0", create: true, dispatch: true, prerelease: false });
    expect(p.notes).toBe("### Added\n\n- A new thing.\n");
  });

  it("does nothing when the version already has a tag on an earlier commit", () => {
    const p = decide(facts({ tags: tagLine("v1.3.0", OTHER) }));
    expect(p).toMatchObject({ action: "nothing", create: false, dispatch: false });
  });

  it("does nothing when the release file is missing", () => {
    const p = decide(facts({ releaseFile: false }));
    expect(p).toMatchObject({ action: "nothing", create: false, dispatch: false });
    expect(p.reason).toMatch(/release file/);
  });

  it("does nothing when the changelog has no section for the version, or an empty one", () => {
    for (const changelog of [CHANGELOG.replace("## [1.3.0]", "## [1.3.1]"), CHANGELOG.replace("- A new thing.", "").replace("### Added", ""), "", "## [1.30.0]\n\n- other\n"]) {
      const p = decide(facts({ changelog }));
      expect(p).toMatchObject({ action: "nothing", create: false, dispatch: false });
      expect(p.reason).toMatch(/changelog/);
    }
  });

  it("names every missing condition", () => {
    const p = decide(facts({ releaseFile: false, changelog: "" }));
    expect(p.reason).toMatch(/release file/);
    expect(p.reason).toMatch(/changelog/);
  });

  it("refuses a version that is not a version", () => {
    for (const version of ["", "1.3", "v1.3.0", "../x"]) expect(decide(facts({ version })).action).toBe("refuse");
  });

  it("marks a pre-release version", () => {
    const p = decide(facts({ version: "1.4.0-rc1" }));
    expect(p).toMatchObject({ action: "release", tag: "v1.4.0-rc1", prerelease: true });
  });
});

describe("a version lower than the newest tag", () => {
  it("is refused, and nothing is created", () => {
    const p = decide(facts({ version: "1.3.0", tags: [tagLine("v1.4.0"), tagLine("v1.2.0")].join("\n") }));
    expect(p).toMatchObject({ action: "refuse", create: false, dispatch: false });
    expect(p.reason).toMatch(/lower than the newest version tag, v1\.4\.0/);
  });

  it("is refused against a pre-release tag of a higher version", () => {
    expect(decide(facts({ tags: tagLine("v1.4.0-rc1") })).action).toBe("refuse");
  });

  it("lets the release follow its own candidate, and ignores tags of another prefix and non-version tags", () => {
    const tags = [tagLine("v1.3.0-rc2"), tagLine("ext-v9.0.0"), tagLine("vNext"), tagLine("v1.2.0")].join("\n");
    expect(decide(facts({ tags })).action).toBe("release");
  });

  it("compares versions the way semver does", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-a")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });

  it("is checked only when all three conditions hold", () => {
    const tags = tagLine("v2.0.0");
    expect(decide(facts({ tags, releaseFile: false })).action).toBe("nothing");
  });
});

describe("a re-run, with the tag on this commit", () => {
  const tags = [tagLine("v1.3.0", COMMIT), tagLine("v1.2.0")].join("\n");
  it("does only what is missing", () => {
    expect(decide(facts({ tags, releaseExists: true, storeRuns: 0 }))).toMatchObject({ action: "release", create: false, dispatch: true });
    expect(decide(facts({ tags, releaseExists: false, storeRuns: 1 }))).toMatchObject({ action: "release", create: true, dispatch: false });
    expect(decide(facts({ tags, releaseExists: false, storeRuns: 0 }))).toMatchObject({ action: "release", create: true, dispatch: true });
  });
  it("does nothing when all is done", () => {
    expect(decide(facts({ tags, releaseExists: true, storeRuns: 1 }))).toMatchObject({ action: "nothing", create: false, dispatch: false });
  });
  it("does not dispatch without the release file, nor create without notes", () => {
    expect(decide(facts({ tags, releaseExists: true, releaseFile: false }))).toMatchObject({ action: "nothing", dispatch: false });
    expect(decide(facts({ tags, releaseExists: false, storeRuns: 1, changelog: "" }))).toMatchObject({ action: "nothing", create: false });
  });
  it("takes a peeled tag's commit over the tag object's", () => {
    const annotated = [tagLine("v1.3.0", OTHER), `${COMMIT}\trefs/tags/v1.3.0^{}`].join("\n");
    expect(tagsOf(annotated, "v").commits.get("v1.3.0")).toBe(COMMIT);
  });
});

describe("the changelog reader", () => {
  it("finds a section by its version in the usual headings, not by prefix", () => {
    expect(notesFor("## 1.2.0\n\n- a\n", "1.2.0")).toBe("- a\n");
    expect(notesFor("## [v1.2.0] (2026-01-01)\n- a\n## 1.1.0\n- b\n", "1.2.0")).toBe("- a\n");
    expect(notesFor("## [1.2.0-rc1]\n- a\n", "1.2.0")).toBeNull();
    expect(notesFor("## [1.2.01]\n- a\n", "1.2.0")).toBeNull();
    expect(notesFor("## [1.2.0]\n\n", "1.2.0")).toBeNull();
  });
});

describe("the command", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function setup(over: { version?: string; releaseFile?: boolean; tags?: string } = {}): { dir: string; args: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "release-decide-test-"));
    dirs.push(dir);
    const version = over.version ?? "1.3.0";
    mkdirSync(join(dir, "store/releases"), { recursive: true });
    if (over.releaseFile !== false) writeFileSync(join(dir, `store/releases/${version}.json`), "{}");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
    writeFileSync(join(dir, "tags.txt"), over.tags ?? tagLine("v1.2.0"));
    const args = [
      "--package-json", join(dir, "package.json"), "--releases-dir", join(dir, "store/releases"), "--changelog", join(dir, "CHANGELOG.md"),
      "--commit", COMMIT, "--tags-file", join(dir, "tags.txt"), "--release-exists", "false", "--store-runs", "0",
      "--notes", join(dir, "notes.md"), "--output", join(dir, "out.txt"), "--summary", join(dir, "summary.md"),
    ];
    return { dir, args };
  }
  const quiet = (): { log: (l: string) => void; lines: string[] } => {
    const lines: string[] = [];
    return { log: (l) => lines.push(l), lines };
  };

  it("writes the notes and the outputs for a release", () => {
    const { dir, args } = setup();
    expect(main(args, quiet().log)).toBe(0);
    expect(readFileSync(join(dir, "notes.md"), "utf-8")).toBe("### Added\n\n- A new thing.\n");
    expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe("tag=v1.3.0\ncreate=true\nprerelease=false\ndispatch=true\n");
    expect(readFileSync(join(dir, "summary.md"), "utf-8")).toMatch(/^release: /);
  });

  it("with no release file, exits 0 and creates and dispatches nothing", () => {
    const { dir, args } = setup({ releaseFile: false });
    expect(main(args, quiet().log)).toBe(0);
    expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe("tag=v1.3.0\ncreate=false\nprerelease=false\ndispatch=false\n");
    expect(existsSync(join(dir, "notes.md"))).toBe(false);
  });

  it("refuses a lower version with exit 1 and no outputs", () => {
    const { dir, args } = setup({ tags: tagLine("v1.9.0") });
    expect(main(args, quiet().log)).toBe(1);
    expect(existsSync(join(dir, "out.txt"))).toBe(false);
    expect(existsSync(join(dir, "notes.md"))).toBe(false);
  });

  it("does not look up a release file for an invalid version", () => {
    const { args } = setup({ version: "../1.3.0", releaseFile: false });
    expect(main(args, quiet().log)).toBe(1);
  });

  it("exits 2 for a bad command line", () => {
    expect(main([], quiet().log)).toBe(2);
    const { args } = setup();
    expect(main([...args.slice(0, -4), "--store-runs", "x"], quiet().log)).toBe(2);
  });
});

describe("the template workflow", () => {
  const text = readFileSync(join(TEMPLATES, "extension-release.yml"), "utf-8");
  const store = readFileSync(join(TEMPLATES, "store-release.yml"), "utf-8");

  it("names no denied word, and no environment, secret or token beyond the workflow's own", () => {
    const config = JSON.parse(readFileSync(join(TEMPLATES, "store/store.config.json"), "utf-8")) as { deny: string[] };
    expect(denyFindings(text, config.deny)).toEqual([]);
    expect(text).not.toMatch(/^\s*environment:/m);
    const code = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/secrets\.|id-token|vars\./);
  });

  it("holds read at the top and contents and actions write on the one job", () => {
    expect(text).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(text).toMatch(/\n {4}permissions:\n {6}contents: write\n {6}actions: write\n {4}steps:|\n {4}permissions:\n {6}contents: write\n {6}actions: write\n {4}env:/);
    expect(text.match(/permissions:/g)).toHaveLength(2);
  });

  it("pins every action to a full commit", () => {
    const uses = text.split("\n").filter((l) => l.includes("uses: ") && !l.trim().startsWith("#"));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+){1,2}$/);
  });

  it("runs on a push to the main branch only, and decides before it creates or dispatches", () => {
    expect(text).toMatch(/\non:\n {2}push:\n {4}branches: \[main\]/);
    expect(text).not.toMatch(/pull_request|workflow_dispatch|schedule/);
    const decide = text.indexOf("release-decide.mjs") > -1 ? text.indexOf('node "$DECIDE_TOOL"') : -1;
    expect(decide).toBeGreaterThan(-1);
    expect(text.indexOf("gh release create")).toBeGreaterThan(decide);
    expect(text.indexOf("gh workflow run")).toBeGreaterThan(decide);
    expect(text).toMatch(/- name: Create the tag and the release\n {8}if: steps\.plan\.outputs\.create == 'true'\n/);
    expect(text).toMatch(/- name: Start the store run, which waits for approval\n {8}if: steps\.plan\.outputs\.dispatch == 'true'\n/);
    expect(text).toMatch(/gh workflow run store-release\.yml --ref "\$TAG" -f upload=true\n/);
    expect((text.match(/gh release create/g) ?? []).length).toBe(2);
    expect(text).toMatch(/concurrency:\n {6}group: extension-release\n {6}cancel-in-progress: false/);
  });

  it("is scanned by the store workflow's check when present", () => {
    expect(store).toMatch(/\[ -f \.github\/workflows\/extension-release\.yml \] && RELEASE_WORKFLOW="--workflow \.github\/workflows\/extension-release\.yml"/);
    expect(store).toMatch(/--workflow \.github\/workflows\/store-release\.yml \$RELEASE_WORKFLOW \\\n/);
  });
});
