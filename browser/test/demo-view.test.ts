// SPDX-License-Identifier: Apache-2.0
// What the demo page says for each state of its model and of its file (demo/view.ts). No page
// is started here: the states are the ones the page reaches, written out by hand.
import { describe, expect, it } from "vitest";

import { addressRequest } from "../demo/page.js";
import { demoView, h264Command, HINT, isVideoType, MARK, type MediaState, modelOf, type ModelState, NO_FACTS, type PanelStatus, panelLines, type RunFacts } from "../demo/view.js";

const ADDRESS = "/release/release.json";
const NO_MODEL: ModelState = { kind: "none" };
const LOADING: ModelState = { kind: "loading", address: ADDRESS };
const LOADED: ModelState = { kind: "loaded", address: ADDRESS, game: "toy", cards: 20 };
const NOT_FOUND: ModelState = { kind: "failed", address: "/release/nope.json", reason: "release: HTTP 404" };
const MODELS = [NO_MODEL, LOADING, LOADED, NOT_FOUND];

const NO_FILE: MediaState = { kind: "none" };
const OPENING: MediaState = { kind: "opening", name: "table.png" };
const PICTURE: MediaState = { kind: "shown", name: "table.png", video: false };
const VIDEO: MediaState = { kind: "shown", name: "table.webm", video: true };
const NOT_A_PICTURE: MediaState = { kind: "undecodable", name: "fake.png", video: false };
const NOT_FETCHED: MediaState = { kind: "unfetched", name: "table.png", reason: "the server answered 404" };
const FILES = [NO_FILE, OPENING, PICTURE, VIDEO, NOT_A_PICTURE, NOT_FETCHED];

const RUNNING: RunFacts = { detector: "webgpu", recognizer: "webgpu", frameMs: 40.2, cards: 6, frameError: null };

describe("the model state of the demo page", () => {
  it("follows what the session reports for the address it was given", () => {
    expect(modelOf("", null)).toEqual(NO_MODEL);
    expect(modelOf("", { state: "ready", error: null, release: { game: "toy", bankCards: 20 } })).toEqual(NO_MODEL);
    expect(modelOf(ADDRESS, null)).toEqual(LOADING);
    expect(modelOf(ADDRESS, { state: "loading", error: null, release: null })).toEqual(LOADING);
    expect(modelOf(ADDRESS, { state: "ready", error: null, release: { game: "toy", bankCards: 20 } })).toEqual(LOADED);
    expect(modelOf("/release/nope.json", { state: "failed", error: "release: HTTP 404", release: null })).toEqual(NOT_FOUND);
    expect(modelOf(ADDRESS, { state: "failed", error: null, release: null })).toEqual({ kind: "failed", address: ADDRESS, reason: "no reason given" });
    // A session that was stopped says nothing about the model: the page is starting another.
    expect(modelOf(ADDRESS, { state: "stopped", error: null, release: null })).toEqual(LOADING);
  });

  it("sends a file to the video element by its type, and by its name when it has no type", () => {
    expect([isVideoType("video/webm"), isVideoType("video/quicktime", "clip.mov"), isVideoType("", "clip.MKV"), isVideoType("", "clip.mp4")]).toEqual([true, true, true, true]);
    expect([isVideoType("image/png"), isVideoType("text/plain", "notes.txt"), isVideoType("", "table.png"), isVideoType(""), isVideoType("image/png", "odd.mp4")]).toEqual([false, false, false, false, false]);
  });
});

