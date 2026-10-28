// SPDX-License-Identifier: Apache-2.0
// node/verify-release.ts: the check of a release folder or address with the runtime's own loader.
// The release is the toy release of fixtures/ with two stand-in model byte strings pinned in place
// of the model files (none is kept in the repository); nothing here reaches the network, and the
// address mode is given a fetch of its own.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LoadedRelease } from "../src/load.js";
import { loadReleaseData, releaseIdOf, sha256HexWebCrypto } from "../src/release.js";
import { DEFAULT_USER_AGENT, type RuntimeApi, verifyRelease, type VerifyOptions } from "../node/verify-release.js";
import { FIXTURES } from "./support.js";

const FIXTURE = `${FIXTURES}toy-release/`;
const ORT = "1.29.0";
const runtime: RuntimeApi = {
  loadReleaseData,
  loadRelease: async () => {
    throw new Error("no model is started in these tests");
  },
};
const options = (over: Partial<VerifyOptions> = {}): VerifyOptions => ({ sessions: false, userAgent: DEFAULT_USER_AGENT, ortWeb: ORT, ...over });

const bytesOf = (value: string): Uint8Array => new TextEncoder().encode(value);
const arrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** The files of the toy release with stand-in models, named by the id their content has. */
async function standIn(): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const name of ["bank.json", "bank.identity-groups.json", "catalog.json"]) files.set(name, new Uint8Array(readFileSync(`${FIXTURE}${name}`)));
  files.set("detector.onnx", bytesOf("stand-in detector bytes"));
  files.set("recognizer.onnx", bytesOf("stand-in recognizer bytes, a little longer"));
  const doc = JSON.parse(readFileSync(`${FIXTURE}release.json`, "utf-8"));
  for (const block of [doc.detector, doc.recognizer]) {
    const body = files.get(block.path)!;
    block.sha256 = await sha256HexWebCrypto(arrayBuffer(body));
    block.bytes = body.length;
  }
  doc.id = await releaseIdOf(JSON.stringify(doc), sha256HexWebCrypto);
  files.set("release.json", bytesOf(`${JSON.stringify(doc, null, 1)}\n`));
  return files;
}

let files: Map<string, Uint8Array>;
let id: string;
let folder: string;
const scratch: string[] = [];

beforeAll(async () => {
  files = await standIn();
  id = JSON.parse(new TextDecoder().decode(files.get("release.json")!)).id;
  folder = mkdtempSync(join(tmpdir(), "verify-release-"));
  scratch.push(folder);
  for (const [name, body] of files) writeFileSync(join(folder, name), body);
});
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("a release folder", () => {
  it("passes, and says what it holds", async () => {
    const out = await verifyRelease(runtime, options({ dir: folder }));
    expect(out).toEqual({ ok: true, id, bankEntries: 20, bankCards: 20, catalogCards: 20, sessions: "skipped", reason: null });
  });

  it("fails when the id is not the expected one", async () => {
    const out = await verifyRelease(runtime, options({ dir: folder, expectId: "0000000000000000" }));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe(`id ${id} is not the expected 0000000000000000`);
    expect(await verifyRelease(runtime, options({ dir: folder, expectId: id }))).toMatchObject({ ok: true });
  });

  it("fails when a pinned file is not the one pinned", async () => {
    const broken = mkdtempSync(join(tmpdir(), "verify-release-"));
    scratch.push(broken);
    for (const [name, body] of files) writeFileSync(join(broken, name), name === "catalog.json" ? bytesOf("{}") : body);
    const out = await verifyRelease(runtime, options({ dir: broken }));
    expect(out.ok).toBe(false);
    expect(out.reason).toEqual(expect.any(String));
  });

  it("fails when a pinned file is missing", async () => {
    const partial = mkdtempSync(join(tmpdir(), "verify-release-"));
    scratch.push(partial);
    for (const [name, body] of files) if (name !== "detector.onnx") writeFileSync(join(partial, name), body);
    expect((await verifyRelease(runtime, options({ dir: partial }))).ok).toBe(false);
  });

  it("fails when the release asks for another ONNX Runtime than the pin", async () => {
    const out = await verifyRelease(runtime, options({ dir: folder, ortWeb: "1.0.0" }));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/1\.29\.0|1\.0\.0/);
  });

  it("reports a model session that cannot start", async () => {
    const out = await verifyRelease(runtime, options({ dir: folder, sessions: true }));
    expect(out).toMatchObject({ ok: false, sessions: "failed", reason: "sessions: Error: no model is started in these tests" });
  });

  it("starts the sessions when asked, through the runtime's loadRelease", async () => {
    let disposed = false;
    const started: RuntimeApi = { ...runtime, loadRelease: async () => ({ backend: { detector: "wasm", recognizer: "wasm" }, dispose: async () => void (disposed = true) }) as unknown as LoadedRelease };
    const out = await verifyRelease(started, options({ dir: folder, sessions: true }));
    expect(out).toMatchObject({ ok: true, sessions: "ok (detector wasm, recognizer wasm)" });
    expect(disposed).toBe(true);
  });
});

