// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): the outline drawn around the card whose tooltip is
// showing. It is the accepted detection's box mapped onto the picture on screen (letterboxing,
// full screen, theater, resizing); for a turned card, the turned outline the compute frame's hit
// test uses, about the same center. The host shows and hides it with the tooltip.
//
// It never takes the pointer and never moves the page: a fixed-position element with
// pointer-events none, nothing focusable, drawn in a closed shadow root so the page's styles do
// not reach it, and styled through the CSSOM only (no inline markup, no style sheet, so a page's
// style policy cannot block it).

import type { ClientBox } from "../capture.js";
import type { FractionBox } from "../compute-messages.js";
import type { ProductConfig } from "./config.js";

/** Smallest outline drawn, in CSS pixels on either side. */
export const MIN_OUTLINE_SIDE = 4;
/** The fade-in when the outline appears (none for viewers who ask for reduced motion). */
export const OUTLINE_FADE_MS = 100;
/** The edge's width, in CSS pixels; the outline is drawn this far outside the box. */
export const OUTLINE_WIDTH = 2;

/**
 * Where the outline goes: the box (fractions of the picture) on the picture's rectangle on
 * screen, or null when the picture's geometry is unknown or the box lies off the picture.
 * A box reaching a little past an edge is clipped to the picture (S-F1).
 */
export function outlineRect(picture: ClientBox, box: FractionBox, pictureKnown = true): ClientBox | null {
  if (!pictureKnown) return null;
  const values = [picture.left, picture.top, picture.width, picture.height, box.x, box.y, box.width, box.height];
  if (!values.every(Number.isFinite) || !(picture.width > 0 && picture.height > 0) || !(box.width > 0 && box.height > 0)) return null;
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(1, box.x + box.width);
  const y1 = Math.min(1, box.y + box.height);
  // Mostly off the picture: not a card on screen.
  if (x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) < 0.5 * box.width * box.height) return null;
  const rect = {
    left: picture.left + x0 * picture.width,
    top: picture.top + y0 * picture.height,
    width: (x1 - x0) * picture.width,
    height: (y1 - y0) * picture.height,
  };
  return rect.width >= MIN_OUTLINE_SIDE && rect.height >= MIN_OUTLINE_SIDE ? rect : null;
}

/** Where the outline goes and its turn in degrees (0 upright, positive clockwise). The element
 *  takes the rectangle, then `rotate()` about its center. */
export interface OutlinePlace extends ClientBox {
  rotation: number;
}

/** A shown card as the outline needs it: its box, its turned outline when it has one, and
 *  whether the card is held (S-F4). */
export interface OutlinedCard {
  box: FractionBox;
  rotation?: number;
  localWidth?: number;
  localHeight?: number;
  held?: true;
}

/**
 * Where the outline of a shown card goes. A turned card (`rotatedOutlines`) gets the outline the
 * compute frame's hit test uses: its own sides (`localWidth` of the picture's width, `localHeight`
 * of its height) about the center of the box, turned by `rotation` degrees in pixels, as
 * `computeCardQuad` draws it. There is no upright fallback for a turned outline that reaches past
 * the picture: the toolkit cuts a card's box to the frame before it works out the turn, so the
 * turned outline fits inside the picture (S-F3). An upright card, an out-of-range turn, a
 * malformed outline or a side under 4 px gets the box, as `outlineRect` places it. Null when the
 * box itself draws nothing, and for a held card, which keeps its tooltip and loses its outline
 * (S-F4).
 */
export function outlinePlace(picture: ClientBox, card: OutlinedCard, pictureKnown = true): OutlinePlace | null {
  if (card.held === true) return null;
  const rect = outlineRect(picture, card.box, pictureKnown);
  if (!rect) return null;
  const upright = { ...rect, rotation: 0 };
  const { rotation, localWidth, localHeight } = card;
  const side = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;
  if (typeof rotation !== "number" || !Number.isFinite(rotation) || rotation === 0 || rotation <= -45 || rotation > 45) return upright;
  if (!side(localWidth) || !side(localHeight)) return upright;
  const width = localWidth * picture.width;
  const height = localHeight * picture.height;
  if (width < MIN_OUTLINE_SIDE || height < MIN_OUTLINE_SIDE) return upright;
  const centerX = picture.left + (card.box.x + card.box.width / 2) * picture.width;
  const centerY = picture.top + (card.box.y + card.box.height / 2) * picture.height;
  return { left: centerX - width / 2, top: centerY - height / 2, width, height, rotation };
}

/**
 * The outline's edge: a solid edge fading into a glow, with a faint light hairline inside the
 * edge so a dark edge still reads on a dark board. Drawn OUTLINE_WIDTH outside the card's box.
 */
export function outlineEdgeStyle(edge: string, glow: string): Partial<CSSStyleDeclaration> {
  return {
    position: "absolute",
    inset: `-${OUTLINE_WIDTH}px`,
    boxSizing: "border-box",
    border: `${OUTLINE_WIDTH}px solid ${edge}`,
    borderRadius: "6px",
    boxShadow: `0 0 10px 3px ${glow}, inset 0 0 0 1px rgba(255, 255, 255, 0.35)`,
    pointerEvents: "none",
  };
}

export interface OutlineEnvironment {
  /** Whether the viewer asked for reduced motion (no fade). */
  reducedMotion?: () => boolean;
}

/** The outline element: one per tooltip, in the same place in the page (`host`). */
export class CardOutline {
  /** The element in the page (the shadow root's host). */
  readonly element: HTMLDivElement;
  private readonly edge: HTMLDivElement;
  private visible = false;

  constructor(
    host: Element,
    private readonly config: Pick<ProductConfig, "tag" | "outline">,
    private readonly env: OutlineEnvironment = {},
  ) {
    const doc = host.ownerDocument;
    const wrap = doc.createElement("div");
    wrap.setAttribute(`data-${config.tag}`, "outline");
    wrap.setAttribute("aria-hidden", "true");
    // Under the tooltip frame (2147483646), over the player. `all:initial` first: none of the
    // page's styles for its elements reach it.
    wrap.style.cssText =
      "all:initial;position:fixed;z-index:2147483645;left:0;top:0;width:0;height:0;display:none;margin:0;padding:0;border:0;pointer-events:none;transform:none;filter:none;";
    const root = wrap.attachShadow({ mode: "closed" });
    const edge = doc.createElement("div");
    Object.assign(edge.style, outlineEdgeStyle(config.outline.edgeColor, config.outline.glowColor));
    root.appendChild(edge);
    host.appendChild(wrap);
    this.element = wrap;
    this.edge = edge;
  }

  get shown(): boolean {
    return this.visible;
  }

  /** Draw it around `rect` (page coordinates), turned by its `rotation` degrees about its center
   *  when it has one, or hide it when `rect` is null. */
  show(rect: (ClientBox & { rotation?: number }) | null): void {
    if (!rect) {
      this.hide();
      return;
    }
    const s = this.element.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    s.transform = rect.rotation ? `rotate(${rect.rotation}deg)` : "none";
    if (this.visible) return;
    this.visible = true;
    s.display = "block";
    const reduced = this.env.reducedMotion?.() ?? globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!reduced && typeof this.edge.animate === "function") {
      this.edge.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OUTLINE_FADE_MS, easing: "ease-out" });
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.element.style.display = "none";
  }

  remove(): void {
    this.visible = false;
    this.element.remove();
  }
}
