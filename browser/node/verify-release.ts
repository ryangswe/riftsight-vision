// SPDX-License-Identifier: Apache-2.0
// Check a release the way the extension's runtime will, before (or after) it goes on a host.
//
//   node verify-release.mjs --dir <release folder> [--expect-id ID] [--sessions]
//   node verify-release.mjs --url https://<host>/vision/releases/<id>/release.json [--expect-id ID] [--sessions]
//
// Without --sessions: the runtime's `loadReleaseData`: the document, every pinned file against its
// size and SHA-256, the bank, catalog and identity groups against each other, and the ONNX Runtime
// pin. Data only, no model is started.
// --sessions: the runtime's `loadRelease` in Node on the "wasm" provider, which also creates both
// ONNX Runtime sessions (use it when the detector or recognizer differs from the live release's).
// With --url the files are fetched over https, as a browser would, with no cookies.
//
// The runtime is the `cardvision.js` beside this script (a product's vendored folder) or one
// folder up (this package's dist/node/). The ONNX Runtime pin is `--ort-web`, else the
// `onnxruntimeWeb` of a VENDOR.json beside the runtime, else the onnxruntime-web package Node can
// resolve.
//
// Prints one JSON line {ok, id, bankEntries, bankCards, catalogCards, sessions, reason} and exits 0
// only when everything holds (and the id is --expect-id, when given); 2 for a bad command line.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { LoadedRelease, LoadOptions } from "../src/load.js";
import type { ReleaseData, ReleaseDeps } from "../src/release.js";

/** The two functions of the runtime this script uses. */
export interface RuntimeApi {
  loadReleaseData(url: string, deps: ReleaseDeps, options: { ortWeb?: string }): Promise<{ ok: true; data: ReleaseData } | { ok: false; reason: string }>;
  loadRelease(url: string, options: LoadOptions): Promise<LoadedRelease>;
}

export interface VerifyOptions {
  dir?: string;
  url?: string;
  expectId?: string;
  sessions: boolean;
  userAgent: string;
  ortWeb: string | undefined;
  /** Folder of ONNX Runtime's `.wasm` files for --sessions (undefined: the package's own). */
  wasmPaths?: string;
}

export interface VerifyResult {
  ok: boolean;
  id: string | null;
  bankEntries: number | null;
  bankCards: number | null;
  catalogCards: number | null;
  sessions: string;
  reason: string | null;
}

export const DEFAULT_USER_AGENT = "cardvision-verify/1";
const URL_SHAPE = /^https:\/\/[^/]+\/vision\/releases\/[0-9a-f]{16}\/release\.json$/;

const digestSha256Hex = async (bytes: ArrayBuffer): Promise<string> => createHash("sha256").update(Buffer.from(bytes)).digest("hex");

