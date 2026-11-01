// SPDX-License-Identifier: Apache-2.0
// From a frame and its face boxes to scored proposals: crop, preprocess, embed, match against
// the bank, apply the accept rule and the orientation rule, then suppress overlapping boxes.
// In Python: cardvision/recognize (crops.py, accept.py, recognizer.py).

import { type AABB, type Candidate, nonMaxSuppression, type Rect } from "./boxes.js";
import { DEFAULT_MIN_CROP_PX } from "./detector/decode.js";
import type { Frame } from "./detector/detector.js";
import type { BatchEmbedder } from "./embedder.js";
import { rotateTensor90, toContractTensor } from "./preprocess.js";
import { evidenceToJson, fuseRow, type GeometricEvidence } from "./geometric/fusion.js";
import type { GeometricStage, VerifyItem } from "./geometric/stage.js";
import type { AcceptRule, EmbeddingRecognizer, ScoredMatch } from "./recognizer.js";
import { tiltedRects, type TiltedRetrySettings } from "./tilt.js";

/** Among boxes whose look reaches tau, one that overlaps a better one by this much is dropped. */
export const ACCEPTED_NMS_IOU = 0.3;

/**
 * Cut a fractional box out of a frame. The convention is truncation: each of the four edges is
 * clipped to the frame and then cut down to a whole number, so the left and top edges move in
 * by a fraction of a pixel and the right and bottom edges move out by less than one. The
 * recognizer's training crops and the bank's measurements were made this way; rounding the
 * edges instead shifts some crops by a pixel and changes the embedding slightly.
 */
export function cropRgba(frame: Frame, box: AABB): { rgba: Uint8ClampedArray; width: number; height: number } {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(frame.width, Math.floor(box.x + box.width));
  const y1 = Math.min(frame.height, Math.floor(box.y + box.height));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = ((y0 + y) * frame.width + x0) * 4;
    rgba.set(frame.data.subarray(srcStart, srcStart + w * 4), y * w * 4);
  }
  return { rgba, width: w, height: h };
}

/** A look's orientation: 0 is upright, k is k quarter turns counter-clockwise. */
export type Orientation = 0 | 1 | 2 | 3;

/** The look the orientation rule settled on for one crop. */
export interface LookChoice {
  orientation: Orientation;
  match: ScoredMatch;
  /** Whether the three turned looks were scored. */
  retried: boolean;
}

/** Whether one look is accepted: its score reaches tau and its margin over the best different
 *  identity reaches delta. tau refuses crops that resemble nothing in the bank; delta refuses
 *  crops that resemble two different cards about equally. */
export function lookAccepted(m: ScoredMatch, rule: Pick<AcceptRule, "tau" | "delta">): boolean {
  return m.similarity >= rule.tau && m.margin >= rule.delta;
}

/**
 * The orientation rule. A card may lie sideways or upside down, so a crop can be looked at in
 * four orientations; the rule keeps the common case to one look.
 *
 * - If the upright look is accepted it is used, and the turned looks are never asked for. The
 *   same holds, accepted or not, when the rule's `rotationRetry` is false.
 * - Otherwise the looks at one, two and three quarter turns are asked for (`rotations` is
 *   called at most once) and all four compete:
 *   - if any look is accepted, the accepted look with the highest score is used (on equal
 *     scores, the lower orientation);
 *   - if none is, the look with the highest score is reported, a turned look replacing the
 *     upright one only when it is strictly higher. Nothing is named in that case, though a look
 *     that reaches tau still takes part in the suppression and in the tracker.
 */
export function chooseLook(
  upright: ScoredMatch,
  rotations: () => readonly [ScoredMatch, ScoredMatch, ScoredMatch],
  rule: AcceptRule,
): LookChoice {
  if (lookAccepted(upright, rule) || !rule.rotationRetry) return { orientation: 0, match: upright, retried: false };
  const looks: readonly ScoredMatch[] = [upright, ...rotations()];
  let best = -1;
  for (let k = 0; k < looks.length; k++) {
    if (lookAccepted(looks[k]!, rule) && (best < 0 || looks[k]!.similarity > looks[best]!.similarity)) best = k;
  }
  if (best < 0) {
    best = 0;
    for (let k = 1; k < looks.length; k++) if (looks[k]!.similarity > looks[best]!.similarity) best = k;
  }
  return { orientation: best as Orientation, match: looks[best]!, retried: true };
}

