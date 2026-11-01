// SPDX-License-Identifier: Apache-2.0
// A scoring run: for each manifest row, find its frame in the video, analyze it, and record
// what the hover rule shows at each labeled position. The result is a list of lines for a
// JSON Lines file, which `cardvision evaluate hover --browser-events` reads and scores
// (cardvision/evaluate/browser.py).
//
// Each row is judged alone, as `cardvision evaluate hover` judges each frame alone. The hover
// layer of an analyzed frame is built from that frame's own boxes and carries nothing over
// from an earlier frame (src/hover-layer.ts), so the order of the rows does not matter.
//
// A row ends in exactly one place:
//   kept          its frame was found and analyzed; every position has an outcome
//   unreachable   no frame within a second of its time was near enough to its fingerprint;
//                 it is never scored on another frame
//   no-video      no video file was given for it, or the section file given ends before its time
//   frame-shape   the video has another shape than the frame the labels were made on
//   failed        the frame could not be read or analyzed, or the video ends before the row's
//                 window starts; `reason` says why
//
// A file may hold one section of a video and not the whole of it. Such a file is read through
// `onVideoTimeline`, which puts its frames on the video's own timeline: the time `x` of the file
// is the time `start + x` of the video. A row at time `t` is then looked for at `t - start` of
// the file, and its window ends where the file starts and ends, as it does at the start and the
// end of a whole video.
//
// Nothing here touches a page: the video and the analysis come in through `ScoringVideo`.

import type { GeometricEvidence } from "../src/geometric/fusion.js";
import type { IdentityRule } from "../src/identity.js";
import type { ReleaseStatus } from "../src/messages.js";
import { type FrameAnalysis, hoverAt } from "../src/pipeline.js";
import type { ExecutionProvider } from "../src/providers.js";
import { ACCEPTED_NMS_IOU } from "../src/recognition.js";
import { RUNTIME_NAME, RUNTIME_VERSION } from "../src/version.js";
import { SAME_FRAME_MAX_HAMMING } from "./dhash.js";
import { type Position, type ScoreRow, shapeMatches } from "./manifest.js";
import { chooseFrame, FINGERPRINT_WINDOW_SECONDS, type VideoFrames } from "./select.js";

export const EVENTS_KIND = "cardvision-browser-events";
export const EVENTS_VERSION = 1;

/** What the hover rule shows at one position of an analyzed frame. */
export interface PositionOutcome {
  /** The position's place in the row's `points` or `boxes`, from 0. */
  index: number;
  /** The position, in fractions of the frame. */
  x: number;
  y: number;
  /** The card shown, or null twice when nothing is shown. */
  cardId: string | null;
  name: string | null;
  /** The box the pointer is on, `[x, y, width, height]` in pixels of the analyzed frame, with
   *  its best match's score and margin and whether it was accepted. Null when the pointer is
   *  on no box. A box that was not accepted is recorded and shows nothing. */
  box: [number, number, number, number] | null;
  similarity: number | null;
  margin: number | null;
  accepted: boolean | null;
  /** With a geometric stage that ran on the box: what it found and what the embedding alone
   *  answered (Python: `GeometricOutcome.to_json`). Absent otherwise. */
  geometric?: GeometricEvidence;
}

/** The outcome at one position: the release's hover rule and accept rule, on this frame alone. */
export function positionOutcome(analysis: FrameAnalysis, position: Position): PositionOutcome {
  const hit = hoverAt(analysis, position.x * analysis.frame.width, position.y * analysis.frame.height);
  const found = hit.boxIndex === null ? undefined : analysis.boxes[hit.boxIndex];
  const face = found?.face ?? null;
  return {
    index: position.index,
    x: position.x,
    y: position.y,
    cardId: hit.cardId,
    name: hit.name,
    box: found ? [...found.box] : null,
    similarity: face?.similarity ?? null,
    margin: face?.margin ?? null,
    accepted: face?.accepted ?? null,
    ...(face?.geometric ? { geometric: face.geometric } : {}),
  };
}

type Backend = { detector: ExecutionProvider; recognizer: ExecutionProvider };

/** The first line of the file: what ran. */
export interface RunHeader {
  kind: typeof EVENTS_KIND;
  version: typeof EVENTS_VERSION;
  release: {
    id: string;
    game: string;
    locale: string;
    detector: { version: string; threshold: number; nmsIou: number; maxProposals: number; minCropPx: number };
    recognizer: { version: string };
    /** The identity rule of the release, which decided the margin of every look. The file is
     *  scored under the same rule: `cardvision evaluate hover` refuses a catalog that states
     *  another. */
    identity: { level: IdentityRule };
    accept: { tau: number; delta: number; rotationRetry: boolean };
    /** The release's tilted retry settings, given only when the release turns it on. */
    tiltedRetry?: { scales: number[]; maxFacesPerFrame: number; budgetMs: number };
    /** `nmsIou` is the suppression overlap of the "accepted-nms" selection, given for it alone. */
    hover: { selection: string; nmsIou?: number };
    analysisWidth: { min: number; max: number };
    ortWeb: string;
  };
  runtime: { name: string; version: string };
  userAgent: string;
  /** `asked` is "release" for the release's own order, or the one backend that was forced. */
  backend: Backend & { asked: "release" | ExecutionProvider };
  role: string;
  manifests: Array<{ file: string; sha256: string; rows: number }>;
  frameSelection: { windowSeconds: number; maxHamming: number };
  /** With the geometric stage: its settings document and its state when the run started. */
  geometric?: { settings: string; state: string; reason: string | null; bytes: number | null };
}

