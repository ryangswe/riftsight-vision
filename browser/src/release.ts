// SPDX-License-Identifier: Apache-2.0
// The release document: one file that pins everything recognition runs with.
// In Python: cardvision/bank/release.py, which writes the document (`cardvision build-release`)
// and holds the full description of its shape.
//
// A detector, a recognizer, a bank, identity groups, a catalog and a handful of thresholds
// only mean something together: accuracy is measured for one exact combination. A release names
// the combination. It points at each component file by a path relative to itself, with the
// file's SHA-256 and size, and writes down the settings that are not files.
//
// Loading is all-or-nothing. The document must parse and name only contracts this runtime
// implements; its id must be the hash of its content; every component must fetch, have the
// stated size and hash, and agree with the others. Any failure means nothing is loaded: there
// is no partial load and no fallback to another file.
//
// This file fetches and checks bytes and builds the pipeline through model factories passed
// in, so it runs without a browser and without ONNX Runtime (the tests pass their own).

import { type EmbeddingBank, parseBank } from "./bank.js";
import { FACE_CLASS } from "./detector/decode.js";
import type { DetectorSettings, FrameDetector } from "./detector/detector.js";
import type { BatchEmbedder, EmbedderSettings } from "./embedder.js";
import { type HoverSelection, isHoverSelection } from "./hover-layer.js";
import { groupsByKey, type IdentityDisplay, type IdentityGroups, identityOf, type IdentityRule, isIdentityRule, parseIdentityGroups } from "./identity.js";
import { EXECUTION_PROVIDERS, type ExecutionProvider } from "./providers.js";
import { Pipeline } from "./pipeline.js";
import { contractOf, PREPROCESSING, type PreprocessingId } from "./preprocess.js";
import type { AcceptRule } from "./recognizer.js";

export const RELEASE_SCHEMA_VERSION = 1;
export const RELEASE_KIND = "vision-release";

/** Strides of the detector family's three output grids: they fix how many rows a model emits. */
const YOLOX_STRIDES = [8, 16, 32] as const;

/** How many rows a detector of this input size emits. */
export function anchorCount(width: number, height: number): number {
  return YOLOX_STRIDES.reduce((n, stride) => n + Math.floor(width / stride) * Math.floor(height / stride), 0);
}

/** A file a release pins: its path relative to the release document, its SHA-256 and its size. */
export interface PinnedFile {
  path: string;
  sha256: string;
  bytes: number;
}

/** A release document, checked and narrowed to what the runtime acts on. */
export interface VisionRelease {
  id: string;
  game: string;
  locale: string;
  detector: PinnedFile & { arm: "yolox"; version: string; weights: string; settings: DetectorSettings };
  recognizer: PinnedFile & { version: string; weights: string; dim: number; inputName: string; outputName: string; preprocessing: PreprocessingId };
  bank: PinnedFile & { version: number; cardCount: number; entryCount: number };
  identity: { level: IdentityRule; groups: PinnedFile & { version: number }; display: IdentityDisplay };
  catalog: PinnedFile & { cardCount: number };
  accept: AcceptRule;
  hover: { selection: HoverSelection; maxAgeMs: number };
  runtime: { ortWeb: string; executionProviders: ExecutionProvider[]; wasmThreads: 1; analysisWidth: { min: number; max: number } };
}