/** One face box after recognition, in the orientation `chooseLook` picked. */
export interface ScoredProposal {
  aabb: AABB;
  rect: Rect;
  /** The detector's score for the box. */
  detectorScore: number;
  /** The chosen look's best bank row: its card id, whether or not the score reaches tau. */
  topId: string;
  /** The identity `topId` belongs to. */
  identity: string;
  /** The id shown when this proposal is accepted. */
  displayId: string;
  /** The chosen look's score. */
  score: number;
  /** The chosen look's margin over the best different identity. */
  margin: number;
  /** The chosen orientation. */
  orientation: Orientation;
  /** Whether the three turned looks were computed. */
  retried: boolean;
  /** Whether the score reaches tau. This alone admits a box to the suppression and the tracker. */
  tauPassed: boolean;
  /** Whether the look is accepted (tau and the margin): whether a card is named. */
  accepted: boolean;
  /** The chosen look's embedding when the score reaches tau, else null. A copy: the tracker
   *  keeps it beyond this frame. */
  embedding: Float32Array | null;
  /** With a geometric stage that ran on this crop: what it found, and what the embedding alone
   *  answered (Python: `GeometricOutcome.to_json`). The fields above are then the fused look's.
   *  Absent when no stage ran. */
  geometric?: GeometricEvidence;
  /** With the tilted retry, on a face it was tried on: the tilt, the rectangle that named the
   *  card (or none), and the answer before it. When a rectangle named the card, the fields above
   *  are that rectangle's look and `orientation` is the look it was embedded at. Absent when the
   *  retry was not tried. */
  tilted?: TiltedEvidence;
}

/** What the tilted retry did with one face (Python: `TiltedOutcome.to_json`). */
export interface TiltedEvidence {
  /** The estimated tilt, in degrees. */
  tilt: number;
  /** The scale of the rectangle that named the card, or null when none passed. */
  scale: number | null;
  /** The face's answer before the retry. */
  before: { topId: string; similarity: number; margin: number };
}

/** The tilted retry for one frame: the release's settings and, when known, a focus point. */
export interface TiltedRun {
  settings: TiltedRetrySettings;
  /** A point in frame pixels, such as the pointer: the faces whose box holds it are retried
   *  first, smallest box first, then the rest by their score. */
  focus?: { x: number; y: number } | null;
}

/** One frame's recognition. */
export interface ScoredFrame {
  /** Every face box whose crop is large enough, in detector order. */
  proposals: ScoredProposal[];
  /** Indices into `proposals` of the ones that reach tau and survive the suppression, best first. */
  kept: number[];
  /** How many proposals had their turned looks computed. */
  retried: number;
  /** How many embeddings were computed: one per proposal and three more per retried one. */
  embeddings: number;
  /** With a geometric stage: the time it took on this frame, in ms. Absent without one, and
   *  when the stage failed. */
  geometricMs?: number;
  /** With a geometric stage that ran: the recognition without it (the cosine looks), which
   *  alone feeds the tracker. Absent without a stage. */
  base?: { proposals: ScoredProposal[]; kept: number[] };
  /** The stage's error when it failed on this frame. The frame is then answered exactly as
   *  without a stage, and the caller turns the stage off. */
  geometricError?: unknown;
  /** With the tilted retry: its time on this frame, in ms. Absent without it, and when it failed. */
  tiltedMs?: number;
  /** The tilted retry's error when it failed on this frame. The frame is then answered as
   *  without it, and the caller turns it off. */
  tiltedError?: unknown;
}

/**
 * The order in which the proposals that reach tau enter the suppression: the ones whose chosen
 * look is upright, in proposal order, then the ones whose chosen look is turned, in proposal
 * order. The suppression's sort is stable, so this order decides exact ties in score.
 */
export function nmsPreOrder(looks: ReadonlyArray<{ tauPassed: boolean; orientation: number; tilted?: TiltedEvidence }>): number[] {
  const upright: number[] = [];
  const turned: number[] = [];
  looks.forEach((l, i) => {
    // A face a tilted rectangle named enters with the turned looks, whatever its look.
    const tiltedNamed = l.tilted !== undefined && l.tilted.scale !== null;
    if (l.tauPassed) (l.orientation === 0 && !tiltedNamed ? upright : turned).push(i);
  });
  return [...upright, ...turned];
}

