// SPDX-License-Identifier: Apache-2.0
// Builds test/fixtures/layout-contract.json, the contract cases of layout registration.
//
//   node scripts/layout-contract.mjs          write the file
//   node scripts/layout-contract.mjs --check  exit 1 when the file is not what this builds
//
// The inputs are built here; every expected value is written here by hand, from the method's
// definition. Nothing is computed with the implementation, so the file can check it. Each case
// is a self-contained list of steps, so another implementation can replay it without this
// repository's test code.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "test", "fixtures", "layout-contract.json");

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

const box = (x, y, w, h) => ({ x, y, w, h });
const project = (t, b) => ({ x: t.sx * b.x + t.tx, y: t.sy * b.y + t.ty, w: t.sx * b.w, h: t.sy * b.h });

const CONFIG = {
  fitMinIoU: 0.7,
  minSpan: 0.3,
  confirmFits: 2,
  confirmWindowMs: 15_000,
  holdMs: 30_000,
  freshnessMs: 12_000,
  intervalMs: 3_000,
  suppressionIoU: 0.3,
};

/** The six-card layout of the recovery case. */
const SIX = [
  ["a", box(0.05, 0.1, 0.12, 0.16)],
  ["b", box(0.4, 0.08, 0.12, 0.16)],
  ["c", box(0.78, 0.12, 0.12, 0.16)],
  ["d", box(0.1, 0.7, 0.12, 0.16)],
  ["e", box(0.45, 0.72, 0.12, 0.16)],
  ["f", box(0.8, 0.68, 0.12, 0.16)],
];
const card = ([id, bounds]) => ({ instance: `card-${id}`, identity: id, bounds });
const L6 = { key: "six", cards: SIX.map(card) };
const L8 = {
  key: "eight",
  cards: [...SIX, ["g", box(0.25, 0.4, 0.12, 0.16)], ["h", box(0.6, 0.4, 0.12, 0.16)]].map(card),
};
/** Four cards outside a dialog, five under it. */
const DIALOG = {
  key: "dialog",
  blocking: box(0.3, 0.3, 0.4, 0.4),
  cards: [
    ["p", box(0.05, 0.05, 0.12, 0.16)],
    ["q", box(0.8, 0.05, 0.12, 0.16)],
    ["r", box(0.05, 0.75, 0.12, 0.16)],
    ["s", box(0.8, 0.75, 0.12, 0.16)],
    ["u1", box(0.32, 0.32, 0.1, 0.12)],
    ["u2", box(0.45, 0.32, 0.1, 0.12)],
    ["u3", box(0.58, 0.32, 0.1, 0.12)],
    ["u4", box(0.32, 0.5, 0.1, 0.12)],
    ["u5", box(0.45, 0.5, 0.1, 0.12)],
  ].map(card),
};
/** The six-card layout with the aspect prior: drawn at 16:9, as the frames are. */
const L6_ASPECT = { ...L6, key: "six-aspect", aspect: 16 / 9 };
/** The same cards drawn at 4:3. */
const L6_4X3 = { ...L6, key: "six-4x3", aspect: 4 / 3 };
const LAYOUTS = { six: L6, eight: L8, dialog: DIALOG, "six-aspect": L6_ASPECT, "six-4x3": L6_4X3 };
/** The frames of the aspect cases: 1920 × 1080. */
const FRAME_ASPECT = 16 / 9;

const T = { sx: 0.6, sy: 0.6, tx: 0.2, ty: 0.1 };
/** A second placement, far from T: 0.1 of the frame to the right. */
const T_RIGHT = { sx: 0.6, sy: 0.6, tx: 0.3, ty: 0.1 };
/** The second region of the ambiguity case. */
const T_SECOND = { sx: 0.6, sy: 0.6, tx: 0.35, ty: 0.1 };

/** T stretched 4.8 % down: at the layout's far edge, 0.6 × 0.048 × 1080 = 31.1 px below where
 *  a placement in proportion puts it. */
const T_TALL = { sx: 0.6, sy: 0.6 * 1.048, tx: 0.2, ty: 0.1 };
/** T stretched 2 % down: within the 3 % tolerance. */
const T_SLIGHT = { sx: 0.6, sy: 0.6 * 1.02, tx: 0.2, ty: 0.1 };
/** A 4:3 layout in a 16:9 frame, in proportion: sy / sx = (16/9) / (4/3) = 4/3. */
const T_PROP = { sx: 0.45, sy: 0.6, tx: 0.3, ty: 0.1 };

/**
 * The aspect prior's refit, written independently of the toolkit for the expected values: least
 * squares over (sx, tx, ty) with sy = ratio · sx, every box edge one equation, x equations
 * scaled by the frame's aspect (pixels), solved through the normal equations by Cramer's rule.
 */
function proportionalFit(observations, layout, ratio, frameAspect) {
  const rows = [];
  for (const o of observations) {
    const c = layout.cards.find((k) => k.identity === o.identity);
    const r = c.bounds;
    const v = o.bounds;
    for (const [a, val] of [[r.x, v.x], [r.x + r.w, v.x + v.w]]) rows.push([frameAspect * a, frameAspect, 0, frameAspect * val]);
    for (const [b, val] of [[r.y, v.y], [r.y + r.h, v.y + v.h]]) rows.push([ratio * b, 0, 1, val]);
  }
  const m = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows.reduce((acc, q) => acc + q[i] * q[j], 0)));
  const rhs = [0, 1, 2].map((i) => rows.reduce((acc, q) => acc + q[i] * q[3], 0));
  const det = (a) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  const col = (k) => det(m.map((row, i) => row.map((x, j) => (j === k ? rhs[i] : x))));
  const sx = col(0) / d;
  return { sx, sy: ratio * sx, tx: col(1) / d, ty: col(2) / d };
}

/** Observations of the six cards in the right shape (placed by T) whose rows drift apart: their
 *  tops follow T_TALL. */
const drifted = () =>
  L6.cards.map((c) => ({
    identity: c.identity,
    bounds: { x: T.sx * c.bounds.x + T.tx, y: T_TALL.sy * c.bounds.y + T_TALL.ty, w: T.sx * c.bounds.w, h: T.sy * c.bounds.h },
  }));

const DRIFT_INLIERS = ["a", "b", "c", "d", "f"];
/** The stretched picture with e's box 2 % shorter (1.6 px of an 81 px card in 1080 lines). */
const STRETCHED_ONE_NOISY_OF = (t) =>
  placed(L6, t).map((o) => (o.identity === "e" ? { ...o, bounds: { ...o.bounds, h: o.bounds.h / 1.02 } } : o));
const driftedOf = (ids) => drifted().filter((o) => ids.includes(o.identity));

/** The refit without the prior, for the expected values: least squares of each axis on its
 *  own over both edges of each box. */
function freeFit(observations, layout) {
  const axis = (pairs) => {
    const n = pairs.length;
    const ma = pairs.reduce((acc, [a]) => acc + a, 0) / n;
    const mv = pairs.reduce((acc, [, v]) => acc + v, 0) / n;
    const s = pairs.reduce((acc, [a, v]) => acc + (a - ma) * (v - mv), 0) / pairs.reduce((acc, [a]) => acc + (a - ma) ** 2, 0);
    return [s, mv - s * ma];
  };
  const xs = [];
  const ys = [];
  for (const o of observations) {
    const r = layout.cards.find((k) => k.identity === o.identity).bounds;
    const v = o.bounds;
    xs.push([r.x, v.x], [r.x + r.w, v.x + v.w]);
    ys.push([r.y, v.y], [r.y + r.h, v.y + v.h]);
  }
  const [sx, tx] = axis(xs);
  const [sy, ty] = axis(ys);
  return { sx, sy, tx, ty };
}

/** Card-shaped observations (3:4 in the frame's units, like the six-card layout's cards placed
 *  by a proportional T) at mutually inconsistent places and sizes. */
function scatteredCards(ids) {
  const spots = [box(0.02, 0.03, 0.06, 0.08), box(0.62, 0.11, 0.09, 0.12), box(0.31, 0.6, 0.045, 0.06), box(0.83, 0.52, 0.105, 0.14)];
  return ids.map((identity, i) => ({ identity, bounds: spots[i] }));
}

/** Observations of a layout's cards placed by `t` (identified cards only). */
function placed(layout, t, ids) {
  return layout.cards
    .filter((c) => c.identity !== undefined && (ids === undefined || ids.includes(c.identity)))
    .map((c) => ({ identity: c.identity, bounds: project(t, c.bounds) }));
}

/** Observations of these identities at fixed, mutually inconsistent places and sizes: no two
 *  agree on any placement. */
function scattered(ids) {
  const spots = [
    box(0.02, 0.03, 0.05, 0.07),
    box(0.62, 0.11, 0.09, 0.05),
    box(0.31, 0.71, 0.04, 0.11),
    box(0.83, 0.52, 0.07, 0.13),
    box(0.12, 0.44, 0.11, 0.06),
    box(0.5, 0.25, 0.06, 0.09),
    box(0.71, 0.84, 0.1, 0.08),
    box(0.4, 0.5, 0.05, 0.05),
  ];
  return ids.map((identity, i) => ({ identity, bounds: spots[i] }));
}

