// SPDX-License-Identifier: Apache-2.0
// still-outline-steady's judgment, apart from the browser so that it can be tested: what moved
// between two polls of a still card's outline and tooltip, and whether it was a wobble.
//
// S-W8: the shown card is reported again only when an edge of its box moved more than 5 % of the
// card's size (x edges against its width, y edges against its height) or its tilt more than 2
// degrees. So between two polls of a still card the outline either stays put or moves by more than
// that (a re-report after a real drift). A move above sub-pixel noise and within the threshold is
// a wobble that should not have been reported: that is the jitter a viewer sees. The tooltip moves
// with a report, so a tooltip move is a wobble unless an outline re-report is at the same poll or
// the one next to it (the two are read one after the other, so one can lag a poll).
//
// The limits come from the card's size in the clip, where the frame takes 5 % of the detected box.
// A detector whose box is tighter than the card could make a re-report of just over 5 % of its box
// that is under 5 % of the card: this would call it a wobble. A still card makes no such move, so
// this matters only for a product whose still card's box drifts by about 5 %.

/** Moves at or below this many pixels are rounding, not a move. */
export const SUB_PX = 0.5;
/** S-W8's tilt threshold, in degrees. */
export const TILT_DEG = 2;

/** The largest move of any edge between two boxes { left, top, width, height }, apart for x and y. */
function edgeMoves(a, b) {
  const x = Math.max(Math.abs(a.left - b.left), Math.abs(a.left + a.width - (b.left + b.width)));
  const y = Math.max(Math.abs(a.top - b.top), Math.abs(a.top + a.height - (b.top + b.height)));
  return { x, y };
}

/**
 * Judge the polls of a rest on a still card.
 * @param {Array<{ outline: { left: number, top: number, width: number, height: number, angle?: number } | null, tip: { left: number, top: number } | null }>} polls
 * @param {{ xLimitPx: number, yLimitPx: number }} limits 5 % of the card's width and height on screen
 * @returns {{ wobbles: Array<object>, rereports: Array<object>, tipWobbles: Array<object> }}
 */
export function stillMoves(polls, { xLimitPx, yLimitPx }) {
  const wobbles = [];
  const rereports = [];
  const rereportAt = new Set();
  for (let i = 1; i < polls.length; i += 1) {
    const a = polls[i - 1].outline;
    const b = polls[i].outline;
    if (!a || !b) continue;
    const { x, y } = edgeMoves(a, b);
    const tilt = Math.abs((b.angle ?? 0) - (a.angle ?? 0));
    if (x <= SUB_PX && y <= SUB_PX && tilt <= 0.1) continue;
    const move = { poll: i, x: round(x), y: round(y), tilt: round(tilt) };
    if (x > xLimitPx || y > yLimitPx || tilt > TILT_DEG) {
      rereports.push(move);
      rereportAt.add(i);
    } else wobbles.push(move);
  }
  const tipWobbles = [];
  for (let i = 1; i < polls.length; i += 1) {
    const a = polls[i - 1].tip;
    const b = polls[i].tip;
    if (!a || !b) continue;
    const moved = Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top));
    if (moved <= SUB_PX) continue;
    if (rereportAt.has(i - 1) || rereportAt.has(i) || rereportAt.has(i + 1)) continue;
    tipWobbles.push({ poll: i, px: round(moved) });
  }
  return { wobbles, rereports, tipWobbles };
}

const round = (v) => Math.round(v * 10) / 10;
