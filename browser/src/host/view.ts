// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): the view adapter a product writes, and the narrow handle
// the host gives it. Types are frozen here.

import type { ClientBox } from "../capture.js";
import type { ShownCard } from "../compute-messages.js";

/** The view frame as the adapter may touch it. The host keeps its visibility, stacking and
 *  pointer-events (always none), and makes, moves and removes it. */
export interface ViewFrame {
  /** Works while the frame is hidden and before it has loaded. Width and height are applied
   *  exactly as given and at once: no rounding, no deferral (a frame that waits for its window to
   *  reach the size it reported does not fit). The host applies the box, plus
   *  overflow:hidden with border-radius = cornerRadius; z-index 2147483646 is the host's. */
  place(box: { left: number; top: number; width: number; height: number; cornerRadius: number }): void;
  /** Post to the frame at the extension's origin. False when it has no window yet. */
  post(message: unknown): boolean;
}

export interface ViewLayout {
  picture: ClientBox; // the video's picture on the page
  card: ClientBox; // the shown card's box on the page
  others: ClientBox[]; // the other cards of the same look
  viewport: { width: number; height: number };
  minTop: number; // the player's top edge
  visible: boolean; // the frame is on show now (for sticky placement)
}

export interface ViewAdapter {
  readonly look: { title: string; shadow: string };
  /** A new view frame exists (first made, made again, moved for full screen, removed by the page
   *  and made again): forget the last one, including the last box placed. Straight after attach()
   *  the host calls show() for the displayed or held card, if any, without waiting for a new one. */
  attach(frame: ViewFrame): void;
  /** The view frame is gone (off, idle, removed by the page). */
  detach(): void;
  /** A message the host has checked (trusted, from the view frame's window, the extension's
   *  origin). True when readiness or the measured size changed: the host then shows again. */
  message(data: unknown): boolean;
  /** Size and place the frame for `card` and tell the frame which card it is. True once the frame
   *  has measured itself for this card; the host shows the frame and the outline only then. */
  show(card: ShownCard, layout: ViewLayout): boolean;
  hide(): void;
}
