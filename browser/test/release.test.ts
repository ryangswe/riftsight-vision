// SPDX-License-Identifier: Apache-2.0
// The release loader, against a release of the toy game written by the Python package
// (fixtures/toy-release, see tests/test_browser_fixtures.py at the top of the repository). The
// fixture has no model files, since none is kept in the repository: where a test needs the
// whole release to load, it pins two stand-in byte strings in their place and gives the
// document its new id.

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Candidate } from "../src/boxes.js";
import {
  anchorCount,
  buildReleasePipeline,
  canonicalReleaseText,
  isRelativePath,
  loadReleaseData,
  ortWebCompatible,
  parseCatalog,
  parseRelease,
  type ReleaseData,
  type ReleaseDeps,
  releaseIdOf,
  type ReleaseModelFactories,
  sha256HexWebCrypto,
} from "../src/release.js";
import { RELEASE_FILES_BASE } from "../src/messages.js";
import { contract, FIXTURES, sha } from "./support.js";

const FOLDER = `${FIXTURES}toy-release/`;
const BASE = "https://example.test/releases/toy/";
const RELEASE_URL = `${BASE}release.json`;
const documentText = readFileSync(`${FOLDER}release.json`, "utf-8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pythonDoc = (): any => JSON.parse(documentText);

const text = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === "string" ? value : `${JSON.stringify(value, null, 1)}\n`);
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** The files of a release as a folder in memory, by path relative to the release document. */
type Files = Map<string, Uint8Array>;

/** Pin a file as it is now in one block of a document. */
async function pin(block: { path: string; sha256: string; bytes: number }, files: Files): Promise<void> {
  const body = files.get(block.path)!;
  block.sha256 = await sha256HexWebCrypto(buffer(body));
  block.bytes = body.length;
}

/** Write the document into the folder with the id its content has. */
async function seal(doc: Record<string, unknown>, files: Files): Promise<void> {
  doc.id = await releaseIdOf(JSON.stringify(doc), sha256HexWebCrypto);
  files.set("release.json", text(doc));
}

