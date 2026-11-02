// SPDX-License-Identifier: Apache-2.0
// Measuring layout registration: pure metric primitives, no policy.
//
// A product scores registration against recordings with a known true placement. These are the
// measurements it composes into its own bar:
//
//   fitError        how far a displayed placement is from the true one, in pixels of a
//                   reference frame, over a 5 × 5 grid of the layout's extent;
//   classifyAccept  correct (within 8 px), loose (8 to 20 px) or false (beyond 20 px);
//   classifyHitbox  what a drawn card box actually lies on;
//   coverage        the share of visible, identified cards a drawn box of the same identity
//                   covers;
//   exitLatency     how long a fitted display outlives a scene boundary.
//
// The 8 px and 20 px lines and the 0.3 overlap are the toolkit's fixed measurement constants.

import { type Box, containsPoint, gridPoints, iou, projectPoint, type Transform } from "./layout-fit.js";

export { compatible } from "./layout-fit.js";

/** A displayed placement within this many pixels of the truth is correct. */
export const CORRECT_PX = 8;
/** Beyond this many pixels a displayed placement is false. */
export const FALSE_PX = 20;
/** A drawn box lies on a true card when they overlap at least this much. */
export const HITBOX_IOU = 0.3;

/** The largest distance, in pixels of a `width` × `height` frame, between a placement and the
 *  true one over the 5 × 5 grid of `extent` (layout units). */
export function fitError(t: Transform, truth: Transform, extent: Box, width: number, height: number): number {
  let e = 0;
  for (const p of gridPoints(extent)) {
    const a = projectPoint(t, p);
    const b = projectPoint(truth, p);
    e = Math.max(e, Math.abs(a.x - b.x) * width, Math.abs(a.y - b.y) * height);
  }
  return e;
}

export type AcceptClass = "correct" | "loose" | "false" | "none";

/** How good a displayed placement is; "none" when nothing was displayed. */
export function classifyAccept(errorPx: number, displayed: boolean): AcceptClass {
  if (!displayed) return "none";
  if (errorPx <= CORRECT_PX) return "correct";
  if (errorPx <= FALSE_PX) return "loose";
  return "false";
}

/** A card as it truly is in the picture, frame units. */
export interface TruthCard {
  box: Box;
  identity?: string;
  faceUp: boolean;
}

/** A card box the product drew, frame units. */
export interface Hitbox {
  box: Box;
  identity?: string;
}

export type HitboxClass = "blocked" | "wrong-identity" | "back-hidden" | "correct" | "empty";

function center(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * What a drawn box lies on: "blocked" when its center is outside the visible `mask` or inside a
 * blocker; otherwise by the true card it overlaps most (at `HITBOX_IOU` or more): "back-hidden"
 * for a face-down card or one without identity, "wrong-identity" for another identity,
 * "correct" for the same one; "empty" when no true card overlaps it enough.
 */
export function classifyHitbox(
  h: Hitbox,
  truthCards: readonly TruthCard[],
  mask: Box,
  blockers: readonly Box[] = [],
): HitboxClass {
  const c = center(h.box);
  if (!containsPoint(mask, c) || blockers.some((b) => containsPoint(b, c))) return "blocked";
  let best: TruthCard | null = null;
  let bestIoU = -1;
  for (const card of truthCards) {
    const q = iou(h.box, card.box);
    if (q >= HITBOX_IOU && q > bestIoU) {
      best = card;
      bestIoU = q;
    }
  }
  if (!best) return "empty";
  if (!best.faceUp || best.identity === undefined) return "back-hidden";
  return best.identity === h.identity ? "correct" : "wrong-identity";
}

/**
 * The share of visible, face-up, identified true cards whose center lies inside a drawn box of
 * the same identity; null when there are none. A card is visible when its center is inside the
 * mask and outside every blocker.
 */
export function coverage(
  truthCards: readonly TruthCard[],
  hitboxes: readonly Hitbox[],
  mask: Box,
  blockers: readonly Box[] = [],
): number | null {
  let total = 0;
  let covered = 0;
  for (const card of truthCards) {
    if (!card.faceUp || card.identity === undefined) continue;
    const c = center(card.box);
    if (!containsPoint(mask, c) || blockers.some((b) => containsPoint(b, c))) continue;
    total += 1;
    if (hitboxes.some((h) => h.identity === card.identity && containsPoint(h.box, c))) covered += 1;
  }
  return total === 0 ? null : covered / total;
}

/** One entry of a verdict trace: what was displayed from `atMs` on. */
export interface TraceEntry {
  atMs: number;
  display: string;
}

/**
 * How long a fitted display outlives each scene boundary: the time from the boundary to the
 * first trace entry at or after it that is not "fitted" (0 when the display was not fitted at
 * the boundary); null when the display stays fitted to the end of the trace. The trace is in
 * time order.
 */
export function exitLatency(trace: readonly TraceEntry[], sceneBoundaries: readonly number[]): Array<number | null> {
  return sceneBoundaries.map((b) => exitLatencyAt(trace, b));
}

function exitLatencyAt(trace: readonly TraceEntry[], boundaryMs: number): number | null {
  let shown: string | null = null;
  for (const entry of trace) {
    if (entry.atMs > boundaryMs) break;
    shown = entry.display;
  }
  if (shown !== "fitted") return 0;
  for (const entry of trace) {
    if (entry.atMs >= boundaryMs && entry.display !== "fitted") return entry.atMs - boundaryMs;
  }
  return null;
}