const SIX_IDS = ["a", "b", "c", "d", "e", "f"];

/** The dialog layout's four outside cards placed by T, and its five covered cards recognized
 *  somewhere else: matched, they would break the fit; under the dialog they are never matched. */
const dialogSeen = () => [
  ...placed(DIALOG, T, ["p", "q", "r", "s"]),
  ...["u1", "u2", "u3", "u4", "u5"].map((identity, i) => ({ identity, bounds: box(0.3 + 0.07 * i, 0.45, 0.05, 0.07) })),
];

/** An analysis step. `at` is both the capture and the arrival time unless `capturedAt` is set. */
function A(at, observations, opts = {}) {
  return {
    op: "analyze",
    now: at,
    input: {
      generation: opts.generation ?? 1,
      capturedAtMs: opts.capturedAt ?? at,
      faces: opts.faces ?? observations.length,
      observations,
      layout: opts.layout === undefined ? "six" : opts.layout,
      windowIdentities: opts.window ?? [],
      ...(opts.frameAspect !== undefined ? { frameAspect: opts.frameAspect } : {}),
    },
    ...(opts.expect ? { expect: opts.expect } : {}),
  };
}
const fitT = (at, opts) => A(at, placed(L6, T), opts);
const fitRight = (at, opts) => A(at, placed(L6, T_RIGHT), opts);
/** Two names only: too few to fit. */
const thin = (at, opts) => A(at, placed(L6, T, ["a", "b"]), opts);
/** Four names, no two agreeing. */
const zero = (at, opts) => A(at, scattered(["a", "b", "c", "d"]), opts);
const ambiguous = (at, opts) =>
  A(at, [...placed(L6, T, ["a", "b", "c", "d"]), ...placed(L6, T_SECOND, ["e", "f"])], opts);
const noFaces = (at, opts) => A(at, [], { faces: 0, ...opts });
const noLayout = (at, opts) => A(at, placed(L6, T), { layout: null, ...opts });
const reset = (now, generation = 1, expect) => ({ op: "reset", generation, now, ...(expect ? { expect } : {}) });
const lost = (now, expect) => ({ op: "lost", now, ...(expect ? { expect } : {}) });
const tick = (now, expect) => ({ op: "tick", now, ...(expect ? { expect } : {}) });

// ---------------------------------------------------------------------------------------------
// G1, G2: frame fits
// ---------------------------------------------------------------------------------------------

const MIXED_DISAGREE = [...scatteredCards(["a", "b", "c"]), ...scattered(["x", "x", "x", "d"]).slice(3)];
const STRETCHED_ONE_NOISY = STRETCHED_ONE_NOISY_OF(T_TALL);
/** The stretched picture with e in the layout's proportions but somewhere else: e's placement
 *  passes the test and wins, supported by nothing but itself, while the five set aside agree. */
const STRETCHED_E_ALONE = placed(L6, T_TALL).map((o) => (o.identity === "e" ? { ...o, bounds: box(0.02, 0.85, 0.072, 0.096) } : o));

const fits = [
  {
    name: "G1 recovery: six cards placed exactly",
    layout: "six",
    observations: placed(L6, T),
    expect: { kind: "verified", n: 6, inliers: SIX_IDS, transform: T, minIoU: 1, span: [0.75, 0.64] },
  },
  {
    name: "G2a an outlier is dropped",
    layout: "six",
    observations: [...placed(L6, T, ["a", "b", "c", "d", "e"]), { identity: "f", bounds: box(0.9, 0.9, 0.072, 0.096) }],
    expect: { kind: "verified", n: 6, inliers: ["a", "b", "c", "d", "e"], transform: T },
  },
  {
    name: "G2b two regions: ambiguous",
    layout: "six",
    observations: [...placed(L6, T, ["a", "b", "c", "d"]), ...placed(L6, T_SECOND, ["e", "f"])],
    expect: { kind: "ambiguous", n: 6, inliers: ["a", "b", "c", "d"], runnerUp: ["e", "f"], transform: T },
  },
  {
    name: "G2b with ambiguityMin 3: two outside supporters are not enough",
    config: { ambiguityMin: 3 },
    layout: "six",
    observations: [...placed(L6, T, ["a", "b", "c", "d"]), ...placed(L6, T_SECOND, ["e", "f"])],
    expect: { kind: "verified", n: 6, inliers: ["a", "b", "c", "d"], transform: T },
  },
  {
    name: "G2c the top row alone does not span the layout vertically",
    layout: "six",
    observations: placed(L6, T, ["a", "b", "c"]),
    expect: { kind: "insufficient", reason: "span", n: 3, inliers: 3 },
  },
  {
    name: "G2d two correspondences are too few",
    layout: "six",
    observations: placed(L6, T, ["a", "b"]),
    expect: { kind: "insufficient", reason: "too-few", n: 2, inliers: 2 },
  },
  {
    name: "G2e an identity seen twice is not a correspondence",
    layout: "six",
    observations: [...placed(L6, T), { identity: "a", bounds: box(0.7, 0.75, 0.072, 0.096) }],
    expect: { kind: "verified", n: 5, inliers: ["b", "c", "d", "e", "f"], transform: T },
  },
  {
    name: "G2f no two names agree",
    layout: "six",
    observations: scattered(["a", "b", "c", "d"]),
    expect: { kind: "insufficient", reason: "zero-inliers", n: 4, inliers: 0 },
  },
  {
    name: "share: four of seven agree",
    layout: "eight",
    observations: [...placed(L8, T, ["a", "c", "d", "f"]), ...scattered(["b", "e", "g"])],
    expect: { kind: "insufficient", reason: "share", n: 7, inliers: 4 },
  },
  {
    name: "a layout card of no width makes no placement",
    layout: { key: "flat", cards: [card(["a", box(0.1, 0.1, 0, 0.1)]), card(["b", box(0.5, 0.5, 0, 0.1)]), card(["c", box(0.8, 0.8, 0, 0.1)])] },
    observations: [
      { identity: "a", bounds: box(0.1, 0.1, 0.05, 0.05) },
      { identity: "b", bounds: box(0.5, 0.5, 0.05, 0.05) },
      { identity: "c", bounds: box(0.8, 0.8, 0.05, 0.05) },
    ],
    expect: { kind: "insufficient", reason: "degenerate", n: 3, inliers: 0 },
  },
  {
    name: "no layout",
    layout: null,
    observations: placed(L6, T),
    expect: { kind: "no-layout" },
  },
  {
    name: "G3vii cards under the dialog are not matched",
    layout: "dialog",
    observations: dialogSeen(),
    expect: { kind: "verified", n: 4, inliers: ["p", "q", "r", "s"], transform: T },
  },
  {
    name: "a column of cards does not span the layout horizontally",
    layout: {
      key: "column",
      cards: [
        card(["a", box(0.05, 0.1, 0.12, 0.16)]),
        card(["b", box(0.06, 0.4, 0.12, 0.16)]),
        card(["c", box(0.05, 0.7, 0.12, 0.16)]),
        card(["d", box(0.8, 0.4, 0.12, 0.16)]),
      ],
    },
    observations: [
      { identity: "a", bounds: project(T, box(0.05, 0.1, 0.12, 0.16)) },
      { identity: "b", bounds: project(T, box(0.06, 0.4, 0.12, 0.16)) },
      { identity: "c", bounds: project(T, box(0.05, 0.7, 0.12, 0.16)) },
    ],
    expect: { kind: "insufficient", reason: "span", n: 3, inliers: 3 },
  },
  {
    name: "unidentified layout cards are not matched",
    layout: { key: "hidden", cards: [...L6.cards, { instance: "back-1", bounds: box(0.3, 0.4, 0.12, 0.16) }] },
    observations: placed(L6, T),
    expect: { kind: "verified", n: 6, inliers: SIX_IDS, transform: T },
  },
  // The aspect prior (amendment 5).
  {
    name: "aspect prior: G1 is unchanged",
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    observations: placed(L6, T),
    expect: { kind: "verified", n: 6, inliers: SIX_IDS, transform: T, minIoU: 1, span: [0.75, 0.64] },
  },
  {
    name: "aspect prior: a picture stretched 4.8 % down (31 px at the far edge) is not verified",
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    observations: placed(L6, T_TALL),
    expect: { kind: "insufficient", reason: "aspect", n: 6, inliers: 0 },
  },
  {
    name: "without the layout's aspect, the stretched picture verifies, stretched",
    layout: "six",
    frameAspect: FRAME_ASPECT,
    observations: placed(L6, T_TALL),
    expect: { kind: "verified", n: 6, inliers: SIX_IDS, transform: T_TALL },
  },
  {
    name: "without the frame's aspect, the stretched picture verifies, stretched",
    layout: "six-aspect",
    observations: placed(L6, T_TALL),
    expect: { kind: "verified", n: 6, inliers: SIX_IDS, transform: T_TALL },
  },
  {
    name: "aspect prior: a stretch within the tolerance verifies in proportion",
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    observations: placed(L6, T_SLIGHT),
    expect: { kind: "verified", n: 6, inliers: SIX_IDS, transform: proportionalFit(placed(L6, T_SLIGHT), L6, 1, FRAME_ASPECT) },
  },
  {
    name: "aspect prior: a tolerance of 0.05 lets the 4.8 % stretch through, placed in proportion",
    config: { scaleRatioTol: 0.05 },
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    observations: placed(L6, T_TALL),
    expect: { kind: "verified", n: 6, inliers: SIX_IDS, transform: proportionalFit(placed(L6, T_TALL), L6, 1, FRAME_ASPECT) },
  },
  {
    // Every card keeps its shape, so no hypothesis is set aside; c's placement wins (it supports
    // a, b, c, d and f) and the one-scale refit places those five within fitMinIoU. The board
    // test then refits them per axis: sy / sx = 1.045 (see the next case), over 3 %.
    name: "aspect prior: rows drifting 31 px at the far edge, every card the right shape, are not verified",
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    observations: drifted(),
    expect: { kind: "insufficient", reason: "aspect", n: 6, inliers: 5 },
  },
  {
    name: "without the prior, the drifting rows stretch the placement",
    layout: "six",
    observations: drifted(),
    expect: { kind: "verified", n: 6, inliers: DRIFT_INLIERS, transform: freeFit(driftedOf(DRIFT_INLIERS), L6) },
  },
  {
    name: "aspect prior: a 4:3 layout in a 16:9 frame, placed in proportion",
    layout: "six-4x3",
    frameAspect: FRAME_ASPECT,
    observations: placed(L6, T_PROP),
    expect: { kind: "verified", n: 6, inliers: SIX_IDS, transform: T_PROP },
  },
  {
    name: "aspect prior: one badly shaped detection is set aside as a placement, and still fits",
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    // f's box is 10 % too tall: its own placement is off the aspect, T's still covers it.
    observations: [...placed(L6, T, ["a", "b", "c", "d", "e"]), { identity: "f", bounds: (() => { const b = project(T, SIX[5][1]); return { ...b, h: b.h * 1.1 }; })() }],
    expect: { kind: "verified", n: 6, inliers: SIX_IDS, aspectRejected: ["f"] },
  },
  {
    name: "aspect prior: card-shaped names that agree on nothing are still zero inliers",
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    observations: scatteredCards(["a", "b", "c", "d"]),
    expect: { kind: "insufficient", reason: "zero-inliers", n: 4, inliers: 0 },
  },
  {
    name: "aspect prior: one placement set aside and no two names agreeing: still zero inliers",
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    // a, b and c are card-shaped and disagree; d is not card-shaped and is set aside, but its
    // own placement is supported by no other name.
    observations: MIXED_DISAGREE,
    expect: { kind: "insufficient", reason: "zero-inliers", n: 4, inliers: 0, aspectRejected: ["d"] },
  },
  {
    name: "aspect prior: G2f is unchanged (its boxes are set aside, and none agrees with another)",
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    observations: scattered(["a", "b", "c", "d"]),
    expect: { kind: "insufficient", reason: "zero-inliers", n: 4, inliers: 0, aspectRejected: ["a", "b", "c", "d"] },
  },
  {
    name: "aspect prior: the one placement left supports only itself while the set-aside ones agree: aspect",
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    observations: STRETCHED_E_ALONE,
    expect: { kind: "insufficient", reason: "aspect", n: 6, inliers: 0, aspectRejected: ["a", "b", "c", "d", "f"] },
  },
  {
    // e's box is 2 % short, so its own placement passes the 3 % test and wins, and the
    // one-scale refit places all six. The board test refits them per axis: 4.8 % off.
    name: "aspect prior: a stretched picture is not verified when one card's noise passes the test",
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    observations: STRETCHED_ONE_NOISY,
    expect: { kind: "insufficient", reason: "aspect", n: 6, inliers: 6, aspectRejected: ["a", "b", "c", "d", "f"] },
  },
  {
    name: "aspect prior: G2b is unchanged",
    layout: "six-aspect",
    frameAspect: FRAME_ASPECT,
    observations: [...placed(L6, T, ["a", "b", "c", "d"]), ...placed(L6, T_SECOND, ["e", "f"])],
    expect: { kind: "ambiguous", n: 6, inliers: ["a", "b", "c", "d"], runnerUp: ["e", "f"], transform: T },
  },
  {
    name: "an aspect that is not positive makes no placement",
    layout: { ...L6, key: "six-flat", aspect: 0 },
    frameAspect: FRAME_ASPECT,
    observations: placed(L6, T),
    expect: { kind: "insufficient", reason: "degenerate", n: 6, inliers: 0 },
  },
];

