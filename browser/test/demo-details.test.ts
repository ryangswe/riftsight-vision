// SPDX-License-Identifier: Apache-2.0
// What the demo page's Details shows for each state of its model and of its file
// (demo/details.ts). No page is started here: the reports are written out by hand, in the shape
// the session gives them.
import { describe, expect, it } from "vitest";

import type { BoxResult, FaceResult, FrameAnalysis } from "../src/pipeline.js";
import { boxAtPoint, detailsView, detectionRows, type DetailsFile, type DetailsStatus, durationText, shortId, SPARK_FRAMES, sparkOf } from "../demo/details.js";
import { demoView, type MediaState, type ModelState, NO_FACTS, type RunFacts } from "../demo/view.js";

const ADDRESS = "/release/release.json";
const NO_MODEL: ModelState = { kind: "none" };
const LOADING: ModelState = { kind: "loading", address: ADDRESS };
const LOADED: ModelState = { kind: "loaded", address: ADDRESS, game: "toy", cards: 20 };
const NOT_FOUND: ModelState = { kind: "failed", address: "/release/nope.json", reason: "release: HTTP 404" };

const NO_FILE: MediaState = { kind: "none" };
const OPENING: MediaState = { kind: "opening", name: "table.png" };
const PICTURE: MediaState = { kind: "shown", name: "table.png", video: false };
const VIDEO: MediaState = { kind: "shown", name: "table.webm", video: true };
const NOT_A_PICTURE: MediaState = { kind: "undecodable", name: "fake.png", video: false };
const RUNNING: RunFacts = { detector: "webgpu", recognizer: "webgpu", frameMs: 25.52, cards: 3, frameError: null };

const STATUS: DetailsStatus = {
  release: {
    id: "176e5b5cfd5c89ef", game: "toy", bankCards: 20, catalogCards: 21,
    detector: { version: "toy-detector", ep: "webgpu" }, recognizer: { version: "toy-recognizer", ep: "webgpu" },
    accept: { tau: 0.9, delta: 0.02 },
  },
  schedule: "fast", frames: 3, lastWorkerMs: 25.52,
};
const PICTURE_FILE: DetailsFile = { name: "table.png", servedAt: null, video: false, width: 1280, height: 768, durationSec: null };

function face(over: Partial<FaceResult>): FaceResult {
  return { topId: "TOY-001", topName: "Amber Circle", similarity: 0.996, margin: 0.126, look: 0, retried: false, tauPassed: true, accepted: true, cardId: "TOY-001", name: "Amber Circle", kept: true, ...over };
}
function box(at: [number, number, number, number], f: FaceResult | null): BoxResult {
  return { box: at, score: 0.9, cls: f ? 0 : 1, className: f ? "face" : "back", face: f };
}
const FRAME: FrameAnalysis = {
  frame: { width: 1280, height: 768 },
  boxes: [
    box([40, 40, 200, 280], face({})),
    box([300, 40, 280, 200], face({ topId: "TOY-003", topName: "Coral Triangle", cardId: "TOY-003", name: "Coral Triangle", look: 3, similarity: 0.998, margin: 0.157 })),
    box([620, 40, 200, 280], face({ topId: "TOY-007", topName: "Azure Circle", similarity: 0.95, margin: 0.011, accepted: false, cardId: null, name: null })),
    box([40, 360, 200, 280], face({ topId: "TOY-009", topName: "Slate Circle", similarity: 0.42, margin: 0.003, tauPassed: false, accepted: false, cardId: null, name: null, kept: false })),
    box([300, 360, 200, 280], null),
  ],
  hover: { selection: "accepted-nms", cards: [] },
  tracks: { shown: false, cards: [] },
  discontinuity: false,
  retried: 1,
  embeddings: 8,
  timings: { detectorMs: 15.46, recognizeMs: 7.21, analyzeMs: 23.1 },
};

const details = (model: ModelState, media: MediaState, opts: { file?: DetailsFile | null; status?: DetailsStatus | null; analysis?: FrameAnalysis | null; times?: number[]; pointerBox?: number | null; facts?: RunFacts } = {}) =>
  detailsView(
    demoView(model, media, opts.facts ?? RUNNING), model, media,
    opts.file === undefined ? (media.kind === "none" ? null : PICTURE_FILE) : opts.file,
    opts.status === undefined ? STATUS : opts.status, (opts.facts ?? RUNNING).frameError,
    opts.analysis === undefined ? FRAME : opts.analysis, opts.times ?? [24.1, 27.0, 25.52], opts.pointerBox ?? null,
  );