/**
 * The toy release with stand-in models, after `change` has had its way with the files and the
 * document. Components named in `repin` get their new hash and size written into the document.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function toyRelease(change?: (doc: any, files: Files) => unknown, repin: string[] = []): Promise<Files> {
  const files: Files = new Map();
  for (const name of ["bank.json", "bank.identity-groups.json", "catalog.json"]) files.set(name, new Uint8Array(readFileSync(`${FOLDER}${name}`)));
  files.set("detector.onnx", text("stand-in detector bytes"));
  files.set("recognizer.onnx", text("stand-in recognizer bytes, a little longer"));
  const doc = pythonDoc();
  await pin(doc.detector, files);
  await pin(doc.recognizer, files);
  await change?.(doc, files);
  for (const label of repin) await pin(label === "identity.groups" ? doc.identity.groups : doc[label], files);
  await seal(doc, files);
  return files;
}

function deps(files: Files, fetched: string[] = []): ReleaseDeps {
  return {
    digestSha256Hex: sha256HexWebCrypto,
    fetchFn: async (url) => {
      fetched.push(url);
      const body = url.startsWith(BASE) ? files.get(url.slice(BASE.length)) : undefined;
      return { ok: body !== undefined, status: body ? 200 : 404, arrayBuffer: async () => (body ? buffer(body) : new ArrayBuffer(0)) };
    },
  };
}

async function load(files: Files, ortWeb?: string) {
  return loadReleaseData(RELEASE_URL, deps(files), ortWeb === undefined ? {} : { ortWeb });
}

async function reasonOf(files: Files): Promise<string> {
  const result = await load(files);
  return result.ok ? "loaded" : result.reason;
}

const jsonOf = (files: Files, name: string) => JSON.parse(new TextDecoder().decode(files.get(name)!));

describe("the release document as the Python package writes it", () => {
  it("parses, and carries every setting the runtime acts on", () => {
    const parsed = parseRelease(pythonDoc());
    if ("error" in parsed) throw new Error(parsed.error);
    const r = parsed.release;
    expect([r.game, r.locale, r.id]).toEqual(["toy", "en", pythonDoc().id]);
    expect(r.detector).toMatchObject({ arm: "yolox", version: "toy-detector", path: "detector.onnx", weights: "fp32" });
    expect(r.detector.settings).toEqual({
      inputName: "images", outputName: "output", letterbox: { width: 640, height: 384, pad: 114 }, anchors: 5040,
      classes: ["face", "back"], decode: { threshold: 0.3, nmsIou: 0.45, maxProposals: 80 }, faceClass: 0, minCropPx: 24,
    });
    expect(r.recognizer).toMatchObject({ version: "toy-recognizer", dim: 128, inputName: "crops", outputName: "embeddings", preprocessing: "full128" });
    expect(r.bank).toMatchObject({ version: 1, cardCount: 20, entryCount: 20, path: "bank.json" });
    expect(r.identity).toMatchObject({ display: "best-printing", groups: { version: 1, path: "bank.identity-groups.json" } });
    expect(r.catalog).toMatchObject({ cardCount: 20, path: "catalog.json" });
    expect(r.accept).toEqual({ tau: 0.9, delta: 0.02, rotationRetry: true });
    expect(r.hover).toEqual({ selection: "accepted-nms", maxAgeMs: 2000 });
    expect(r.runtime).toEqual({ ortWeb: "1.29.0", executionProviders: ["webgpu", "wasm"], wasmThreads: 1, analysisWidth: { min: 720, max: 1920 } });
  });

  it("has the id this runtime computes from its text", async () => {
    expect(await releaseIdOf(documentText, sha256HexWebCrypto)).toBe(pythonDoc().id);
  });

  it("names the release's ONNX Runtime Web version, which is the one this package depends on", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    expect(pkg.dependencies["onnxruntime-web"]).toBe(pythonDoc().runtime.ortWeb);
  });

  it("counts a detector's rows from its input size", () => {
    expect([anchorCount(640, 384), anchorCount(64, 64)]).toEqual([5040, 84]);
  });
});

describe("the text an id is the hash of", () => {
  it("sorts keys, drops whitespace and the top-level id, and copies numbers as written", () => {
    const source = '{ "kind": "k", "id": "x", "b": [1.0, 2, 1e-05, -0.50, true, null], "a": {"id": 7, "z": "é\\n\\"q\\"", "y": {}} , "c": [] }';
    expect(canonicalReleaseText(source)).toBe('{"a":{"id":7,"y":{},"z":"é\\n\\"q\\""},"b":[1.0,2,1e-05,-0.50,true,null],"c":[],"kind":"k"}');
  });

  it("refuses text that is not one JSON object", () => {
    for (const bad of ["[1]", '{"a": 1} x', '{"a": }', '{"a" 1}', '"text"', "", '{"a": [1, }']) expect(() => canonicalReleaseText(bad), bad).toThrow();
  });
});

describe("what parseRelease refuses", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refused = (change: (doc: any) => void): string => {
    const doc = pythonDoc();
    change(doc);
    const parsed = parseRelease(doc);
    return "error" in parsed ? parsed.error : "accepted";
  };

  it("a document of another kind or schema, an unknown key, a missing part", () => {
    expect(refused((d) => (d.kind = "other"))).toContain("vision-release");
    expect(refused((d) => (d.schemaVersion = 2))).toContain("schema version 1");
    expect(refused((d) => (d.extra = 1))).toContain("unknown key(s) extra");
    for (const part of ["detector", "recognizer", "bank", "catalog", "accept"]) expect(refused((d) => delete d[part]), part).toContain("incomplete release");
    expect(refused((d) => delete d.identity.groups)).toContain("incomplete release");
    expect(refused((d) => delete d.hover)).toContain("hover");
    expect(refused((d) => delete d.runtime)).toContain("runtime");
    expect(parseRelease(null)).toHaveProperty("error");
  });

  it("a path that leaves the release's folder", () => {
    expect(refused((d) => (d.bank.path = "../bank.json"))).toContain("bank");
    expect(refused((d) => (d.detector.path = "/abs/detector.onnx"))).toContain("detector");
    expect(refused((d) => (d.catalog.path = "https://elsewhere.test/catalog.json"))).toContain("catalog");
    expect([isRelativePath("models/a.onnx"), isRelativePath("a/../b"), isRelativePath("C:/a"), isRelativePath("a\\b"), isRelativePath(""), isRelativePath(3)]).toEqual([true, false, false, false, false, false]);
  });

  // The paths of tests/test_browser_fixtures.py, with the answers verify-release gives.
  it.each((contract.paths as { paths: Array<{ path: string; accepted: boolean }> }).paths.map((row) => [row.path, row.accepted] as const))(
    "isRelativePath(%j) is %s, as verify-release says",
    (path, accepted) => {
      expect(isRelativePath(path)).toBe(accepted);
    },
  );

  it("a detector contract this runtime does not implement", () => {
    expect(refused((d) => (d.detector.arm = "other"))).toContain("detector.arm");
    expect(refused((d) => (d.detector.decode.channels = "RGB"))).toContain("detector.decode.channels");
    expect(refused((d) => (d.detector.decode.scale = "0-1"))).toContain("detector.decode.scale");
    expect(refused((d) => (d.detector.decode.letterbox.resize = "nearest"))).toContain("letterbox.resize");
    expect(refused((d) => (d.detector.decode.letterbox.width = 320))).toContain("letterbox differs");
    expect(refused((d) => (d.detector.decode.output.anchors = 9))).toContain("anchors must be 5040");
    expect(refused((d) => d.detector.decode.output.columns.pop())).toContain("columns");
    expect(refused((d) => (d.detector.decode.nms.classAgnostic = false))).toContain("nms");
    expect(refused((d) => (d.detector.decode.threshold = 1))).toContain("threshold");
    expect(refused((d) => (d.detector.decode.threshold = 0.005))).toContain("below 0.01");
    expect(refused((d) => (d.detector.faceClass = 1))).toContain("faceClass");
    expect(refused((d) => (d.detector.minCropPx = 0))).toContain("minCropPx");
  });

  it("takes a detector's numbers from the document when the method is the one implemented", () => {
    const doc = pythonDoc();
    doc.detector.input = { width: 416, height: 256 };
    Object.assign(doc.detector.decode.letterbox, { width: 416, height: 256, pad: 0 });
    doc.detector.decode.output.anchors = anchorCount(416, 256);
    Object.assign(doc.detector.decode, { threshold: 0.5, maxProposals: 10, inputName: "in", outputName: "out" });
    doc.detector.decode.nms.iou = 0.6;
    const parsed = parseRelease(doc);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.release.detector.settings).toMatchObject({
      inputName: "in", outputName: "out", letterbox: { width: 416, height: 256, pad: 0 }, anchors: anchorCount(416, 256),
      decode: { threshold: 0.5, nmsIou: 0.6, maxProposals: 10 },
    });
  });

  it("a recognizer contract, an accept rule, a hover rule or a runtime it cannot honor", () => {
    expect(refused((d) => (d.recognizer.preprocessing.size = 96))).toContain("preprocessing");
    expect(refused((d) => (d.recognizer.preprocessing = "full128"))).toContain("preprocessing");
    expect(refused((d) => delete d.recognizer.inputName)).toContain("input and output");
    expect(refused((d) => (d.accept.tau = 0))).toContain("accept.tau");
    expect(refused((d) => (d.accept.delta = 1))).toContain("accept.delta");
    expect(refused((d) => (d.accept.rotationRetry = "yes"))).toContain("rotationRetry");
    expect(refused((d) => (d.accept.rotation = "retry"))).toContain("unknown key");
    expect(refused((d) => (d.identity.level = "id"))).toContain("identity.level");
    expect(refused((d) => (d.identity.display = "other"))).toContain("identity.display");
    expect(refused((d) => (d.bank.aggregation = "max"))).toContain("aggregation");
    expect(refused((d) => (d.hover.selection = "newest"))).toContain("hover.selection");
    expect(refused((d) => (d.hover.maxAgeMs = 0))).toContain("maxAgeMs");
    expect(refused((d) => (d.runtime.ortWeb = "1.29"))).toContain("ortWeb");
    expect(refused((d) => (d.runtime.wasmThreads = 4))).toContain("wasmThreads");
    expect(refused((d) => (d.runtime.executionProviders = ["webgpu", "cuda"]))).toContain("executionProviders");
    expect(refused((d) => (d.runtime.executionProviders = []))).toContain("executionProviders");
    expect(refused((d) => (d.runtime.analysisWidth = { min: 2000, max: 1000 }))).toContain("analysisWidth");
  });

  it("accepts each documented alternative", () => {
    expect(refused((d) => (d.accept.rotationRetry = false))).toBe("accepted");
    expect(refused((d) => (d.identity.display = "representative"))).toBe("accepted");
    expect(refused((d) => (d.hover.selection = "detector-score"))).toBe("accepted");
    expect(refused((d) => (d.runtime.executionProviders = ["wasm"]))).toBe("accepted");
    expect(refused((d) => (d.runtime.analysisWidth = { min: 640, max: 1280 }))).toBe("accepted");
  });
});

describe("loading a release, all-or-nothing", () => {
  it("goes on when the onDocument callback throws: it is advisory", async () => {
    const files = await toyRelease();
    const result = await loadReleaseData(RELEASE_URL, deps(files), { onDocument: () => { throw new Error("a display that broke"); } });
    expect(result.ok).toBe(true);
  });

  it("tells loadRelease's caller: downloading, then the bytes, then preparing; and no preparing when a file fails", async () => {
    const { loadRelease, ReleaseError } = await import("../src/load.js");
    const phases = async (files: Files, throwing = false) => {
      const said: Array<[string, number | null]> = [];
      const outcome = await loadRelease(RELEASE_URL, {
        deps: deps(files),
        providers: ["wasm"],
        onProgress: (progress) => {
          said.push([progress.phase, progress.phase === "downloading" ? progress.bytes : null]);
          if (throwing) throw new Error("a display that broke");
        },
      }).then(() => "loaded", (error: unknown) => (error instanceof ReleaseError ? `refused: ${error.reason}` : `threw: ${String(error)}`));
      return { said, outcome };
    };
    const files = await toyRelease();
    const doc = JSON.parse(new TextDecoder().decode(files.get("release.json")));
    const pinned = doc.detector.bytes + doc.recognizer.bytes + doc.bank.bytes + doc.identity.groups.bytes + doc.catalog.bytes;
    // The stand-in model files are not ONNX models, so preparing them fails: after it was said.
    const stand = await phases(files);
    expect(stand.said).toEqual([["downloading", null], ["downloading", pinned], ["preparing", null]]);
    expect(stand.outcome).toMatch(/^refused: /);
    // A callback that throws changes nothing.
    expect(await phases(files, true)).toEqual(stand);
    const noCatalog = new Map(files);
    noCatalog.delete("catalog.json");
    expect(await phases(noCatalog)).toEqual({ said: [["downloading", null], ["downloading", pinned]], outcome: "refused: catalog: HTTP 404" });
    const noDocument = new Map(files);
    noDocument.delete("release.json");
    expect(await phases(noDocument)).toEqual({ said: [["downloading", null]], outcome: "refused: release: HTTP 404" });
  });

  it("says what is left to download once the document is read, before any pinned file is fetched", async () => {
    const files = await toyRelease();
    const fetched: string[] = [];
    const told: Array<[number, number]> = [];
    const result = await loadReleaseData(RELEASE_URL, deps(files, fetched), { onDocument: (bytes) => told.push([bytes, fetched.length]) });
    if (!result.ok) throw new Error(result.reason);
    const r = result.data.release;
    expect(told).toEqual([[r.detector.bytes + r.recognizer.bytes + r.bank.bytes + r.identity.groups.bytes + r.catalog.bytes, 1]]);
  });

  it("fetches the document and each pinned file beside it, once, and returns them checked", async () => {
    const files = await toyRelease();
    const fetched: string[] = [];
    const result = await loadReleaseData(RELEASE_URL, deps(files, fetched), { ortWeb: "1.29.0" });
    if (!result.ok) throw new Error(result.reason);
    expect(fetched.sort()).toEqual(["bank.identity-groups.json", "bank.json", "catalog.json", "detector.onnx", "recognizer.onnx", "release.json"].map((name) => BASE + name));
    const { data } = result;
    expect(data.bank.ids).toHaveLength(20);
    expect([data.bank.dim, data.bank.model, data.bank.preprocessing]).toEqual([128, "toy-recognizer", "full128"]);
    expect(data.cards).toHaveLength(20);
    expect(data.names.get("TOY-003A")).toBe("Coral Triangle");
    expect(data.identityGroups.groups).toEqual([["TOY-003", "TOY-003A"], ["TOY-010", "TOY-P01"]]);
    expect(new TextDecoder().decode(data.detectorBytes)).toBe("stand-in detector bytes");
    expect(data.release.accept.tau).toBe(0.9);
  });

  it("resolves paths against the document, wherever it is", async () => {
    const files = await toyRelease(async (doc, all) => {
      all.set("models/detector.onnx", all.get("detector.onnx")!);
      all.delete("detector.onnx");
      doc.detector.path = "models/detector.onnx";
    });
    expect(await reasonOf(files)).toBe("loaded");
  });

  it("refuses the release when one byte of any component changed", async () => {
    for (const name of ["detector.onnx", "recognizer.onnx", "bank.json", "bank.identity-groups.json", "catalog.json"]) {
      const files = await toyRelease();
      const body = files.get(name)!.slice();
      body[10] = body[10]! ^ 1;
      files.set(name, body);
      expect(await reasonOf(files), name).toContain(`sha256 of ${name} does not match`);
    }
  });

  it("refuses a component of another size, a missing one, and one that cannot be fetched", async () => {
    const longer = await toyRelease();
    longer.set("bank.json", text(`${new TextDecoder().decode(longer.get("bank.json")!)} `));
    expect(await reasonOf(longer)).toMatch(/bank: bank\.json is \d+ bytes, the release says \d+/);
    const missing = await toyRelease();
    missing.delete("recognizer.onnx");
    expect(await reasonOf(missing)).toBe("recognizer: HTTP 404");
    const broken = await toyRelease();
    const failing: ReleaseDeps = { ...deps(broken), fetchFn: async (url) => (url.endsWith("catalog.json") ? Promise.reject(new Error("offline")) : deps(broken).fetchFn(url)) };
    expect(await loadReleaseData(RELEASE_URL, failing)).toMatchObject({ ok: false, reason: expect.stringContaining("catalog: fetch failed") });
    expect(await loadReleaseData(`${BASE}absent.json`, deps(broken))).toEqual({ ok: false, reason: "release: HTTP 404" });
  });

  it("refuses a document that was edited after it was given its id", async () => {
    const files = await toyRelease();
    const doc = jsonOf(files, "release.json");
    doc.accept.tau = 0.5;
    files.set("release.json", text(doc));
    expect(await reasonOf(files)).toMatch(/is not the hash of the document/);
    files.set("release.json", text("{ not json"));
    expect(await reasonOf(files)).toBe("release: the file is not JSON");
  });

  it("refuses a release measured on another line of ONNX Runtime Web", async () => {
    const files = await toyRelease();
    expect((await load(files, "1.29.4")).ok).toBe(true);
    expect((await load(files)).ok).toBe(true);
    expect(await load(files, "1.30.0")).toMatchObject({ ok: false, reason: expect.stringContaining("onnxruntime-web 1.29.0") });
    expect([ortWebCompatible("1.29.0", "1.29.9"), ortWebCompatible("1.29.0", "2.29.0"), ortWebCompatible("1.29", "1.29.0")]).toEqual([true, false, false]);
  });

  it("refuses a bank that does not belong to the release's recognizer or accept rule", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withBank = (edit: (bank: any) => void) => toyRelease((_doc, files) => {
      const bank = jsonOf(files, "bank.json");
      edit(bank);
      files.set("bank.json", text(bank));
    }, ["bank"]);
    expect(await reasonOf(await withBank((b) => (b.model = "another-recognizer")))).toContain("is not recognizer.version");
    expect(await reasonOf(await withBank((b) => (b.version = 2)))).toContain("bank.version");
    expect(await reasonOf(await withBank((b) => (b.tau = 0.5)))).toContain("records tau 0.5");
    expect(await reasonOf(await withBank((b) => b.entries.pop()))).toContain("entryCount");
    expect(await reasonOf(await withBank((b) => (b.entries[1].cardId = b.entries[0].cardId)))).toContain("cardCount");
    expect(await reasonOf(await withBank((b) => (b.entries[0].vec = "AAAA")))).toContain("not a bank this runtime can read");
    expect(await reasonOf(await toyRelease((doc) => (doc.recognizer.dim = 64)))).toContain("vector size");
    // A bank that records the release's own tau is fine, though its groups file no longer names it.
    expect(await reasonOf(await withBank((b) => (b.tau = 0.9)))).toContain("identity.groups: the file was not made for this release's bank");
  });

  it("refuses a catalog for another game, of another size, or without one of the bank's cards", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withCatalog = (edit: (catalog: any, doc: any) => void) => toyRelease((doc, files) => {
      const catalog = jsonOf(files, "catalog.json");
      edit(catalog, doc);
      files.set("catalog.json", text(catalog));
    }, ["catalog"]);
    expect(await reasonOf(await withCatalog((c) => (c.game = "other")))).toContain("another game or locale");
    expect(await reasonOf(await withCatalog((c) => c.cards.pop()))).toContain("cardCount 20 is not the file's 19 cards");
    expect(await reasonOf(await withCatalog((c, doc) => (c.cards.pop(), (doc.catalog.cardCount = 19))))).toContain("1 bank id(s) are not in the catalog (e.g. TOY-P01)");
    expect(await reasonOf(await withCatalog((c) => (c.cards[1].id = c.cards[0].id)))).toContain("appears twice");
    expect(parseCatalog({ game: "g", locale: "en", cards: [{ id: "A", name: "a" }] })).toContain("art path");
  });

  it("refuses identity groups that are not the ones the catalog's names give for the bank", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withGroups = (edit: (groups: any) => void) => toyRelease((_doc, files) => {
      const groups = jsonOf(files, "bank.identity-groups.json");
      edit(groups);
      files.set("bank.identity-groups.json", text(groups));
    }, ["identity.groups"]);
    expect(await reasonOf(await withGroups((g) => (g.version = 9)))).toContain("identity.groups.version");
    expect(await reasonOf(await withGroups((g) => (g.bank.sha256 = "0".repeat(64))))).toContain("not made for this release's bank");
    expect(await reasonOf(await withGroups((g) => (g.groups.pop(), delete g.representative["TOY-P01"])))).toContain("not the ones the catalog's names give");
    expect(await reasonOf(await withGroups((g) => (g.kind = "other")))).toContain("not an identity-groups document");
    // A renamed card changes which printings are one identity: the old groups no longer hold.
    const renamed = await toyRelease((_doc, files) => {
      const catalog = jsonOf(files, "catalog.json");
      catalog.cards.find((card: { id: string }) => card.id === "TOY-003A").name = "Something Else";
      files.set("catalog.json", text(catalog));
    }, ["catalog"]);
    expect(await reasonOf(renamed)).toContain("not the ones the catalog's names give");
  });
});

describe("a release converted as cardvision convert-release writes it: bank.bin and a compact catalog", () => {
  /** The Python package's binary form of the toy release's bank (fixtures/contract.json). */
  const binaryBank = (): Uint8Array => new Uint8Array(Buffer.from(contract.bank.toyReleaseBinary as string, "base64"));

  /** The toy release converted: the bank as `bank` (the binary form unless given), the groups
   *  naming its SHA-256, the catalog compact, every seal and the id written again. */
  const converted = (bank: Uint8Array = binaryBank()) => toyRelease(async (doc, files) => {
    files.delete("bank.json");
    files.set("bank.bin", bank);
    doc.bank.path = "bank.bin";
    await pin(doc.bank, files);
    const groups = jsonOf(files, "bank.identity-groups.json");
    groups.bank.sha256 = doc.bank.sha256;
    files.set("bank.identity-groups.json", text(groups));
    files.set("catalog.json", text(`${JSON.stringify(jsonOf(files, "catalog.json"))}\n`));
  }, ["identity.groups", "catalog"]);

  it("loads, with the same bank, catalog and groups as the JSON release, bit for bit", async () => {
    const before = await load(await toyRelease());
    const after = await load(await converted());
    if (!before.ok || !after.ok) throw new Error(before.ok ? (after as { reason: string }).reason : before.reason);
    expect(after.data.release.bank.path).toBe("bank.bin");
    expect(after.data.bank.ids).toEqual(before.data.bank.ids);
    expect(sha(after.data.bank.matrix)).toBe(sha(before.data.bank.matrix));
    expect(after.data.bank).toEqual(before.data.bank);
    expect(after.data.cards).toEqual(before.data.cards);
    expect(after.data.identityGroups).toEqual(before.data.identityGroups);
  });

  it("refuses a binary bank of another format version, cut short, or with bytes after its rows", async () => {
    const versionTwo = binaryBank();
    versionTwo[7] = 2;
    expect(await reasonOf(await converted(versionTwo))).toBe("bank: the binary bank is of format version 2, and this runtime reads version 1 only");
    const body = binaryBank();
    expect(await reasonOf(await converted(body.subarray(0, body.length - 2)))).toBe("bank: the file is not a bank this runtime can read");
    expect(await reasonOf(await converted(new Uint8Array([...body, 0, 0])))).toBe("bank: the file is not a bank this runtime can read");
  });
});

