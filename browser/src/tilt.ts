// SPDX-License-Identifier: Apache-2.0
// The tilted retry: a second chance for a face crop that is not accepted because its card is
// tilted. In Python: cardvision/recognize/tilt.py, which explains the method.
//
// 1. The tilt: the crop shrunk to at most 128 px a side, grey, 3 x 3 Sobel gradients; in the
//    outer band the strongest quarter vote for their direction modulo 90 degrees, weighted by
//    magnitude; the smoothed peak, refined by a parabola, folded to (-45, 45].
// 2. The rectangles: the card's sides solved from the box and the tilt (or the card-aspect
//    prior), sampled from the frame bilinearly at each scale, black outside it.
// 3. Each rectangle gets one look, the crop's chosen look, and the accept rule decides.
//
// The arithmetic follows the Python reference to the bit: the shrunk copy, the grey values, the
// gradients, their magnitudes, the vote threshold (NumPy's float32 quantile) and the angles are
// rounded to 32-bit floats after every operation, as NumPy computes them; each direction is the
// 64-bit arctangent rounded to 32 bits, on both sides; the votes, the smoothing and the sampler are
// 64-bit.

const f32 = Math.fround;

/** Short side over long side of the card the prior assumes; the same for every game, used only
 *  when the exact solve is not. */
export const CARD_ASPECT = 63 / 88;
export const TILT_MAX_SIDE = 128;
export const TILT_BINS = 90;
export const TILT_BORDER = 0.2;
export const TILT_MIN_SIDE = 8;
const EXACT_MIN_DEN = 0.35;
const EXACT_ASPECT_MIN = 0.55;
const EXACT_ASPECT_MAX = 0.9;

/** The settings of a release's `tiltedRetry` block (Python: `TiltedRetry`). */
export interface TiltedRetrySettings {
  /** Sizes of the rectangles relative to the solved card, in the order they are tried. */
  scales: number[];
  /** At most this many faces of one frame are retried: faces under the focus point first. */
  maxFacesPerFrame: number;
  /** The retry is turned off for the session when it takes more than this of a frame on two
   *  frames in a row. */
  budgetMs: number;
}

export const DEFAULT_TILTED_RETRY: Readonly<TiltedRetrySettings> = Object.freeze({ scales: [0.95, 1.0, 1.05], maxFacesPerFrame: 8, budgetMs: 1500 });

/** The Gaussian weights of the circular smoothing (sigma 2 bins, radius 6), j = 0..6, as NumPy's
 *  `exp` gives them; the kernel is symmetric. */
const SMOOTH = [1.0, 0.8824969025845955, 0.6065306597126334, 0.32465246735834974, 0.1353352832366127, 0.04393693362340742, 0.011108996538242306];
const SMOOTH_RADIUS = 6;
/** NumPy's float32 degrees: the value times 180/pi, the constant computed in float32. */
const RAD_TO_DEG_F32 = f32(f32(180) / f32(Math.PI));
const GREY = [f32(0.299), f32(0.587), f32(0.114)] as const;

/** An angle in degrees folded to (-45, 45] modulo 90. */
export function fold(degrees: number): number {
  const folded = degrees - 90.0 * Math.ceil((degrees - 45.0) / 90.0);
  return folded <= -45.0 ? 45.0 : folded;
}

/** Python's `%` for floats: the result has the divisor's sign. */
function pyMod(a: number, b: number): number {
  const r = a % b;
  return r !== 0 && r < 0 !== b < 0 ? r + b : r;
}

/** NumPy's float32 remainder by a positive divisor. */
function remainderF32(a: number, b: number): number {
  const r = a % b; // exact for floats
  if (r === 0) return 0;
  return r < 0 ? f32(r + b) : r;
}

/** Python's `round` to a whole number: halves go to the even neighbor. */
export function roundHalfEven(value: number): number {
  const down = Math.floor(value);
  const diff = value - down;
  if (diff < 0.5) return down;
  if (diff > 0.5) return down + 1;
  return down % 2 === 0 ? down : down + 1;
}