const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const TOP_KEYS = ["schemaVersion", "kind", "id", "game", "locale", "detector", "recognizer", "bank", "identity", "catalog", "accept", "hover", "runtime"];
const ACCEPT_KEYS = ["tau", "delta", "rotationRetry"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Whether a path is a plain relative one that stays inside the folder of the release document. */
export function isRelativePath(path: unknown): path is string {
  if (!isText(path) || path.includes("\\") || path.includes("://")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").includes("..");
}

function pinned(raw: unknown): PinnedFile | null {
  if (!isObj(raw) || !isRelativePath(raw.path) || typeof raw.sha256 !== "string" || !HEX64.test(raw.sha256) || !isPosInt(raw.bytes)) return null;
  return { path: raw.path, sha256: raw.sha256, bytes: raw.bytes };
}

/**
 * The detector block as settings, or the reason this runtime cannot honor it. The block spells
 * the decode contract out as data; the parts that are numbers or names are taken from it, and
 * the parts that describe the method must be exactly the method implemented here.
 */
function detectorSettings(d: Obj): DetectorSettings | string {
  const input = d.input;
  const dec = d.decode;
  if (!isObj(input) || !isPosInt(input.width) || !isPosInt(input.height)) return "detector.input must give a width and a height";
  if (!isObj(dec)) return "detector.decode must be an object";
  if (!isText(dec.inputName) || !isText(dec.outputName)) return "detector.decode must name the model's input and output";
  const fixed: Array<[string, unknown]> = [
    ["layout", "NCHW"],
    ["channels", "BGR"],
    ["scale", "0-255"],
    ["score", "obj * max(cls)"],
    ["class", "argmax(cls)"],
  ];
  for (const [key, want] of fixed) if (dec[key] !== want) return `detector.decode.${key} is not ${JSON.stringify(want)}, the contract this runtime implements`;
  const lb = dec.letterbox;
  if (!isObj(lb) || lb.width !== input.width || lb.height !== input.height) return "detector.decode.letterbox differs from detector.input";
  if (typeof lb.pad !== "number" || !Number.isInteger(lb.pad) || lb.pad < 0 || lb.pad > 255) return "detector.decode.letterbox.pad must be a whole number from 0 to 255";
  const fixedLetterbox: Array<[string, unknown]> = [
    ["anchor", "top-left"],
    ["resize", "pillow-bilinear"],
    ["ratio", "min(height / frameHeight, width / frameWidth)"],
    ["size", "round(frame * ratio)"],
  ];
  for (const [key, want] of fixedLetterbox) if (lb[key] !== want) return `detector.decode.letterbox.${key} is not ${JSON.stringify(want)}`;
  const classes = dec.classes;
  if (!Array.isArray(classes) || classes.length === 0 || !classes.every(isText) || new Set(classes).size !== classes.length) {
    return "detector.decode.classes must be a list of distinct class names";
  }
  if (d.faceClass !== FACE_CLASS || classes[FACE_CLASS] !== "face") return `detector.faceClass must be ${FACE_CLASS} and that class must be named "face"`;
  const out = dec.output;
  const columns = ["cx", "cy", "w", "h", "obj", ...classes.map((name) => `cls_${name}`)];
  if (!isObj(out) || !Array.isArray(out.columns) || out.columns.length !== columns.length || !out.columns.every((c, i) => c === columns[i])) {
    return "detector.decode.output.columns must be cx, cy, w, h, obj and one cls_<name> per class";
  }
  if (out.anchors !== anchorCount(input.width, input.height)) {
    return `detector.decode.output.anchors must be ${anchorCount(input.width, input.height)} for a ${input.width} x ${input.height} input`;
  }
  if (!isNum(dec.threshold) || !(dec.threshold > 0 && dec.threshold < 1)) return "detector.decode.threshold must be a number between 0 and 1";
  // The detector export checks box parity down to this score (cardvision.core.constants, as in Python).
  if (dec.threshold < 0.01) return `detector.decode.threshold ${dec.threshold} is below 0.01, the lowest score at which the detector export checks box parity`;
  const nms = dec.nms;
  if (!isObj(nms) || !isNum(nms.iou) || !(nms.iou > 0 && nms.iou <= 1) || nms.classAgnostic !== true || nms.greedy !== true) {
    return "detector.decode.nms must give an iou above 0 and at most 1, with classAgnostic and greedy both true";
  }
  if (!isPosInt(dec.maxProposals)) return "detector.decode.maxProposals must be a whole number above 0";
  if (!isPosInt(d.minCropPx)) return "detector.minCropPx must be a whole number above 0";
  return {
    inputName: dec.inputName,
    outputName: dec.outputName,
    letterbox: { width: input.width, height: input.height, pad: lb.pad },
    anchors: out.anchors as number,
    classes: classes as string[],
    decode: { threshold: dec.threshold, nmsIou: nms.iou, maxProposals: dec.maxProposals },
    faceClass: FACE_CLASS,
    minCropPx: d.minCropPx,
  };
}

/**
 * Check a parsed release document and narrow it. Strict: a missing part, a malformed field, an
 * unknown key at the top, or a contract this runtime does not implement refuses the whole
 * document. Returns the reason on failure. The id is checked by `loadRelease`, which has the
 * document's text.
 */
export function parseRelease(raw: unknown): { release: VisionRelease } | { error: string } {
  const fail = (error: string) => ({ error });
  if (!isObj(raw) || raw.schemaVersion !== RELEASE_SCHEMA_VERSION || raw.kind !== RELEASE_KIND) {
    return fail(`not a "${RELEASE_KIND}" document of schema version ${RELEASE_SCHEMA_VERSION}`);
  }
  const unknown = Object.keys(raw).filter((key) => !TOP_KEYS.includes(key));
  if (unknown.length > 0) return fail(`unknown key(s) ${unknown.sort().join(", ")}`);
  if (typeof raw.id !== "string" || !HEX16.test(raw.id)) return fail("id must be 16 lowercase hex digits");
  if (!isText(raw.game) || !isText(raw.locale)) return fail("game and locale must be non-empty strings");

  const d = raw.detector;
  if (!isObj(d)) return fail("incomplete release: detector missing (a release is all-or-nothing)");
  const dRef = pinned(d);
  if (!dRef || !isText(d.version) || !isText(d.weights)) return fail("detector must pin a file and carry a version and a weights label");
  if (d.arm !== "yolox") return fail(`detector.arm ${JSON.stringify(d.arm)} is not one this runtime implements`);
  const settings = detectorSettings(d);
  if (typeof settings === "string") return fail(settings);

  const r = raw.recognizer;
  if (!isObj(r)) return fail("incomplete release: recognizer missing (a release is all-or-nothing)");
  const rRef = pinned(r);
  if (!rRef || !isText(r.version) || !isText(r.weights) || !isPosInt(r.dim)) return fail("recognizer must pin a file and carry a version, a weights label and a dim");
  if (!isText(r.inputName) || !isText(r.outputName)) return fail("recognizer must name the model's input and output");
  const preprocessing = contractOf(r.preprocessing);
  if (preprocessing === null) return fail(`recognizer.preprocessing is not a contract this runtime implements (known: ${Object.keys(PREPROCESSING).join(", ")})`);

  const b = raw.bank;
  if (!isObj(b)) return fail("incomplete release: bank missing (a release is all-or-nothing)");
  const bRef = pinned(b);
  if (!bRef || !isPosInt(b.version) || !isPosInt(b.cardCount) || !isPosInt(b.entryCount)) return fail("bank must pin a file and carry a version, a cardCount and an entryCount");
  if (b.aggregation !== "mean") return fail('bank.aggregation must be "mean"');

  const ident = raw.identity;
  if (!isObj(ident) || !isIdentityRule(ident.level)) return fail('identity.level must be "name" or "printing"');
  const g = ident.groups;
  const gRef = pinned(g);
  if (!gRef || !isObj(g) || !isPosInt(g.version)) return fail("incomplete release: identity.groups must pin a file and carry a version");
  if (ident.display !== "best-printing" && ident.display !== "representative") return fail(`identity.display ${JSON.stringify(ident.display)} is not one of best-printing, representative`);

  const cat = raw.catalog;
  const cRef = pinned(cat);
  if (!cRef || !isObj(cat) || !isPosInt(cat.cardCount)) return fail("incomplete release: catalog must pin a file and carry a cardCount");

  const acc = raw.accept;
  if (!isObj(acc)) return fail("incomplete release: accept missing (a release is all-or-nothing)");
  if (Object.keys(acc).some((key) => !ACCEPT_KEYS.includes(key))) return fail(`accept has unknown key(s) (expected ${ACCEPT_KEYS.join(", ")})`);
  if (!isNum(acc.tau) || !(acc.tau > 0 && acc.tau <= 1)) return fail("accept.tau must be a number above 0 and at most 1");
  if (!isNum(acc.delta) || !(acc.delta >= 0 && acc.delta < 1)) return fail("accept.delta must be a number from 0 to below 1");
  if (typeof acc.rotationRetry !== "boolean") return fail("accept.rotationRetry must be true or false");

  const hov = raw.hover;
  if (!isObj(hov) || !isHoverSelection(hov.selection)) return fail("hover.selection is not one of accepted-nms, best-score, detector-score");
  if (!isPosInt(hov.maxAgeMs)) return fail("hover.maxAgeMs must be a whole number above 0");

  const rt = raw.runtime;
  if (!isObj(rt) || typeof rt.ortWeb !== "string" || !SEMVER.test(rt.ortWeb)) return fail("runtime.ortWeb must be an exact version of the form 1.2.3");
  if (rt.wasmThreads !== 1) return fail("runtime.wasmThreads must be 1");
  const eps = rt.executionProviders;
  if (!Array.isArray(eps) || eps.length === 0 || new Set(eps).size !== eps.length || !eps.every((e) => (EXECUTION_PROVIDERS as readonly unknown[]).includes(e))) {
    return fail(`runtime.executionProviders must list one or more of ${EXECUTION_PROVIDERS.join(", ")}, each once`);
  }
  const aw = rt.analysisWidth;
  if (!isObj(aw) || !isPosInt(aw.min) || !isPosInt(aw.max) || aw.min > aw.max) return fail("runtime.analysisWidth must give whole numbers min <= max above 0");

  return {
    release: {
      id: raw.id,
      game: raw.game,
      locale: raw.locale,
      detector: { ...dRef, arm: "yolox", version: d.version, weights: d.weights, settings },
      recognizer: { ...rRef, version: r.version, weights: r.weights, dim: r.dim, inputName: r.inputName, outputName: r.outputName, preprocessing },
      bank: { ...bRef, version: b.version, cardCount: b.cardCount, entryCount: b.entryCount },
      identity: { level: ident.level, groups: { ...gRef, version: g.version }, display: ident.display },
      catalog: { ...cRef, cardCount: cat.cardCount },
      accept: { tau: acc.tau, delta: acc.delta, rotationRetry: acc.rotationRetry },
      hover: { selection: hov.selection, maxAgeMs: hov.maxAgeMs },
      runtime: { ortWeb: rt.ortWeb, executionProviders: eps as ExecutionProvider[], wasmThreads: 1, analysisWidth: { min: aw.min, max: aw.max } },
    },
  };
}

// ------------------------------------------------------------------------------------- the id

/**
 * The text a release's id is the hash of: the document without its `id` key, as JSON with
 * sorted keys and no whitespace, non-ASCII characters as themselves. Numbers are copied from
 * the document's own text, character for character, because the id was computed over numbers
 * as Python writes them (`1.0` stays `1.0`), which parsing and printing again would not
 * preserve. Throws when the text is not a JSON object.
 */
export function canonicalReleaseText(text: string): string {
  let at = 0;
  const fail = (): never => {
    throw new Error("not JSON");
  };
  const skip = (): void => {
    while (at < text.length && " \t\n\r".includes(text[at]!)) at++;
  };
  const string = (): string => {
    const start = at;
    if (text[at] !== '"') fail();
    at++;
    while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    if (at >= text.length) fail();
    at++;
    return JSON.parse(text.slice(start, at)) as string;
  };
  const value = (dropId: boolean): string => {
    skip();
    const c = text[at];
    if (c === "{") {
      at++;
      const members: Array<[string, string]> = [];
      skip();
      if (text[at] === "}") at++;
      else {
        for (;;) {
          skip();
          const key = string();
          skip();
          if (text[at] !== ":") fail();
          at++;
          const v = value(false);
          if (!(dropId && key === "id")) members.push([key, v]);
          skip();
          if (text[at] === ",") at++;
          else if (text[at] === "}") {
            at++;
            break;
          } else fail();
        }
      }
      members.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return `{${members.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(",")}}`;
    }
    if (c === "[") {
      at++;
      const items: string[] = [];
      skip();
      if (text[at] === "]") at++;
      else {
        for (;;) {
          items.push(value(false));
          skip();
          if (text[at] === ",") at++;
          else if (text[at] === "]") {
            at++;
            break;
          } else fail();
        }
      }
      return `[${items.join(",")}]`;
    }
    if (c === '"') return JSON.stringify(string());
    const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at, at + 64));
    if (!literal) return fail();
    at += literal[0].length;
    return literal[0];
  };
  skip();
  if (text[at] !== "{") fail();
  const out = value(true);
  skip();
  if (at !== text.length) fail();
  return out;
}

