// SPDX-License-Identifier: Apache-2.0
// Per-face evidence of an analyzed frame, in the file format of
// `cardvision evaluate hover --evidence` (cardvision/evaluate/evidence.py, whose description
// holds): what every face came to, the geometric stage's record of it, and what a pointer shows
// at each labeled position. Two runs of the same configuration, this runtime's and the Python
// package's, can then be compared face by face and event by event.
//
// Nothing is judged here: an event's `outcome` (right, wrong, nothing) needs the catalog's
// identity rule, and is left null for the Python side's scorer to fill in. Nothing here touches
// a page.

import { pyRound } from "../src/geometric/fusion.js";
import type { GeometricEvidence } from "../src/geometric/fusion.js";
import { type FrameAnalysis, hoverAt } from "../src/pipeline.js";

export const EVIDENCE_KIND = "cardvision-hover-evidence";
export const EVIDENCE_VERSION = 1;

/** One face of a frame (Python: `face_json`). */
export interface EvidenceFace {
  /** Its position among the frame's detections, best detector score first. */
  index: number;
  /** `[x, y, width, height]` in pixels of the analyzed frame, to three decimals. */
  box: [number, number, number, number];
  score: number;
  topId: string;
  similarity: number;
  margin: number;
  look: number;
  accepted: boolean;
  /** The card named, or null. */
  shownId: string | null;
  geometric: GeometricEvidence | null;
  /** The tilted retry on this face (Python: `TiltedOutcome.to_json`), or null when it was not
   *  tried. */
  tilted: { tilt: number; scale: number | null; before: { topId: string; similarity: number; margin: number } } | null;
}

/** A labeled position, as the Python side lists it for a frame. */
export interface EvidencePosition {
  key: string;
  kind: string;
  label: string;
  role: string;
  /** Fractions of the frame. */
  x: number;
  y: number;
  truthId: string | null;
}

/** What a pointer shows at one labeled position (Python: the evidence line's event). */
export interface EvidenceEvent extends EvidencePosition {
  /** The `index` of the face the pointer is on, or null. */
  hit: number | null;
  shownId: string | null;
  shown: string | null;
  box: [number, number, number, number] | null;
  /** Filled in by the Python side's scorer; null here. */
  outcome: string | null;
}

/** The row a frame stands for. */
export interface EvidenceRow {
  key: string;
  platform: string;
  video_id: string;
  t: number;
  group: string;
  source_type: string;
}

/** One frame's line of the evidence file. */
export interface EvidenceLine extends EvidenceRow {
  frame: { width: number; height: number; pixelSha256: string };
  analyzed: { width: number; height: number };
  ms: { frame: number; geometric: number | null };
  faces: EvidenceFace[];
  events: EvidenceEvent[];
  namedFaces: Array<[number, number, string]>;
}

const box3 = (box: readonly number[]): [number, number, number, number] => [pyRound(box[0]!, 3), pyRound(box[1]!, 3), pyRound(box[2]!, 3), pyRound(box[3]!, 3)];

/** The faces of an analyzed frame, in detector order. */
export function evidenceFaces(analysis: FrameAnalysis): EvidenceFace[] {
  const faces: EvidenceFace[] = [];
  analysis.boxes.forEach((found, index) => {
    const face = found.face;
    if (!face) return;
    faces.push({
      index,
      box: box3(found.box),
      score: pyRound(found.score, 6),
      topId: face.topId,
      similarity: pyRound(face.similarity, 6),
      margin: pyRound(face.margin, 6),
      look: face.look,
      accepted: face.accepted,
      shownId: face.accepted ? face.cardId : null,
      geometric: face.geometric ?? null,
      tilted: face.tilted
        ? {
            tilt: pyRound(face.tilted.tilt, 6),
            scale: face.tilted.scale,
            before: { topId: face.tilted.before.topId, similarity: pyRound(face.tilted.before.similarity, 6), margin: pyRound(face.tilted.before.margin, 6) },
          }
        : null,
    });
  });
  return faces;
}

/** What the release's hover rule shows at each position of an analyzed frame. */
export function evidenceEvents(analysis: FrameAnalysis, positions: readonly EvidencePosition[]): EvidenceEvent[] {
  const { width, height } = analysis.frame;
  return positions.map((position) => {
    const hit = hoverAt(analysis, position.x * width, position.y * height);
    const found = hit.boxIndex === null ? null : analysis.boxes[hit.boxIndex]!;
    return {
      ...position,
      hit: hit.boxIndex,
      shownId: hit.cardId,
      shown: hit.name,
      box: found ? box3(found.box) : null,
      outcome: null,
    };
  });
}

/** One frame's line: the row, the frame as read, the faces and the events. */
export function evidenceLine(
  row: EvidenceRow,
  frame: EvidenceLine["frame"],
  analysis: FrameAnalysis,
  positions: readonly EvidencePosition[],
  namedFaces: EvidenceLine["namedFaces"] = [],
): EvidenceLine {
  const geometricMs = analysis.timings.geometricMs;
  return {
    ...row,
    frame,
    analyzed: { width: analysis.frame.width, height: analysis.frame.height },
    ms: { frame: pyRound(analysis.timings.analyzeMs, 3), geometric: geometricMs === undefined ? null : pyRound(geometricMs, 3) },
    faces: evidenceFaces(analysis),
    events: evidenceEvents(analysis, positions),
    namedFaces: namedFaces.map(([x, y, id]) => [x, y, id]),
  };
}

/** SHA-256 of a frame's RGB bytes, row by row, from its RGBA pixels (Python: `pixel_sha256` of
 *  the same frame read as RGB). */
export async function rgbSha256(rgba: Uint8Array | Uint8ClampedArray, digest: (bytes: Uint8Array) => Promise<string>): Promise<string> {
  const pixels = rgba.length / 4;
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    rgb[3 * i] = rgba[4 * i]!;
    rgb[3 * i + 1] = rgba[4 * i + 1]!;
    rgb[3 * i + 2] = rgba[4 * i + 2]!;
  }
  return digest(rgb);
}
