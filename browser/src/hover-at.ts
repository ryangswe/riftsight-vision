// SPDX-License-Identifier: Apache-2.0
// What a pointer shows for an analyzed frame. A leaf module: it imports types and the hover
// layer's pure functions only, so a bundle that includes it carries no ONNX Runtime.

import type { FrameAnalysis } from "./pipeline.js";
import type { LayerCard } from "./hover-geometry.js";
import { hoverEntriesToCards, type HoverOutcome, type HoverSelection, resolveHover, selectHoverLayer } from "./hover-layer.js";

/**
 * The hover layer of an analyzed frame under any of the three selections, rebuilt from the
 * frame's boxes. Under the selection the frame was analyzed with, it stacks exactly as
 * `analysis.hover.cards` does; the cards' ids are positions in the stack, not the stable ids
 * of `analysis.hover.cards`.
 */
export function hoverCardsOf(analysis: FrameAnalysis, selection: HoverSelection = analysis.hover.selection): LayerCard[] {
  const boxIndexOfFace = analysis.boxes.flatMap((b, i) => (b.face !== null ? [i] : []));
  const faces = boxIndexOfFace.map((i) => analysis.boxes[i]!);
  const names = new Map<string, string>();
  const proposals = faces.map((b) => {
    const f = b.face!;
    if (f.cardId !== null && f.name !== null) names.set(f.cardId, f.name);
    const aabb = { x: b.box[0], y: b.box[1], width: b.box[2], height: b.box[3] };
    return {
      aabb,
      rect: { cx: aabb.x + aabb.width / 2, cy: aabb.y + aabb.height / 2, w: aabb.width, h: aabb.height, angle: 0 },
      score: f.similarity,
      detectorScore: b.score,
      accepted: f.cardId !== null,
      displayId: f.cardId ?? f.topId,
    };
  });
  const kept = faces.flatMap((b, i) => (b.face!.kept ? [i] : []));
  const entries = selectHoverLayer({ proposals, kept }, selection);
  return hoverEntriesToCards(
    entries,
    entries.map((_, k) => `${selection}_${k}`),
    { frameWidth: analysis.frame.width, frameHeight: analysis.frame.height, names },
    (i) => boxIndexOfFace[i]!,
  );
}

/**
 * What a pointer at `(x, y)`, in pixels of the analyzed frame, would show for an analyzed
 * frame: the card it is on, and that card's id and name if its look was accepted. `selection`
 * defaults to the one the frame was analyzed with.
 */
export function hoverAt(analysis: FrameAnalysis, x: number, y: number, selection?: HoverSelection): HoverOutcome {
  const cards = selection === undefined || selection === analysis.hover.selection ? analysis.hover.cards : hoverCardsOf(analysis, selection);
  return resolveHover(cards, { x, y }, analysis.frame);
}
