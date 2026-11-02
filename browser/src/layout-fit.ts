// SPDX-License-Identifier: Apache-2.0
// Registering a layout onto a video frame: the per-frame fit.
//
// A product has a *layout*: card instances with boxes in the layout's own unit square, as some
// external source reports a board. The video shows that board somewhere in the picture, at an
// unknown axis-aligned scale and offset. The recognizer names some of the cards in the picture.
// This file finds the scale and offset that place the layout onto the frame from one frame's
// accepted cards, or says why it cannot:
//
//   1. Correspondences: identities seen exactly once in the frame and exactly once in the
//      layout (cards without identity, and cards under the layout's `blocking` box, are not
//      matched).
//   2. One hypothesis per correspondence (the scale and offset that map its layout box onto its
//      frame box exactly), scored by how many other correspondences it also places within
//      `fitMinIoU`. The best supported hypothesis wins; ties go to the larger IoU sum, then the
//      lower index.
//   3. A least-squares refit per axis over the winner's supporters, then one re-test under the
//      refit (no second refit).
//   4. The frame is `verified` with enough inliers (`fitMinInliers`, and two thirds of all
//      correspondences, tested in integers) spread far enough over the layout (`minSpan` of its extent on each
//      axis). Two coherent names fit any scale and offset exactly, so three distinct
//      identities with spread is the least that can outvote a wrong name.
//   5. A second, incompatible placement with its own supporters makes the frame `ambiguous`.
//
// Everything here is a pure function: no clocks, no state, no randomness. layout-state.ts
// decides what to display from a sequence of these outcomes.

/** Axis-aligned box; x, y top-left. Frame boxes are fractions of the frame; layout boxes are
 *  fractions of the layout's unit square. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutCard {
  /** Stable id of this card instance within its layout. */
  instance: string;
  /** The identity the recognizer also uses; absent for an unknown or hidden card. */
  identity?: string;
  bounds: Box;
  /** Informational only; the fit does not use it. */
  rotated?: boolean;
}

export interface Layout {
  key: string;
  cards: LayoutCard[];
  /** A region of the layout painted over in the picture (a dialog). Cards whose center lies in
   *  it are never matched. */
  blocking?: Box;
}

/** A card the recognizer accepted, in frame units. */
export interface Observation {
  identity: string;
  bounds: Box;
}

/** Per-axis scale and offset from layout units to frame units: v = s·a + t. */
export interface Transform {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

/** The same map as a region: the layout's unit square placed in the frame. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InsufficientReason = "too-few" | "share" | "span" | "degenerate" | "zero-inliers";

export type FrameFitOutcome =
  | {
      kind: "verified";
      transform: Transform;
      inliers: string[];
      n: number;
      minIoU: number;
      /** The inliers' layout-center range on each axis, in layout units. */
      span: [number, number];
    }
  | { kind: "ambiguous"; transform: Transform; inliers: string[]; runnerUp: string[]; n: number }
  | { kind: "insufficient"; reason: InsufficientReason; n: number; inliers: number }
  | { kind: "no-layout" };

/** The fit's fixed parameters. The toolkit's values are `LAYOUT_FIT_DEFAULTS`; `fitMinIoU` and
 *  `minSpan` come from the product's configuration. */
export interface FitParams {
  /** A correspondence supports a placement when its projected layout box overlaps its frame
   *  box at least this much. */
  fitMinIoU: number;
  /** The inliers' layout centers must spread over at least this share of the layout's extent,
   *  on each axis. */
  minSpan: number;
  /** At most this many correspondences are scored (the largest frame boxes). */
  maxCorrespondences: number;
  /** At least this many inliers. */
  fitMinInliers: number;
  /** At least this share of the correspondences are inliers, as [numerator, denominator]: the
   *  test is `denominator · inliers ≥ numerator · n`, in integers. */
  inlierShare: readonly [number, number];
  /** A second placement with this many supporters outside the first makes the frame ambiguous. */
  ambiguityMin: number;
  /** Two placements are compatible when they put every point of the layout's extent within
   *  this distance of each other, as a fraction of the frame on each axis. */
  compatTol: number;
}

