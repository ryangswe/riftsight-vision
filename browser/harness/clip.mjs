// SPDX-License-Identifier: Apache-2.0
// The browser checks' clip: the product module's cards at their places over a noisy table, rendered
// by ffmpeg as VP8 in WebM (Chrome for Testing plays no H.264). The hover browser test and the
// rollback check both render it from here, so a place's times mean the same in both.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { SLOTS } from "./product-shape.mjs";

/** The card's box in the clip, in clip pixels (the picture is scaled to it). */
export function cardBox(product, slot) {
  const p = product.places[slot];
  return { x: p.x, y: p.y, w: product.cardWidth, h: Math.round(product.cardWidth * product.cardAspect) };
}

/** ffmpeg's `enable` for a place: shown from `from` (which wins over `until`), else until `until`,
 *  and again from `back` (a card that leaves and comes back with no seek). A place with none is
 *  shown the whole clip. */
export function enableOf(place) {
  if (place.from !== undefined) return `:enable='gte(t,${place.from})'`;
  if (place.back !== undefined) return `:enable='lt(t,${place.until})+gte(t,${place.back})'`;
  if (place.until !== undefined) return `:enable='lt(t,${place.until})'`;
  return "";
}

/** The ffmpeg arguments for the clip, in a fixed slot order: a later slot is drawn over an earlier
 *  one (D over A). `files` maps each slot to its picture file. */
export function clipArgs(product, files, out) {
  const { clip } = product;
  const inputs = SLOTS.flatMap((s) => ["-loop", "1", "-i", files[s]]);
  const scaled = SLOTS.map((s, i) => `[${i + 1}]scale=${cardBox(product, s).w}:${cardBox(product, s).h}[${s}]`);
  let last = "bg";
  const layered = SLOTS.map((s, i) => {
    const p = product.places[s];
    const next = i === SLOTS.length - 1 ? "v" : `l${i}`;
    const step = `[${last}][${s}]overlay=${p.x}:${p.y}${enableOf(p)}:shortest=1[${next}]`;
    last = next;
    return step;
  });
  const graph = [`[0]noise=alls=10:allf=t[bg]`, ...scaled, ...layered].join(";");
  return ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x1d4a2e:s=${clip.width}x${clip.height}:r=${clip.fps}:d=${clip.seconds}`, ...inputs,
    // libvpx's real-time setting: about 8 times faster than its default here, for the same quality
    // where the cards are (PSNR 36.2 against 36.4 dB, on the toy clip against a lossless render).
    "-filter_complex", graph, "-map", "[v]", "-t", String(clip.seconds), "-c:v", "libvpx", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8", "-an", out];
}

/** Render the clip into `dir`; returns its path. */
export function renderClip(product, files, dir) {
  const out = join(dir, "clip.webm");
  execFileSync("ffmpeg", clipArgs(product, files, out));
  return out;
}
