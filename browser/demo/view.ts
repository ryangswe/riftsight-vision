// SPDX-License-Identifier: Apache-2.0
// What the demo page says, as a function of what it knows. Nothing here touches the page, so
// every state can be tested without a browser (test/demo-view.test.ts).
//
// The page knows two things, and keeps them apart so that one cannot hide the other:
//   - the model: none named, loading, loaded, or failed to load (`ModelState`);
//   - the file: none chosen, opening, on show, or not opened (`MediaState`).
// "Ready" needs both: a loaded model and a file that decoded to a picture. A file that the
// browser cannot decode never reads as ready, and a model that failed never leaves the figures
// of an earlier run on screen.

import type { ExecutionProvider } from "../src/providers.js";

export type ModelState =
  /** No address of a release document is known. */
  | { kind: "none" }
  /** `phase` and `bytes` say where the load is, when the worker has said (`SessionStatus.loading`);
   *  `name` is what the page calls the models, such as "the One Piece models". */
  | { kind: "loading"; address: string; phase?: "downloading" | "preparing"; bytes?: number | null; name?: string; local?: true }
  | { kind: "loaded"; address: string; game: string; cards: number }
  /** `local`, for a release read from a folder chosen on this computer: `address` is then the
   *  path of its release document in that folder, and nothing was downloaded. */
  | { kind: "failed"; address: string; reason: string; local?: true };

export type MediaState =
  | { kind: "none" }
  | { kind: "opening"; name: string }
  /** The browser decoded the file to a picture: an image, or a frame of a video. */
  | { kind: "shown"; name: string; video: boolean }
  /** The browser could not decode the file as an image or as a video; `video` when its type
   *  or name says it is a video, which may be in a codec this browser does not play. */
  | { kind: "undecodable"; name: string; video: boolean }
  /** The file the page's address named could not be fetched from the local server. */
  | { kind: "unfetched"; name: string; reason: string };

/** What a session reports about its release, as far as the page's model state needs it. */
export interface ReleaseReport {
  state: "loading" | "ready" | "failed" | "stopped";
  error: string | null;
  release: { game: string; bankCards: number } | null;
  loading?: { phase: "downloading" | "preparing"; bytes: number | null } | null;
}

/** The model state for a session's report. `address` is the release address the session was
 *  given; `name`, when given, is what the page calls its models while they load; `local`, that
 *  the release is read from a folder chosen on this computer, so it is read, not downloaded. */