/** NumPy's `quantile` (linear method) of float32 values at a float32 `q`, in float32. */
function quantileF32(values: Float32Array, q: number): number {
  const n = values.length;
  const sorted = Float32Array.from(values).sort();
  const qq = f32(q);
  const vi = f32(f32(f32(n * qq) + f32(1 + f32(qq * -1))) - 1);
  let lo: number;
  let hi: number;
  if (vi >= n - 1) lo = hi = n - 1;
  else if (vi < 0) lo = hi = 0;
  else {
    lo = Math.floor(vi);
    hi = lo + 1;
  }
  const gamma = lo === hi ? 0 : f32(vi - lo);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  const diff = f32(b - a);
  if (gamma >= 0.5) return f32(b - f32(diff * f32(1 - gamma)));
  return f32(a + f32(diff * gamma));
}

/** An RGB or RGBA picture, row by row. */
export interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /** Values per pixel: 4 for RGBA (the default), 3 for RGB. */
  channels?: 3 | 4;
}

/**
 * The in-plane tilt, in degrees in (-45, 45], of the card in a crop (Python: `estimate_tilt`).
 * The crop is the shipped crop of a detector box. One under 8 px a side once shrunk, or with no
 * edges, gives 0. Image coordinates, y down.
 */
export function estimateTilt(crop: Pixels): number {
  const { width, height } = crop;
  const ch = crop.channels ?? 4;
  const k = Math.max(1, Math.ceil(Math.max(height, width) / TILT_MAX_SIDE));
  const h2 = k === 1 ? height : Math.floor(height / k);
  const w2 = k === 1 ? width : Math.floor(width / k);
  if (Math.min(h2, w2) < TILT_MIN_SIDE) return 0;
  // Shrink (whole-block means; the integer sums are exact in float32) and turn grey.
  const grey = new Float32Array(h2 * w2);
  const area = k * k;
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const rgb = [0, 0, 0];
      for (let dy = 0; dy < k; dy++) {
        let at = ((y * k + dy) * width + x * k) * ch;
        for (let dx = 0; dx < k; dx++, at += ch) {
          rgb[0]! += crop.data[at]!;
          rgb[1]! += crop.data[at + 1]!;
          rgb[2]! += crop.data[at + 2]!;
        }
      }
      const r = k === 1 ? rgb[0]! : f32(rgb[0]! / area);
      const g = k === 1 ? rgb[1]! : f32(rgb[1]! / area);
      const b = k === 1 ? rgb[2]! : f32(rgb[2]! / area);
      grey[y * w2 + x] = f32(f32(f32(r * GREY[0]) + f32(g * GREY[1])) + f32(b * GREY[2]));
    }
  }
  // Sobel with the edges repeated outward, then the outermost ring dropped.
  const at = (y: number, x: number): number => grey[Math.min(h2 - 1, Math.max(0, y)) * w2 + Math.min(w2 - 1, Math.max(0, x))]!;
  const hh = h2 - 2;
  const ww = w2 - 2;
  const count = hh * ww;
  const gx = new Float32Array(count);
  const gy = new Float32Array(count);
  const band = new Uint8Array(count);
  const magnitude = new Float32Array(count);
  let bandCount = 0;
  let maxMagnitude = 0;
  for (let i = 0; i < hh; i++) {
    for (let j = 0; j < ww; j++) {
      const y = i + 1;
      const x = j + 1;
      const right = f32(f32(at(y - 1, x + 1) + f32(2 * at(y, x + 1))) + at(y + 1, x + 1));
      const left = f32(f32(at(y - 1, x - 1) + f32(2 * at(y, x - 1))) + at(y + 1, x - 1));
      const down = f32(f32(at(y + 1, x - 1) + f32(2 * at(y + 1, x))) + at(y + 1, x + 1));
      const up = f32(f32(at(y - 1, x - 1) + f32(2 * at(y - 1, x))) + at(y - 1, x + 1));
      const p = i * ww + j;
      gx[p] = f32(right - left);
      gy[p] = f32(down - up);
      const distance = Math.min(Math.min(j, ww - 1 - j) / ww, Math.min(i, hh - 1 - i) / hh);
      if (distance <= TILT_BORDER) {
        band[p] = 1;
        bandCount++;
        magnitude[p] = f32(Math.hypot(gx[p]!, gy[p]!));
        if (magnitude[p]! > maxMagnitude) maxMagnitude = magnitude[p]!;
      }
    }
  }
  if (maxMagnitude <= 0) return 0;
  const inBand = new Float32Array(bandCount);
  for (let p = 0, q = 0; p < count; p++) if (band[p]) inBand[q++] = magnitude[p]!;
  const threshold = quantileF32(inBand, 0.75);
  // The votes, in the order NumPy's bincount adds them.
  const votes = new Float64Array(TILT_BINS);
  for (let p = 0; p < count; p++) {
    const m = magnitude[p]!;
    if (!band[p] || !(m >= threshold) || !(m > 0)) continue;
    const angle = remainderF32(f32(f32(Math.atan2(gy[p]!, gx[p]!)) * RAD_TO_DEG_F32), 90);
    const bin = Math.min(Math.trunc(f32(f32(angle / 90) * TILT_BINS)), TILT_BINS - 1);
    votes[bin] = votes[bin]! + m;
  }
  const smoothed = new Float64Array(TILT_BINS);
  for (let i = 0; i < TILT_BINS; i++) {
    let sum = 0;
    for (let j = -SMOOTH_RADIUS; j <= SMOOTH_RADIUS; j++) sum += SMOOTH[Math.abs(j)]! * votes[(((i - j) % TILT_BINS) + TILT_BINS) % TILT_BINS]!;
    smoothed[i] = sum;
  }
  let best = 0;
  for (let i = 1; i < TILT_BINS; i++) if (smoothed[i]! > smoothed[best]!) best = i;
  const left = smoothed[(best - 1 + TILT_BINS) % TILT_BINS]!;
  const right = smoothed[(best + 1) % TILT_BINS]!;
  const den = left - 2 * smoothed[best]! + right;
  const shift = den !== 0 ? (0.5 * (left - right)) / den : 0;
  const peak = pyMod(((best + 0.5 + shift) * 90.0) / TILT_BINS, 90.0);
  return fold(peak);
}