describe("what the demo page says", () => {
  it("is ready only when a model has loaded and the file decoded to a picture", () => {
    for (const model of MODELS) {
      for (const media of FILES) {
        const view = demoView(model, media, RUNNING);
        const ready = model.kind === "loaded" && media.kind === "shown";
        expect([view.ready, view.state.word === "ready", view.state.tone === "ready", view.state.text.startsWith("Ready")], `${model.kind} x ${media.kind}`).toEqual([ready, ready, ready, ready]);
        // The hint and the figures of a frame belong to the ready state alone.
        expect(view.hint, `${model.kind} x ${media.kind}`).toBe(ready);
        expect(view.strip.some((part) => part.includes("per frame") || part.includes("found")), `${model.kind} x ${media.kind}`).toBe(ready);
      }
    }
  });

  it("first shows a drop zone, and the model it is loading or has loaded", () => {
    const loading = demoView(LOADING, NO_FILE);
    expect([loading.step, loading.stage, loading.state.text, loading.modelLine]).toEqual(["file", "drop", "Loading the model…", "Model: loading /release/release.json…"]);
    const loaded = demoView(LOADED, NO_FILE, { ...NO_FACTS, detector: "webgpu", recognizer: "webgpu" });
    expect([loaded.step, loaded.stage, loaded.state.text, loaded.modelLine, loaded.strip]).toEqual(["file", "drop", "Model loaded. Choose a file.", "Model: toy · 20 cards", ["WebGPU"]]);
    expect([loaded.fileName, loaded.fileProblem, loaded.modelProblem, loaded.addressProblem, loaded.hint]).toEqual([null, null, null, null, false]);
    expect(demoView({ ...LOADED, cards: 1 }, NO_FILE).modelLine).toBe("Model: toy · 1 card");
  });

  it("starts on a chosen file: opening, then ready with a hint, the backend, the time and the cards found", () => {
    const waiting = demoView(LOADING, OPENING);
    expect([waiting.stage, waiting.fileName, waiting.state.text, waiting.ready]).toEqual(["opening", "table.png", "Loading the model…", false]);
    // The model can load before the file has decoded, and the file before the model.
    expect(demoView(LOADED, OPENING).state).toEqual({ tone: "busy", text: "Opening table.png…", word: "opening the file" });
    expect(demoView(LOADING, PICTURE).state).toEqual({ tone: "busy", text: "Loading the model…", word: "loading the model" });
    const before = demoView(LOADED, PICTURE, { ...NO_FACTS, detector: "webgpu", recognizer: "wasm" });
    expect([before.stage, before.fileName, before.state.text, before.hint]).toEqual(["file", "table.png", "Ready. Move over a face-up card.", true]);
    expect(before.strip).toEqual(["detector on WebGPU, recognizer on WebAssembly"]);
    const ready = demoView(LOADED, PICTURE, RUNNING);
    expect(ready.state).toEqual({ tone: "ready", text: `Ready. ${HINT}.`, word: "ready" });
    expect(ready.strip).toEqual(["WebGPU", "40 ms per frame", "6 cards found"]);
    expect(demoView(LOADED, VIDEO, { ...RUNNING, recognizer: "wasm", detector: "wasm", frameMs: 4.26, cards: 1 }).strip).toEqual(["WebAssembly", "4.3 ms per frame", "1 card found"]);
    expect(demoView(LOADED, PICTURE, { ...RUNNING, cards: 0 }).strip[2]).toBe("0 cards found");
  });

  it("drops the hint once a name has been shown, and says nothing more for a card back or bare table", () => {
    expect(demoView(LOADED, PICTURE, RUNNING, false).hint).toBe(true);
    const named = demoView(LOADED, PICTURE, RUNNING, true);
    expect(named.hint).toBe(false);
    // Nothing under the pointer is a normal answer: the state stays ready, with no problem anywhere.
    expect([named.state.tone, named.fileProblem, named.modelProblem, named.addressProblem]).toEqual(["ready", null, null, null]);
  });

  it("says by name that a file is not a picture or video, beside the stage, and never shows ready", () => {
    for (const model of MODELS) {
      const view = demoView(model, NOT_A_PICTURE, RUNNING);
      expect(view.fileProblem, model.kind).toBe("fake.png is not a picture or video this browser can open. Choose another file.");
      expect([view.ready, view.stage, view.fileName, view.hint], model.kind).toEqual([false, "drop", null, false]);
    }
    const view = demoView(LOADED, NOT_A_PICTURE, RUNNING);
    expect(view.state).toEqual({ tone: "problem", text: "The file did not open.", word: "file not opened" });
    // The model is still loaded, and says so: one state does not hide the other.
    expect([view.modelLine, view.modelProblem, view.strip]).toEqual(["Model: toy · 20 cards", null, ["WebGPU"]]);
    expect(demoView(LOADED, { kind: "undecodable", name: "notes.txt", video: false }).fileProblem).toContain("notes.txt is not a picture or video");
    // A video gets the command that converts it, with its own name in it.
    expect(demoView(LOADED, { kind: "undecodable", name: "my clip.mp4", video: true }).fileProblem).toBe(
      "my clip.mp4 is not a picture or video this browser can open. Choose another file, or convert the video to H.264: "
      + "ffmpeg -i 'my clip.mp4' -c:v libx264 -pix_fmt yuv420p 'my clip-h264.mp4'");
    expect(h264Command("it's.webm")).toBe("ffmpeg -i 'it'\\''s.webm' -c:v libx264 -pix_fmt yuv420p 'it'\\''s-h264.mp4'");
    expect(h264Command("clip.mp4")).toBe("ffmpeg -i clip.mp4 -c:v libx264 -pix_fmt yuv420p clip-h264.mp4");
    expect(h264Command("-clip.mp4")).toBe("ffmpeg -i ./-clip.mp4 -c:v libx264 -pix_fmt yuv420p ./-clip-h264.mp4");
    expect(h264Command("$x`y`.mp4")).toBe("ffmpeg -i '$x`y`.mp4' -c:v libx264 -pix_fmt yuv420p '$x`y`-h264.mp4'");
  });

  it("says beside the model line that a model did not load, with the address and the reason, and keeps the file", () => {
    const view = demoView(NOT_FOUND, PICTURE, RUNNING, true);
    expect(view.modelProblem).toBe("Could not load the model at /release/nope.json (release: HTTP 404). Check the address, then press Retry.");
    expect([view.modelLine, view.state.text, view.state.tone]).toEqual(["Model: not loaded", "The model did not load.", "problem"]);
    // The file stays on the stage, and the step that leads is still the file's.
    expect([view.stage, view.fileName, view.fileProblem, view.step]).toEqual(["file", "table.png", null, "file"]);
    // Nothing of an earlier run is left as if it were current: no figures, no names, no hint.
    expect([view.ready, view.strip, view.hint]).toEqual([false, [], false]);
    const unreachable = demoView({ kind: "failed", address: "http://127.0.0.1:1/release.json", reason: "release: fetch failed (TypeError: Failed to fetch)" }, PICTURE);
    expect(unreachable.modelProblem).toBe("Could not load the model at http://127.0.0.1:1/release.json (release: fetch failed (TypeError: Failed to fetch)). Check the address, then press Retry.");
  });

  it("makes loading a model the step that leads while there is none, and the file's once there is", () => {
    const none = demoView(NO_MODEL, NO_FILE);
    expect([none.step, none.stage, none.state.text, none.modelLine, none.modelProblem]).toEqual(["model", "drop", "No model loaded.", null, null]);
    // A file can be chosen first: it is shown, and the page still asks for a model.
    const fileFirst = demoView(NO_MODEL, PICTURE);
    expect([fileFirst.step, fileFirst.stage, fileFirst.ready, fileFirst.state.text]).toEqual(["model", "file", false, "No model loaded."]);
    expect(demoView(LOADING, NO_FILE).step).toBe("file");
    expect(demoView(LOADED, NO_FILE).step).toBe("file");
    // A model that failed leads again when no file is open, and stays beside its line when one is.
    expect(demoView(NOT_FOUND, NO_FILE).step).toBe("model");
    expect(demoView(NOT_FOUND, NOT_A_PICTURE).step).toBe("model");
    expect(demoView(NOT_FOUND, OPENING).step).toBe("file");
    expect(demoView(NOT_FOUND, PICTURE).step).toBe("file");
  });

  it("stops saying ready when a frame could not be analyzed", () => {
    const view = demoView(LOADED, PICTURE, { ...RUNNING, frameError: "no reply" });
    expect(view.state).toEqual({ tone: "problem", text: "The last frame was not analyzed (no reply).", word: "frame not analyzed" });
  });

  it("marks each tone with a shape of its own", () => {
    expect(new Set(Object.values(MARK)).size).toBe(4);
    expect(Object.values(MARK).every((mark) => mark !== "")).toBe(true);
  });
});