/** The id of a release document, from its text: 16 hex digits of the SHA-256 of
 *  `canonicalReleaseText`. */
export async function releaseIdOf(text: string, digestSha256Hex: (bytes: ArrayBuffer) => Promise<string>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalReleaseText(text));
  return (await digestSha256Hex(bytes.buffer as ArrayBuffer)).slice(0, 16);
}

// ---------------------------------------------------------------------------------- loading

/** How bytes are fetched and hashed. The defaults are `fetch` and the Web Crypto API. */
export interface ReleaseDeps {
  fetchFn: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  digestSha256Hex: (bytes: ArrayBuffer) => Promise<string>;
}

export async function sha256HexWebCrypto(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const defaultReleaseDeps: ReleaseDeps = {
  fetchFn: (url) => fetch(url),
  digestSha256Hex: sha256HexWebCrypto,
};

/** One card of a release's catalog, as far as the runtime reads it. */
export interface CatalogCard {
  id: string;
  name: string;
  /** Where the card's image is: a path relative to a base the caller supplies, or a URL. The
   *  runtime never opens it. Null for a card without art (`"art": null`): a card known by its id
   *  and name with no image yet. A bank built from the catalog has no row for it (a bank extended
   *  from one that had a row keeps it), so it is never named by its own row; a printing of it
   *  that has art still names its identity. */
  art: string | null;
  /** The id of the card this one is an alternate printing of, or null. */
  printingOf: string | null;
  /** The card's `extra` object as the catalog gives it (any keys and values), when it has one.
   *  The runtime never reads it; it is the game's own data, kept with the card. */
  extra?: Record<string, unknown>;
}

/** Everything a release loaded, checked against the document and against each other. */
export interface ReleaseData {
  release: VisionRelease;
  detectorBytes: Uint8Array;
  recognizerBytes: Uint8Array;
  bank: EmbeddingBank;
  identityGroups: IdentityGroups;
  cards: CatalogCard[];
  /** Card id to name. */
  names: Map<string, string>;
}

export type ReleaseLoad = { ok: true; data: ReleaseData } | { ok: false; reason: string };

export interface ReleaseLoadOptions {
  /** The onnxruntime-web version this build runs on. A release measured on another line of it
   *  is refused; leave it out to skip the check (a caller without ONNX Runtime). */
  ortWeb?: string;
  /** Called once the release document is read, before the files it pins are fetched, with the
   *  sum of their sizes as the document pins them: what is left to download. Advisory: what it
   *  throws is ignored, and the load goes on. */
  onDocument?: (pinnedBytes: number) => void;
}

/**
 * Whether a release measured on onnxruntime-web `releaseOrt` may run on `bundledOrt`: the same
 * major and minor version, any patch. A minor release can change kernels and so the numbers a
 * model produces; a release's measured accuracy then no longer describes what runs.
 */
export function ortWebCompatible(releaseOrt: string, bundledOrt: string): boolean {
  const mm = (v: string) => /^(\d+)\.(\d+)\.\d+/.exec(v);
  const a = mm(releaseOrt);
  const b = mm(bundledOrt);
  return a !== null && b !== null && a[1] === b[1] && a[2] === b[2];
}

class ReleaseFailure extends Error {}

async function fetchBytes(deps: ReleaseDeps, url: string, label: string): Promise<ArrayBuffer> {
  let response: Awaited<ReturnType<ReleaseDeps["fetchFn"]>>;
  try {
    response = await deps.fetchFn(url);
  } catch (error) {
    throw new ReleaseFailure(`${label}: fetch failed (${String(error)})`);
  }
  if (!response.ok) throw new ReleaseFailure(`${label}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function fetchPinned(deps: ReleaseDeps, base: string, ref: PinnedFile, label: string): Promise<ArrayBuffer> {
  const buf = await fetchBytes(deps, new URL(ref.path, base).href, label);
  if (buf.byteLength !== ref.bytes) throw new ReleaseFailure(`${label}: ${ref.path} is ${buf.byteLength} bytes, the release says ${ref.bytes}`);
  if ((await deps.digestSha256Hex(buf)) !== ref.sha256) throw new ReleaseFailure(`${label}: sha256 of ${ref.path} does not match the release`);
  return buf;
}

function json(buf: ArrayBuffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch {
    throw new ReleaseFailure(`${label}: the file is not JSON`);
  }
}

/** One facet a catalog declares (a filter of the labeling tool), with its values in chip order:
 *  the declared ones, else those the cards carry (numbers ascending, text in order of first
 *  appearance). The runtime reads no facet; it checks them as the Python package does. */
export interface CatalogFacet {
  key: string;
  label: string;
  type: "text" | "number";
  values: Array<string | number>;
}

type FacetValue = string | number;
interface FacetDecl { key: string; label: string; type: "text" | "number" | null; values: FacetValue[] | null }
const FACET_KEY = /^[a-z][a-zA-Z0-9]*$/;
const FACET_DECL_KEYS = ["key", "label", "values", "type"];
const facetType = (v: FacetValue): "text" | "number" => (typeof v === "string" ? "text" : "number");
const show = (v: unknown): string => JSON.stringify(v) ?? String(v);

/** The type of a list of facet values (`type` when given), or the reason it is refused, naming `what`. */
function facetValuesType(values: unknown[], type: "text" | "number" | null, what: string): "text" | "number" | string {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!(isText(v) || isNum(v))) return `${what}: ${show(v)} is not a facet value (a non-empty string or a number)`;
    type = type ?? facetType(v);
    if (facetType(v) !== type) return `${what}: ${show(v)} is not ${type === "text" ? "text" : "a number"}, and the facet's values are ${type === "text" ? "text" : "numbers"}`;
    if (values.slice(0, i).includes(v)) return `${what}: ${show(v)} is listed twice`;
  }
  return type!;
}

function parseFacetDecls(raw: unknown): FacetDecl[] | string {
  if (!Array.isArray(raw)) return '"facets" must be a list of objects, each with a "key" and a "label"';
  const out: FacetDecl[] = [];
  for (const [i, d] of raw.entries()) {
    const where = `facets[${i}]`;
    if (!isObj(d) || !("key" in d) || !("label" in d)) return `${where} must be an object with a "key" and a "label"`;
    const unknown = Object.keys(d).filter((k) => !FACET_DECL_KEYS.includes(k));
    if (unknown.length > 0) return `${where}: unknown key(s) ${unknown.join(", ")}`;
    if (typeof d.key !== "string" || !FACET_KEY.test(d.key)) return `${where}: "key" ${show(d.key)} must be a lowercase letter, then letters and digits only`;
    const key = d.key;
    if (key === "kind") return `${where}: "key" "kind" is reserved: the card's kind is always the first filter`;
    if (out.some((o) => o.key === key)) return `${where}: duplicate key ${show(key)}`;
    if (!isText(d.label)) return `${where} (${key}): "label" must be a non-empty string`;
    let type: "text" | "number" | null = null;
    if ("type" in d) {
      if (d.type !== "text" && d.type !== "number") return `${where} (${key}): "type" must be "text" or "number", not ${show(d.type)}`;
      type = d.type;
    }
    let values: FacetValue[] | null = null;
    if ("values" in d) {
      if (!Array.isArray(d.values) || d.values.length === 0) return `${where} (${key}): "values" must be a non-empty list`;
      const t = facetValuesType(d.values, type, `${where} (${key}) values`);
      if (t !== "text" && t !== "number") return t;
      type = t;
      values = d.values as FacetValue[];
    }
    out.push({ key, label: d.label, type, values });
  }
  return out;
}

/** Check one card's facets against the declarations (an untyped one takes its first value's type). */
function checkCardFacets(raw: unknown, decls: FacetDecl[], card: string, seen: Map<string, FacetValue[]>): string | null {
  const where = `card ${card}`;
  if (!isObj(raw)) return `${where}: "facets" must be an object of facet key to a value or a list of values`;
  for (const [key, value] of Object.entries(raw)) {
    const decl = decls.find((d) => d.key === key);
    if (decl === undefined) return `${where}: facets.${key}: the catalog declares no facet ${show(key)}`;
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) return `${where}: facets.${key} is an empty list (leave the key out instead)`;
    const t = facetValuesType(values, decl.type, `${where}: facets.${key}`);
    if (t !== "text" && t !== "number") return t;
    decl.type = t;
    for (const v of values as FacetValue[]) {
      if (decl.values !== null && !decl.values.includes(v)) return `${where}: facets.${key}: ${show(v)} is not one of the declared values`;
      const list = seen.get(key) ?? [];
      if (!list.includes(v)) list.push(v);
      seen.set(key, list);
    }
  }
  return null;
}

