// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  analysisSize,
  createSignatureSampler,
  CUT_REFERENCE_ADOPT_FRACTION,
  CUT_SIGNATURE_THRESHOLD,
  CutReference,
  type FrameSignature,
  lumaFromRgba,
  MAX_ANALYSIS_WIDTH,
  MIN_ANALYSIS_WIDTH,
  SIGNATURE_WIDTH,
  signatureDistance,
  signatureSize,
} from "../src/capture.js";
import { withinMaxAge } from "../src/frame-scheduler.js";
import { pictureBox } from "../src/session.js";
import { contract } from "./support.js";

const flat = (value: number, width = 8, height = 4): FrameSignature => ({ width, height, luma: new Uint8Array(width * height).fill(value) });
const WHOLE = { x: 0, y: 0, width: 1, height: 1 };

describe("analysisSize", () => {
  it("keeps a width between 720 and 1920 and the picture's aspect ratio", () => {
    expect([MIN_ANALYSIS_WIDTH, MAX_ANALYSIS_WIDTH]).toEqual([720, 1920]);
    expect(analysisSize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(analysisSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(analysisSize(640, 360)).toEqual({ width: 720, height: 405 });
  });

  it("follows a release's own range", () => {
    expect(analysisSize(1280, 720, { min: 320, max: 640 })).toEqual({ width: 640, height: 360 });
  });

  it("agrees with the Python package on the sizes of the contract file", () => {
    const { min, max, cases } = contract.analysisSize;
    for (const item of cases) {
      const size = analysisSize(item.width, item.height, { min, max });
      expect([size.width, size.height], `${item.width}x${item.height}`).toEqual(item.analysis);
    }
  });

  it("rounds a height that falls exactly between two whole numbers upward", () => {
    // 480 x 271 enlarged to 720 wide is 406.5 high. The Python package rounds it upward too
    // (the contract file holds this case and five more).
    expect(analysisSize(480, 271)).toEqual({ width: 720, height: 407 });
  });
});

describe("the signature", () => {
  it("is 128 cells wide with the picture's aspect ratio", () => {
    expect(SIGNATURE_WIDTH).toBe(128);
    expect(signatureSize(1920, 1080)).toEqual({ width: 128, height: 72 });
    expect(signatureSize(0, 0)).toEqual({ width: 128, height: 1 });
  });

  it("brightness is (77 R + 150 G + 29 B) / 256, rounded down, one byte per pixel", () => {
    const rgba = Uint8Array.from([255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    expect(Array.from(lumaFromRgba(rgba, 2, 2))).toEqual([255, 76, 149, 28]);
  });

  it("identical pictures are at distance 0 and a full swing is 1", () => {
    expect(signatureDistance(flat(40), flat(40), WHOLE)).toBe(0);
    expect(signatureDistance(flat(0), flat(255), WHOLE)).toBe(1);
  });

  it("counts only the cells the box touches", () => {
    const live = flat(100);
    live.luma[0] = 200; // the top-left cell alone changed
    expect(signatureDistance(flat(100), live, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 })).toBe(0);
    expect(signatureDistance(flat(100), live, { x: 0, y: 0, width: 0.25, height: 0.5 })).toBeCloseTo(100 / (4 * 255), 12);
  });

  it("a tiny box still covers one cell, and a box off the edge is clamped", () => {
    const live = flat(100);
    live.luma[live.luma.length - 1] = 151;
    expect(signatureDistance(flat(100), live, { x: 0.999, y: 0.999, width: 0.0001, height: 0.0001 })).toBeCloseTo(51 / 255, 12);
    expect(signatureDistance(flat(100), live, { x: 0.9, y: 0.9, width: 5, height: 5 })).toBeCloseTo(51 / 255, 12);
  });

  it("cannot compare thumbnails of two sizes, or an empty box", () => {
    expect(signatureDistance(flat(1, 8, 4), flat(1, 8, 5), WHOLE)).toBeNull();
    expect(signatureDistance(flat(1), flat(1), { x: 0.2, y: 0.2, width: 0, height: 0.5 })).toBeNull();
  });

  it("without a page there is no sampler, and asking for one does not throw", () => {
    expect(createSignatureSampler()).toBeNull();
  });
});

describe("CutReference", () => {
  const step = Math.floor(CUT_SIGNATURE_THRESHOLD * CUT_REFERENCE_ADOPT_FRACTION * 255); // a change that is adopted

  it("the first sample becomes the reference", () => {
    const ref = new CutReference();
    expect(ref.hasReference).toBe(false);
    expect(ref.observe(flat(50), WHOLE)).toEqual({ distance: null, cut: false });
    expect(ref.hasReference).toBe(true);
  });

  it("slow drift that adds up far beyond the threshold is never a cut", () => {
    const ref = new CutReference();
    ref.observe(flat(10), WHOLE);
    for (let v = 10 + step; v <= 250; v += step) expect(ref.observe(flat(v), WHOLE).cut, `at ${v}`).toBe(false);
  });

  it("a single jump above the threshold is a cut", () => {
    const ref = new CutReference();
    ref.observe(flat(100), WHOLE);
    const jump = Math.ceil(CUT_SIGNATURE_THRESHOLD * 255) + 1;
    expect(ref.observe(flat(100 + jump), WHOLE).cut).toBe(true);
  });

  it("a change between the adopt fraction and the threshold holds the reference, so fast change adds up", () => {
    const ref = new CutReference();
    ref.observe(flat(100), WHOLE);
    const held = step + 2; // above the adopt fraction, below the threshold
    expect(ref.observe(flat(100 + held), WHOLE).cut).toBe(false);
    expect(ref.observe(flat(100 + 2 * held), WHOLE).cut).toBe(true); // still measured from 100
  });

  it("a seed is checked once: above the threshold is a cut, anything below is adopted", () => {
    const ref = new CutReference();
    ref.seed(flat(100));
    const held = step + 2;
    expect(ref.observe(flat(100 + held), WHOLE).cut).toBe(false); // adopted although above the fraction
    expect(ref.observe(flat(100 + 2 * held), WHOLE).cut).toBe(false); // measured from the adopted sample
    ref.seed(flat(100));
    expect(ref.observe(flat(200), WHOLE).cut).toBe(true);
  });

  it("another thumbnail size replaces the reference, and reset forgets it", () => {
    const ref = new CutReference();
    ref.observe(flat(100), WHOLE);
    expect(ref.observe(flat(250, 8, 5), WHOLE)).toEqual({ distance: null, cut: false });
    expect(ref.observe(flat(250, 8, 5), WHOLE).distance).toBe(0);
    ref.reset();
    expect(ref.hasReference).toBe(false);
  });
});

describe("where the picture sits in its element", () => {
  const element = { left: 100, top: 50, width: 800, height: 600 };

  it("a video is fitted inside its box, leaving bars", () => {
    expect(pictureBox(element, { width: 1920, height: 1080 }, "contain")).toEqual({ left: 100, top: 125, width: 800, height: 450 });
    expect(pictureBox(element, { width: 600, height: 900 }, "contain")).toEqual({ left: 300, top: 50, width: 400, height: 600 });
  });

  it("an image that fills its box is the box, and a covering one overflows it", () => {
    expect(pictureBox(element, { width: 1920, height: 1080 }, "fill")).toEqual(element);
    const cover = pictureBox(element, { width: 1600, height: 900 }, "cover");
    expect([cover.width, cover.height, cover.top]).toEqual([1600 * (600 / 900), 600, 50]);
    expect(pictureBox(element, { width: 0, height: 0 }, "contain")).toEqual(element);
  });

  it("reads a rectangle whose fields are inherited, as the page's own rectangles are", () => {
    const rect = Object.create({ left: 10, top: 20, width: 300, height: 200 }) as typeof element;
    expect(pictureBox(rect, { width: 600, height: 400 }, "fill")).toEqual({ left: 10, top: 20, width: 300, height: 200 });
  });
});

describe("the age of a shown result", () => {
  it("is measured in video time, both ways, and the limit is inclusive", () => {
    expect([withinMaxAge(10, 12, 2000), withinMaxAge(10, 12.001, 2000), withinMaxAge(10, 8, 2000), withinMaxAge(10, 7.9, 2000)]).toEqual([true, false, true, false]);
  });
});