// ---------------------------------------------------------------------------------------------
// The state table: setups, events and the intended row of every pair
// ---------------------------------------------------------------------------------------------

/** The starting points: the seven states, three of them also reached a second way. */
const STATES = [
  "off",
  "unverified",
  "unverified (verified earlier)",
  "verified",
  "held",
  "contradicted",
  "mismatch",
  "mismatch (verified earlier)",
  "no-faces",
  "no-faces (after contradiction)",
];
/** The machine's state at each starting point. */
const MACHINE_STATE = (label) => label.replace(/ \(.*\)$/, "");
const EVENTS = [
  "eligibility-lost",
  "generation-reset",
  "A:trip",
  "A:recover",
  "A:verified-incompatible",
  "A:verified-confirming",
  "A:verified-not-confirming",
  "A:insufficient",
  "A:insufficient-after-hold",
  "A:zero-inliers-first",
  "A:zero-inliers-second",
  "A:ambiguous",
  "A:no-faces",
  "A:no-layout",
  "timer:hold",
  "timer:freshness",
];

/** The window of the monitor's analyses: the six identities. */
const W = SIX_IDS;

/** Setup steps that leave the machine in each state; the last analysis is at `.last`. */
function setup(state) {
  switch (state) {
    case "off":
      return { steps: [reset(0), lost(0)], last: 0 };
    case "unverified":
      return { steps: [reset(0)], last: 0 };
    case "verified":
      return { steps: [reset(0), fitT(0), fitT(3000)], last: 3000 };
    case "held":
      return { steps: [reset(0), fitT(0), fitT(3000), thin(6000)], last: 6000 };
    case "contradicted":
      return { steps: [reset(0), fitT(0), fitT(3000), fitRight(6000)], last: 6000 };
    case "mismatch": {
      // Nine counted analyses with two identities (too few to judge), then a tenth that brings
      // the window to five identities, one of them offered: share 1/5 trips it.
      const steps = [reset(0)];
      for (let k = 1; k <= 9; k++) {
        steps.push(A(3000 * k, [...placed(L6, T, ["a"]), { identity: "x1", bounds: box(0.05, 0.6, 0.07, 0.1) }], { window: W }));
      }
      steps.push(
        A(30_000, [...placed(L6, T, ["a"]), ...scattered(["x1", "x2", "x3", "x4"]).slice(0, 4)], { window: W }),
      );
      return { steps, last: 30_000 };
    }
    case "no-faces":
      return { steps: [reset(0), fitT(0), fitT(3000), noFaces(6000)], last: 6000 };
    case "unverified (verified earlier)":
      // Confirmed, then withdrawn by freshness.
      return { steps: [reset(0), fitT(0), fitT(3000), tick(15_000)], last: 15_000 };
    case "mismatch (verified earlier)":
      return { steps: [reset(0), fitT(0), fitT(3000), A(6000, scattered(["x1", "x2", "x3"]), { window: W })], last: 6000 };
    case "no-faces (after contradiction)":
      return { steps: [reset(0), fitT(0), fitT(3000), fitRight(6000), noFaces(9000)], last: 9000 };
  }
  throw new Error(state);
}

