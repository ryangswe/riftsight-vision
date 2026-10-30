// SPDX-License-Identifier: Apache-2.0
// Reading the picture back from a <video> or image element, on the page's main thread.
//
// Two readers:
//
//  - `captureFrame`: the analysis tap. It draws the current picture into a canvas at analysis
//    size and makes a transferable ImageBitmap of it for the worker. The draw is synchronous
//    (it happens before the function first awaits), so whatever the caller reads from the
//    element right after calling it, in the same task, belongs to the same picture.
//
//  - the signature sampler: a tiny brightness thumbnail of the whole picture, compared over
//    the box of the card under the pointer, so that a tooltip is cleared when the picture
//    under it is cut to another without a seek, while slow drift does not clear it. It runs on
//    presented frames while a tooltip shows, so it must cost far less than a frame of main
//    thread. A 2D-canvas draw of a video frame converts the whole frame synchronously and
//    takes milliseconds whatever the target size; a WebGL2 texture upload with a mipmapped
//    downscale, read back through a pixel-pack buffer once a fence signals, does not block.
//    So the sampler is WebGL2 and asynchronous: `sample` issues the GPU work and returns a
//    ticket, `read` returns the thumbnail once the GPU is done and never waits. Without
//    WebGL2, or after a lost context, there is no sampler and no cut detection; there is
//    never a slow path.
//
// The pixels stay in the page's memory: a downscaled brightness grid of what the player
// already shows. Nothing is stored or sent.

import type { NormalizedBounds } from "./hover-geometry.js";

/** The detector is run on a frame whose width lies in this range: a narrower picture is
 *  enlarged and a wider one reduced, keeping the aspect ratio. Crops come from that frame, so
 *  a small picture analyzed at its own size would give the recognizer crops too small to
 *  compare. A release document states its own range (`runtime.analysisWidth`). */
export const MAX_ANALYSIS_WIDTH = 1920;
export const MIN_ANALYSIS_WIDTH = 720;

export interface AnalysisWidth {
  min: number;
  max: number;
}

/** The size of the analysis frame for a picture of this size. */
export function analysisSize(
  sourceWidth: number,
  sourceHeight: number,
  range: AnalysisWidth = { min: MIN_ANALYSIS_WIDTH, max: MAX_ANALYSIS_WIDTH },
): { width: number; height: number } {
  const width = Math.max(range.min, Math.min(range.max, sourceWidth));
  // At least one row: a very wide, very short picture still gives a frame that can be drawn.
  return { width, height: Math.max(1, Math.round((width * sourceHeight) / sourceWidth)) };
}

/** A point (viewport coordinates) in fractions of a box, such as the picture's box from
 *  `pictureBox`; null when it is outside the box, or the box is empty. The edges count as inside. */
export function fractionIn(
  box: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!(box.width > 0 && box.height > 0)) return null;
  const x = (clientX - box.left) / box.width;
  const y = (clientY - box.top) / box.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

/** An element a session can read frames from. */
export type FrameSource = HTMLVideoElement | HTMLImageElement;

/** The picture's own size, in pixels (0 x 0 until the element has one). */
export function sourceSize(source: FrameSource): { width: number; height: number } {
  return source instanceof HTMLVideoElement
    ? { width: source.videoWidth, height: source.videoHeight }
    : { width: source.naturalWidth, height: source.naturalHeight };
}

/** The picture's time in the video, in seconds; 0 for an image. */
export function sourceTimeSec(source: FrameSource): number {
  return source instanceof HTMLVideoElement ? source.currentTime : 0;
}

export interface CapturedFrame {
  bitmap: ImageBitmap;
  /** Time of the picture when it was drawn, in seconds. */
  videoTimeSec: number;
  /** What the tap cost the main thread, in ms. */
  tapMs: number;
}

/**
 * Draw the element's current picture into `canvas` at analysis size and make a transferable
 * bitmap of it. Rejects when the picture cannot be read (an element showing a file from
 * another origin without permission); the caller treats that as a source it cannot analyze.
 */
export async function captureFrame(
  source: FrameSource,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  range?: AnalysisWidth,
): Promise<CapturedFrame> {
  const native = sourceSize(source);
  const size = analysisSize(native.width, native.height, range);
  canvas.width = size.width;
  canvas.height = size.height;
  const tapStart = performance.now();
  const videoTimeSec = sourceTimeSec(source);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const bitmap = await createImageBitmap(canvas);
  return { bitmap, videoTimeSec, tapMs: performance.now() - tapStart };
}

// ------------------------------------------------------------------------- signature

/** Width of the signature thumbnail, in cells; its height follows the picture's aspect ratio. */
export const SIGNATURE_WIDTH = 128;

/**
 * Mean absolute brightness difference (as a fraction of full scale) over the hovered box above
 * which the picture under a showing tooltip counts as cut: the tooltip is cleared and the
 * picture looked at again. Within one shot of recorded play the difference stays well under
 * this value, slow camera motion included; across a cut, or when a hand covers the card, it is
 * above it.
 */
