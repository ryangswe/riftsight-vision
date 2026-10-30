// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { captureAllowed, MAX_REST_MS, POINTER_GRACE_MS, READING_LINGER_MS } from "../src/capture-gate.js";
import * as scheduler from "../src/frame-scheduler.js";

const base = { inside: true, lastTrustedPointerAt: 1000, tooltipShowing: false, lastTooltipAt: -Infinity };

describe("captureAllowed", () => {
  it("defaults to the scheduler's own limits", () => {
    expect([POINTER_GRACE_MS, READING_LINGER_MS]).toEqual([10_000, 5_000]);
    expect([POINTER_GRACE_MS, READING_LINGER_MS]).toEqual([scheduler.POINTER_GRACE_MS, scheduler.READING_LINGER_MS]);
  });

  it("answers within the active window of a trusted pointer event over the picture", () => {
    expect(captureAllowed(base, 1000 + POINTER_GRACE_MS - 1)).toBe(true);
    expect(captureAllowed(base, 1000 + POINTER_GRACE_MS)).toBe(false);
  });

  it("never answers with the pointer outside the picture, or with no trusted event ever", () => {
    expect(captureAllowed({ ...base, inside: false }, 1001)).toBe(false);
    expect(captureAllowed({ ...base, lastTrustedPointerAt: -Infinity }, 1001)).toBe(false);
    expect(captureAllowed({ ...base, lastTrustedPointerAt: -Infinity, tooltipShowing: true }, 1001)).toBe(false);
  });

  it("keeps answering while a card shows under a resting pointer, and for the linger after", () => {
    const later = 1000 + POINTER_GRACE_MS + 30_000;
    expect(captureAllowed({ ...base, tooltipShowing: true, lastTooltipAt: later }, later)).toBe(true);
    expect(captureAllowed({ ...base, lastTooltipAt: later }, later + READING_LINGER_MS - 1)).toBe(true);
    expect(captureAllowed({ ...base, lastTooltipAt: later }, later + READING_LINGER_MS)).toBe(false);
  });

  it("takes other limits", () => {
    expect(captureAllowed(base, 1000 + 99, { graceMs: 100 })).toBe(true);
    expect(captureAllowed(base, 1000 + 100, { graceMs: 100 })).toBe(false);
    const later = 1000 + POINTER_GRACE_MS + 30_000;
    expect(captureAllowed({ ...base, lastTooltipAt: later }, later + 49, { lingerMs: 50 })).toBe(true);
    expect(captureAllowed({ ...base, lastTooltipAt: later }, later + 50, { lingerMs: 50 })).toBe(false);
  });

  it("caps every branch at MAX_REST_MS (60 s) after the last trusted event", () => {
    expect(MAX_REST_MS).toBe(60_000);
    const end = 1000 + MAX_REST_MS;
    const showing = { ...base, tooltipShowing: true, lastTooltipAt: end };
    expect(captureAllowed(showing, end - 1)).toBe(true);
    expect(captureAllowed(showing, end)).toBe(false);
    expect(captureAllowed({ ...base, lastTooltipAt: end - 1 }, end)).toBe(false);
    // A fresh trusted event restores it.
    expect(captureAllowed({ ...showing, lastTrustedPointerAt: end }, end)).toBe(true);
  });

  it("takes another cap", () => {
    const showing = { ...base, tooltipShowing: true, lastTooltipAt: 1000 };
    expect(captureAllowed(showing, 1000 + 120_000, { restMs: 121_000 })).toBe(true);
    expect(captureAllowed(showing, 1000 + 20_000, { restMs: 20_000 })).toBe(false);
    // Below the grace period it cuts that too.
    expect(captureAllowed(base, 1000 + 5_000, { restMs: 5_000 })).toBe(false);
  });
});