/** Hand-written: the row and next state each pair should produce, or why the pair cannot occur. */
const INTENT = {
  off: {
    "eligibility-lost": [1, "off"],
    "generation-reset": [2, "unverified"],
    "A:trip": "n/a: off drops every analysis, so the monitor sees none",
    "A:recover": "n/a: off drops every analysis, so the monitor sees none",
    "A:verified-incompatible": ["dropped", "off"],
    "A:verified-confirming": ["dropped", "off"],
    "A:verified-not-confirming": ["dropped", "off"],
    "A:insufficient": ["dropped", "off"],
    "A:insufficient-after-hold": ["dropped", "off"],
    "A:zero-inliers-first": ["dropped", "off"],
    "A:zero-inliers-second": ["dropped", "off"],
    "A:ambiguous": ["dropped", "off"],
    "A:no-faces": ["dropped", "off"],
    "A:no-layout": ["dropped", "off"],
    "timer:hold": [0, "off"],
    "timer:freshness": [0, "off"],
  },
  unverified: {
    "eligibility-lost": [1, "off"],
    "generation-reset": [2, "unverified"],
    "A:trip": [3, "mismatch"],
    "A:recover": "n/a: not from this starting point: the monitor is not tripped here",
    "A:verified-incompatible": "n/a: not from this starting point: no confirmed placement to contradict",
    "A:verified-confirming": [9, "verified"],
    "A:verified-not-confirming": [12, "unverified"],
    "A:insufficient": [12, "unverified"],
    "A:insufficient-after-hold": "n/a: not from this starting point: no hold runs without a confirmed placement",
    "A:zero-inliers-first": [12, "unverified"],
    "A:zero-inliers-second": [12, "unverified"],
    "A:ambiguous": [8, "unverified"],
    "A:no-faces": [12, "unverified"],
    "A:no-layout": [12, "unverified"],
    "timer:hold": [0, "unverified"],
    "timer:freshness": [0, "unverified"],
  },
  verified: {
    "eligibility-lost": [1, "off"],
    "generation-reset": [2, "unverified"],
    "A:trip": [3, "mismatch"],
    "A:recover": "n/a: not from this starting point: the monitor is not tripped here",
    "A:verified-incompatible": [5, "contradicted"],
    "A:verified-confirming": [9, "verified"],
    "A:verified-not-confirming": [10, "held"],
    "A:insufficient": [10, "held"],
    "A:insufficient-after-hold": [11, "unverified"],
    "A:zero-inliers-first": [10, "held"],
    "A:zero-inliers-second": "n/a: not from this starting point: the first moves a verified page to held",
    "A:ambiguous": [8, "held"],
    "A:no-faces": [7, "no-faces"],
    "A:no-layout": [10, "held"],
    "timer:hold": "n/a: every confirmation restarts the hold, and freshness runs out first",
    "timer:freshness": [11, "unverified"],
  },
  held: {
    "eligibility-lost": [1, "off"],
    "generation-reset": [2, "unverified"],
    "A:trip": [3, "mismatch"],
    "A:recover": "n/a: not from this starting point: the monitor is not tripped here",
    "A:verified-incompatible": [5, "contradicted"],
    "A:verified-confirming": [9, "verified"],
    "A:verified-not-confirming": [10, "held"],
    "A:insufficient": [10, "held"],
    "A:insufficient-after-hold": [11, "unverified"],
    "A:zero-inliers-first": [10, "held"],
    "A:zero-inliers-second": [6, "contradicted"],
    "A:ambiguous": [8, "held"],
    "A:no-faces": [7, "no-faces"],
    "A:no-layout": [10, "held"],
    "timer:hold": [11, "unverified"],
    "timer:freshness": [11, "unverified"],
  },
  contradicted: {
    "eligibility-lost": [1, "off"],
    "generation-reset": [2, "unverified"],
    "A:trip": [3, "mismatch"],
    "A:recover": "n/a: not from this starting point: the monitor is not tripped here",
    "A:verified-incompatible": "n/a: not from this starting point: no confirmed placement to contradict",
    "A:verified-confirming": [9, "verified"],
    "A:verified-not-confirming": [12, "unverified"],
    "A:insufficient": [12, "unverified"],
    "A:insufficient-after-hold": "n/a: not from this starting point: no hold runs without a confirmed placement",
    "A:zero-inliers-first": [12, "unverified"],
    "A:zero-inliers-second": "n/a: not from this starting point: the first moves a contradicted page to unverified",
    "A:ambiguous": [8, "unverified"],
    "A:no-faces": [7, "no-faces"],
    "A:no-layout": [12, "unverified"],
    "timer:hold": [0, "contradicted"],
    "timer:freshness": [0, "contradicted"],
  },
  mismatch: {
    "eligibility-lost": [1, "off"],
    "generation-reset": [2, "unverified"],
    "A:trip": "n/a: not from this starting point: the monitor is already tripped",
    "A:recover": [4, "unverified"],
    "A:verified-incompatible": "n/a: not from this starting point: no confirmed placement to contradict",
    "A:verified-confirming": [9, "verified"],
    "A:verified-not-confirming": [12, "mismatch"],
    "A:insufficient": [12, "mismatch"],
    "A:insufficient-after-hold": "n/a: not from this starting point: no hold runs without a confirmed placement",
    "A:zero-inliers-first": [12, "mismatch"],
    "A:zero-inliers-second": [12, "mismatch"],
    "A:ambiguous": [8, "mismatch"],
    "A:no-faces": [12, "mismatch"],
    "A:no-layout": [12, "mismatch"],
    "timer:hold": [0, "mismatch"],
    "timer:freshness": [0, "mismatch"],
  },
  "no-faces": {
    "eligibility-lost": [1, "off"],
    "generation-reset": [2, "unverified"],
    "A:trip": [3, "mismatch"],
    "A:recover": "n/a: not from this starting point: the monitor is not tripped here",
    "A:verified-incompatible": [5, "contradicted"],
    "A:verified-confirming": [9, "verified"],
    "A:verified-not-confirming": [10, "held"],
    "A:insufficient": [10, "held"],
    "A:insufficient-after-hold": [11, "unverified"],
    "A:zero-inliers-first": [10, "held"],
    "A:zero-inliers-second": "n/a: not from this starting point: the first moves a no-faces page to held",
    "A:ambiguous": [8, "held"],
    "A:no-faces": [7, "no-faces"],
    "A:no-layout": [10, "held"],
    "timer:hold": [11, "unverified"],
    "timer:freshness": [11, "unverified"],
  },
  "unverified (verified earlier)": {
    "eligibility-lost": [1, "off"],
    "generation-reset": [2, "unverified"],
    "A:trip": [3, "mismatch"],
    "A:recover": "n/a: not from this starting point: the monitor is not tripped here",
    "A:verified-incompatible": "n/a: not from this starting point: no confirmed placement to contradict",
    "A:verified-confirming": [9, "verified"],
    "A:verified-not-confirming": [12, "unverified"],
    "A:insufficient": [12, "unverified"],
    "A:insufficient-after-hold": "n/a: not from this starting point: no hold runs without a confirmed placement",
    "A:zero-inliers-first": [12, "unverified"],
    "A:zero-inliers-second": [12, "unverified"],
    "A:ambiguous": [8, "unverified"],
    "A:no-faces": [7, "no-faces"],
    "A:no-layout": [12, "unverified"],
    "timer:hold": [0, "unverified"],
    "timer:freshness": [0, "unverified"],
  },
  "mismatch (verified earlier)": {
    "eligibility-lost": [1, "off"],
    "generation-reset": [2, "unverified"],
    "A:trip": "n/a: not from this starting point: the monitor is already tripped",
    "A:recover": [4, "unverified"],
    "A:verified-incompatible": "n/a: not from this starting point: no confirmed placement to contradict",
    "A:verified-confirming": [9, "verified"],
    "A:verified-not-confirming": [12, "mismatch"],
    "A:insufficient": [12, "mismatch"],
    "A:insufficient-after-hold": "n/a: not from this starting point: no hold runs without a confirmed placement",
    "A:zero-inliers-first": [12, "mismatch"],
    "A:zero-inliers-second": [12, "mismatch"],
    "A:ambiguous": [8, "mismatch"],
    "A:no-faces": [12, "mismatch"],
    "A:no-layout": [12, "mismatch"],
    "timer:hold": [0, "mismatch"],
    "timer:freshness": [0, "mismatch"],
  },
  "no-faces (after contradiction)": {
    "eligibility-lost": [1, "off"],
    "generation-reset": [2, "unverified"],
    "A:trip": [3, "mismatch"],
    "A:recover": "n/a: not from this starting point: the monitor is not tripped here",
    "A:verified-incompatible": "n/a: not from this starting point: no confirmed placement to contradict",
    "A:verified-confirming": [9, "verified"],
    "A:verified-not-confirming": [12, "unverified"],
    "A:insufficient": [12, "unverified"],
    "A:insufficient-after-hold": "n/a: not from this starting point: no hold runs without a confirmed placement",
    "A:zero-inliers-first": [12, "unverified"],
    "A:zero-inliers-second": "n/a: not from this starting point: the first moves the page to unverified",
    "A:ambiguous": [8, "unverified"],
    "A:no-faces": [7, "no-faces"],
    "A:no-layout": [12, "unverified"],
    "timer:hold": "n/a: not from this starting point: no hold runs without a confirmed placement",
    "timer:freshness": [11, "unverified"],
  },
};