export const CUT_SIGNATURE_THRESHOLD = 0.06;

/**
 * A cut is a jump, not drift that adds up. A live sample is compared with a rolling reference:
 * whenever the box's difference from the reference is at most this fraction of
 * `CUT_SIGNATURE_THRESHOLD`, the live sample becomes the reference, so slow change (a handheld
 * camera, auto-exposure) is followed sample by sample and never adds up to a cut. Between the
 * fraction and the threshold the reference holds; above the threshold it is a cut.
 *
 * The analyzed frame's own signature seeds the reference each time a result is shown, so a cut
 * during the time the analysis took is still caught: the first live sample after a seed is
 * checked against it once. Above the threshold it is a cut; otherwise that live sample becomes
 * the reference whatever the difference.
 */
export const CUT_REFERENCE_ADOPT_FRACTION = 0.5;

/** The least time between two live signature samples while a tooltip shows, in ms. */
export const CUT_SAMPLE_MIN_INTERVAL_MS = 60;

/** What one live sample said. */
export interface CutCheck {
  /** The difference from the reference over the box; null when the two cannot be compared (no
   *  reference yet, another thumbnail size, an empty box). */
  distance: number | null;
  cut: boolean;
}

/**
 * The rolling reference for cut detection. `seed` it with the analyzed frame's signature when
 * its result is shown, `observe` each live sample over the hovered box, `reset` it when what
 * is shown is cleared. It holds no timers; the session decides when to sample and what a cut
 * does.
 */
export class CutReference {
  private ref: FrameSignature | null = null;
  /** The reference is a seed that no live sample has been checked against yet. */
  private seeded = false;

  seed(signature: FrameSignature): void {
    this.ref = signature;
    this.seeded = true;
  }

  reset(): void {
    this.ref = null;
    this.seeded = false;
  }

  get hasReference(): boolean {
    return this.ref !== null;
  }

  observe(live: FrameSignature, box: NormalizedBounds): CutCheck {
    const ref = this.ref;
    if (ref === null || ref.width !== live.width || ref.height !== live.height) {
      // Nothing to compare with (the first sample, or a source of another size): this picture
      // becomes the reference.
      this.ref = live;
      this.seeded = false;
      return { distance: null, cut: false };
    }
    const distance = signatureDistance(ref, live, box);
    if (distance === null) return { distance, cut: false };
    if (distance > CUT_SIGNATURE_THRESHOLD) return { distance, cut: true };
    if (this.seeded || distance <= CUT_SIGNATURE_THRESHOLD * CUT_REFERENCE_ADOPT_FRACTION) this.ref = live;
    this.seeded = false;
    return { distance, cut: false };
  }
}

/** A brightness thumbnail of one whole picture: one byte per cell, row-major, top row first. */
export interface FrameSignature {
  width: number;
  height: number;
  luma: Uint8Array;
}

/** The thumbnail size for a picture of this size. */
export function signatureSize(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  return { width: SIGNATURE_WIDTH, height: Math.max(1, Math.round((SIGNATURE_WIDTH * sourceHeight) / Math.max(1, sourceWidth))) };
}

/** Brightness of an RGBA buffer, one byte per pixel: (77 R + 150 G + 29 B) / 256, rounded down. */
export function lumaFromRgba(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) out[i] = (77 * rgba[p]! + 150 * rgba[p + 1]! + 29 * rgba[p + 2]!) >> 8;
  return out;
}

/**
 * How much the picture inside `bounds` (fractions of the frame) changed between two
 * signatures: the mean absolute brightness difference over the cells the box touches, from 0
 * to 1. Null when the two cannot be compared (different thumbnail sizes) or the box is empty.
 */
export function signatureDistance(ref: FrameSignature, live: FrameSignature, bounds: NormalizedBounds): number | null {
  if (ref.width !== live.width || ref.height !== live.height) return null;
  if (!(bounds.width > 0) || !(bounds.height > 0)) return null;
  const { width: w, height: h } = ref;
  const x0 = clamp(Math.floor(bounds.x * w), 0, w - 1);
  const x1 = clamp(Math.ceil((bounds.x + bounds.width) * w), x0 + 1, w);
  const y0 = clamp(Math.floor(bounds.y * h), 0, h - 1);
  const y1 = clamp(Math.ceil((bounds.y + bounds.height) * h), y0 + 1, h);
  let sum = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = y * w + x;
      sum += Math.abs(ref.luma[i]! - live.luma[i]!);
    }
  }
  return sum / ((x1 - x0) * (y1 - y0) * 255);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** A signature sample that was issued and not yet read. */
export interface SignatureTicket {
  readonly id: number;
}

