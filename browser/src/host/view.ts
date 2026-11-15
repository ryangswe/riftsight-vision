// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): the view adapter a product writes, and the narrow handle
// the host gives it. Types are frozen here.
//
// The host makes the view frame (the extension page that shows the card), keeps its visibility,
// stacking and pointer-events, mounts it where it is drawn (inside the full-screen element in full
// screen), and checks every message from it. The adapter sizes and places it through `ViewFrame`,
// posts to it, and reads the data of the messages the host has checked.

import type { ClientBox } from "../capture.js";
import { fromExtensionFrame } from "../capture-control.js";
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

/** The extension's frames in the page: `all:initial` first, so none of the page's styles for
 *  iframes reach them. */
export const FRAME_STYLE =
  "all:initial;position:fixed;display:block;border:0;margin:0;padding:0;background:transparent;color-scheme:normal;transform:none;filter:none;";

/** The view frame's stacking: over the player and the outline (2147483645). */
export const VIEW_Z_INDEX = 2147483646;

/** Where the view frame and the outline go: in full screen only the full-screen element is drawn,
 *  so inside it (unless it is the video or a frame, which cannot hold children); else the root. */
export function mountHost(doc: Document): Element {
  const fs = doc.fullscreenElement;
  if (fs) {
    const name = fs.tagName.toUpperCase();
    if (name !== "VIDEO" && name !== "IFRAME") return fs;
  }
  return doc.documentElement;
}

/** A new view frame, hidden, appended to `host`. The adapter places it in `attach()`. */
export function createViewFrame(doc: Document, host: Element, src: string, look: ViewAdapter["look"]): HTMLIFrameElement {
  const frame = doc.createElement("iframe");
  frame.title = look.title;
  // Not in the tab order: there is nothing in it to focus.
  frame.tabIndex = -1;
  // Nothing in it can be clicked: the pointer passes through to whatever is under it.
  frame.style.cssText = `${FRAME_STYLE}z-index:${VIEW_Z_INDEX};visibility:hidden;pointer-events:none;left:0;top:0;overflow:hidden;box-shadow:${look.shadow};`;
  frame.src = src;
  host.appendChild(frame);
  return frame;
}

/** The handle the adapter gets for `frame`: placing it and posting to it, nothing else. */
export function viewFrameHandle(frame: HTMLIFrameElement, origin: string): ViewFrame {
  return Object.freeze({
    place(box: { left: number; top: number; width: number; height: number; cornerRadius: number }): void {
      const s = frame.style;
      s.left = `${box.left}px`;
      s.top = `${box.top}px`;
      s.width = `${box.width}px`;
      s.height = `${box.height}px`;
      s.borderRadius = `${box.cornerRadius}px`;
      s.overflow = "hidden";
    },
    post(message: unknown): boolean {
      const target = frame.contentWindow;
      if (!target) return false;
      try {
        target.postMessage(message, origin);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/** Whether `event` is the view frame's own (S-B9): trusted, from its window, at the extension's
 *  origin. The data is not read before this holds. */
export function fromViewFrame(event: MessageEvent, frame: HTMLIFrameElement | null, origin: string): boolean {
  return frame !== null && fromExtensionFrame(event, frame.contentWindow, origin);
}