/** Steps after the setup that keep the state, then the event step (the last one). */
function eventSteps(state, event, last) {
  const t = last + 3000;
  switch (event) {
    case "eligibility-lost":
      return [lost(t)];
    case "generation-reset":
      return [reset(t, 2)];
    case "A:trip":
      return [A(t, scattered(["x1", "x2", "x3"]), { window: W })];
    case "A:recover": {
      // Mismatch only. Nineteen counted analyses of five identities, four offered (share 0.8):
      // the analyses that tripped it leave the window after nine, and ten in a row at 0.8
      // recover.
      const steps = [];
      const obs = [...scattered(["a", "b", "c", "d"]), { identity: "z", bounds: box(0.45, 0.05, 0.03, 0.03) }];
      for (let k = 0; k < 19; k++) steps.push(A(t + 3000 * k, obs, { window: W }));
      return steps;
    }
    case "A:verified-incompatible":
      return [fitRight(t)];
    case "A:verified-confirming":
      if (state === "unverified" || state === "mismatch") return [fitT(t), fitT(t + 3000)];
      if (state === "contradicted" || state === "no-faces (after contradiction)") return [fitRight(t)];
      return [fitT(t)];
    case "A:verified-not-confirming":
      if (state === "held") return [thin(t), thin(t + 3000), thin(t + 6000), thin(t + 9000), fitT(19_000)];
      if (state === "no-faces") return [noFaces(t), noFaces(t + 3000), noFaces(t + 6000), noFaces(t + 9000), fitT(19_000)];
      if (state === "contradicted" || state === "no-faces (after contradiction)") return [fitT(t)];
      if (state === "unverified (verified earlier)" || state === "mismatch (verified earlier)") return [fitRight(t)];
      // Analyses that arrive late: a confirmation captured at 3500 arrives at 7000; the next
      // fit, captured past the window after it, arrives before freshness runs out.
      if (state === "verified") return [fitT(7000, { capturedAt: 3500 }), fitT(18_700, { capturedAt: 18_600 })];
      return [fitT(t)];
    case "A:insufficient":
      return [thin(t)];
    case "A:insufficient-after-hold":
      // No timer ran: the analysis arrives 30 s after the confirmation at 3000.
      return [thin(33_000)];
    case "A:zero-inliers-first":
      return [zero(t)];
    case "A:zero-inliers-second":
      return [zero(t), zero(t + 3000)];
    case "A:ambiguous":
      return [ambiguous(t)];
    case "A:no-faces":
      return [noFaces(t)];
    case "A:no-layout":
      return [noLayout(t)];
    case "timer:hold": {
      // A page holding a placement: keep analyses arriving (so freshness never runs out) until
      // the hold does, 30 s after the confirmation at 3000. Elsewhere there is no hold to run
      // out: the timer alone.
      if (state !== "held" && state !== "no-faces") return [tick(Math.max(last, 3000) + 30_000)];
      const steps = [];
      const keep = state === "no-faces" ? noFaces : thin;
      for (let at = t; at < 33_000; at += 3000) steps.push(keep(at));
      steps.push(tick(33_000));
      return steps;
    }
    case "timer:freshness":
      return [tick(last + 12_000)];
  }
  throw new Error(event);
}

const intent = [];
for (const state of STATES) {
  for (const event of EVENTS) {
    const want = INTENT[state][event];
    if (typeof want === "string") {
      intent.push({ state, machineState: MACHINE_STATE(state), event, na: want });
      continue;
    }
    const events = eventSteps(state, event, setup(state).last);
    const [row, next] = want;
    const final = events[events.length - 1];
    final.expect = row === "dropped" ? { dropped: true, state: next } : { row, state: next };
    intent.push({ state, machineState: MACHINE_STATE(state), event, row, next, setup: state, steps: events });
  }
}

// ---------------------------------------------------------------------------------------------
// G3, G4: named traces
// ---------------------------------------------------------------------------------------------

const v = (state, display, contradicted, row) => ({ state, display, contradicted, ...(row !== undefined ? { row } : {}) });
const mismatchSteps = setup("mismatch").steps;
mismatchSteps[mismatchSteps.length - 1].expect = v("mismatch", "vision", true, 3);

/** Frames without faces every 3 s from `from` through `to`. */
const noFacesFrom = (from, to) => {
  const steps = [];
  for (let at = from; at <= to; at += 3000) steps.push(noFaces(at));
  return steps;
};