describe("a release given as files, from a folder chosen on this computer", () => {
  afterEach(() => vi.restoreAllMocks());
  const blobs = (files: Files): Record<string, Blob> => Object.fromEntries([...files].map(([name, body]) => [name, new Blob([buffer(body)])]));

  /** loadRelease on the files, with no fetch allowed: what it says, and how it ends. */
  async function fromFiles(files: Record<string, Blob>, releaseUrl = "release.json") {
    const { loadRelease, ReleaseError } = await import("../src/load.js");
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("nothing may be fetched");
    });
    const said: string[] = [];
    const outcome = await loadRelease(releaseUrl, { files, providers: ["wasm"], onProgress: (progress) => said.push(progress.phase) })
      .then(() => "loaded", (error: unknown) => (error instanceof ReleaseError ? `refused: ${error.reason}` : `threw: ${String(error)}`));
    return { said, outcome, fetches: fetched.mock.calls.length };
  }

  it("reads the release from the files, with every check a fetched one has, and fetches nothing", async () => {
    const { filesFetch } = await import("../src/load.js");
    const files = blobs(await toyRelease());
    const result = await loadReleaseData(`${RELEASE_FILES_BASE}release.json`, { fetchFn: filesFetch(files), digestSha256Hex: sha256HexWebCrypto });
    if (!result.ok) throw new Error(result.reason);
    expect(result.data.cards).toHaveLength(20);
    expect(result.data.release.game).toBe("toy");
    // Through loadRelease: every file checked, then the models are prepared (and fail, being
    // stand-ins), and no request was made.
    const loaded = await fromFiles(files);
    expect(loaded.said).toEqual(["downloading", "downloading", "preparing"]);
    expect(loaded.outcome).toMatch(/^refused: /);
    expect(loaded.outcome).not.toMatch(/sha256|bytes, the release says|fetch failed/);
    expect(loaded.fetches).toBe(0);
  });

  it("refuses a file that was changed, as it refuses a fetched one", async () => {
    for (const name of ["detector.onnx", "recognizer.onnx", "bank.json", "bank.identity-groups.json", "catalog.json"]) {
      const files = await toyRelease();
      const body = files.get(name)!.slice();
      body[10] = body[10]! ^ 1;
      files.set(name, body);
      const tampered = await fromFiles(blobs(files));
      expect(tampered.outcome, name).toBe(`refused: ${name.replace(/\.onnx$/, "").replace(/^bank\.identity-groups\.json$/, "identity.groups").replace(/\.json$/, "")}: sha256 of ${name} does not match the release`);
      expect(tampered.said, name).not.toContain("preparing");
      expect(tampered.fetches, name).toBe(0);
    }
    const edited = await toyRelease();
    const doc = jsonOf(edited, "release.json");
    doc.accept.tau = 0.5;
    edited.set("release.json", text(doc));
    expect((await fromFiles(blobs(edited))).outcome).toMatch(/^refused: release: id \S+ is not the hash of the document/);
  });

  it.each(["file:/etc/passwd", "%2e%2e/x", "http:evil/x", "data:application/octet-stream,x"])(
    "refuses a document that pins %j, before reading anything",
    async (path) => {
      const files = await toyRelease();
      const doc = jsonOf(files, "release.json");
      doc.recognizer.path = path;
      await seal(doc, files);
      const result = await fromFiles(blobs(files));
      expect(result.outcome).toMatch(/^refused: .*recognizer must pin a file/);
      expect(result.said).not.toContain("preparing");
      expect(result.fetches).toBe(0);
    },
  );

  it("names a file that is not among them, and reads nothing outside them", async () => {
    const files = blobs(await toyRelease());
    delete files["recognizer.onnx"];
    expect((await fromFiles(files)).outcome).toBe("refused: recognizer: fetch failed (Error: no file recognizer.onnx among the release's files)");
    // An address is never fetched when files are given: only paths among them are read.
    const elsewhere = await fromFiles(blobs(await toyRelease()), "https://example.test/release.json");
    expect(elsewhere.outcome).toBe("refused: release: fetch failed (Error: https://example.test/release.json is not one of the release's files)");
    expect(elsewhere.fetches).toBe(0);
  });

  it("finds a file by its path relative to the document's folder, as the loader resolves it", async () => {
    const { filesFetch } = await import("../src/load.js");
    const fetchFn = filesFetch({ "a b/x.onnx": new Blob(["x"]), "y.json": new Blob(["yy"]) });
    expect((await (await fetchFn(new URL("a b/x.onnx", `${RELEASE_FILES_BASE}release.json`).href)).arrayBuffer()).byteLength).toBe(1);
    expect((await (await fetchFn(new URL("./y.json", `${RELEASE_FILES_BASE}release.json`).href)).arrayBuffer()).byteLength).toBe(2);
    await expect(fetchFn(`${RELEASE_FILES_BASE}toString`)).rejects.toThrow("no file toString among the release's files");
  });
});