describe("a file named by the page's address", () => {
  const SERVER = { release: true, images: true, file: "/file/table.png" };
  const ORIGIN = "http://127.0.0.1:8765";

  it("is opened like a chosen file, and the panel says where it came from", () => {
    const asked = addressRequest("?file=/file/table.png&images=/images/", SERVER, ORIGIN);
    expect([asked.file?.name, asked.file?.path, asked.images, asked.refused]).toEqual(["table.png", "/file/table.png", true, []]);
    const media: MediaState = { kind: "shown", name: asked.file!.name, video: false };
    const view = demoView(LOADED, media, RUNNING, false, asked.refused);
    expect([view.ready, view.fileName, view.addressProblem]).toEqual([true, "table.png", null]);
    const lines = panelLines(view, LOADED, { name: asked.file!.name, servedAt: asked.file!.path }, null, null, null);
    expect(lines.slice(0, 2)).toEqual(["state: ready", "file: table.png, from the local server's /file/table.png (named in this page's address)"]);
  });

  it("says what the address asked for and was refused, and opens nothing for it", () => {
    for (const search of ["?file=http://elsewhere.example/table.png", "?file=/release/release.json", "?file=/file/other.png"]) {
      const asked = addressRequest(search, SERVER, ORIGIN);
      expect(asked.file, search).toBeNull();
      const view = demoView(LOADED, NO_FILE, NO_FACTS, false, asked.refused);
      expect(view.addressProblem, search).toBe(`This page's address asked for something that was not done. ${asked.refused[0]}.`);
      expect([view.stage, view.ready, view.fileName], search).toEqual(["drop", false, null]);
    }
    const none = addressRequest("?file=/file/table.png&images=/images/", { release: true }, ORIGIN);
    expect(demoView(LOADED, NO_FILE, NO_FACTS, false, none.refused).addressProblem).toBe(
      "This page's address asked for something that was not done. images=/images/: this page's server has no image folder (it was started without --images). " +
        "file=/file/table.png: this page's server offers no file (it was started without --file).",
    );
  });

  it("says so beside the stage when the server does not answer for it", () => {
    const view = demoView(LOADED, NOT_FETCHED);
    expect(view.fileProblem).toBe("table.png could not be loaded from the local server (the server answered 404). Choose a file here instead.");
    expect([view.ready, view.stage, view.state.word]).toEqual([false, "drop", "file not opened"]);
  });
});