describe("Details of the demo page, state by state", () => {
  it("says in one line that nothing is loaded yet, and shows no figure", () => {
    const view = details(NO_MODEL, NO_FILE, { status: null, analysis: null, times: [] });
    expect(view.line).toBe("Nothing loaded yet. Load a model and choose a file: what it finds in each frame shows here.");
    expect([view.tone, view.tiles, view.spark, view.frame, view.model, view.file]).toEqual(["idle", null, null, null, null, null]);
  });

  it("names the address while the model loads, and says why nothing runs when it did not load", () => {
    const loading = details(LOADING, NO_FILE, { status: { ...STATUS, release: null }, analysis: null });
    expect([loading.tone, loading.line, loading.tiles, loading.model]).toEqual(["busy", "Loading the model. What it is, and then each frame's figures, show here once it has loaded.", null, [{ label: "Address", value: ADDRESS }]]);
    const failed = details(NOT_FOUND, PICTURE, { status: { ...STATUS, release: null } });
    expect([failed.tone, failed.line, failed.tiles, failed.frame, failed.spark]).toEqual(["problem", "The model did not load (release: HTTP 404), so nothing is analyzed.", null, null, null]);
    // The file stays named, and so does the address that failed.
    expect(failed.model).toEqual([{ label: "Address", value: "/release/nope.json" }]);
    expect(failed.file?.[0]).toEqual({ label: "Name", value: "table.png" });
  });

  it("shows the model and the backend once the model has loaded, and no figure of a frame before a file", () => {
    const view = details(LOADED, NO_FILE, { analysis: null });
    expect(view.line).toBe("Model loaded, no file yet. Choose a file to see what each frame holds.");
    expect(view.tiles?.map((tile) => [tile.label, tile.value, tile.unit, tile.note])).toEqual([
      ["Cards found", "—", "", "in the newest frame"],
      ["Time per frame", "—", "", "in the worker"],
      ["Backend", "WebGPU", "", "detector and recognizer"],
      ["Frames analyzed", "—", "", "since the file opened"],
    ]);
    expect([view.frame, view.spark, view.file]).toEqual([null, null, null]);
    expect(view.model).toEqual([
      { label: "Release", value: "176e5b5c…", full: "176e5b5cfd5c89ef" },
      { label: "Game", value: "toy" },
      { label: "Cards", value: "20 in the bank, 21 in the catalog" },
      { label: "Detector", value: "toy-detector" },
      { label: "Recognizer", value: "toy-recognizer" },
      { label: "Address", value: ADDRESS },
    ]);
    expect(details(LOADED, OPENING, { analysis: null }).line).toBe("Model loaded. Opening table.png…");
  });

  it("gives the figures of the newest frame, the times of the last frames and the detections while running", () => {
    const view = details(LOADED, PICTURE, { pointerBox: 0 });
    expect([view.tone, view.line]).toEqual(["ready", "Running. The figures are those of the newest analyzed frame."]);
    expect(view.tiles?.map((tile) => [tile.label, tile.value, tile.unit, tile.note])).toEqual([
      ["Cards found", "5", "cards", "2 named · 2 not named · 1 back"],
      ["Time per frame", "25.5", "ms", "detect 15.5 · recognize 7.2 ms"],
      ["Backend", "WebGPU", "", "detector and recognizer"],
      ["Frames analyzed", "3", "frames", "analyzing while the pointer moves"],
    ]);
    expect(view.spark).toEqual({ points: [24.1, 27.0, 25.52], latest: 25.52, max: 27.0, min: 24.1 });
    expect(view.frame?.caption).toBe("analyzed at 1280 × 768 px · named when the score is at least 0.9 and the margin at least 0.02");
    expect(view.frame?.empty).toBeNull();
    expect(view.file).toEqual([{ label: "Name", value: "table.png" }, { label: "Size", value: "1280 × 768 px" }]);
  });

  it("says when no analyzed frame matches the picture yet, and how to get one", () => {
    const view = details(LOADED, PICTURE, { analysis: null, times: [] });
    expect(view.line).toBe("Running. No analyzed frame matches the picture on screen yet: move the pointer over it.");
    expect(view.frame).toEqual({ caption: "named when the score is at least 0.9 and the margin at least 0.02", rows: [], empty: "No analyzed frame matches the picture on screen yet." });
    expect(view.tiles?.[0]?.value).toBe("—");
    expect(details(LOADED, PICTURE, { analysis: null, status: { ...STATUS, schedule: "always-on" } }).line).toBe("Running. No analyzed frame matches the picture on screen yet.");
    expect(details(LOADED, PICTURE, { analysis: { ...FRAME, boxes: [] } }).frame?.empty).toBe("No card was found in this frame.");
  });

  it("names the problem when the file did not open or the last frame was not analyzed", () => {
    const file = details(LOADED, NOT_A_PICTURE, { file: { ...PICTURE_FILE, name: "fake.png", width: null, height: null } });
    expect([file.tone, file.line, file.frame, file.spark]).toEqual(["problem", "The file did not open, so nothing was analyzed.", null, null]);
    // A file that did not decode has no size.
    expect(file.file).toEqual([{ label: "Name", value: "fake.png" }]);
    const frame = details(LOADED, PICTURE, { facts: { ...RUNNING, frameError: "no reply" } });
    expect([frame.tone, frame.line]).toEqual(["problem", "The last frame was not analyzed (no reply)."]);
  });

  it("keeps no figure of a frame unless the page is ready", () => {
    for (const [model, media] of [[NO_MODEL, PICTURE], [LOADING, PICTURE], [NOT_FOUND, PICTURE], [LOADED, OPENING], [LOADED, NOT_A_PICTURE], [LOADED, NO_FILE]] as const) {
      const view = details(model, media);
      expect([view.frame, view.spark], `${model.kind} x ${media.kind}`).toEqual([null, null]);
      expect(view.tiles?.every((tile) => tile.key === "backend" || tile.value === "—") ?? true, `${model.kind} x ${media.kind}`).toBe(true);
    }
  });

  it("gives a video's length and where a file named by the address came from", () => {
    const view = details(LOADED, VIDEO, { file: { name: "table.webm", servedAt: "/file/table.webm", video: true, width: 1280, height: 768, durationSec: 6.0 } });
    expect(view.file).toEqual([
      { label: "Name", value: "table.webm" },
      { label: "Size", value: "1280 × 768 px" },
      { label: "Duration", value: "6.0 s" },
      { label: "From", value: "the local server's /file/table.webm" },
    ]);
  });

  it("says when the detector and the recognizer run on different backends", () => {
    const status: DetailsStatus = { ...STATUS, release: { ...STATUS.release!, recognizer: { version: "toy-recognizer", ep: "wasm" } } };
    expect(details(LOADED, PICTURE, { status }).tiles?.[2]).toEqual({ key: "backend", label: "Backend", value: "Mixed", unit: "", note: "detector on WebGPU, recognizer on WebAssembly" });
  });
});

