// SPDX-License-Identifier: Apache-2.0
// The hover rule: what a pointer resting at one position of a frame would show.
// In Python: cardvision/evaluate/hover.py.
//
// A tooltip shows what one fresh look at the current frame says, not what a track remembers.
// Each analyzed frame therefore yields a hover layer built from that frame's own proposals,
// with no history. The rule has three parts.
//
// Which boxes take part, and how they stack. A release names one of three selections:
//  - "accepted-nms": the proposals that reach tau, after suppression that ignores identity
//    (`ScoredFrame.kept`). Among them the smallest box is on top (on equal area the higher
//    score, then the earlier proposal).
//  - "best-score": every proposal; the higher score is on top (then the smaller box, then the
//    earlier proposal).
//  - "detector-score": every proposal; the higher detector score is on top (then the earlier
//    proposal).
//
// Which box the pointer hits. The topmost box that contains the point (hover-geometry.ts).
//
// What is shown. The hit box's card, if its look is accepted (tau and the margin); otherwise
// nothing. A box that takes part but fails the margin still wins the pointer and shows
// nothing: it hides whatever lies beneath it.
//
// Card backs are never proposals: the detector reports them and nothing is shown for them.

import { type AABB, iou, type Rect } from "./boxes.js";
import { computeCardQuad, type HoverCandidate, type LayerCard, resolveHoveredCard, type StageSize } from "./hover-geometry.js";
import type { ScoredFrame, ScoredProposal } from "./recognition.js";
import { type SceneContext, toLayerCards } from "./scene.js";

export type HoverSelection = "accepted-nms" | "best-score" | "detector-score";

export const HOVER_SELECTIONS: readonly HoverSelection[] = ["accepted-nms", "best-score", "detector-score"];

export function isHoverSelection(v: unknown): v is HoverSelection {
  return typeof v === "string" && (HOVER_SELECTIONS as readonly string[]).includes(v);
}

/** The selection a release is built with unless it names another. */
export const DEFAULT_HOVER_SELECTION: HoverSelection = "accepted-nms";

/** A hover-layer card keeps its id from one frame to the next when a card of the same identity
 *  overlaps its previous box by at least this much. */
export const HOVER_ID_IOU = 0.5;

/** Prefix of hover-layer ids. Track ids use another, so the two never collide. */
export const HOVER_ID_PREFIX = "hover_";

/** One box of the hover layer before it becomes a layer card. */
export interface HoverEntry {
  /** Index of the proposal in `ScoredFrame.proposals`. */
  proposal: number;
  aabb: AABB;
  rect: Rect;
  /** The card's outline when rotated outlines are on (`ScoredProposal.outline`). */
  outline?: Rect;
  /** The card id to show, or null: the box takes part and shows nothing. */
  identity: string | null;
  /** The proposal's score. */
  score: number;
  /** Stack rank, 1 at the bottom. The winner under a pointer is the highest rank containing it. */
  zIndex: number;
}

type HoverFrame = Pick<ScoredFrame, "kept"> & {
  proposals: ReadonlyArray<Pick<ScoredProposal, "aabb" | "rect" | "score" | "detectorScore" | "accepted" | "displayId" | "outline">>;
};

function area(b: AABB): number {
  return b.width * b.height;
}

/**
 * The selection's members as indices into `frame.proposals`, bottom of the stack first (entry
 * k of `selectHoverLayer` has stack rank k + 1).
 */
export function hoverOrder(frame: HoverFrame, selection: HoverSelection): number[] {
  const members = selection === "accepted-nms" ? frame.kept : frame.proposals.map((_, i) => i);
  // below(a, b) < 0 means a is stacked below b. Equal on every key: the earlier proposal is on top.
  const below = (a: number, b: number): number => {
    const pa = frame.proposals[a]!;
    const pb = frame.proposals[b]!;
    if (selection === "detector-score") {
      if (pa.detectorScore !== pb.detectorScore) return pa.detectorScore < pb.detectorScore ? -1 : 1;
      return b - a;
    }
    const byArea = area(pb.aabb) - area(pa.aabb); // the larger box is below
    const byScore = pa.score - pb.score; // the lower score is below
    const primary = selection === "accepted-nms" ? byArea : byScore;
    const secondary = selection === "accepted-nms" ? byScore : byArea;
    if (primary !== 0) return primary;
    if (secondary !== 0) return secondary;
    return b - a;
  };
  return [...members].sort(below);
}