/** One line per row of the role. */
export interface RowLine {
  platform: string;
  video_id: string;
  t: number;
  status: "kept" | "unreachable" | "no-video" | "frame-shape" | "failed";
  /** How many points and boxes the row has in the manifest. */
  labels: { points: number; boxes: number };
  /** Why, for `failed`. */
  reason?: string;
  /** The video file used and the size it decodes to. For a file that holds one section of the
   *  video, `start` is the time in the video at which the file starts: the row was looked for
   *  at `t - start` of the file. A whole video has no `start`. */
  video?: { file: string; width: number; height: number; start?: number };
  /** The frame kept, or for `unreachable` the nearest frame found. `mediaTime` is the frame's
   *  time in the video (for a section: its time in the file plus `video.start`), `offset` that
   *  time minus the row's, `distance` the bits between its
   *  fingerprint and the row's (null for a row without one), `looked` the number of frames
   *  fingerprinted, and `exactTime` whether the browser reported the frame's own time. Where
   *  it did not (`exactTime` false), `mediaTime` is the time the page asked for when it saw the
   *  frame: a time at which the frame is on screen, up to one step after the frame's start.
   *  `looked` then counts the looks, and a frame can be looked at more than once. */
  frame?: { mediaTime: number; offset: number; distance: number | null; looked: number; exactTime: boolean };
  /** The size of the analyzed frame, for `kept`. */
  analyzed?: { width: number; height: number };
  /** The backend each model ran on, for `kept`. */
  backend?: Backend;
  /** For `kept`: the outcome at every labeled point and at the center of every box. */
  points?: PositionOutcome[];
  centers?: PositionOutcome[];
}

/** A video a run reads: its frames, and the analysis of the frame it shows. */
export interface ScoringVideo extends VideoFrames {
  /** The file's name, without its folder. */
  readonly file: string;
  /** The size the video decodes to. */
  readonly width: number;
  readonly height: number;
  /** For a file that holds one section of a video, seen through `onVideoTimeline`: the time in
   *  the video at which the file starts. Absent for a whole video. */
  readonly sectionStart?: number;
  /** Analyze the frame now on screen, the one the last `frameAt` showed. */
  analyzeShown(): Promise<FrameAnalysis>;
}

/** Times are kept to the microsecond, which is what a browser reports. */
const micro = (seconds: number): number => Math.round(seconds * 1e6) / 1e6;

/**
 * A file that holds one section of a video, seen on the video's own timeline. `file` is the
 * opened file, whose times count from its own start, and `start` the time in the video at which
 * it starts. In the result every time is a time in the video: asking for `t` shows the file's
 * frame at `t - start`, and a time before `start` shows the file's first frame, as a time
 * before 0 does in a whole video.
 */
export function onVideoTimeline(file: ScoringVideo, start: number): ScoringVideo {
  return {
    file: file.file,
    width: file.width,
    height: file.height,
    exactTimes: file.exactTimes,
    durationSec: micro(start + file.durationSec),
    sectionStart: start,
    async frameAt(timeSec) {
      const frame = await file.frameAt(Math.max(0, timeSec - start));
      return { timeSec: micro(start + frame.timeSec), seekSec: timeSec, fingerprint: frame.fingerprint };
    },
    analyzeShown: () => file.analyzeShown(),
  };
}