/**
 * Suppression over the proposals that reach tau, by score, ignoring identity: a proposal is
 * dropped when it overlaps an already kept one by `ACCEPTED_NMS_IOU` or more. `order` is the
 * order they enter in (it decides exact ties only); it defaults to proposal order. Returns
 * indices into `proposals`, best first.
 */
export function keepAfterNms(
  proposals: ReadonlyArray<Pick<ScoredProposal, "aabb" | "score" | "tauPassed">>,
  order?: readonly number[],
): number[] {
  const passing = (order ?? proposals.map((_, i) => i)).filter((i) => proposals[i]!.tauPassed);
  return nonMaxSuppression(
    passing,
    (i: number): AABB => proposals[i]!.aabb,
    (i: number) => proposals[i]!.score,
    ACCEPTED_NMS_IOU,
  );
}

/**
 * Recognize the face boxes of one frame.
 *
 * Every crop is embedded upright in one batch. The crops whose upright look is not accepted
 * are then embedded at one, two and three quarter turns in a second batch (when the rule
 * allows the retry), and `chooseLook` picks among the four. The turns are applied to the
 * preprocessed tensor, not to the crop. A box whose crop is under `minCropPx` on either side
 * is skipped.
 *
 * With a geometric `stage`, each crop it applies to is verified after the orientation rule has
 * chosen its look (Python: `Recognizer._geometric_recognition`): the stage is given the raw
 * upright crop and the chosen look's ranking of the cards, every row of a verified card is moved
 * by its fused score less its cosine, and the fused row gives the look (re-ranked, or within the
 * embedding's identity for the accept booster). The accept rule then judges the fused look; the
 * orientation stays the one chosen. Without a stage the result is exactly as before. The
 * cosine looks are returned too (`base`): the tracker pools those, as it did before the stage.
 * When the stage throws, the frame is answered with the cosine looks alone, exactly as without
 * a stage, and the error is returned (`geometricError`).
 *
 * With `tilted`, every face still not accepted after that (at most the settings'
 * `maxFacesPerFrame`, those under the focus point first) gets the tilted retry (tilt.ts,
 * Python: `Recognizer._tilted_retry`): its straightened rectangles are embedded in one batch, each
 * at the face's chosen look, and the passing one with the highest score names the face, the
 * earlier scale on equal scores. The tracker still pools the cosine looks (`base`). When the
 * retry throws, the frame is answered as without it and the error is returned (`tiltedError`).
 */