/** The hover layer of one frame's proposals, in stacking order (bottom first). */
export function selectHoverLayer(frame: HoverFrame, selection: HoverSelection = DEFAULT_HOVER_SELECTION): HoverEntry[] {
  return hoverOrder(frame, selection).map((i, rank) => {
    const p = frame.proposals[i]!;
    return {
      proposal: i,
      aabb: p.aabb,
      rect: p.rect,
      ...(p.outline ? { outline: p.outline } : {}),
      identity: p.accepted ? p.displayId : null,
      score: p.score,
      zIndex: rank + 1,
    };
  });
}

/**
 * Ids for hover-layer cards that stay the same from one frame to the next, so that whatever
 * draws a tooltip need not rebuild it on every analysis: an entry takes the id of the previous
 * frame's entry with the same identity (null matches null) and the highest overlap of at least
 * `HOVER_ID_IOU`; otherwise it gets a new id. Ids keep counting across `reset`.
 */
export class HoverIdAssigner {
  private prev: Array<{ id: string; aabb: AABB; identity: string | null }> = [];
  private nextId = 1;

  reset(): void {
    this.prev = [];
  }

  assign(entries: readonly HoverEntry[]): string[] {
    const used = new Set<number>();
    // The entries stacked highest choose first: they are the ones a pointer resolves to.
    const order = entries.map((_, i) => i).sort((a, b) => entries[b]!.zIndex - entries[a]!.zIndex);
    const ids: string[] = new Array<string>(entries.length);
    for (const i of order) {
      const e = entries[i]!;
      let best = -1;
      let bestIou = HOVER_ID_IOU;
      for (let j = 0; j < this.prev.length; j++) {
        if (used.has(j) || this.prev[j]!.identity !== e.identity) continue;
        const v = iou(e.aabb, this.prev[j]!.aabb);
        if (v >= bestIou && (best < 0 || v > bestIou)) {
          best = j;
          bestIou = v;
        }
      }
      if (best >= 0) {
        used.add(best);
        ids[i] = this.prev[best]!.id;
      } else {
        ids[i] = `${HOVER_ID_PREFIX}${String(this.nextId++).padStart(4, "0")}`;
      }
    }
    this.prev = entries.map((e, i) => ({ id: ids[i]!, aabb: e.aabb, identity: e.identity }));
    return ids;
  }
}

/**
 * Hover entries as layer cards, each carrying its stack rank and the position of its box.
 * `boxIndexOf` turns a proposal's index into the position of its box in the list the caller
 * reports; without it the proposal's index is used.
 */
export function hoverEntriesToCards(
  entries: readonly HoverEntry[],
  ids: readonly string[],
  ctx: SceneContext,
  boxIndexOf: (proposal: number) => number = (proposal) => proposal,
): LayerCard[] {
  const cards = toLayerCards(
    entries.map((e, i) => ({ instanceId: ids[i]!, aabb: e.aabb, rect: e.rect, ...(e.outline ? { outline: e.outline } : {}), identity: e.identity })),
    ctx,
  );
  return cards.map((card, i) => ({ ...card, zIndex: entries[i]!.zIndex, boxIndex: boxIndexOf(entries[i]!.proposal) }));
}

/** What a pointer resolves to. */
export interface HoverOutcome {
  /** The card the pointer is on, or null when it is on none. */
  card: LayerCard | null;
  /** The position of that card's box in the frame's list of boxes. */
  boxIndex: number | null;
  /** That card's box in pixels of the analyzed frame. */
  box: AABB | null;
  /** The card id shown, or null when nothing is shown (no card, or one that is not accepted). */
  cardId: string | null;
  /** The name shown. */
  name: string | null;
}

export const NOTHING_HIT: HoverOutcome = { card: null, boxIndex: null, box: null, cardId: null, name: null };

/**
 * Resolve a pointer against a hover layer. `cards` are the layer's cards (each with its stack
 * rank), `point` is in pixels of a stage of size `stage` that the frame fills exactly.
 */
export function resolveHover(cards: readonly LayerCard[], point: { x: number; y: number }, stage: StageSize): HoverOutcome {
  const candidates: Array<HoverCandidate<LayerCard>> = cards.map((card) => ({
    card,
    quad: computeCardQuad(card, stage),
    zIndex: card.zIndex ?? 0,
  }));
  const hit = resolveHoveredCard(point, candidates);
  if (!hit) return NOTHING_HIT;
  return {
    card: hit,
    boxIndex: hit.boxIndex ?? null,
    box: {
      x: hit.bounds.x * stage.width,
      y: hit.bounds.y * stage.height,
      width: hit.bounds.width * stage.width,
      height: hit.bounds.height * stage.height,
    },
    cardId: hit.cardId,
    name: hit.name,
  };
}