const traces = [
  {
    name: "G3i mismatch, then the game returns: geometry wins over the monitor",
    steps: [
      ...mismatchSteps,
      // The probe keeps running with no pointer. The game returns: two compatible verified
      // fits arrive before the monitor could recover.
      fitT(33_000, { window: W, expect: v("mismatch", "vision", true, 12) }),
      fitT(36_000, { window: W, expect: v("verified", "fitted", false, 9) }),
      fitT(39_000, { window: W, expect: v("verified", "fitted", false, 9) }),
    ],
  },
  {
    name: "G3i' mismatch, no fit: recovery after ten counted analyses at 0.8",
    steps: [
      ...mismatchSteps,
      ...eventSteps("mismatch", "A:recover", 30_000).map((s, k, all) =>
        k === all.length - 1 ? { ...s, expect: v("unverified", "vision", true, 4) } : k === all.length - 2 ? { ...s, expect: v("mismatch", "vision", true, 12) } : s,
      ),
    ],
  },
  {
    name: "G3ii contradiction, no faces, faces return",
    steps: [
      reset(0),
      fitT(0, { expect: v("unverified", "today", false, 12) }),
      fitT(3000, { expect: v("verified", "fitted", false, 9) }),
      fitRight(6000, { expect: v("contradicted", "vision", true, 5) }),
      noFaces(9000, { expect: v("no-faces", "hidden", true, 7) }),
      A(12_000, placed(L6, T_RIGHT, ["a", "b"]), { expect: v("unverified", "vision", true, 12) }),
      fitRight(15_000, { expect: v("verified", "fitted", false, 9) }),
    ],
  },
  {
    name: "G3iii a 15 s stall withdraws the page; an incompatible fit afterwards starts over",
    steps: [
      reset(0),
      fitT(0),
      fitT(3000, { expect: v("verified", "fitted", false, 9) }),
      tick(15_000, v("unverified", "today", false, 11)),
      fitRight(18_000, { expect: v("unverified", "today", false, 12) }),
      fitRight(21_000, { expect: v("verified", "fitted", false, 9) }),
    ],
  },
  {
    name: "G3iv eligibility lost with a reply in flight: off, the reply dropped",
    steps: [
      reset(0),
      fitT(0),
      fitT(3000, { expect: v("verified", "fitted", false, 9) }),
      lost(4000, v("off", "today", false, 1)),
      fitT(4500, { expect: { dropped: true, state: "off" } }),
      reset(5000, 2, v("unverified", "today", false, 2)),
      fitT(5500, { expect: { dropped: true, state: "unverified" } }),
      fitT(6000, { generation: 2, expect: v("unverified", "today", false, 12) }),
    ],
  },
  {
    name: "G3v a gallery of the same cards after verified: held, then vision",
    steps: [
      reset(0),
      A(0, placed(L8, T), { layout: "eight" }),
      A(3000, placed(L8, T), { layout: "eight", expect: v("verified", "fitted", false, 9) }),
      A(6000, scattered(["a", "b", "c", "d", "e", "f", "g", "h"]), { layout: "eight", expect: v("held", "fitted", false, 10) }),
      A(9000, scattered(["a", "b", "c", "d", "e", "f", "g", "h"]), { layout: "eight", expect: v("contradicted", "vision", true, 6) }),
    ],
  },
  {
    name: "G3vii dialog cards never feed the zero-inlier exit",
    steps: [
      reset(0),
      A(0, dialogSeen(), { layout: "dialog" }),
      A(3000, dialogSeen(), { layout: "dialog", expect: v("verified", "fitted", false, 9) }),
      A(6000, dialogSeen(), { layout: "dialog", expect: v("verified", "fitted", false, 9) }),
      A(9000, dialogSeen(), { layout: "dialog", expect: v("verified", "fitted", false, 9) }),
    ],
  },
  {
    name: "G4 two compatible fits 3 s apart confirm",
    steps: [reset(0), fitT(0, { expect: v("unverified", "today", false, 12) }), fitT(3000, { expect: v("verified", "fitted", false, 9) })],
  },
  {
    name: "G4 two compatible fits 16 s apart do not",
    steps: [reset(0), fitT(0), fitT(16_000, { expect: { ...v("unverified", "today", false, 12), runLength: 1 } })],
  },
  {
    name: "G4 a held page: a compatible fit after the window stays held, the next confirms",
    steps: [
      reset(0),
      fitT(0),
      fitT(3000, { expect: v("verified", "fitted", false, 9) }),
      thin(6000, { expect: v("held", "fitted", false, 10) }),
      thin(9000),
      thin(12_000),
      thin(15_000),
      thin(18_000, { expect: v("held", "fitted", false, 10) }),
      fitT(19_000, { expect: { ...v("held", "fitted", false, 10), runLength: 1 } }),
      fitT(22_000, { expect: { ...v("verified", "fitted", false, 9), runLength: 2 } }),
    ],
  },
  {
    name: "fitted verdicts carry the region and the suppressed instances",
    steps: [
      reset(0),
      fitT(0),
      // f is seen elsewhere (a), and an unknown card lies on c's place (b).
      A(3000, [...placed(L6, T, ["a", "b", "d", "e"]), { identity: "f", bounds: box(0.05, 0.85, 0.072, 0.096) }, { identity: "zz", bounds: project(T, box(0.78, 0.12, 0.12, 0.16)) }], {
        expect: { ...v("verified", "fitted", false, 9), region: { x: 0.2, y: 0.1, width: 0.6, height: 0.6 }, suppressed: ["card-c", "card-f"] },
      }),
    ],
  },
  {
    name: "a held page suppresses against the placement it shows",
    steps: [
      reset(0),
      fitT(0),
      fitT(3000, { expect: v("verified", "fitted", false, 9) }),
      // Two names agree with the placement, f is seen elsewhere, an unknown card lies on c.
      A(6000, [...placed(L6, T, ["a", "b"]), { identity: "f", bounds: box(0.05, 0.85, 0.072, 0.096) }, { identity: "zz", bounds: project(T, box(0.78, 0.12, 0.12, 0.16)) }], {
        expect: { ...v("held", "fitted", false, 10), suppressed: ["card-c", "card-f"] },
      }),
    ],
  },
  {
    name: "a confirmation clears a trip and the identities behind it: the page stays fitted",
    steps: [
      reset(0),
      fitT(0),
      fitT(3000, { expect: v("verified", "fitted", false, 9) }),
      // One offered identity among eight: share 1/8 trips the monitor.
      A(6000, [...placed(L6, T, ["a"]), ...scattered(["x1", "x2", "x3", "x4", "x5", "x6", "x7"])], { window: W, expect: v("mismatch", "vision", true, 3) }),
      // The game returns: four names agree with the placement.
      A(9000, placed(L6, T, ["a", "b", "d", "e"]), { window: W, expect: { ...v("verified", "fitted", false, 9), monitorShare: null } }),
      A(12_000, placed(L6, T, ["a", "b", "d", "e"]), { window: W, expect: { ...v("verified", "fitted", false, 9), monitorShare: 1 } }),
      A(15_000, placed(L6, T, ["a", "b", "d", "e"]), { window: W, expect: v("verified", "fitted", false, 9) }),
    ],
  },
  {
    name: "a stall shorter than the confirmation window: one compatible fit confirms again",
    steps: [
      reset(0),
      fitT(0),
      fitT(3000, { expect: v("verified", "fitted", false, 9) }),
      tick(15_500, v("unverified", "today", false, 11)),
      fitT(16_000, { expect: { ...v("verified", "fitted", false, 9), runLength: 3 } }),
    ],
  },
  {
    name: "a stall longer than the confirmation window: confirmFits fresh fits",
    steps: [
      reset(0),
      fitT(0),
      fitT(3000, { expect: v("verified", "fitted", false, 9) }),
      tick(15_500, v("unverified", "today", false, 11)),
      fitT(20_000, { expect: { ...v("unverified", "today", false, 12), runLength: 1 } }),
      fitT(23_000, { expect: { ...v("verified", "fitted", false, 9), runLength: 2 } }),
    ],
  },
  {
    name: "a mismatch page shown a frame without faces stays in mismatch",
    steps: [
      reset(0),
      fitT(0),
      fitT(3000),
      A(6000, scattered(["x1", "x2", "x3"]), { window: W, expect: v("mismatch", "vision", true, 3) }),
      noFaces(9000, { expect: v("mismatch", "vision", true, 12) }),
    ],
  },
  // The hold runs only while a placement is confirmed. Each trace below leaves the hold that
  // began at the confirmation (3000) behind a row that stops it, then shows frames without faces
  // and a timer after 33 000 with no frame in between: a hold left running would withdraw that
  // page there.
  {
    name: "a trip stops the hold: a no-faces page after recovery outlives the old hold",
    steps: [
      ...setup("mismatch (verified earlier)").steps,
      ...eventSteps("mismatch (verified earlier)", "A:recover", 6000).map((s, k, all) =>
        k === all.length - 1 ? { ...s, expect: v("unverified", "vision", true, 4) } : s,
      ),
      noFaces(66_000, { expect: v("no-faces", "hidden", true, 7) }),
      tick(67_000, v("no-faces", "hidden", true, 0)),
    ],
  },
  {
    name: "a contradiction stops the hold: a no-faces page outlives the old hold",
    steps: [
      ...setup("contradicted").steps,
      ...noFacesFrom(9000, 30_000),
      tick(33_500, v("no-faces", "hidden", true, 0)),
    ],
  },
  {
    name: "a second zero-inlier frame stops the hold: a no-faces page outlives the old hold",
    steps: [
      ...setup("verified").steps,
      zero(6000, { expect: v("held", "fitted", false, 10) }),
      zero(9000, { expect: v("contradicted", "vision", true, 6) }),
      ...noFacesFrom(12_000, 30_000),
      tick(33_500, v("no-faces", "hidden", true, 0)),
    ],
  },
  {
    name: "a hold that runs out stops: a no-faces page afterwards is not withdrawn again",
    steps: [
      ...setup("held").steps,
      ...eventSteps("held", "timer:hold", 6000).map((s, k, all) =>
        k === all.length - 1 ? { ...s, expect: v("unverified", "today", false, 11) } : s,
      ),
      noFaces(36_000, { expect: v("no-faces", "hidden", false, 7) }),
      noFaces(39_000),
      tick(40_000, v("no-faces", "hidden", false, 0)),
    ],
  },
  {
    name: "an ambiguous frame after expiry reports the expiry",
    steps: [
      ...setup("verified").steps,
      ambiguous(15_000, { expect: v("unverified", "today", false, 11) }),
    ],
  },
  {
    name: "ambiguityMin 3: a runner-up with two outside supporters no longer blocks confirmation",
    config: { ambiguityMin: 3 },
    steps: [
      reset(0),
      ambiguous(0, { expect: v("unverified", "today", false, 12) }),
      ambiguous(3000, { expect: v("verified", "fitted", false, 9) }),
    ],
  },
  {
    name: "ambiguityMin 2 (the default): the same frames stay ambiguous",
    steps: [
      reset(0),
      ambiguous(0, { expect: v("unverified", "today", false, 8) }),
      ambiguous(3000, { expect: v("unverified", "today", false, 8) }),
    ],
  },
  {
    name: "aspect prior: a stretched source never verifies and keeps today's hovers",
    steps: [
      reset(0),
      A(0, placed(L6, T_TALL), { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("unverified", "today", false, 12) }),
      A(3000, placed(L6, T_TALL), { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("unverified", "today", false, 12) }),
      A(6000, placed(L6, T_TALL), { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("unverified", "today", false, 12) }),
    ],
  },
  {
    name: "aspect prior: frames off the aspect after a confirmation hold, then fall back to today, not to vision",
    steps: [
      reset(0),
      A(0, placed(L6, T), { layout: "six-aspect", frameAspect: FRAME_ASPECT }),
      A(3000, placed(L6, T), { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("verified", "fitted", false, 9) }),
      // Two in a row would be row 6 if they counted as zero inliers; they do not.
      A(6000, placed(L6, T_TALL), { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("held", "fitted", false, 10) }),
      A(9000, placed(L6, T_TALL), { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("held", "fitted", false, 10) }),
      ...[12_000, 15_000, 18_000, 21_000, 24_000, 27_000, 30_000].map((at) => A(at, placed(L6, T_TALL), { layout: "six-aspect", frameAspect: FRAME_ASPECT })),
      tick(33_000, v("unverified", "today", false, 11)),
    ],
  },
  {
    name: "aspect prior: a stretched picture with one in-tolerance card never confirms",
    steps: [
      reset(0),
      A(0, STRETCHED_ONE_NOISY, { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("unverified", "today", false, 12) }),
      A(3000, STRETCHED_ONE_NOISY, { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("unverified", "today", false, 12) }),
      A(6000, STRETCHED_ONE_NOISY, { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("unverified", "today", false, 12) }),
    ],
  },
  {
    name: "aspect prior: a stretched picture whose one in-proportion card stands alone holds, then falls back to today",
    steps: [
      reset(0),
      A(0, placed(L6, T), { layout: "six-aspect", frameAspect: FRAME_ASPECT }),
      A(3000, placed(L6, T), { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("verified", "fitted", false, 9) }),
      A(6000, STRETCHED_E_ALONE, { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("held", "fitted", false, 10) }),
      A(9000, STRETCHED_E_ALONE, { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("held", "fitted", false, 10) }),
    ],
  },
  {
    name: "aspect prior: one off-shape card does not keep a wrong layout on screen (row 6 still applies)",
    steps: [
      reset(0),
      A(0, placed(L6, T), { layout: "six-aspect", frameAspect: FRAME_ASPECT }),
      A(3000, placed(L6, T), { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("verified", "fitted", false, 9) }),
      A(6000, MIXED_DISAGREE, { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("held", "fitted", false, 10) }),
      A(9000, MIXED_DISAGREE, { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("contradicted", "vision", true, 6) }),
    ],
  },
  {
    name: "aspect prior through the registration: scaleRatioTol 0.05 confirms the 4.8 % stretch, in proportion",
    config: { scaleRatioTol: 0.05 },
    steps: [
      reset(0),
      A(0, placed(L6, T_TALL), { layout: "six-aspect", frameAspect: FRAME_ASPECT }),
      A(3000, placed(L6, T_TALL), { layout: "six-aspect", frameAspect: FRAME_ASPECT, expect: v("verified", "fitted", false, 9) }),
    ],
  },
  {
    name: "the monitor leaves out identities the product excludes",
    exclude: ["x1", "x2", "x3"],
    steps: [reset(0), A(3000, scattered(["x1", "x2", "x3"]), { window: W, expect: v("unverified", "today", false, 12) })],
  },
];