export async function recognizeFrame(
  frame: Frame,
  embedder: BatchEmbedder,
  recognizer: EmbeddingRecognizer,
  faces: readonly Candidate[],
  minCropPx: number = DEFAULT_MIN_CROP_PX,
  stage: GeometricStage | null = null,
  tilted: TiltedRun | null = null,
): Promise<ScoredFrame> {
  const contract = recognizer.preprocessing;
  const rule = recognizer.rule;
  const n = contract.size;
  const dim = recognizer.dim;
  const tensors: Float32Array[] = [];
  const kept: Candidate[] = [];
  const crops: Array<{ rgba: Uint8ClampedArray; width: number; height: number }> = [];
  for (const face of faces) {
    const crop = cropRgba(frame, face.aabb);
    const { rgba, width, height } = crop;
    if (width < minCropPx || height < minCropPx) continue;
    tensors.push(toContractTensor(rgba, width, height, contract));
    kept.push(face);
    if (stage || tilted) crops.push(crop);
  }
  if (kept.length === 0) return { proposals: [], kept: [], retried: 0, embeddings: 0, ...(stage ? { geometricMs: 0 } : {}), ...(tilted ? { tiltedMs: 0 } : {}) };

  const plane = 3 * n * n;
  const batch = new Float32Array(kept.length * plane);
  for (let i = 0; i < tensors.length; i++) batch.set(tensors[i]!, i * plane);
  const embs = await embedder.embedBatch(batch, kept.length);

  const uprights = kept.map((_, i) => recognizer.matchScored(embs, i * dim));
  // The turned looks are wanted exactly for the proposals whose upright look is not accepted:
  // embed them all in one batch before choosing.
  const retry: number[] = [];
  if (rule.rotationRetry) {
    for (let i = 0; i < kept.length; i++) if (!lookAccepted(uprights[i]!, rule)) retry.push(i);
  }
  const slotOf = new Map<number, number>(retry.map((i, j) => [i, j]));
  let turnedEmbs: Float32Array | null = null;
  if (retry.length > 0) {
    const turned = new Float32Array(retry.length * 3 * plane);
    for (let j = 0; j < retry.length; j++) {
      const t = tensors[retry[j]!]!;
      for (let k = 1; k <= 3; k++) turned.set(rotateTensor90(t, k, n), (j * 3 + k - 1) * plane);
    }
    turnedEmbs = await embedder.embedBatch(turned, retry.length * 3);
  }
  /** Where proposal i's look at orientation k (1 to 3) sits in `turnedEmbs`. */
  const turnedOffset = (i: number, k: number): number => {
    const j = slotOf.get(i);
    if (j === undefined || turnedEmbs === null) throw new Error(`the turned looks of proposal ${i} were not embedded`);
    return (j * 3 + k - 1) * dim;
  };

  const choices = kept.map((_, i) =>
    chooseLook(
      uprights[i]!,
      () => [1, 2, 3].map((k) => recognizer.matchScored(turnedEmbs!, turnedOffset(i, k))) as [ScoredMatch, ScoredMatch, ScoredMatch],
      rule,
    ),
  );
  /** Where proposal i's chosen look's embedding sits. */
  const chosenAt = (i: number): { embs: Float32Array; off: number } =>
    choices[i]!.orientation === 0 ? { embs, off: i * dim } : { embs: turnedEmbs!, off: turnedOffset(i, choices[i]!.orientation) };

  // The geometric stage, on every crop it applies to, in one batch.
  const fusedLooks = new Map<number, { match: ScoredMatch; geometric: GeometricEvidence }>();
  let geometricMs: number | undefined;
  let geometricError: unknown;
  let failed = false;
  if (stage) {
    try {
      const t0 = performance.now();
      const which: number[] = [];
      const rows: Float64Array[] = [];
      const items: VerifyItem[] = [];
      for (let i = 0; i < kept.length; i++) {
        if (!stage.applies(null, lookAccepted(choices[i]!.match, rule))) continue;
        const { embs: source, off } = chosenAt(i);
        const row = recognizer.scoreRow(source, off);
        which.push(i);
        rows.push(row);
        items.push({ ...crops[i]!, ranked: recognizer.rankCards(row) });
      }
      if (items.length > 0) {
        const results = await stage.verifyBatch(items, recognizer.bankIds);
        which.forEach((i, j) => {
          const result = results[j]!;
          const row = rows[j]!;
          const before = choices[i]!.match;
          const fused = fuseRow(row, result.candidates, (cardId) => recognizer.columnsOf(cardId));
          const look = stage.reorder ? recognizer.lookOf(fused) : recognizer.lookWithin(fused, recognizer.lookOf(row).row);
          const { row: _top, ...match } = look;
          fusedLooks.set(i, {
            match,
            geometric: evidenceToJson({ topId: before.topId, similarity: before.similarity, margin: before.margin, accepted: lookAccepted(before, rule) }, result),
          });
        });
      }
      geometricMs = performance.now() - t0;
    } catch (error) {
      failed = true;
      geometricError = error;
      fusedLooks.clear();
      geometricMs = undefined;
    }
  }

  // The tilted retry, on the faces still not accepted, in one batch.
  const tiltedLooks = new Map<number, { match: ScoredMatch | null; evidence: TiltedEvidence }>();
  let tiltedMs: number | undefined;
  let tiltedError: unknown;
  let tiltedFailed = false;
  let tiltedEmbeddings = 0;
  if (tilted) {
    try {
      const t0 = performance.now();
      const { scales, maxFacesPerFrame } = tilted.settings;
      const current = (i: number): ScoredMatch => fusedLooks.get(i)?.match ?? choices[i]!.match;
      const which = tiltedOrder(
        kept.map((face, i) => ({ aabb: face.aabb, similarity: choices[i]!.match.similarity, accepted: lookAccepted(current(i), rule) })),
        tilted.focus ?? null,
      ).slice(0, maxFacesPerFrame);
      if (which.length > 0) {
        const tilts: number[] = [];
        const batch = new Float32Array(which.length * scales.length * plane);
        which.forEach((i, j) => {
          const crop = crops[i]!;
          const { tilt, rects } = tiltedRects(frame, kept[i]!.aabb, { data: crop.rgba, width: crop.width, height: crop.height }, scales);
          tilts.push(tilt);
          rects.forEach((rect, q) => {
            const tensor = toContractTensor(rect.rgba, rect.width, rect.height, contract);
            batch.set(rotateTensor90(tensor, choices[i]!.orientation, n), (j * scales.length + q) * plane);
          });
        });
        tiltedEmbeddings = which.length * scales.length;
        const rectEmbs = await embedder.embedBatch(batch, tiltedEmbeddings);
        which.forEach((i, j) => {
          const before = current(i);
          let best: { q: number; match: ScoredMatch } | null = null;
          for (let q = 0; q < scales.length; q++) {
            const match = recognizer.matchScored(rectEmbs, (j * scales.length + q) * dim);
            if (lookAccepted(match, rule) && (best === null || match.similarity > best.match.similarity)) best = { q, match };
          }
          tiltedLooks.set(i, {
            match: best ? best.match : null,
            evidence: { tilt: tilts[j]!, scale: best ? scales[best.q]! : null, before: { topId: before.topId, similarity: before.similarity, margin: before.margin } },
          });
        });
      }
      tiltedMs = performance.now() - t0;
    } catch (error) {
      tiltedFailed = true;
      tiltedError = error;
      tiltedLooks.clear();
      tiltedEmbeddings = 0;
      tiltedMs = undefined;
    }
  }

  const proposalsOf = (fused: boolean): ScoredProposal[] => {
    const scored: ScoredProposal[] = [];
    for (let i = 0; i < kept.length; i++) {
      const chosen = choices[i]!;
      const fusedLook = fused ? fusedLooks.get(i) : undefined;
      const tiltedLook = fused ? tiltedLooks.get(i) : undefined;
      const { orientation, retried } = chosen;
      const m = tiltedLook?.match ?? (fusedLook ? fusedLook.match : chosen.match);
      const tauPassed = m.cardId !== null;
      // A look that reaches tau carries the chosen look's embedding (a fused look too, though
      // the tracker is given the cosine looks only: `base`).
      let embedding: Float32Array | null = null;
      if (tauPassed) {
        const { embs: source, off } = chosenAt(i);
        embedding = source.slice(off, off + dim);
      }
      scored.push({
        aabb: kept[i]!.aabb,
        rect: kept[i]!.rect,
        detectorScore: kept[i]!.score,
        topId: m.topId,
        identity: m.identity,
        displayId: m.displayId,
        score: m.similarity,
        margin: m.margin,
        orientation,
        retried,
        tauPassed,
        accepted: lookAccepted(m, rule),
        embedding,
        ...(fusedLook ? { geometric: fusedLook.geometric } : {}),
        ...(tiltedLook ? { tilted: tiltedLook.evidence } : {}),
      });
    }
    return scored;
  };

  const scored = proposalsOf(true);
  const ran = (stage !== null && !failed) || (tilted !== null && !tiltedFailed);
  const base = ran ? proposalsOf(false) : null;
  return {
    proposals: scored,
    kept: keepAfterNms(scored, nmsPreOrder(scored)),
    retried: retry.length,
    embeddings: kept.length + 3 * retry.length + tiltedEmbeddings,
    ...(geometricMs !== undefined ? { geometricMs } : {}),
    ...(tiltedMs !== undefined ? { tiltedMs } : {}),
    ...(base ? { base: { proposals: base, kept: keepAfterNms(base, nmsPreOrder(base)) } } : {}),
    ...(failed ? { geometricError } : {}),
    ...(tiltedFailed ? { tiltedError } : {}),
  };
}

/**
 * The order in which the tilted retry takes the faces that are not accepted: those whose box
 * holds `focus`, smallest box first, then the rest by their score (`similarity`, the chosen
 * cosine look's), highest first; on equal keys, in proposal order. Returns indices.
 */
export function tiltedOrder(
  faces: ReadonlyArray<{ aabb: AABB; similarity: number; accepted: boolean }>,
  focus: { x: number; y: number } | null,
): number[] {
  const holds = (b: AABB): boolean => focus !== null && focus.x >= b.x && focus.x <= b.x + b.width && focus.y >= b.y && focus.y <= b.y + b.height;
  const open = faces.map((_, i) => i).filter((i) => !faces[i]!.accepted);
  const under = open.filter((i) => holds(faces[i]!.aabb)).sort((a, b) => faces[a]!.aabb.width * faces[a]!.aabb.height - faces[b]!.aabb.width * faces[b]!.aabb.height);
  const rest = open.filter((i) => !holds(faces[i]!.aabb)).sort((a, b) => faces[b]!.similarity - faces[a]!.similarity);
  return [...under, ...rest];
}
