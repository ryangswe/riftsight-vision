// SPDX-License-Identifier: Apache-2.0
// The hit test: which card a pointer is on.
//
// A card is stored as fractions of the frame (see `LayerCard`). To test a pointer against it,
// the card is turned back into a four-corner outline in pixels of the stage it is shown on, and
// the pointer is inside when it lies on the same side of all four edges. Among the cards that
// contain the pointer, the one stacked highest wins.

/** A box as fractions of the frame: 0 is the left or top edge, 1 the right or bottom edge. */
export interface NormalizedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One card of a layer, in fractions of the frame.
 *
 * `bounds` is the card's axis-aligned box. `localWidth` and `localHeight` are the card's own
 * size before any turn, and `rotation` its tilt in degrees, in (-45, 45], positive clockwise on
 * screen. The detector's boxes are axis-aligned, so for them the tilt is 0 and the local size
 * equals the box's size; with rotated outlines a named card takes its outline's (tilt.ts
 * `outlineRect`), and `bounds` stays the box.
 * `cardId` and `name` are set only for a card that is named; a card that was detected and not
 * named carries neither, so nothing can be shown for it by mistake.
 */
export interface LayerCard {
  instanceId: string;
  bounds: NormalizedBounds;
  rotation: number;
  localWidth: number;
  localHeight: number;
  /** Wider than tall. */
  landscape: boolean;
  cardId: string | null;
  name: string | null;
  /** Stack rank: among cards under a pointer the highest wins. */
  zIndex?: number;
  /** For a hover-layer card: the position of its box in the frame's list of boxes. */
  boxIndex?: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Four corners in pixels: top-left, top-right, bottom-right, bottom-left of the card before
 *  its turn, each turned about the card's center. The winding is always the same. */
export interface CardQuad {
  points: [Point, Point, Point, Point];
}

export interface StageSize {
  width: number;
  height: number;
}

export interface NormalizedBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The card's own box before its turn, in fractions of the frame: the center of `bounds` with
 * the card's local size. The axis-aligned box of a turned card is larger than the card, but
 * its center is still the card's center.
 */
export function computeHitboxBox(card: Pick<LayerCard, "bounds" | "localWidth" | "localHeight">): NormalizedBox {
  const localWidth = card.localWidth ?? card.bounds.width;
  const localHeight = card.localHeight ?? card.bounds.height;
  const centerX = card.bounds.x + card.bounds.width / 2;
  const centerY = card.bounds.y + card.bounds.height / 2;
  return {
    left: centerX - localWidth / 2,
    top: centerY - localHeight / 2,
    width: localWidth,
    height: localHeight,
  };
}

/**
 * The card's outline as four corners in pixels of a stage of the given size. The turn is
 * applied in pixels, not in fractions: a stage is not square, so a turn in fractions would
 * skew the angle. Positive degrees turn clockwise on screen (y grows downward).
 */
export function computeCardQuad(card: Pick<LayerCard, "bounds" | "localWidth" | "localHeight" | "rotation">, stageSize: StageSize): CardQuad {
  const box = computeHitboxBox(card);
  const centerX = (box.left + box.width / 2) * stageSize.width;
  const centerY = (box.top + box.height / 2) * stageSize.height;
  const halfWidthPx = (box.width / 2) * stageSize.width;
  const halfHeightPx = (box.height / 2) * stageSize.height;

  const angleRad = (card.rotation * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const localCorners: Point[] = [
    { x: -halfWidthPx, y: -halfHeightPx },
    { x: halfWidthPx, y: -halfHeightPx },
    { x: halfWidthPx, y: halfHeightPx },
    { x: -halfWidthPx, y: halfHeightPx },
  ];
  const points = localCorners.map(({ x, y }) => ({
    x: centerX + x * cos - y * sin,
    y: centerY + x * sin + y * cos,
  })) as [Point, Point, Point, Point];

  return { points };
}

/**
 * Whether a point is inside a convex outline: on the same side of every edge, whichever way
 * the outline winds. A point exactly on an edge is inside.
 */
export function pointInConvexQuad(point: Point, quad: CardQuad): boolean {
  const { points } = quad;
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const toPointX = point.x - a.x;
    const toPointY = point.y - a.y;
    const cross = edgeX * toPointY - edgeY * toPointX;
    if (cross === 0) continue;
    const currentSign = cross > 0 ? 1 : -1;
    if (sign === 0) sign = currentSign;
    else if (currentSign !== sign) return false;
  }
  return true;
}

export interface HoverCandidate<C = LayerCard> {
  card: C;
  quad: CardQuad;
  zIndex: number;
}

/**
 * The card a pointer is on: among the candidates whose outline contains the point, the one
 * with the highest `zIndex`; on equal `zIndex`, the one later in the list. Null when no outline
 * contains the point.
 */
export function resolveHoveredCard<C>(point: Point, candidates: ReadonlyArray<HoverCandidate<C>>): C | null {
  let best: HoverCandidate<C> | null = null;
  for (const candidate of candidates) {
    if (!pointInConvexQuad(point, candidate.quad)) continue;
    if (!best || candidate.zIndex >= best.zIndex) best = candidate;
  }
  return best ? best.card : null;
}
