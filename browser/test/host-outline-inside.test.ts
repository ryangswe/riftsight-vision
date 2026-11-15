// SPDX-License-Identifier: Apache-2.0
// S-F3 as a property: a turned outline stays inside the picture for boxes at each edge, because
// the toolkit cuts every box to the frame (clipToFrame) before the turn is worked out
// (outlineFromTilt, which solves rectFromAabb), and the turned rectangle's own bounding box is
// that cut box. This holds by construction only while the picture keeps the frame's aspect (one
// uniform scale, as the cases below draw it); a stretched `object-fit: fill` picture is outside it.
// A seeded generator; nothing here reaches the network.
import { describe, expect, it } from "vitest";

import type { Candidate } from "../src/boxes.js";
import { clipToFrame } from "../src/detector/decode.js";
import { type OutlinePlace, outlinePlace } from "../src/host/outline.js";
import { outlineFromTilt } from "../src/tilt.js";

/** A small seeded generator (mulberry32): the same cases on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corners(p: OutlinePlace): { x: number; y: number }[] {
  const cx = p.left + p.width / 2;
  const cy = p.top + p.height / 2;
  const t = (p.rotation * Math.PI) / 180;
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const x = (sx! * p.width) / 2;
    const y = (sy! * p.height) / 2;
    return { x: cx + x * Math.cos(t) - y * Math.sin(t), y: cy + x * Math.sin(t) + y * Math.cos(t) };
  });
}

type Side = "left" | "right" | "top" | "bottom";
const EDGE_CASES: Side[][] = [["left"], ["right"], ["top"], ["bottom"], ["left", "top"], ["right", "top"], ["left", "bottom"], ["right", "bottom"], []];

describe("a turned outline stays inside the picture (S-F3)", () => {
  it("holds for boxes at each edge and corner, turned by any tilt", () => {
    const next = seeded(20261115);
    let turnedCases = 0;
    let clippedTurned = 0;
    let total = 0;
    for (let n = 0; n < 4000; n++) {
      // An analysis frame, and the picture it is drawn as on screen: the same shape, one scale.
      const frame = { width: 320 + Math.floor(next() * 1600), height: 180 + Math.floor(next() * 900) };
      const scale = 0.3 + next() * 3;
      const picture = { left: -200 + next() * 600, top: -100 + next() * 400, width: frame.width * scale, height: frame.height * scale };
      // A card-shaped box about 4 to 25 % of the frame's height, at a tilt; its bounding box.
      const tilt = (next() * 2 - 1) * 45;
      const cardH = frame.height * (0.04 + next() * 0.21);
      const cardW = cardH * (0.55 + next() * 0.3);
      const t = (Math.abs(tilt) * Math.PI) / 180;
      const aabbW = cardW * Math.cos(t) + cardH * Math.sin(t);
      const aabbH = cardW * Math.sin(t) + cardH * Math.cos(t);
      // Placed so it overhangs the chosen edges by up to 35 % of its size (0 = touching or inside).
      const edges = EDGE_CASES[n % EDGE_CASES.length]!;
      let x = (frame.width - aabbW) * next();
      let y = (frame.height - aabbH) * next();
      for (const side of edges) {
        const over = next() * 0.35;
        if (side === "left") x = -over * aabbW;
        if (side === "right") x = frame.width - aabbW * (1 - over);
        if (side === "top") y = -over * aabbH;
        if (side === "bottom") y = frame.height - aabbH * (1 - over);
      }
      const aabb = { x, y, width: aabbW, height: aabbH };
      const candidate: Candidate = { aabb, rect: { cx: x + aabbW / 2, cy: y + aabbH / 2, w: aabbW, h: aabbH, angle: 0 }, score: 0.9, cls: 0 };

      // What the pipeline hands over: the cut box, then the turn worked out from the cut box.
      const clipped = clipToFrame(candidate, frame).aabb;
      if (!(clipped.width > 0 && clipped.height > 0)) continue;
      const outline = outlineFromTilt(tilt, clipped.width, clipped.height);
      const shown = {
        box: { x: clipped.x / frame.width, y: clipped.y / frame.height, width: clipped.width / frame.width, height: clipped.height / frame.height },
        ...(outline.tilt !== 0 ? { rotation: outline.tilt, localWidth: outline.w / frame.width, localHeight: outline.h / frame.height } : {}),
      };
      // What the host draws.
      const place = outlinePlace(picture, shown);
      if (place === null) continue; // under 4 px a side, or mostly off: nothing drawn
      total++;
      const slack = 0.01 + 1e-9 * Math.max(picture.width, picture.height);
      for (const c of corners(place)) {
        expect(c.x, `case ${n} x`).toBeGreaterThanOrEqual(picture.left - slack);
        expect(c.x, `case ${n} x`).toBeLessThanOrEqual(picture.left + picture.width + slack);
        expect(c.y, `case ${n} y`).toBeGreaterThanOrEqual(picture.top - slack);
        expect(c.y, `case ${n} y`).toBeLessThanOrEqual(picture.top + picture.height + slack);
      }
      if (place.rotation !== 0) {
        turnedCases++;
        if (edges.length > 0 && (clipped.width < aabbW - 1e-6 || clipped.height < aabbH - 1e-6)) clippedTurned++;
      }
    }
    // The property is not vacuous: many outlines were turned, and many of them were cut first.
    expect(total).toBeGreaterThan(2000);
    expect(turnedCases).toBeGreaterThan(500);
    expect(clippedTurned).toBeGreaterThan(100);
  });
});
