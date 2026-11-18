// SPDX-License-Identifier: Apache-2.0
export interface StillBox {
  left: number;
  top: number;
  width: number;
  height: number;
  angle?: number;
}
export interface StillPoll {
  outline: StillBox | null;
  tip: { left: number; top: number } | null;
}
export interface StillMove {
  poll: number;
  x: number;
  y: number;
  tilt: number;
}
export const SUB_PX: number;
export const TILT_DEG: number;
export function stillMoves(
  polls: StillPoll[],
  limits: { xLimitPx: number; yLimitPx: number },
): { wobbles: StillMove[]; rereports: StillMove[]; tipWobbles: Array<{ poll: number; px: number }> };