/**
 * Read the cards of a catalog document, the identity rule it states ("name" when it states
 * none) and the facets it declares; the reason as a string when it is not one. Under the
 * "printing" rule a `printingOf` must name a card that is a printing of none, as in Python.
 */
export function parseCatalog(raw: unknown): { game: string; locale: string; identity: IdentityRule; cards: CatalogCard[]; facets: CatalogFacet[] } | string {
  if (!isObj(raw) || !isText(raw.game) || !isText(raw.locale) || !Array.isArray(raw.cards) || raw.cards.length === 0) {
    return "the file is not a catalog (game, locale and a list of cards)";
  }
  const identity = raw.identity === undefined ? "name" : raw.identity;
  if (!isIdentityRule(identity)) return `"identity" must be "name" or "printing", not ${JSON.stringify(raw.identity)}`;
  const decls = raw.facets === undefined ? [] : parseFacetDecls(raw.facets);
  if (typeof decls === "string") return decls;
  const seen = new Map<string, FacetValue[]>();
  const byId = new Map<string, CatalogCard>();
  const cards: CatalogCard[] = [];
  for (const entry of raw.cards) {
    if (!isObj(entry) || !isText(entry.id) || !isText(entry.name)) return "every card needs an id, a name and an art path";
    // "art" is required; null marks a card without art (as in Python, a missing key is refused)
    if (!("art" in entry) || (entry.art !== null && !isText(entry.art))) {
      return `card ${entry.id}: "art" must be an art path (a file path or an http(s) URL), or null for a card without art`;
    }
    if (byId.has(entry.id)) return `card id ${entry.id} appears twice`;
    const printingOf = entry.printingOf ?? null;
    if (printingOf !== null && !isText(printingOf)) return `card ${entry.id}: "printingOf" must be a card id or null`;
    const facetProblem = entry.facets === undefined ? null : checkCardFacets(entry.facets, decls, entry.id, seen);
    if (facetProblem !== null) return facetProblem;
    if (entry.extra !== undefined && !isObj(entry.extra)) {
      return `card ${entry.id}: "extra" must be an object (any keys and values), not ${show(entry.extra)}`;
    }
    const card: CatalogCard = { id: entry.id, name: entry.name, art: entry.art, printingOf };
    if (entry.extra !== undefined) card.extra = entry.extra as Record<string, unknown>;
    byId.set(card.id, card);
    cards.push(card);
  }
  if (identity === "printing") {
    for (const card of cards) {
      if (card.printingOf === null) continue;
      const base = byId.get(card.printingOf);
      if (base === undefined || base === card) return `card ${card.id}: "printingOf" names ${card.printingOf}, which is not another card`;
      if (base.printingOf !== null) return `card ${card.id}: "printingOf" names ${card.printingOf}, which is itself a printing of ${base.printingOf}`;
    }
  }
  const facets = decls.map((d): CatalogFacet => {
    const values = d.values ?? [...(seen.get(d.key) ?? [])];
    if (d.values === null && d.type === "number") (values as number[]).sort((a, b) => a - b);
    return { key: d.key, label: d.label, type: d.type ?? "text", values: [...values] };
  });
  return { game: raw.game, locale: raw.locale, identity, cards, facets };
}