/** The toolkit's defaults for the parameters a product does not tune. */
export const LAYOUT_FIT_DEFAULTS = {
  /** Bounds the n² scoring. */
  maxCorrespondences: 40,
  /** Two names fit any placement exactly; three is the least that can outvote a wrong one. */
  fitMinInliers: 3,
  inlierShare: [2, 3] as const,
  ambiguityMin: 2,
  /** 0.01 of the frame per axis: 19.2 px across and 10.8 px down a 1920 × 1080 frame. */
  compatTol: 0.01,
} as const;

/** Ties between IoU sums closer than this count as equal, and so do span tests this close. */
const TIE_EPS = 1e-9;

/** The 5 × 5 grid over a box (corners included) on which placements are compared. */
export const GRID_STEPS = 5;

// -------------------------------------------------------------------------------------------
// Geometry
// -------------------------------------------------------------------------------------------

/** Intersection over union; 0 when the union has no area. */
export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** A layout box placed in the frame. */
export function project(t: Transform, b: Box): Box {
  return { x: t.sx * b.x + t.tx, y: t.sy * b.y + t.ty, w: t.sx * b.w, h: t.sy * b.h };
}

/** A layout point placed in the frame. */
export function projectPoint(t: Transform, p: { x: number; y: number }): { x: number; y: number } {
  return { x: t.sx * p.x + t.tx, y: t.sy * p.y + t.ty };
}

/** The layout's unit square in the frame. */
export function toRegion(t: Transform): Region {
  return { x: t.tx, y: t.ty, width: t.sx, height: t.sy };
}

/** The bounding box of every card of a layout; null for a layout without cards. */
export function layoutExtent(layout: Layout): Box | null {
  if (layout.cards.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { bounds: b } of layout.cards) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The points of the 5 × 5 grid over a box, row by row. */
export function gridPoints(box: Box): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let j = 0; j < GRID_STEPS; j++) {
    for (let i = 0; i < GRID_STEPS; i++) {
      points.push({ x: box.x + (box.w * i) / (GRID_STEPS - 1), y: box.y + (box.h * j) / (GRID_STEPS - 1) });
    }
  }
  return points;
}

/** The largest distance, per axis in frame fractions, between two placements over the grid. */
export function placementDistance(t1: Transform, t2: Transform, extent: Box): { x: number; y: number } {
  let dx = 0;
  let dy = 0;
  for (const p of gridPoints(extent)) {
    const a = projectPoint(t1, p);
    const b = projectPoint(t2, p);
    dx = Math.max(dx, Math.abs(a.x - b.x));
    dy = Math.max(dy, Math.abs(a.y - b.y));
  }
  return { x: dx, y: dy };
}

/** Do two placements agree within `compatTol` of the frame, on each axis, over the extent? */
export function compatible(
  t1: Transform,
  t2: Transform,
  extent: Box,
  compatTol: number = LAYOUT_FIT_DEFAULTS.compatTol,
): boolean {
  const d = placementDistance(t1, t2, extent);
  return d.x <= compatTol && d.y <= compatTol;
}

