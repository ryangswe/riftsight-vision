// SPDX-License-Identifier: Apache-2.0
// The fixture's view adapter: a small one. The view frame measures itself for each card and says
// so; the adapter then places the frame beside the card and reports that it is ready to show.

import type { ShownCard, ViewAdapter, ViewFrame, ViewLayout } from "@cardvision/host-content";

import { parseFromView, VIEW_TAG } from "./messages.js";

/** The size the frame has until it has measured a card, and the gap between card and frame. */
const FIRST_SIZE = { width: 180, height: 250 };
const GAP = 12;
const CORNER_RADIUS = 8;

export function createAdapter(): ViewAdapter {
  let frame: ViewFrame | null = null;
  let ready = false;
  /** The card the frame was told about last, and the size it measured for it. */
  let told: { cardId: string; seq: number } | null = null;
  let sized: { cardId: string; seq: number; width: number; height: number } | null = null;
  let seq = 0;

  return {
    look: { title: "Toy card", shadow: "0 4px 16px rgba(0, 0, 0, 0.45)" },

    attach(next) {
      // A new frame: nothing of the last one is known any more.
      frame = next;
      ready = false;
      told = null;
      sized = null;
      // The host sets no size of its own: the first one is the adapter's.
      next.place({ left: 0, top: 0, ...FIRST_SIZE, cornerRadius: CORNER_RADIUS });
    },

    detach() {
      frame = null;
      ready = false;
      told = null;
      sized = null;
    },

    message(data) {
      const message = parseFromView(data);
      if (!message) return false;
      if (message.kind === "ready") {
        const changed = !ready;
        ready = true;
        return changed;
      }
      // A size for a card other than the one told last is stale.
      if (!told || message.cardId !== told.cardId || message.seq !== told.seq) return false;
      const changed = !sized || sized.width !== message.width || sized.height !== message.height || sized.seq !== message.seq;
      sized = { cardId: message.cardId, seq: message.seq, width: message.width, height: message.height };
      return changed;
    },

    show(card: ShownCard, layout: ViewLayout) {
      if (!frame || !ready) return false;
      if (!told || told.cardId !== card.cardId) {
        seq += 1;
        told = { cardId: card.cardId, seq };
        sized = null;
        if (!frame.post({ tag: VIEW_TAG, kind: "card", cardId: card.cardId, name: card.name, seq })) {
          told = null;
          return false;
        }
      }
      if (!sized || sized.cardId !== card.cardId || sized.seq !== told.seq) return false;
      const { width, height } = sized;
      const { card: box, viewport, minTop } = layout;
      const right = box.left + box.width + GAP;
      const left = right + width <= viewport.width ? right : Math.max(0, box.left - GAP - width);
      const top = Math.min(Math.max(box.top, minTop), Math.max(minTop, viewport.height - height));
      frame.place({ left, top, width, height, cornerRadius: CORNER_RADIUS });
      return true;
    },

    hide() {
      frame?.post({ tag: VIEW_TAG, kind: "hide" });
    },
  };
}