/**
 * Load a release from the absolute URL of its document, all-or-nothing. In order: the document (its
 * shape, its contracts, its id); the onnxruntime-web line; every component in parallel, each
 * against its size and SHA-256; then the agreement between them (the bank against the
 * recognizer and the accept rule, the identity groups against the bank and the catalog's
 * identity rule, every bank id against the catalog). Never throws: any failure is
 * `{ok: false}` with the reason.
 */
export async function loadReleaseData(releaseUrl: string, deps: ReleaseDeps = defaultReleaseDeps, opts: ReleaseLoadOptions = {}): Promise<ReleaseLoad> {
  try {
    const docBuf = await fetchBytes(deps, releaseUrl, "release");
    const parsed = parseRelease(json(docBuf, "release"));
    if ("error" in parsed) throw new ReleaseFailure(`release: ${parsed.error}`);
    const release = parsed.release;
    const id = await releaseIdOf(new TextDecoder().decode(docBuf), deps.digestSha256Hex);
    if (id !== release.id) throw new ReleaseFailure(`release: id ${release.id} is not the hash of the document (which is ${id})`);
    if (opts.ortWeb !== undefined && !ortWebCompatible(release.runtime.ortWeb, opts.ortWeb)) {
      throw new ReleaseFailure(`release: measured on onnxruntime-web ${release.runtime.ortWeb}, this build runs ${opts.ortWeb} (major and minor version must match)`);
    }

    try {
      opts.onDocument?.([release.detector, release.recognizer, release.bank, release.identity.groups, release.catalog].reduce((sum, ref) => sum + ref.bytes, 0));
    } catch {
      // Advisory: a caller's display cannot stop the load.
    }
    const [detBuf, recBuf, bankBuf, groupsBuf, catBuf] = await Promise.all([
      fetchPinned(deps, releaseUrl, release.detector, "detector"),
      fetchPinned(deps, releaseUrl, release.recognizer, "recognizer"),
      fetchPinned(deps, releaseUrl, release.bank, "bank"),
      fetchPinned(deps, releaseUrl, release.identity.groups, "identity.groups"),
      fetchPinned(deps, releaseUrl, release.catalog, "catalog"),
    ]);

    const bank = parseBank(json(bankBuf, "bank"));
    if (!bank) throw new ReleaseFailure("bank: the file is not a bank this runtime can read");
    const checks: Array<[boolean, string]> = [
      [bank.version === release.bank.version, "bank.version differs from the bank file's"],
      [bank.model === release.recognizer.version, `bank: the file's model ${JSON.stringify(bank.model)} is not recognizer.version ${JSON.stringify(release.recognizer.version)}`],
      [bank.dim === release.recognizer.dim, "bank: the vector size differs from recognizer.dim"],
      [bank.preprocessing === release.recognizer.preprocessing, "bank: the file's preprocessing differs from recognizer.preprocessing"],
      [bank.ids.length === release.bank.entryCount, "bank.entryCount is not the number of entries in the bank file"],
      [new Set(bank.ids).size === release.bank.cardCount, "bank.cardCount is not the number of distinct card ids in the bank file"],
      [bank.tau === null || bank.tau === release.accept.tau, `bank: the file records tau ${bank.tau}, accept.tau is ${release.accept.tau}`],
    ];
    for (const [ok, message] of checks) if (!ok) throw new ReleaseFailure(message);

    const catalog = parseCatalog(json(catBuf, "catalog"));
    if (typeof catalog === "string") throw new ReleaseFailure(`catalog: ${catalog}`);
    if (catalog.game !== release.game || catalog.locale !== release.locale) throw new ReleaseFailure("catalog: the file is for another game or locale");
    if (catalog.cards.length !== release.catalog.cardCount) throw new ReleaseFailure(`catalog.cardCount ${release.catalog.cardCount} is not the file's ${catalog.cards.length} cards`);
    const names = new Map(catalog.cards.map((card) => [card.id, card.name]));
    const lost = bank.ids.filter((cardId) => !names.has(cardId));
    if (lost.length > 0) throw new ReleaseFailure(`${new Set(lost).size} bank id(s) are not in the catalog (e.g. ${lost[0]})`);

    const groupsDoc = json(groupsBuf, "identity.groups");
    const groups = parseIdentityGroups(groupsDoc);
    if (!groups) throw new ReleaseFailure("identity.groups: the file is not an identity-groups document");
    if (groups.version !== release.identity.groups.version) throw new ReleaseFailure("identity.groups.version differs from the file's");
    const madeFor = isObj(groupsDoc) && isObj(groupsDoc.bank) ? groupsDoc.bank.sha256 : undefined;
    if (madeFor !== release.bank.sha256) throw new ReleaseFailure("identity.groups: the file was not made for this release's bank (its bank sha256 differs)");
    // The rule is the catalog's: the release and the groups file must both record it, and
    // the groups must be the ones it gives for the bank's ids.
    const rule = catalog.identity;
    if (release.identity.level !== rule) {
      throw new ReleaseFailure(`identity.level is "${release.identity.level}", and the catalog states the identity rule "${rule}": a release is used with the rule its catalog states`);
    }
    const madeBy = isObj(groupsDoc) && isObj(groupsDoc.rule) ? groupsDoc.rule.level : undefined;
    if (madeBy !== rule) throw new ReleaseFailure(`identity.groups: the file's groups are not by ${rule}`);
    const keys = new Map(catalog.cards.map((card) => [card.id, identityOf(card, rule)]));
    const sorted = (list: string[][]): string => JSON.stringify(list.map((group) => [...group].sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)));
    if (sorted(groups.groups) !== sorted(groupsByKey(bank.ids, keys))) {
      throw new ReleaseFailure(`identity.groups: the groups are not the ones the catalog's ${rule === "name" ? "names give" : "identity rule gives"} for the bank's ids`);
    }

    return {
      ok: true,
      data: { release, detectorBytes: new Uint8Array(detBuf), recognizerBytes: new Uint8Array(recBuf), bank, identityGroups: groups, cards: catalog.cards, names },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof ReleaseFailure ? error.message : `unexpected: ${String(error)}` };
  }
}