// ---------------------------------------------------------------------------------------------
// The rest: configuration, compatibility, regions, the monitor, metrics, the scheduler
// ---------------------------------------------------------------------------------------------

const configErrors = [
  { name: "the window below 3 intervals", config: { ...CONFIG, confirmWindowMs: 8000 }, error: "confirmWindowMs" },
  { name: "freshness below 2 intervals", config: { ...CONFIG, freshnessMs: 5000 }, error: "freshnessMs" },
  { name: "hold below freshness", config: { ...CONFIG, holdMs: 10_000 }, error: "holdMs" },
  { name: "confirmFits out of range", config: { ...CONFIG, confirmFits: 4 }, error: "confirmFits" },
  { name: "fitMinIoU below its floor", config: { ...CONFIG, fitMinIoU: 0.45 }, error: "fitMinIoU" },
  { name: "a missing value", config: { ...CONFIG, holdMs: undefined }, error: "holdMs" },
  { name: "an unknown key", config: { ...CONFIG, extra: 1 }, error: "extra" },
  { name: "ambiguityMin 1", config: { ...CONFIG, ambiguityMin: 1 }, error: "ambiguityMin" },
  { name: "ambiguityMin 2.5", config: { ...CONFIG, ambiguityMin: 2.5 }, error: "ambiguityMin" },
  { name: "scaleRatioTol 0", config: { ...CONFIG, scaleRatioTol: 0 }, error: "scaleRatioTol" },
  { name: "scaleRatioTol above 0.25", config: { ...CONFIG, scaleRatioTol: 0.3 }, error: "scaleRatioTol" },
];

// The six-card layout's extent is x 0.05..0.92 (0.87), y 0.08..0.88 (0.80). A scale change that
// moves the far corner by d leaves the near corner in place.
const farCorner = (d) => ({ sx: T.sx + d / 0.87, sy: T.sy, tx: T.tx - (d / 0.87) * 0.05, ty: T.ty });
const compat = [
  { name: "far corner moved 0.011: incompatible", a: T, b: farCorner(0.011), layout: "six", compatible: false },
  { name: "far corner moved 0.009: compatible", a: T, b: farCorner(0.009), layout: "six", compatible: true },
  { name: "0.0105 down (10.8 px of 1080 is 0.01): incompatible", a: T, b: { ...T, ty: T.ty + 0.0105 }, layout: "six", compatible: false },
];

const G5_BOXES = [box(0, 0, 1, 1), box(0.25, 0.5, 0.1, 0.2), box(0.9, 0.9, 0.1, 0.1)];
const G5_TRANSFORMS = [T, { sx: 1, sy: 1, tx: 0, ty: 0 }, { sx: 0.5, sy: 0.75, tx: 0.1, ty: 0 }];

const monitor = [
  {
    name: "exactly 0.4 does not trip; below it does",
    steps: [
      { window: ["a", "b"], accepted: ["a", "b", "x", "y", "w"], expect: { state: "in", share: 0.4, identities: 5 } },
      { window: ["a", "b"], accepted: ["v"], expect: { state: "tripped", event: "trip", identities: 6 } },
    ],
  },
  {
    name: "a share of 1/5 trips",
    steps: [{ window: SIX_IDS, accepted: ["a", "w", "x", "y", "z"], expect: { state: "tripped", event: "trip", share: 0.2, identities: 5 } }],
  },
  {
    name: "two identities never trip",
    steps: [{ window: SIX_IDS, accepted: ["x", "y"], expect: { state: "unknown", event: null, share: 0, identities: 2 } }],
  },
  {
    name: "excluded identities are left out",
    exclude: ["x", "y", "z"],
    steps: [{ window: SIX_IDS, accepted: ["a", "x", "y", "z"], expect: { event: null, share: 1, identities: 1 } }],
  },
  {
    name: "an analysis with nothing offered is not counted",
    steps: [
      { window: [], accepted: ["x", "y", "w"], expect: { state: "unknown", counted: false, identities: 0 } },
      { window: ["a"], accepted: ["a", "b"], expect: { state: "unknown", counted: true, identities: 2 } },
    ],
  },
];

const metrics = {
  fitError: [
    { name: "4 px across a 1920-wide frame", t: { ...T, tx: T.tx + 4 / 1920 }, truth: T, layout: "six", width: 1920, height: 1080, expect: 4 },
    { name: "the larger of the two axes", t: { ...T, tx: T.tx + 2 / 1920, ty: T.ty + 9 / 1080 }, truth: T, layout: "six", width: 1920, height: 1080, expect: 9 },
  ],
  classifyAccept: [
    { errorPx: 8, displayed: true, expect: "correct" },
    { errorPx: 8.5, displayed: true, expect: "loose" },
    { errorPx: 20, displayed: true, expect: "loose" },
    { errorPx: 20.5, displayed: true, expect: "false" },
    { errorPx: 50, displayed: false, expect: "none" },
  ],
  classifyHitbox: [
    { name: "outside the mask", h: { box: box(0.9, 0.9, 0.05, 0.05), identity: "a" }, truth: [], mask: box(0, 0, 0.8, 0.8), blockers: [], expect: "blocked" },
    { name: "under a blocker", h: { box: box(0.4, 0.4, 0.1, 0.1), identity: "a" }, truth: [], mask: box(0, 0, 1, 1), blockers: [box(0.3, 0.3, 0.3, 0.3)], expect: "blocked" },
    { name: "same identity", h: { box: box(0.1, 0.1, 0.1, 0.1), identity: "a" }, truth: [{ box: box(0.11, 0.1, 0.1, 0.1), identity: "a", faceUp: true }], mask: box(0, 0, 1, 1), blockers: [], expect: "correct" },
    { name: "another identity", h: { box: box(0.1, 0.1, 0.1, 0.1), identity: "a" }, truth: [{ box: box(0.11, 0.1, 0.1, 0.1), identity: "b", faceUp: true }], mask: box(0, 0, 1, 1), blockers: [], expect: "wrong-identity" },
    { name: "a face-down card", h: { box: box(0.1, 0.1, 0.1, 0.1), identity: "a" }, truth: [{ box: box(0.1, 0.1, 0.1, 0.1), faceUp: false }], mask: box(0, 0, 1, 1), blockers: [], expect: "back-hidden" },
    { name: "nothing under it", h: { box: box(0.1, 0.1, 0.1, 0.1), identity: "a" }, truth: [{ box: box(0.5, 0.5, 0.1, 0.1), identity: "a", faceUp: true }], mask: box(0, 0, 1, 1), blockers: [], expect: "empty" },
  ],
  coverage: [
    {
      name: "one of two visible cards covered; a face-down one and a blocked one not counted",
      truth: [
        { box: box(0.1, 0.1, 0.1, 0.1), identity: "a", faceUp: true },
        { box: box(0.5, 0.1, 0.1, 0.1), identity: "b", faceUp: true },
        { box: box(0.1, 0.5, 0.1, 0.1), faceUp: false },
        { box: box(0.75, 0.75, 0.1, 0.1), identity: "c", faceUp: true },
      ],
      hitboxes: [
        { box: box(0.09, 0.09, 0.12, 0.12), identity: "a" },
        { box: box(0.49, 0.09, 0.12, 0.12), identity: "z" },
      ],
      mask: box(0, 0, 1, 1),
      blockers: [box(0.7, 0.7, 0.3, 0.3)],
      expect: 0.5,
    },
  ],
  exitLatency: [
    {
      name: "fitted outlives the boundary by 4 s; not fitted at the second; still fitted at the end",
      trace: [
        { atMs: 0, display: "fitted" },
        { atMs: 3000, display: "fitted" },
        { atMs: 6000, display: "vision" },
        { atMs: 9000, display: "today" },
        { atMs: 12_000, display: "fitted" },
      ],
      boundaries: [2000, 7000, 12_000],
      expect: [4000, 0, null],
    },
  ],
};