const fileFetch: ReleaseDeps["fetchFn"] = async (url) => {
  const path = fileURLToPath(url);
  if (!existsSync(path)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  const bytes = readFileSync(path);
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
};

/**
 * Check one release. `fetchFn` replaces the https fetch (tests, a local server); the file mode
 * always reads the folder.
 */
export async function verifyRelease(runtime: RuntimeApi, options: VerifyOptions, fetchFn?: (url: string, init: { credentials: "omit"; headers: Record<string, string> }) => ReturnType<ReleaseDeps["fetchFn"]>): Promise<VerifyResult> {
  const out: VerifyResult = { ok: false, id: null, bankEntries: null, bankCards: null, catalogCards: null, sessions: options.sessions ? "not run" : "skipped", reason: null };
  if (options.url && !URL_SHAPE.test(options.url)) {
    out.reason = "the url is not https://<host>/vision/releases/<id>/release.json";
    return out;
  }
  const releaseUrl = options.dir ? pathToFileURL(join(resolve(options.dir), "release.json")).href : (options.url as string);
  const request = fetchFn ?? ((url, init) => fetch(url, init) as ReturnType<ReleaseDeps["fetchFn"]>);
  const httpsFetch: ReleaseDeps["fetchFn"] = (url) => request(url, { credentials: "omit", headers: { "User-Agent": options.userAgent } });
  const deps: ReleaseDeps = { fetchFn: options.dir ? fileFetch : httpsFetch, digestSha256Hex };

  const checked = await runtime.loadReleaseData(releaseUrl, deps, options.ortWeb === undefined ? {} : { ortWeb: options.ortWeb });
  if (!checked.ok) {
    out.reason = checked.reason;
    return out;
  }
  const r = checked.data.release;
  Object.assign(out, { id: r.id, bankEntries: r.bank.entryCount, bankCards: r.bank.cardCount, catalogCards: r.catalog.cardCount });
  if (options.expectId && r.id !== options.expectId) {
    out.reason = `id ${r.id} is not the expected ${options.expectId}`;
  } else if (options.sessions) {
    try {
      const loaded = await runtime.loadRelease(releaseUrl, { providers: ["wasm"], deps, ...(options.wasmPaths !== undefined ? { wasmPaths: options.wasmPaths } : {}) });
      out.sessions = `ok (detector ${loaded.backend.detector}, recognizer ${loaded.backend.recognizer})`;
      await loaded.dispose();
      out.ok = true;
    } catch (error) {
      out.sessions = "failed";
      const reason = (error as { reason?: unknown } | null)?.reason;
      out.reason = `sessions: ${reason ? String(reason) : String(error)}`;
    }
  } else out.ok = true;
  return out;
}

/** The folder of the onnxruntime-web package Node resolves from this script, or undefined. */
function installedOrtDir(): string | undefined {
  try {
    let dir = dirname(createRequire(import.meta.url).resolve("onnxruntime-web"));
    for (; dir !== dirname(dir); dir = dirname(dir)) {
      const file = join(dir, "package.json");
      if (!existsSync(file)) continue;
      if ((JSON.parse(readFileSync(file, "utf-8")) as { name?: string }).name === "onnxruntime-web") return dir;
    }
  } catch {
    // Not installed.
  }
  return undefined;
}

/** True when this module is the script Node was started on (not imported by a test or `node -`). */
function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const USAGE = "usage: node verify-release.mjs (--dir DIR | --url URL) [--expect-id ID] [--sessions] [--ort-web VERSION] [--user-agent TEXT]";

async function main(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: "string" },
        url: { type: "string" },
        "expect-id": { type: "string" },
        sessions: { type: "boolean", default: false },
        "ort-web": { type: "string" },
        "user-agent": { type: "string", default: DEFAULT_USER_AGENT },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.dir === !values.url) {
    console.error(USAGE);
    return 2;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const runtimeDir = [here, dirname(here)].find((dir) => existsSync(join(dir, "cardvision.js")));
  if (!runtimeDir) {
    console.error(`cardvision.js is neither beside this script nor one folder up (${here})`);
    return 2;
  }
  const runtime = (await import(pathToFileURL(join(runtimeDir, "cardvision.js")).href)) as RuntimeApi;

  const ortDir = installedOrtDir();
  let ortWeb = values["ort-web"];
  const vendorFile = join(runtimeDir, "VENDOR.json");
  if (ortWeb === undefined && existsSync(vendorFile)) {
    ortWeb = (JSON.parse(readFileSync(vendorFile, "utf-8")) as { onnxruntimeWeb?: string }).onnxruntimeWeb;
    if (ortWeb === undefined) {
      console.error(`${vendorFile} has no onnxruntimeWeb: pass --ort-web VERSION`);
      return 2;
    }
  } else if (ortWeb === undefined && ortDir !== undefined) {
    ortWeb = (JSON.parse(readFileSync(join(ortDir, "package.json"), "utf-8")) as { version?: string }).version;
  }
  if (ortWeb === undefined) {
    console.error("no ONNX Runtime pin to check the release against: pass --ort-web VERSION");
    return 2;
  }
  // ONNX Runtime's WebAssembly files: beside the runtime when it carries them (this package's
  // dist/), else the dist/ of the onnxruntime-web package Node resolves from here (a product's).
  let wasmDir: string | undefined;
  if (readdirSync(runtimeDir).some((name) => /^ort-wasm-.*\.wasm$/.test(name))) wasmDir = runtimeDir;
  else if (ortDir !== undefined && existsSync(join(ortDir, "dist"))) wasmDir = join(ortDir, "dist");

  const out = await verifyRelease(runtime, {
    ...(values.dir !== undefined ? { dir: values.dir } : {}),
    ...(values.url !== undefined ? { url: values.url } : {}),
    ...(values["expect-id"] !== undefined ? { expectId: values["expect-id"] } : {}),
    sessions: values.sessions,
    userAgent: values["user-agent"],
    ortWeb,
    ...(wasmDir !== undefined ? { wasmPaths: `${pathToFileURL(wasmDir).href}/` } : {}),
  });
  console.log(JSON.stringify(out));
  return out.ok ? 0 : 1;
}

// Run as a script (the bundle's entry), not when a test imports verifyRelease.
if (isEntry()) process.exit(await main(process.argv.slice(2)));