function center(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Is a point inside a box (edges included)? */
export function containsPoint(b: Box, p: { x: number; y: number }): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

// -------------------------------------------------------------------------------------------
// Correspondences
// -------------------------------------------------------------------------------------------

export interface Correspondence {
  identity: string;
  /** The observation's box, frame units. */
  v: Box;
  /** The layout card's box, layout units. */
  r: Box;
  /** The layout card's instance. */
  instance: string;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Is this layout card one the fit may match: it has an identity and is not under the
 *  layout's blocking box? */
export function matchable(layout: Layout, card: LayoutCard): boolean {
  if (card.identity === undefined) return false;
  return layout.blocking === undefined || !containsPoint(layout.blocking, center(card.bounds));
}

/**
 * The frame's correspondences with the layout: identities occurring exactly once among the
 * observations and exactly once among the layout's matchable cards. At most `maxCorrespondences`
 * are kept, the largest frame boxes first (ties by identity). The result is in identity order
 * (code units), which is the index order the fit's tie-breaks use.
 */
export function correspondences(
  observations: readonly Observation[],
  layout: Layout,
  maxCorrespondences: number = LAYOUT_FIT_DEFAULTS.maxCorrespondences,
): Correspondence[] {
  const seen = new Map<string, Observation | null>();
  for (const o of observations) seen.set(o.identity, seen.has(o.identity) ? null : o);
  const cards = new Map<string, LayoutCard | null>();
  for (const card of layout.cards) {
    if (!matchable(layout, card)) continue;
    const id = card.identity!;
    cards.set(id, cards.has(id) ? null : card);
  }
  let out: Correspondence[] = [];
  for (const [identity, o] of seen) {
    const card = cards.get(identity);
    if (!o || !card) continue;
    out.push({ identity, v: o.bounds, r: card.bounds, instance: card.instance });
  }
  if (out.length > maxCorrespondences) {
    out.sort((a, b) => b.v.w * b.v.h - a.v.w * a.v.h || compareStrings(a.identity, b.identity));
    out = out.slice(0, maxCorrespondences);
  }
  return out.sort((a, b) => compareStrings(a.identity, b.identity));
}

// -------------------------------------------------------------------------------------------
// The fit
// -------------------------------------------------------------------------------------------

/** The placement that maps one correspondence's layout box exactly onto its frame box; null
 *  when it is not a valid placement. */
export function hypothesis(c: Correspondence): Transform | null {
  if (!(c.r.w > 0) || !(c.r.h > 0)) return null;
  const sx = c.v.w / c.r.w;
  const sy = c.v.h / c.r.h;
  const t = { sx, sy, tx: c.v.x - sx * c.r.x, ty: c.v.y - sy * c.r.y };
  if (![t.sx, t.sy, t.tx, t.ty].every(Number.isFinite) || !(sx > 0) || !(sy > 0)) return null;
  return t;
}

/** Least squares of v = s·a + t; null when the points do not determine a positive scale. */
export function fitAxis(points: ReadonlyArray<readonly [number, number]>): { s: number; t: number } | null {
  const n = points.length;
  if (n === 0) return null;
  let ma = 0;
  let mv = 0;
  for (const [a, v] of points) {
    ma += a;
    mv += v;
  }
  ma /= n;
  mv /= n;
  let cov = 0;
  let varA = 0;
  for (const [a, v] of points) {
    cov += (a - ma) * (v - mv);
    varA += (a - ma) * (a - ma);
  }
  if (!(varA > 0)) return null;
  const s = cov / varA;
  if (!(s > 0) || !Number.isFinite(s)) return null;
  const t = mv - s * ma;
  if (!Number.isFinite(t)) return null;
  return { s, t };
}

/** The per-axis refit over a set of correspondences: both edges of each box on each axis. */
export function refit(cs: readonly Correspondence[]): Transform | null {
  const xs: Array<[number, number]> = [];
  const ys: Array<[number, number]> = [];
  for (const { r, v } of cs) {
    xs.push([r.x, v.x], [r.x + r.w, v.x + v.w]);
    ys.push([r.y, v.y], [r.y + r.h, v.y + v.h]);
  }
  const fx = fitAxis(xs);
  const fy = fitAxis(ys);
  if (!fx || !fy) return null;
  return { sx: fx.s, sy: fy.s, tx: fx.t, ty: fy.t };
}

/** Everything the fit computed, for diagnostics and tests. */
export interface FitDetail {
  outcome: FrameFitOutcome;
  correspondences: Correspondence[];
  /** Supporters of each hypothesis (indices into `correspondences`); empty for an invalid one. */
  support: number[][];
  /** The winning hypothesis's index, or -1. */
  winner: number;
}

/** Fit one frame. See the file comment for the steps. */
export function fitFrame(
  observations: readonly Observation[],
  layout: Layout | null,
  params: FitParams,
): FrameFitOutcome {
  return fitFrameDetail(observations, layout, params).outcome;
}

export function fitFrameDetail(
  observations: readonly Observation[],
  layout: Layout | null,
  params: FitParams,
): FitDetail {
  if (layout === null) return { outcome: { kind: "no-layout" }, correspondences: [], support: [], winner: -1 };
  const cs = correspondences(observations, layout, params.maxCorrespondences);
  const n = cs.length;
  const insufficient = (reason: InsufficientReason, inliers: number, support: number[][] = [], winner = -1): FitDetail => ({
    outcome: { kind: "insufficient", reason, n, inliers },
    correspondences: cs,
    support,
    winner,
  });

  // Hypotheses and the support matrix.
  const hyps = cs.map(hypothesis);
  const support: number[][] = [];
  const iouSum: number[] = [];
  for (let i = 0; i < n; i++) {
    const h = hyps[i];
    const sup: number[] = [];
    let sum = 0;
    if (h) {
      for (let j = 0; j < n; j++) {
        const q = iou(project(h, cs[j]!.r), cs[j]!.v);
        if (q >= params.fitMinIoU) {
          sup.push(j);
          sum += q;
        }
      }
    }
    support.push(sup);
    iouSum.push(sum);
  }

  let winner = -1;
  for (let i = 0; i < n; i++) {
    if (!hyps[i]) continue;
    if (winner < 0) {
      winner = i;
      continue;
    }
    const a = support[i]!.length;
    const b = support[winner]!.length;
    if (a > b || (a === b && iouSum[i]! > iouSum[winner]! + TIE_EPS)) winner = i;
  }
  if (winner < 0) return insufficient(n < params.fitMinInliers ? "too-few" : "degenerate", 0, support, winner);
  // A winner supported by itself alone: no two names agree on any placement.
  if (support[winner]!.length <= 1 && n >= params.fitMinInliers) return insufficient("zero-inliers", 0, support, winner);

  const candidates = support[winner]!.map((j) => cs[j]!);
  const t = refit(candidates);
  if (!t) return insufficient("degenerate", 0, support, winner);

  // Re-test under the refit; no second refit.
  const inlierIdx: number[] = [];
  let minIoU = Infinity;
  for (const j of support[winner]!) {
    const q = iou(project(t, cs[j]!.r), cs[j]!.v);
    if (q >= params.fitMinIoU) {
      inlierIdx.push(j);
      minIoU = Math.min(minIoU, q);
    }
  }
  const inliers = inlierIdx.map((j) => cs[j]!.identity);

  // Ambiguity: an incompatible placement with its own supporters outside the inliers.
  const extent = layoutExtent(layout)!;
  const inlierSet = new Set(inlierIdx);
  let runnerUp: number[] = [];
  for (let k = 0; k < n; k++) {
    const h = hyps[k];
    if (!h || compatible(h, t, extent, params.compatTol)) continue;
    const outside = support[k]!.filter((j) => !inlierSet.has(j));
    if (outside.length > runnerUp.length) runnerUp = outside;
  }
  if (runnerUp.length >= params.ambiguityMin) {
    return {
      outcome: { kind: "ambiguous", transform: t, inliers, runnerUp: runnerUp.map((j) => cs[j]!.identity), n },
      correspondences: cs,
      support,
      winner,
    };
  }

  if (inliers.length < params.fitMinInliers) return insufficient("too-few", inliers.length, support, winner);
  const [num, den] = params.inlierShare;
  if (den * inliers.length < num * n) return insufficient("share", inliers.length, support, winner);
  let cx0 = Infinity;
  let cx1 = -Infinity;
  let cy0 = Infinity;
  let cy1 = -Infinity;
  for (const j of inlierIdx) {
    const c = center(cs[j]!.r);
    cx0 = Math.min(cx0, c.x);
    cx1 = Math.max(cx1, c.x);
    cy0 = Math.min(cy0, c.y);
    cy1 = Math.max(cy1, c.y);
  }
  const span: [number, number] = [cx1 - cx0, cy1 - cy0];
  if (span[0] < params.minSpan * extent.w - TIE_EPS || span[1] < params.minSpan * extent.h - TIE_EPS) {
    return insufficient("span", inliers.length, support, winner);
  }
  return {
    outcome: { kind: "verified", transform: t, inliers, n, minIoU, span },
    correspondences: cs,
    support,
    winner,
  };
}