// ------------------------------------------------------------------- building the pipeline

/** A model that can free its session. */
interface Releasable {
  release?(): Promise<void>;
}

export type ReleaseEmbedder = BatchEmbedder & Releasable & { readonly ep: ExecutionProvider };
export type ReleaseDetector = FrameDetector & Releasable & { readonly ep: ExecutionProvider };

/** The models a release needs. Each tries `providers` in order and resolves null when none
 *  initializes. */
export interface ReleaseModelFactories {
  embedder(bytes: Uint8Array, settings: EmbedderSettings, providers: readonly ExecutionProvider[]): Promise<ReleaseEmbedder | null>;
  detector(bytes: Uint8Array, settings: DetectorSettings, providers: readonly ExecutionProvider[]): Promise<ReleaseDetector | null>;
}

export interface ReleaseBuild {
  pipeline: Pipeline;
  embedder: ReleaseEmbedder;
  detector: ReleaseDetector;
  /** The execution providers that were tried, in order. */
  providers: ExecutionProvider[];
}

async function releaseModels(models: ReadonlyArray<Releasable | null>): Promise<void> {
  for (const m of models) {
    try {
      await m?.release?.();
    } catch {
      // already gone
    }
  }
}

/**
 * Build the pipeline a release describes. All-or-nothing here too: when a model does not
 * initialize on any provider, the one already created is released and the reason returned.
 * `providers` defaults to the release's own list.
 */
