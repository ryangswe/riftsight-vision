// SPDX-License-Identifier: Apache-2.0
// When a content script hands a picture to the compute frame.
//
// In the two-frame setup (docs/extension-session.md) the page can post messages to the compute
// frame (it is a frame of the page), and so could make it ask for pictures. The content script
// therefore answers a request only when the viewer is really pointing at the player: the pointer
// is over the picture, a pointer event the browser marks as trusted (from the user, not a
// script) happened within the scheduler's active window, or a card is showing under a resting
// pointer (the scheduler's "reading" state). The limits default to the scheduler's own. Whatever
// the branch, nothing is given more than `MAX_REST_MS` (60 s) after the last trusted pointer
// event: a page that hides pointer events from the content script (a frame of its own laid over
// the document) cannot keep a card showing, and so the gate open, for longer.

import { POINTER_GRACE_MS, READING_LINGER_MS } from "./frame-scheduler.js";

export { POINTER_GRACE_MS, READING_LINGER_MS };

/** The longest a picture is given after the last trusted pointer event, whatever else holds:
 *  a card showing or the linger after one does not stretch it. */
export const MAX_REST_MS = 60_000;

export interface GateState {
  /** The pointer is over the picture (from trusted events only). */
  inside: boolean;
  /** The last trusted pointer event over the picture; -Infinity for none. */
  lastTrustedPointerAt: number;
  /** A card is showing now. */
  tooltipShowing: boolean;
  /** The last time a card was showing; -Infinity for never. */
  lastTooltipAt: number;
}

export interface GateLimits {
  /** How long after a trusted pointer event pictures are given, in ms. */
  graceMs?: number;
  /** How long after a card last showed pictures are still given, in ms. */
  lingerMs?: number;
  /** The most time after a trusted pointer event any picture is given, in ms; default
   *  `MAX_REST_MS`. */
  restMs?: number;
}

/** Whether a picture may be given to the compute frame now. */
export function captureAllowed(state: GateState, now: number, { graceMs = POINTER_GRACE_MS, lingerMs = READING_LINGER_MS, restMs = MAX_REST_MS }: GateLimits = {}): boolean {
  if (!state.inside || !Number.isFinite(state.lastTrustedPointerAt)) return false;
  if (now - state.lastTrustedPointerAt >= restMs) return false;
  if (now - state.lastTrustedPointerAt < graceMs) return true;
  return state.tooltipShowing || now - state.lastTooltipAt < lingerMs;
}