export interface SignatureSampler {
  /** Issue a thumbnail of the element's current picture (GPU work only). Null when the sampler
   *  cannot be used or too many samples are outstanding. */
  sample(source: FrameSource): SignatureTicket | null;
  /** The thumbnail once the GPU has finished it, else null; it never waits. A ticket is read
   *  once: a successful read releases it. */
  read(ticket: SignatureTicket): FrameSignature | null;
  /** Drop a ticket without reading it. */
  release(ticket: SignatureTicket | null): void;
  /** False once the context is lost or a sample threw: no more samples from this sampler. */
  readonly usable: boolean;
  dispose(): void;
}

/** Samples that may be outstanding at once: the analyzed frame's, the live one, one spare. */
const MAX_OUTSTANDING = 3;

const VERTEX_SHADER = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;
const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D frame;
out vec4 color;
void main() {
  color = texture(frame, uv);
}`;

/**
 * The WebGL2 sampler, or null where WebGL2 is not available. Create it only once a tooltip has
 * shown and `dispose` it with the session: a page may hold only a few live WebGL contexts.
 */
export function createSignatureSampler(): SignatureSampler | null {
  try {
    return createWebGl2Sampler();
  } catch {
    return null;
  }
}

function createWebGl2Sampler(): SignatureSampler | null {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "low-power" });
  if (!gl) return null;
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX_SHADER],
    [gl.FRAGMENT_SHADER, FRAGMENT_SHADER],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // Mipmaps: each thumbnail cell averages its whole area of the picture, not four texels.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  interface Slot {
    pbo: WebGLBuffer;
    fence: WebGLSync | null;
    width: number;
    height: number;
    ticket: SignatureTicket | null;
  }
  const slots: Slot[] = [];
  let nextId = 1;
  let usable = true;
  let rgba = new Uint8Array(0);
  canvas.addEventListener("webglcontextlost", () => {
    usable = false;
  });

  function slotOf(ticket: SignatureTicket): Slot | undefined {
    return slots.find((s) => s.ticket === ticket);
  }
  function free(slot: Slot): void {
    if (slot.fence) gl!.deleteSync(slot.fence);
    slot.fence = null;
    slot.ticket = null;
  }

  return {
    get usable() {
      return usable && !gl.isContextLost();
    },
    sample(source) {
      const size = sourceSize(source);
      if (!this.usable || size.width === 0 || size.height === 0) return null;
      let slot = slots.find((s) => s.ticket === null);
      if (!slot) {
        if (slots.length >= MAX_OUTSTANDING) return null;
        const pbo = gl.createBuffer();
        if (!pbo) return null;
        slot = { pbo, fence: null, width: 0, height: 0, ticket: null };
        slots.push(slot);
      }
      const { width, height } = signatureSize(size.width, size.height);
      try {
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        if (slot.width !== width || slot.height !== height) {
          gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
          slot.width = width;
          slot.height = height;
        }
        // The framebuffer is read bottom row first, and the quad maps the picture's top row to
        // the framebuffer's bottom row, so the buffer comes back top row first.
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
      } catch {
        // A picture from another origin without permission cannot be read: no signature.
        usable = false;
        return null;
      }
      if (!slot.fence) return null;
      const ticket = { id: nextId++ };
      slot.ticket = ticket;
      return ticket;
    },
    read(ticket) {
      const slot = slotOf(ticket);
      if (!slot || !slot.fence || !this.usable) return null;
      if (gl.getSyncParameter(slot.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return null;
      const n = slot.width * slot.height * 4;
      if (rgba.length !== n) rgba = new Uint8Array(n);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, rgba);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const signature = { width: slot.width, height: slot.height, luma: lumaFromRgba(rgba, slot.width, slot.height) };
      free(slot);
      return signature;
    },
    release(ticket) {
      if (!ticket) return;
      const slot = slotOf(ticket);
      if (slot) free(slot);
    },
    dispose() {
      usable = false;
      if (gl.isContextLost()) return;
      for (const slot of slots) {
        free(slot);
        gl.deleteBuffer(slot.pbo);
      }
      slots.length = 0;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

/** A rectangle in CSS pixels of the viewport, like `getBoundingClientRect`. */
export interface ClientBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the picture sits inside an element's box, for the element's `object-fit`. A video is
 * fitted inside its box by default, leaving bars; an image fills its box by default.
 */
export function pictureBox(element: ClientBox, picture: { width: number; height: number }, fit: string): ClientBox {
  // Field by field: a DOMRect's fields are not its own properties, so spreading one copies nothing.
  const whole = { left: element.left, top: element.top, width: element.width, height: element.height };
  if (picture.width <= 0 || picture.height <= 0 || fit === "fill") return whole;
  const scaleX = element.width / picture.width;
  const scaleY = element.height / picture.height;
  let scale: number;
  if (fit === "cover") scale = Math.max(scaleX, scaleY);
  else if (fit === "none") scale = 1;
  else if (fit === "scale-down") scale = Math.min(1, scaleX, scaleY);
  else scale = Math.min(scaleX, scaleY);
  const width = picture.width * scale;
  const height = picture.height * scale;
  return { left: element.left + (element.width - width) / 2, top: element.top + (element.height - height) / 2, width, height };
}