describe("building the pipeline a release describes", () => {
  async function data(): Promise<ReleaseData> {
    const result = await load(await toyRelease());
    if (!result.ok) throw new Error(result.reason);
    return result.data;
  }

  function factories(log: string[], missing: "embedder" | "detector" | null = null): ReleaseModelFactories {
    return {
      embedder: async (bytes, settings, providers) => {
        log.push(`embedder ${new TextDecoder().decode(bytes).slice(0, 19)} ${JSON.stringify(settings)} ${providers.join("+")}`);
        if (missing === "embedder") return null;
        return { ep: "wasm", embedBatch: async (_d, n) => new Float32Array(n * 128), release: async () => void log.push("embedder released") };
      },
      detector: async (_bytes, settings, providers) => {
        log.push(`detector ${settings.letterbox.width}x${settings.letterbox.height} ${providers.join("+")}`);
        if (missing === "detector") return null;
        return { ep: "wasm", lastTimings: null, propose: async (): Promise<Candidate[]> => [], release: async () => void log.push("detector released") };
      },
    };
  }

  it("hands each model its bytes and the release's settings, and the release's providers in order", async () => {
    const log: string[] = [];
    const built = await buildReleasePipeline(await data(), factories(log));
    if ("error" in built) throw new Error(built.error);
    expect(log).toEqual([
      'embedder stand-in recognizer {"inputName":"crops","outputName":"embeddings","inputSize":128,"dim":128} webgpu+wasm',
      "detector 640x384 webgpu+wasm",
    ]);
    expect([built.pipeline.size, built.pipeline.hoverSelection, built.providers]).toEqual([20, "accepted-nms", ["webgpu", "wasm"]]);
    const analysis = await built.pipeline.analyze({ data: new Uint8ClampedArray(720 * 405 * 4), width: 720, height: 405 });
    expect(analysis.boxes).toEqual([]);
  });

  it("takes another list of providers when given one", async () => {
    const log: string[] = [];
    await buildReleasePipeline(await data(), factories(log), ["wasm"]);
    expect(log[1]).toBe("detector 640x384 wasm");
    expect(await buildReleasePipeline(await data(), factories(log), [])).toEqual({ error: "no execution provider to try" });
  });

  it("is all-or-nothing: a model that does not start frees the one that did", async () => {
    const log: string[] = [];
    expect(await buildReleasePipeline(await data(), factories(log, "detector"))).toMatchObject({ error: expect.stringContaining("detector") });
    expect(log.slice(-1)).toEqual(["embedder released"]);
    const none: string[] = [];
    expect(await buildReleasePipeline(await data(), factories(none, "embedder"))).toMatchObject({ error: expect.stringContaining("recognizer") });
    expect(none).toHaveLength(1);
  });
});