describe("a release address", () => {
  const URL_OK = "https://cdn.example.org/vision/releases/0123456789abcdef/release.json";

  it.each([
    "http://cdn.example.org/vision/releases/0123456789abcdef/release.json",
    "https://cdn.example.org/vision/releases/0123456789ABCDEF/release.json",
    "https://cdn.example.org/vision/releases/0123456789abcdef/other.json",
    "https://cdn.example.org/releases/0123456789abcdef/release.json",
    "file:///tmp/vision/releases/0123456789abcdef/release.json",
  ])("is refused unless it is https://<host>/vision/releases/<id>/release.json: %s", async (url) => {
    let fetched = 0;
    const out = await verifyRelease(runtime, options({ url }), async () => {
      fetched += 1;
      throw new Error("must not fetch");
    });
    expect(out).toMatchObject({ ok: false, reason: "the url is not https://<host>/vision/releases/<id>/release.json" });
    expect(fetched).toBe(0);
  });

  it("is fetched without cookies, with the default user agent, and passes", async () => {
    const seen: Array<{ url: string; credentials: string; agent: string | undefined }> = [];
    const base = "https://cdn.example.org/vision/releases/0123456789abcdef/";
    const out = await verifyRelease(runtime, options({ url: URL_OK }), async (url, init) => {
      seen.push({ url, credentials: init.credentials, agent: init.headers["User-Agent"] });
      const body = url.startsWith(base) ? files.get(url.slice(base.length)) : undefined;
      return { ok: body !== undefined, status: body ? 200 : 404, arrayBuffer: async () => (body ? arrayBuffer(body) : new ArrayBuffer(0)) };
    });
    expect(out).toMatchObject({ ok: true, id });
    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(seen[0]).toEqual({ url: URL_OK, credentials: "omit", agent: "cardvision-verify/1" });
    expect(new Set(seen.map((s) => s.agent))).toEqual(new Set(["cardvision-verify/1"]));
  });

  it("sends the user agent it is given", async () => {
    const agents: Array<string | undefined> = [];
    await verifyRelease(runtime, options({ url: URL_OK, userAgent: "example-check/2" }), async (_url, init) => {
      agents.push(init.headers["User-Agent"]);
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    });
    expect(agents).toEqual(["example-check/2"]);
  });

  it("fails with the reason when the host answers 404", async () => {
    const out = await verifyRelease(runtime, options({ url: URL_OK }), async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }));
    expect(out.ok).toBe(false);
    expect(out.reason).toEqual(expect.any(String));
  });
});

// The built script, run as a product runs it. Needs `npm run build` to have written dist/.
const SCRIPT = fileURLToPath(new URL("../dist/node/verify-release.mjs", import.meta.url));
const RUNTIME = fileURLToPath(new URL("../dist/cardvision.js", import.meta.url));
const BUILT = existsSync(SCRIPT) && existsSync(RUNTIME);
// CI builds first and sets this, so that these tests cannot be skipped there unseen.
it.runIf(process.env.CARDVISION_REQUIRE_BROWSER === "1")("has the build these script tests need", () => {
  expect(BUILT).toBe(true);
});
describe.skipIf(!BUILT)("the built script", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8" });

  it("prints one JSON line with ok true for the release folder and exits 0", () => {
    const done = run("--dir", folder);
    expect(done.status).toBe(0);
    const lines = done.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, id });
  });

  it("refuses an address of another shape with exit 1", () => {
    const done = run("--url", "https://cdn.example.org/not/a/release.json");
    expect(done.status).toBe(1);
    expect(JSON.parse(done.stdout)).toMatchObject({ ok: false });
  });

  it("exits 2 without --dir or --url, or with both", () => {
    expect(run().status).toBe(2);
    expect(run("--dir", folder, "--url", "https://cdn.example.org/vision/releases/0123456789abcdef/release.json").status).toBe(2);
  });

  /** A product's layout: the runtime and VENDOR.json in one folder, the script in node/ below it,
   *  no ONNX Runtime files beside them, and onnxruntime-web in a node_modules above. */
  function productLayout(vendor: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), "verify-release-product-"));
    scratch.push(root);
    const dir = join(root, "vendor", "cardvision-browser");
    mkdirSync(join(dir, "node"), { recursive: true });
    copyFileSync(RUNTIME, join(dir, "cardvision.js"));
    copyFileSync(SCRIPT, join(dir, "node", "verify-release.mjs"));
    writeFileSync(join(dir, "VENDOR.json"), JSON.stringify(vendor));
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"));
    return join(dir, "node", "verify-release.mjs");
  }

  it("in a product's layout, finds ONNX Runtime's files in the installed package for --sessions", () => {
    const script = productLayout({ onnxruntimeWeb: ORT });
    const done = spawnSync(process.execPath, [script, "--dir", folder, "--sessions"], { encoding: "utf-8" });
    const out = JSON.parse(done.stdout);
    // The stand-in models are not models, so the sessions fail; but not for want of the runtime's files.
    expect(out.sessions).toBe("failed");
    expect(out.reason).not.toMatch(/ERR_MODULE_NOT_FOUND|ort-wasm.*(not found|Cannot find)/i);
    expect(spawnSync(process.execPath, [script, "--dir", folder], { encoding: "utf-8" }).status).toBe(0);
  });

  it("exits 2 when VENDOR.json beside the runtime pins no ONNX Runtime", () => {
    const script = productLayout({});
    const done = spawnSync(process.execPath, [script, "--dir", folder], { encoding: "utf-8" });
    expect(done.status).toBe(2);
    expect(done.stderr).toContain("onnxruntimeWeb");
  });

  it("can be imported from stdin (`node -`, where argv[1] is \"-\") without throwing", () => {
    const done = spawnSync(process.execPath, ["--input-type=module", "-"], { input: `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});\n`, encoding: "utf-8" });
    expect(done.status).toBe(0);
  });
});