// The probe in the scheduler's "layout" mode: 500 ms pointer cadence, 1000 ms reading, a
// 3000 ms probe, still pictures analyzed 3 times outside the probe.
const SCHED = { intervalMs: 500, confirmFrames: 3, mode: "layout", readingIntervalMs: 1000, probeIntervalMs: 3000 };
const playing = [];
for (let t = 100; t < 3000; t += 100) playing.push({ op: "present" }, { op: "due", now: t, expect: false });
const cadence = [
  {
    name: "playing: one analysis every probe interval, whatever the pointer",
    scheduler: SCHED,
    steps: [
      { op: "present" },
      { op: "state", now: 0, expect: "probe" },
      { op: "due", now: 0, expect: true },
      { op: "start", now: 0 },
      ...playing,
      { op: "pointerMoved", now: 1500 },
      { op: "state", now: 1500, expect: "probe" },
      { op: "present" },
      { op: "due", now: 3000, expect: true },
    ],
  },
  {
    name: "paused: one analysis per picture, no repeats",
    scheduler: SCHED,
    steps: [
      { op: "present" },
      { op: "due", now: 0, expect: true },
      { op: "start", now: 0 },
      { op: "due", now: 250, expect: false },
      { op: "due", now: 3000, expect: false },
      { op: "due", now: 60_000, expect: false },
      { op: "present" },
      { op: "due", now: 60_000, expect: true },
    ],
  },
  {
    name: "with pointer analysis on, a moving pointer runs the fast cadence in the same slot",
    scheduler: SCHED,
    steps: [
      { op: "pointerAnalysis", on: true },
      { op: "present" },
      { op: "due", now: 0, expect: true },
      { op: "start", now: 0 },
      { op: "pointerMoved", now: 400 },
      { op: "state", now: 400, expect: "fast" },
      { op: "present" },
      { op: "due", now: 400, expect: false },
      { op: "due", now: 500, expect: true },
      { op: "hoverDue", now: 500, videoTimeSec: 10, inFlight: false, expect: true },
      { op: "hoverDue", now: 500, videoTimeSec: 10, inFlight: true, expect: false },
    ],
  },
  {
    name: "with pointer analysis off, the pointer asks for nothing",
    scheduler: SCHED,
    steps: [
      { op: "present" },
      { op: "start", now: 0 },
      { op: "pointerMoved", now: 400 },
      { op: "present" },
      { op: "due", now: 500, expect: false },
      { op: "hoverDue", now: 500, videoTimeSec: 10, inFlight: false, expect: false },
      { op: "pointerAnalysis", on: true },
      { op: "due", now: 500, expect: true },
      { op: "pointerAnalysis", on: false },
      { op: "due", now: 500, expect: false },
    ],
  },
  {
    name: "layout mode without a probe interval is refused",
    scheduler: { ...SCHED, probeIntervalMs: null },
    throws: true,
    steps: [],
  },
];

// The recording reader: clocks, the truth of a scene, the causal rule.
const truthRegion = { x: 0.1, y: 0.05, width: 0.8, height: 0.9 };
const fullMask = box(0, 0, 1, 1);
const solve = (atMs, residualPx, region = truthRegion) => ({ atMs, residualPx, region });
const recording = {
  frame: { width: 1920, height: 1080 },
  clocks: [
    { name: "decoded", clock: { status: "ok", streamTimeMs: 1000 }, status: "ok", usable: true },
    { name: "undecodable", clock: { status: "undecodable" }, status: "undecodable", usable: false },
    { name: "missing", clock: { status: "missing" }, status: "missing", usable: false },
    { name: "an unknown status", clock: { status: "garbled", streamTimeMs: 1000 }, status: "missing", usable: false, problem: true },
    { name: "no clock", clock: null, status: "missing", usable: false, problem: true },
    { name: "ok without a finite time", clock: { status: "ok", streamTimeMs: null }, status: "missing", usable: false, problem: true },
  ],
  scenes: [
    { name: "one clean solve", truth: { region: truthRegion, residualPx: 1.2, mask: fullMask, solves: [solve(0, 1.2)] }, usable: true },
    {
      name: "two solves 1 px apart",
      truth: { region: truthRegion, residualPx: 1.2, mask: fullMask, solves: [solve(0, 1.2), solve(60_000, 0.8, { ...truthRegion, x: 0.1 + 1 / 1920 })] },
      usable: true,
    },
    {
      name: "two solves 3 px apart",
      truth: { region: truthRegion, residualPx: 1.2, mask: fullMask, solves: [solve(0, 1.2), solve(60_000, 0.8, { ...truthRegion, x: 0.1 + 3 / 1920 })] },
      usable: false,
    },
    {
      name: "two solves of different scale, 2.7 px apart at a corner fiducial (vertically)",
      // 0.95 × 0.0025 × 1080 = 2.565 px at the lower fiducials; plus nothing at the top ones.
      truth: { region: truthRegion, residualPx: 1.2, mask: fullMask, solves: [solve(0, 1.2), solve(60_000, 0.8, { ...truthRegion, height: 0.9 + 0.0025 })] },
      usable: false,
    },
    {
      name: "a region 1 px from its one solve",
      truth: { region: { ...truthRegion, y: 0.05 + 1 / 1080 }, residualPx: 1.2, mask: fullMask, solves: [solve(0, 1.2)] },
      usable: true,
    },
    {
      name: "a region 3 px from its one solve",
      truth: { region: { ...truthRegion, y: 0.05 + 3 / 1080 }, residualPx: 1.2, mask: fullMask, solves: [solve(0, 1.2)] },
      usable: false,
    },
    {
      name: "a region of another scale than its solves, 2.4 px off at the far fiducials",
      // 0.95 × 0.00125 × 1920 = 2.28 px across at the right-hand fiducials.
      truth: { region: { ...truthRegion, width: 0.8 + 0.00125 }, residualPx: 1.2, mask: fullMask, solves: [solve(0, 1.2), solve(60_000, 1)] },
      usable: false,
    },
    { name: "a solve with no region", truth: { region: truthRegion, residualPx: 1.2, mask: fullMask, solves: [solve(0, 1.2, null)] }, usable: false, problem: true },
    { name: "a solve over 2 px", truth: { region: truthRegion, residualPx: 1.2, mask: fullMask, solves: [solve(0, 2.5)] }, usable: false },
    { name: "a residual over 2 px", truth: { region: truthRegion, residualPx: 2.5, mask: fullMask, solves: [] }, usable: false },
    { name: "no truth", truth: null, usable: false },
    { name: "a residual that is not a number", truth: { region: truthRegion, residualPx: null, mask: fullMask }, usable: false, problem: true },
    { name: "a negative scene: no region, nothing to judge", truth: { region: null, residualPx: null, mask: fullMask }, usable: null },
    { name: "a region that is not one", truth: { region: { x: 0.1, y: 0.05 }, residualPx: 1, mask: fullMask }, usable: false, problem: true },
    {
      name: "keys the reader does not know are ignored",
      truth: { region: truthRegion, residualPx: 1.2, mask: fullMask, solves: [{ ...solve(0, 1.2), rs: { extra: 1 } }], rs: { note: "x" } },
      usable: true,
    },
  ],
  causal: {
    candidates: [
      { key: "k1", producedAtMs: 0, arrivedAtMs: 500 },
      { key: "k2", producedAtMs: 1000, arrivedAtMs: 4000 },
      { key: "k3", producedAtMs: 3000, arrivedAtMs: 3500 },
    ],
    frames: [
      { capturedAtMs: 400, streamTimeMs: 400, offered: [], latest: null, truth: "k1" },
      { capturedAtMs: 3600, streamTimeMs: 2500, offered: ["k1", "k3"], latest: "k3", truth: "k2" },
      { capturedAtMs: 4000, streamTimeMs: 3200, offered: ["k1", "k3", "k2"], latest: "k2", truth: "k3" },
    ],
  },
};

// ---------------------------------------------------------------------------------------------

export function buildLayoutContract() {
  return {
    schema: "layout-contract/1",
    note: "Contract cases of layout registration. Built by scripts/layout-contract.mjs; expected values written by hand.",
    tolerance: 1e-6,
    config: CONFIG,
    layouts: LAYOUTS,
    fits,
    states: STATES,
    events: EVENTS,
    setups: Object.fromEntries(STATES.map((st) => [st, setup(st).steps])),
    intent,
    traces,
    configErrors,
    compat,
    regions: { tolerance: 1e-12, boxes: G5_BOXES, transforms: G5_TRANSFORMS },
    monitor,
    recording,
    metrics,
    cadence,
  };
}

/** JSON with values that fit on one line kept on one line. */
function pretty(value, indent = "") {
  const flat = JSON.stringify(value);
  if (flat === undefined || flat.length + indent.length <= 110 || value === null || typeof value !== "object") return flat;
  const inner = `${indent} `;
  if (Array.isArray(value)) return `[\n${value.map((x) => inner + pretty(x, inner)).join(",\n")}\n${indent}]`;
  const entries = Object.entries(value).filter(([, x]) => x !== undefined);
  return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${pretty(x, inner)}`).join(",\n")}\n${indent}}`;
}

export function layoutContractText() {
  return `${pretty(buildLayoutContract())}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = layoutContractText();
  if (process.argv.includes("--check")) {
    const current = readFileSync(OUT, "utf8");
    if (current !== text) {
      console.error("test/fixtures/layout-contract.json is out of date: run node scripts/layout-contract.mjs");
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