export interface RunInputs {
  /** The rows to score, in manifest order. */
  rows: readonly ScoreRow[];
  /** The video for a row, opened and ready, or null when no file was given for it. */
  videoOf(row: ScoreRow): Promise<ScoringVideo | null>;
  backend: Backend;
  /** Called with each row's line as soon as it is known. */
  onRow?(line: RowLine, done: number, total: number): void;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const EPSILON = 1e-6;

/** The header line of a run. */
export function runHeader(
  release: NonNullable<ReleaseStatus["release"]>,
  details: {
    userAgent: string;
    asked: "release" | ExecutionProvider;
    role: string;
    manifests: RunHeader["manifests"];
    geometric?: RunHeader["geometric"];
  },
): RunHeader {
  return {
    kind: EVENTS_KIND,
    version: EVENTS_VERSION,
    release: {
      id: release.id,
      game: release.game,
      locale: release.locale,
      detector: { version: release.detector.version, ...release.decode },
      recognizer: { version: release.recognizer.version },
      identity: { level: release.identityLevel },
      accept: { ...release.accept },
      ...(release.tiltedRetry ? { tiltedRetry: { ...release.tiltedRetry, scales: [...release.tiltedRetry.scales] } } : {}),
      hover: { selection: release.hoverSelection, ...(release.hoverSelection === "accepted-nms" ? { nmsIou: ACCEPTED_NMS_IOU } : {}) },
      analysisWidth: { ...release.analysisWidth },
      ortWeb: release.ortWeb,
    },
    runtime: { name: RUNTIME_NAME, version: RUNTIME_VERSION },
    userAgent: details.userAgent,
    backend: { asked: details.asked, detector: release.detector.ep, recognizer: release.recognizer.ep },
    role: details.role,
    manifests: details.manifests,
    frameSelection: { windowSeconds: FINGERPRINT_WINDOW_SECONDS, maxHamming: SAME_FRAME_MAX_HAMMING },
    ...(details.geometric ? { geometric: details.geometric } : {}),
  };
}

async function scoreRow(row: ScoreRow, video: ScoringVideo | null, backend: Backend): Promise<RowLine> {
  const line: RowLine = { platform: row.platform, video_id: row.videoId, t: row.t, status: "no-video", labels: { points: row.points, boxes: row.boxes } };
  if (video === null) return line;
  // A section that ends before the row's time does not hold the row: no file was given for it.
  if (video.sectionStart !== undefined && row.t > video.durationSec + EPSILON) return line;
  line.video = { file: video.file, width: video.width, height: video.height, ...(video.sectionStart === undefined ? {} : { start: video.sectionStart }) };
  if (!shapeMatches(row, video.width, video.height)) return { ...line, status: "frame-shape" };
  const choice = await chooseFrame(video, row.t, row.fingerprint);
  if (choice.status === "failed") return { ...line, status: "failed", reason: choice.reason };
  const { frame } = choice;
  line.frame = { mediaTime: frame.timeSec, offset: round3(frame.timeSec - row.t), distance: choice.distance, looked: choice.looked, exactTime: video.exactTimes };
  if (choice.status === "unreachable") return { ...line, status: "unreachable" };
  // Show the chosen frame again and make sure it is the one that was chosen.
  const shown = await video.frameAt(frame.seekSec);
  if (shown.timeSec !== frame.timeSec || shown.fingerprint !== frame.fingerprint) {
    return { ...line, status: "failed", reason: "the chosen frame could not be shown again" };
  }
  const analysis = await video.analyzeShown();
  const outcomes = row.positions.map((position) => ({ kind: position.kind, outcome: positionOutcome(analysis, position) }));
  return {
    ...line,
    status: "kept",
    analyzed: { width: analysis.frame.width, height: analysis.frame.height },
    backend: { ...backend },
    points: outcomes.filter((o) => o.kind === "point").map((o) => o.outcome),
    centers: outcomes.filter((o) => o.kind === "center").map((o) => o.outcome),
  };
}

/**
 * Score every row, one at a time, in order. A row whose frame cannot be read or analyzed is
 * recorded as `failed` with the reason, and the run goes on.
 */
export async function scoreRows(inputs: RunInputs): Promise<RowLine[]> {
  const lines: RowLine[] = [];
  for (const row of inputs.rows) {
    let line: RowLine;
    try {
      line = await scoreRow(row, await inputs.videoOf(row), inputs.backend);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      line = { platform: row.platform, video_id: row.videoId, t: row.t, status: "failed", labels: { points: row.points, boxes: row.boxes }, reason };
    }
    lines.push(line);
    inputs.onRow?.(line, lines.length, inputs.rows.length);
  }
  return lines;
}

/** The lines of the file a run writes: the header, then one line per row. */
export function eventLines(header: RunHeader, rows: readonly RowLine[]): string[] {
  return [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))];
}

/** How a run went, in counts. */
export interface RunSummary {
  rows: number;
  kept: number;
  unreachable: number;
  noVideo: number;
  frameShape: number;
  failed: number;
  /** Positions with an outcome, and how many of them show a card. */
  positions: number;
  shown: number;
  /** The fingerprint distances of the kept rows that have one, as `distance -> rows`. */
  distances: Record<string, number>;
}

export function summarize(rows: readonly RowLine[]): RunSummary {
  const count = (status: RowLine["status"]): number => rows.filter((row) => row.status === status).length;
  const outcomes = rows.flatMap((row) => [...(row.points ?? []), ...(row.centers ?? [])]);
  const distances: Record<string, number> = {};
  for (const row of rows) {
    const distance = row.status === "kept" ? row.frame?.distance : null;
    if (distance !== null && distance !== undefined) distances[String(distance)] = (distances[String(distance)] ?? 0) + 1;
  }
  return {
    rows: rows.length,
    kept: count("kept"),
    unreachable: count("unreachable"),
    noVideo: count("no-video"),
    frameShape: count("frame-shape"),
    failed: count("failed"),
    positions: outcomes.length,
    shown: outcomes.filter((outcome) => outcome.cardId !== null).length,
    distances,
  };
}