describe("the detections table of Details", () => {
  it("has a row per box, with the name and id, the score and margin, and the accept rule's answer", () => {
    const rows = detectionRows(FRAME, { tau: 0.9, delta: 0.02 }, 2);
    expect(rows.map((row) => [row.number, row.kind, row.card, row.id, row.nearest, row.turned, row.score, row.margin, row.scoreLow, row.marginLow, row.result, row.pointer])).toEqual([
      [1, "named", "Amber Circle", "TOY-001", false, null, "0.996", "0.126", false, false, "Named", false],
      [2, "named", "Coral Triangle", "TOY-003", false, "turned 270°", "0.998", "0.157", false, false, "Named", false],
      [3, "unnamed", "Not named", "TOY-007", true, null, "0.950", "0.011", false, true, "Not named: margin under 0.02", true],
      [4, "unnamed", "Not named", "TOY-009", true, null, "0.420", "0.003", true, true, "Not named: score under 0.9, margin under 0.02", false],
      [5, "other", "Card back", null, false, null, null, null, false, false, "Not looked up", false],
    ]);
  });

  it("finds the box under the pointer: the hover layer's card first, else the smallest box that holds the point", () => {
    expect(boxAtPoint(FRAME, 100, 100, 1)).toBe(1);
    expect(boxAtPoint(FRAME, 400, 500, null)).toBe(4);
    expect(boxAtPoint(FRAME, 1200, 700, null)).toBeNull();
    const nested: FrameAnalysis = { ...FRAME, boxes: [box([0, 0, 600, 600], null), box([100, 100, 50, 50], null)] };
    expect(boxAtPoint(nested, 120, 120, null)).toBe(1);
  });
});

describe("the small parts of Details", () => {
  it("keeps the last frames' times for the sparkline", () => {
    expect(sparkOf([])).toBeNull();
    expect(sparkOf([12.5])).toEqual({ points: [12.5], latest: 12.5, max: 12.5, min: 12.5 });
    const many = Array.from({ length: SPARK_FRAMES + 5 }, (_, i) => i);
    expect(sparkOf(many)?.points).toHaveLength(SPARK_FRAMES);
    expect(sparkOf(many)?.latest).toBe(SPARK_FRAMES + 4);
  });

  it("shortens a release id and writes a duration", () => {
    expect([shortId("176e5b5cfd5c89ef"), shortId("abc")]).toEqual(["176e5b5c…", "abc"]);
    expect([durationText(6), durationText(59.94), durationText(61), durationText(3725)]).toEqual(["6.0 s", "59.9 s", "1 min 01 s", "62 min 05 s"]);
  });

  it("is built from the same facts the strip and the text panel read", () => {
    // The tiles show a model's backend exactly when the status strip does.
    for (const model of [NO_MODEL, LOADING, LOADED, NOT_FOUND]) {
      const strip = demoView(model, NO_FILE, { ...NO_FACTS, detector: "webgpu", recognizer: "webgpu" }).strip;
      expect(details(model, NO_FILE, { analysis: null }).tiles !== null, model.kind).toBe(strip.length > 0);
    }
  });
});