export function modelOf(address: string, report: ReleaseReport | null, name?: string, local = false): ModelState {
  if (address === "") return { kind: "none" };
  if (report?.state === "ready" && report.release) return { kind: "loaded", address, game: report.release.game, cards: report.release.bankCards };
  if (report?.state === "failed") return { kind: "failed", address, reason: report.error ?? "no reason given", ...(local ? { local: true as const } : {}) };
  const loading = report?.loading ?? null;
  return {
    kind: "loading", address,
    ...(loading ? { phase: loading.phase, bytes: loading.bytes } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(local ? { local: true as const } : {}),
  };
}

/** A download's size as a beginner reads it: "about 12 MB", "about 400 KB". */
export function aboutSize(bytes: number): string {
  if (bytes >= 1e6) return `about ${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `about ${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** What the state line says while a model loads: downloading its files, with their size once it
 *  is known, then preparing the models. */
export function loadingText(model: Extract<ModelState, { kind: "loading" }>): string {
  const name = model.name ?? "the model";
  if (model.phase === "preparing") return `Preparing ${name}…`;
  const verb = model.local ? "Reading" : "Downloading";
  if (model.phase === "downloading" && typeof model.bytes === "number") return `${verb} ${name} (${aboutSize(model.bytes)})…`;
  if (model.phase === "downloading") return `${verb} ${name}…`;
  return `Loading ${name}…`;
}

/** The endings of a video file's name, for a file the browser gives no type for. */
const VIDEO_NAME = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;


/** The command that converts a video file to H.264, which browsers play: the file's own name,
 *  quoted for a POSIX shell, and the output beside it as NAME-h264.mp4. */
export function h264Command(name: string): string {
  // Quoted only when needed (a plain name also works in Windows' cmd.exe, which keeps single
  // quotes); a name that starts with "-" gets "./" so that ffmpeg does not read it as an option.
  const arg = (text: string) => {
    const path = text.startsWith("-") ? `./${text}` : text;
    return /^[A-Za-z0-9._+\/-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
  };
  const stem = name.replace(/\.[^./]*$/, "") || name;
  return `ffmpeg -i ${arg(name)} -c:v libx264 -pix_fmt yuv420p ${arg(`${stem}-h264.mp4`)}`;
}

/** Whether a file goes to the video element: by its type, or by its name when it has no type.
 *  Anything else goes to the image element. */
export function isVideoType(type: string, name = ""): boolean {
  return type === "" ? VIDEO_NAME.test(name) : type.startsWith("video/");
}

/** What the newest analyzed frame says, for the status strip. Null where nothing is known yet. */
export interface RunFacts {
  detector: ExecutionProvider | null;
  recognizer: ExecutionProvider | null;
  /** The worker's time for the newest frame, in ms. */
  frameMs: number | null;
  /** How many cards the newest frame holds: faces and backs. */
  cards: number | null;
  /** Why the newest frame was not analyzed, when it was not. */
  frameError: string | null;
}

export const NO_FACTS: RunFacts = { detector: null, recognizer: null, frameMs: null, cards: null, frameError: null };

/** How a state reads besides its words: a mark of its own shape, so that it does not rest on color. */
export type Tone = "idle" | "busy" | "ready" | "problem";
export const MARK: Record<Tone, string> = { idle: "○", busy: "…", ready: "●", problem: "!" };

export interface DemoView {
  /** Which step leads the page: loading a model, or choosing a file. */
  step: "model" | "file";
  /** What the stage holds: the drop zone, the name of a file that is opening, or the file. */
  stage: "drop" | "opening" | "file";
  /** The state line. */
  state: { tone: Tone; text: string; word: string };
  /** The rest of the status strip: the backend, the time per frame, the cards found. */
  strip: string[];
  /** Whether names and outlines may be drawn. False whenever the state is not ready. */
  ready: boolean;
  /** Whether the stage shows its hint. */
  hint: boolean;
  /** The line that names the model, or null when the model step leads with nothing to name. */
  modelLine: string | null;
  /** What went wrong with the model, said beside the model line. The address field opens under
   *  it, and its button reads Retry. */
  modelProblem: string | null;
  /** The name of the file on show or opening. */
  fileName: string | null;
  /** What went wrong with the file, said by name beside the stage. */
  fileProblem: string | null;
  /** What the page's address asked for and was refused, said beside the stage. */
  addressProblem: string | null;
}

export const BACKEND: Record<ExecutionProvider, string> = { webgpu: "WebGPU", wasm: "WebAssembly" };

export const HINT = "Move over a face-up card";

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function backendText(facts: RunFacts): string | null {
  if (facts.detector === null || facts.recognizer === null) return null;
  if (facts.detector === facts.recognizer) return BACKEND[facts.detector];
  return `detector on ${BACKEND[facts.detector]}, recognizer on ${BACKEND[facts.recognizer]}`;
}

/** What a hosted page (a static build, scripts/pages.mjs) says where the local server's page
 *  speaks of a server: it has no server, and its release address is fixed when it is built. */
export const HOSTED = {
  noModelState: "No model is set for this page.",
  noModelTitle: "No model is set for this page",
  noModelText: "This copy of the demo was published without the address of a model, so it cannot name cards. The repository says how to run the demo on your own computer, with a model of your own.",
};

/** The hosted page's line under its title: where the model comes from. The title's own line
 *  already says that the file stays in this browser. Null when no release address is set. */
export function hostedNote(releaseUrl: string | null): string | null {
  if (releaseUrl === null) return null;
  let host = releaseUrl;
  try {
    host = new URL(releaseUrl).host;
  } catch {
    // Not an address: said as it is.
  }
  return `The model is downloaded from ${host} when the page opens.`;
}

/** The line under a game of the picker: where its model comes from. A release bundled with the
 *  site is fetched from the page's own host; another is downloaded from its host when the game is
 *  chosen. */
export function gameSource(release: string, pageUrl: string): string {
  let at: URL | null = null;
  try {
    at = new URL(release, pageUrl);
  } catch {
    return `The model is downloaded from ${release} when this game is chosen.`;
  }
  if (at.origin === new URL(pageUrl).origin) return "The model comes with this page.";
  return `The model is downloaded from ${at.host} when this game is chosen.`;
}

/**
 * Everything the demo page says for a model state and a file state.
 *
 * `named` is whether a name has been shown since the page opened: the hint goes away with the
 * first one. `refused` is what the page's address asked for and did not get (page.ts). `hosted`
 * is whether the page is a hosted build, whose release address cannot be changed.
 */
export function demoView(model: ModelState, media: MediaState, facts: RunFacts = NO_FACTS, named = false, refused: readonly string[] = [], hosted = false): DemoView {
  const ready = model.kind === "loaded" && media.kind === "shown";
  const fileOpen = media.kind === "shown" || media.kind === "opening";

  let state: DemoView["state"];
  if (model.kind === "none") state = { tone: "idle", text: hosted ? HOSTED.noModelState : "No model loaded.", word: "no model" };
  else if (model.kind === "loading") state = { tone: "busy", text: loadingText(model), word: "loading the model" };
  else if (model.kind === "failed") state = { tone: "problem", text: "The model did not load.", word: "model failed" };
  else if (media.kind === "none") state = { tone: "idle", text: "Model loaded. Choose a file.", word: "waiting for a file" };
  else if (media.kind === "opening") state = { tone: "busy", text: `Opening ${media.name}…`, word: "opening the file" };
  else if (media.kind !== "shown") state = { tone: "problem", text: "The file did not open.", word: "file not opened" };
  else if (facts.frameError !== null) state = { tone: "problem", text: `The last frame was not analyzed (${facts.frameError}).`, word: "frame not analyzed" };
  else state = { tone: "ready", text: `Ready. ${HINT}.`, word: "ready" };

  // Figures are those of the model and file now in effect, or they are not shown at all.
  const strip: string[] = [];
  const backend = model.kind === "loaded" ? backendText(facts) : null;
  if (backend !== null) strip.push(backend);
  if (ready && facts.frameMs !== null) strip.push(`${facts.frameMs < 10 ? facts.frameMs.toFixed(1) : Math.round(facts.frameMs)} ms per frame`);
  if (ready && facts.cards !== null) strip.push(`${count(facts.cards, "card")} found`);

  let modelLine: string | null = null;
  if (model.kind === "loading") modelLine = `Model: loading ${model.address}…`;
  else if (model.kind === "loaded") modelLine = `Model: ${model.game} · ${count(model.cards, "card")}`;
  else if (model.kind === "failed") modelLine = "Model: not loaded";

  let fileProblem: string | null = null;
  if (media.kind === "undecodable") {
    fileProblem = `${media.name} is not a picture or video this browser can open. Choose another file`
      + (media.video ? `, or convert the video to H.264: ${h264Command(media.name)}` : ".");
  }
  else if (media.kind === "unfetched") fileProblem = `${media.name} could not be loaded from ${hosted ? "this site" : "the local server"} (${media.reason}). Choose a file here instead.`;

  return {
    step: model.kind === "none" || (model.kind === "failed" && !fileOpen) ? "model" : "file",
    stage: media.kind === "shown" ? "file" : media.kind === "opening" ? "opening" : "drop",
    state,
    strip,
    ready,
    hint: ready && !named,
    modelLine,
    modelProblem: model.kind !== "failed" ? null
      : model.local ? `Could not load the release in ${model.address} (${model.reason}). Choose the release folder again.`
      : hosted ? `Could not load the model from ${model.address} (${model.reason}). Press Retry to try again.`
      : `Could not load the model at ${model.address} (${model.reason}). Check the address, then press Retry.`,
    fileName: fileOpen ? media.name : null,
    fileProblem,
    addressProblem: refused.length > 0 ? `This page's address asked for something that was not done. ${refused.join(". ")}.` : null,
  };
}

/** What a session reports, as far as the Details panel prints it. */
export interface PanelStatus {
  release: {
    id: string;
    game: string;
    bankCards: number;
    detector: { ep: ExecutionProvider };
    recognizer: { ep: ExecutionProvider };
    ortWeb: string;
    hoverSelection: string;
    hoverMaxAgeMs: number;
  } | null;
  schedule: string;
  frames: number;
  lastWorkerMs: number | null;
  lastRoundTripMs: number | null;
  lastFrameError: string | null;
}

/** The newest analyzed frame, as far as the Details panel prints it. */
export interface PanelFrame {
  width: number;
  height: number;
  boxes: number;
  faces: number;
  named: number;
  detectorMs: number;
  recognizeMs: number;
  embeddings: number;
}

/**
 * The lines of the Details panel. The first line is the page's state in one word or a few
 * (`state: ready` only when the view is ready), for a person and for a script that waits for
 * it. Lines about frames and the pointer are printed only while the view is ready, so that
 * nothing of an earlier model or file stays in the panel.
 */
export function panelLines(
  view: DemoView,
  model: ModelState,
  file: { name: string; servedAt: string | null } | null,
  status: PanelStatus | null,
  frame: PanelFrame | null,
  shown: { name: string; cardId: string } | null,
): string[] {
  const lines = [`state: ${view.state.word}`];
  if (file === null) lines.push("file: none");
  else if (file.servedAt === null) lines.push(`file: ${file.name}`);
  else lines.push(`file: ${file.name}, from the local server's ${file.servedAt} (named in this page's address)`);
  if (view.fileProblem !== null) lines.push(`  ${view.fileProblem}`);
  if (model.kind === "none") lines.push("model: none");
  else lines.push(`model: ${model.address}`);
  if (model.kind === "failed") lines.push(`  did not load: ${model.reason}`);
  const release = model.kind === "loaded" ? status?.release ?? null : null;
  if (release) {
    lines.push(
      `release: ${release.id} (${release.game}, ${release.bankCards} cards in the bank)`,
      `backend: detector on ${release.detector.ep}, recognizer on ${release.recognizer.ep}`,
      `ONNX Runtime Web: the release was measured on ${release.ortWeb}`,
      `hover selection: ${release.hoverSelection}; a result is shown for at most ${release.hoverMaxAgeMs} ms of video`,
    );
  }
  if (!view.ready || status === null) return lines;
  lines.push(`schedule: ${status.schedule}`, `frames analyzed: ${status.frames}`);
  if (status.lastWorkerMs !== null) lines.push(`last frame: ${status.lastWorkerMs.toFixed(1)} ms in the worker, ${status.lastRoundTripMs?.toFixed(1)} ms from capture to result`);
  if (status.lastFrameError) lines.push(`last frame was not analyzed: ${status.lastFrameError}`);
  if (frame) {
    lines.push(
      `analyzed at ${frame.width} x ${frame.height}: ${frame.boxes} boxes, ${frame.faces} faces, ${frame.named} named`,
      `  detector ${frame.detectorMs.toFixed(1)} ms, recognizer ${frame.recognizeMs.toFixed(1)} ms, ${frame.embeddings} embeddings`,
    );
  }
  lines.push(shown ? `under the pointer: ${shown.name} (${shown.cardId})` : "under the pointer: nothing shown");
  return lines;
}