export async function buildReleasePipeline(
  data: ReleaseData,
  factories: ReleaseModelFactories,
  providers: readonly ExecutionProvider[] = data.release.runtime.executionProviders,
): Promise<ReleaseBuild | { error: string }> {
  const { release } = data;
  let embedder: ReleaseEmbedder | null = null;
  let detector: ReleaseDetector | null = null;
  const fail = async (error: string): Promise<{ error: string }> => {
    await releaseModels([embedder, detector]);
    return { error };
  };
  try {
    if (providers.length === 0) return await fail("no execution provider to try");
    const rec = release.recognizer;
    embedder = await factories.embedder(
      data.recognizerBytes,
      { inputName: rec.inputName, outputName: rec.outputName, inputSize: PREPROCESSING[rec.preprocessing].size, dim: rec.dim },
      providers,
    );
    if (!embedder) return await fail("recognizer: the model did not initialize on any execution provider, or is not the model the release describes");
    detector = await factories.detector(data.detectorBytes, release.detector.settings, providers);
    if (!detector) return await fail("detector: the model did not initialize on any execution provider, or is not the model the release describes");
    const pipeline = new Pipeline({
      detector,
      embedder,
      bank: data.bank,
      accept: release.accept,
      identityGroups: data.identityGroups,
      identityDisplay: release.identity.display,
      names: data.names,
      hoverSelection: release.hover.selection,
      classNames: release.detector.settings.classes,
      faceClass: release.detector.settings.faceClass,
      minCropPx: release.detector.settings.minCropPx,
    });
    return { pipeline, embedder, detector, providers: [...providers] };
  } catch (error) {
    return await fail(`unexpected while building: ${String(error)}`);
  }
}