/** How `rectFromAabb` found the sides. */
export type RectHow = "exact" | "prior";

/**
 * The sides `[w, h]` of a card turned by `tilt` degrees whose bounding box is `width` x `height`
 * (Python: `rect_from_aabb`). `w` runs along the tilted top edge. The exact solve is used while
 * it is well posed and card-shaped; otherwise the card-aspect prior, portrait or landscape,
 * whichever fits better, scaled by least squares.
 */
export function rectFromAabb(width: number, height: number, tilt: number): { w: number; h: number; how: RectHow } {
  const t = Math.abs(tilt) * (Math.PI / 180);
  const c = Math.cos(t);
  const s = Math.sin(t);
  const den = c * c - s * s;
  if (den > EXACT_MIN_DEN) {
    const w = (width * c - height * s) / den;
    const h = (height * c - width * s) / den;
    if (w > 0 && h > 0) {
      const aspect = Math.min(w, h) / Math.max(w, h);
      if (aspect >= EXACT_ASPECT_MIN && aspect <= EXACT_ASPECT_MAX) return { w, h, how: "exact" };
    }
  }
  let best: { residual: number; w: number; h: number } | null = null;
  for (const ratio of [CARD_ASPECT, 1.0 / CARD_ASPECT]) {
    const bw = ratio * c + s;
    const bh = ratio * s + c;
    const k = (width * bw + height * bh) / (bw * bw + bh * bh);
    const residual = (width - k * bw) ** 2 + (height - k * bh) ** 2;
    if (best === null || residual < best.residual) best = { residual, w: ratio * k, h: k };
  }
  return { w: best!.w, h: best!.h, how: "prior" };
}

