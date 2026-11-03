// SPDX-License-Identifier: Apache-2.0
// From boxes in analysis-frame pixels to layer cards in fractions of the frame.
//
// A card that carries an identity the catalog knows becomes a named card. Any other card
// (no identity, or an id the catalog does not hold) is emitted without a card id and a name:
// it is a card that was detected and not named, and nothing is shown for it.

import type { AABB, Rect } from "./boxes.js";
import type { LayerCard } from "./hover-geometry.js";

/** One box to place in a layer. */
export interface SceneItem {
  instanceId: string;
  aabb: AABB;
  rect: Rect;
  /** The card's outline (rotated outlines): a named card is placed by it in place of `rect`. */
  outline?: Rect;
  /** The card id to show, or null: detected, not named. */
  identity: string | null;
}

export interface SceneContext {
  frameWidth: number;
  frameHeight: number;
  /** Card id to name, from the release's catalog. */
  names: ReadonlyMap<string, string>;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function toLayerCards(items: readonly SceneItem[], ctx: SceneContext): LayerCard[] {
  const { frameWidth: fw, frameHeight: fh, names } = ctx;
  return items.map((item) => {
    const { aabb } = item;
    const name = item.identity ? names.get(item.identity) : undefined;
    // A named card follows its outline when it has one; every other card keeps its box's rect.
    const rect = name !== undefined && item.outline ? item.outline : item.rect;
    const card: LayerCard = {
      instanceId: item.instanceId,
      bounds: {
        x: clamp01(aabb.x / fw),
        y: clamp01(aabb.y / fh),
        width: clamp01(aabb.width / fw),
        height: clamp01(aabb.height / fh),
      },
      // Fold any angle into (-45, 45]: a card's angle and the ambiguity of which side is its
      // width collapse to one small tilt.
      rotation: ((rect.angle + 45) % 90) - 45,
      localWidth: clamp01(rect.w / fw),
      localHeight: clamp01(rect.h / fh),
      landscape: rect.w > rect.h,
      cardId: null,
      name: null,
    };
    if (item.identity && name !== undefined) {
      card.cardId = item.identity;
      card.name = name;
    }
    return card;
  });
}