describe("the Details panel of the demo page", () => {
  const STATUS: PanelStatus = {
    release: { id: "176e5b5cfd5c89ef", game: "toy", bankCards: 20, detector: { ep: "webgpu" }, recognizer: { ep: "webgpu" }, ortWeb: "1.29.0", hoverSelection: "accepted-nms", hoverMaxAgeMs: 2000 },
    schedule: "fast", frames: 3, lastWorkerMs: 45.52, lastRoundTripMs: 46.31, lastFrameError: null,
  };
  const FRAME = { width: 1280, height: 768, boxes: 6, faces: 5, named: 5, detectorMs: 29.6, recognizeMs: 8.04, embeddings: 8 };
  const FILE = { name: "table.png", servedAt: null };

  it("prints the state, the file, the release, the newest frame and what is under the pointer", () => {
    const lines = panelLines(demoView(LOADED, PICTURE, RUNNING), LOADED, FILE, STATUS, FRAME, { name: "Amber Circle", cardId: "TOY-001" });
    expect(lines).toEqual([
      "state: ready",
      "file: table.png",
      "model: /release/release.json",
      "release: 176e5b5cfd5c89ef (toy, 20 cards in the bank)",
      "backend: detector on webgpu, recognizer on webgpu",
      "ONNX Runtime Web: the release was measured on 1.29.0",
      "hover selection: accepted-nms; a result is shown for at most 2000 ms of video",
      "schedule: fast",
      "frames analyzed: 3",
      "last frame: 45.5 ms in the worker, 46.3 ms from capture to result",
      "analyzed at 1280 x 768: 6 boxes, 5 faces, 5 named",
      "  detector 29.6 ms, recognizer 8.0 ms, 8 embeddings",
      "under the pointer: Amber Circle (TOY-001)",
    ]);
    const away = panelLines(demoView(LOADED, PICTURE, RUNNING), LOADED, FILE, STATUS, FRAME, null);
    expect(away[away.length - 1]).toBe("under the pointer: nothing shown");
  });

  it("says ready on its first line only when the page is ready, and keeps no line of an earlier run", () => {
    for (const model of MODELS) {
      for (const media of FILES) {
        const view = demoView(model, media, RUNNING);
        const lines = panelLines(view, model, media.kind === "none" ? null : FILE, STATUS, FRAME, { name: "Amber Circle", cardId: "TOY-001" });
        expect(lines[0] === "state: ready", `${model.kind} x ${media.kind}`).toBe(view.ready);
        expect(lines.some((line) => /^(schedule|frames analyzed|last frame|analyzed at|under the pointer)/.test(line)), `${model.kind} x ${media.kind}`).toBe(view.ready);
        expect(lines.some((line) => line.startsWith("release: ")), `${model.kind} x ${media.kind}`).toBe(model.kind === "loaded");
      }
    }
    expect(panelLines(demoView(NOT_FOUND, PICTURE), NOT_FOUND, FILE, STATUS, FRAME, null)).toEqual([
      "state: model failed", "file: table.png", "model: /release/nope.json", "  did not load: release: HTTP 404",
    ]);
    expect(panelLines(demoView(LOADED, NOT_A_PICTURE), LOADED, { name: "fake.png", servedAt: null }, STATUS, null, null).slice(0, 3)).toEqual([
      "state: file not opened", "file: fake.png", "  fake.png is not a picture or video this browser can open. Choose another file.",
    ]);
    expect(panelLines(demoView(NO_MODEL, NO_FILE), NO_MODEL, null, null, null, null)).toEqual(["state: no model", "file: none", "model: none"]);
  });
});