/**
 * The rectangle of `frame` centered on `(cx, cy)`, `width` x `height`, turned by `tilt` degrees,
 * as RGBA (Python: `sample_rect`). Sides are rounded half to even, at least 2 px. Bilinear,
 * pixel centers at integer + 0.5, black outside the frame, rounded half up.
 */
export function sampleRect(frame: Pixels, cx: number, cy: number, width: number, height: number, tilt: number): { rgba: Uint8ClampedArray; width: number; height: number } {
  const ow = Math.max(2, roundHalfEven(width));
  const oh = Math.max(2, roundHalfEven(height));
  const a = tilt * (Math.PI / 180);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const fw = frame.width;
  const fh = frame.height;
  const ch = frame.channels ?? 4;
  const src = frame.data;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const value = (y: number, x: number, k: number): number => (y >= 0 && y < fh && x >= 0 && x < fw ? src[(y * fw + x) * ch + k]! : 0);
  for (let i = 0; i < oh; i++) {
    const v = i + 0.5 - oh / 2;
    for (let j = 0; j < ow; j++) {
      const u = j + 0.5 - ow / 2;
      const x = cx + u * c - v * s - 0.5;
      const y = cy + u * s + v * c - 0.5;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const o = (i * ow + j) * 4;
      for (let k = 0; k < 3; k++) {
        const sum =
          value(y0, x0, k) * (1 - fx) * (1 - fy) + value(y0, x0 + 1, k) * fx * (1 - fy) + value(y0 + 1, x0, k) * (1 - fx) * fy + value(y0 + 1, x0 + 1, k) * fx * fy;
        out[o + k] = Math.min(255, Math.max(0, Math.floor(sum + 0.5)));
      }
      out[o + 3] = 255;
    }
  }
  return { rgba: out, width: ow, height: oh };
}

/**
 * The tilt of the card in `box` and its straightened rectangles at `scales`, in that order
 * (Python: `tilted_rects`). `box` is the detector box in `frame`'s pixels, unrounded; `crop`
 * the shipped crop it gave.
 */
export function tiltedRects(
  frame: Pixels,
  box: { x: number; y: number; width: number; height: number },
  crop: Pixels,
  scales: readonly number[],
): { tilt: number; rects: Array<{ rgba: Uint8ClampedArray; width: number; height: number }> } {
  const tilt = estimateTilt(crop);
  const { w, h } = rectFromAabb(box.width, box.height, tilt);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return { tilt, rects: scales.map((scale) => sampleRect(frame, cx, cy, w * scale, h * scale, tilt)) };
}

/** Every reason `raw` is not a valid `tiltedRetry` block, or null when it is (Python:
 *  `tilted_retry_errors`). */
export function tiltedRetryError(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "tiltedRetry must be an object";
  const block = raw as Record<string, unknown>;
  const unknown = Object.keys(block).filter((key) => !["scales", "maxFacesPerFrame", "budgetMs"].includes(key));
  if (unknown.length > 0) return `tiltedRetry has unknown key(s) ${unknown.sort().join(", ")}`;
  const scales = block.scales;
  if (!Array.isArray(scales) || scales.length < 1 || scales.length > 5 || !scales.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0.5 && v <= 1.5)) {
    return "tiltedRetry.scales must list 1 to 5 numbers from 0.5 to 1.5";
  }
  const whole = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 1;
  if (!whole(block.maxFacesPerFrame)) return "tiltedRetry.maxFacesPerFrame must be a whole number above 0";
  if (!whole(block.budgetMs)) return "tiltedRetry.budgetMs must be a whole number above 0";
  return null;
}
