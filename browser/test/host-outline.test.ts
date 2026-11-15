// SPDX-License-Identifier: Apache-2.0
// The shared hover host's outline: the box mapped onto the picture on screen (S-F1), the turned
// outline with no upright fallback (S-F3), a held card with no outline (S-F4), and an element that
// never takes the pointer, with stand-in elements (no DOM) and no network.
import { describe, expect, it, vi } from "vitest";

import { pictureBox } from "../src/capture.js";
import { computeCardQuad } from "../src/hover-geometry.js";
import { CardOutline, MIN_OUTLINE_SIDE, OUTLINE_WIDTH, outlineEdgeStyle, type OutlinePlace, outlinePlace, outlineRect } from "../src/host/outline.js";

type Rect = { left: number; top: number; width: number; height: number };


/** A stand-in element: a style that reads `cssText` as the browser does, attributes, a closed shadow
 *  root, and the few calls the outline makes. */
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attrs = new Map<string, string>();
  parent: FakeElement | null = null;
  readonly tabIndex = -1;
  readonly style: Record<string, unknown> & { cssText: string };
  animate: ((...args: unknown[]) => unknown) | undefined;
  constructor(readonly ownerDocument: { createElement(tag: string): FakeElement } | null) {
    const values: Record<string, string> = {};
    const camel = (name: string): string => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    this.style = new Proxy(values as Record<string, unknown> & { cssText: string }, {
      get: (target, key: string) => (key === "cssText" ? "" : target[key]),
      set: (target, key: string, value: unknown) => {
        if (key === "cssText") {
          for (const part of String(value).split(";")) {
            const at = part.indexOf(":");
            if (at > 0) target[camel(part.slice(0, at).trim())] = part.slice(at + 1).trim();
          }
        } else target[key] = value;
        return true;
      },
    });
  }
  get isConnected(): boolean {
    return this.parent !== null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  attachShadow(): FakeElement {
    return new FakeElement(this.ownerDocument);
  }
  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    this.parent = null;
  }
}
const fakeDocument = { createElement: (): FakeElement => new FakeElement(fakeDocument) };
const fakeBody = (): FakeElement => {
  const body = new FakeElement(fakeDocument);
  body.parent = body; // the page's own element: connected
  return body;
};
const asElement = (e: FakeElement): Element => e as unknown as Element;
const outlineIn = (body: FakeElement, env?: { reducedMotion?: () => boolean }): CardOutline => new CardOutline(asElement(body), config, env);

const config = { tag: "example", outline: { edgeColor: "#123456", glowColor: "rgba(10, 20, 30, 0.5)" } };

/** Equal to a hundredth of a pixel (fractions do not add up exactly in floating point). */
function expectRect(actual: Rect | null, expected: Rect): void {
  expect(actual).not.toBeNull();
  for (const k of ["left", "top", "width", "height"] as const) expect(actual![k]).toBeCloseTo(expected[k], 2);
}

const box = { x: 0.25, y: 0.5, width: 0.1, height: 0.2 };

describe("outlineRect (S-F1)", () => {
  it("maps the box onto the picture", () => {
    expectRect(outlineRect({ left: 10, top: 20, width: 1000, height: 500 }, box), { left: 260, top: 270, width: 100, height: 100 });
  });

  it("follows letterboxing: a 16:9 picture in a taller element (contain)", () => {
    const picture = pictureBox({ left: 0, top: 0, width: 800, height: 600 }, { width: 1920, height: 1080 }, "contain");
    expect(picture).toEqual({ left: 0, top: 75, width: 800, height: 450 });
    expectRect(outlineRect(picture, box), { left: 200, top: 300, width: 80, height: 90 });
  });

  it("follows pillarboxing (full screen on a wide display) and a resized player", () => {
    const wide = pictureBox({ left: 0, top: 0, width: 2560, height: 1080 }, { width: 1920, height: 1080 }, "contain");
    expectRect(outlineRect(wide, { x: 0, y: 0, width: 0.5, height: 0.5 }), { left: 320, top: 0, width: 960, height: 540 });
    const small = pictureBox({ left: 100, top: 50, width: 480, height: 270 }, { width: 1920, height: 1080 }, "contain");
    expectRect(outlineRect(small, { x: 0, y: 0, width: 0.5, height: 0.5 }), { left: 100, top: 50, width: 240, height: 135 });
  });

  it("clips a box that reaches a little past the picture's edge (10 % past the right edge)", () => {
    expectRect(outlineRect({ left: 0, top: 0, width: 1000, height: 1000 }, { x: 0.95, y: 0.1, width: 0.1, height: 0.1 }), { left: 950, top: 100, width: 50, height: 100 });
  });

  it("draws nothing for a box mostly or wholly off the picture (70 % off)", () => {
    const picture = { left: 0, top: 0, width: 1000, height: 1000 };
    // 30 % of the box is on the picture, 70 % past its right edge.
    expect(outlineRect(picture, { x: 0.97, y: 0.1, width: 0.1, height: 0.1 })).toBeNull();
    expect(outlineRect(picture, { x: 0.95, y: 0.1, width: 0.2, height: 0.1 })).toBeNull();
    expect(outlineRect(picture, { x: 1.2, y: 0.1, width: 0.1, height: 0.1 })).toBeNull();
    expect(outlineRect(picture, { x: -0.5, y: -0.5, width: 0.2, height: 0.2 })).toBeNull();
  });

  it("draws nothing when the picture's geometry is unknown or degenerate", () => {
    expect(outlineRect({ left: 0, top: 0, width: 1000, height: 500 }, box, false)).toBeNull();
    expect(outlineRect({ left: 0, top: 0, width: 0, height: 500 }, box)).toBeNull();
    expect(outlineRect({ left: Number.NaN, top: 0, width: 1000, height: 500 }, box)).toBeNull();
    expect(outlineRect({ left: 0, top: 0, width: 1000, height: 500 }, { ...box, width: 0 })).toBeNull();
    expect(outlineRect({ left: 0, top: 0, width: 1000, height: 500 }, { ...box, height: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("holds the 4 px floor on either side", () => {
    const picture = { left: 0, top: 0, width: 100, height: 100 };
    const below = (MIN_OUTLINE_SIDE - 0.5) / 100;
    expect(outlineRect(picture, { x: 0.5, y: 0.5, width: below, height: 0.2 })).toBeNull();
    expect(outlineRect(picture, { x: 0.5, y: 0.5, width: 0.2, height: below })).toBeNull();
    expect(outlineRect(picture, { x: 0.5, y: 0.5, width: MIN_OUTLINE_SIDE / 100, height: MIN_OUTLINE_SIDE / 100 })).not.toBeNull();
    // The floor applies to the clipped side: 10 px wide, 7 px of it past the edge.
    expect(outlineRect(picture, { x: 0.93, y: 0.2, width: 0.1, height: 0.2 })).not.toBeNull();
    expect(outlineRect(picture, { x: 0.97, y: 0.2, width: 0.07, height: 0.2 })).toBeNull();
  });
});

/** The corners of a CSS box turned by `rotate()` about its center, clockwise from top left. */
function cssCorners(p: OutlinePlace): { x: number; y: number }[] {
  const cx = p.left + p.width / 2;
  const cy = p.top + p.height / 2;
  const t = (p.rotation * Math.PI) / 180;
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const x = (sx! * p.width) / 2;
    const y = (sy! * p.height) / 2;
    return { x: cx + x * Math.cos(t) - y * Math.sin(t), y: cy + x * Math.sin(t) + y * Math.cos(t) };
  });
}

describe("outlinePlace", () => {
  const picture = { left: 10, top: 20, width: 1000, height: 500 };
  const turned = { box: { x: 0.4, y: 0.3, width: 0.2, height: 0.4 }, rotation: 20, localWidth: 0.1, localHeight: 0.3 };

  it("places an upright card's outline on its box, unturned", () => {
    expect(outlinePlace(picture, { box })).toEqual({ ...outlineRect(picture, box)!, rotation: 0 });
  });

  it("places a turned card's outline on its own sides about the box's center", () => {
    const place = outlinePlace(picture, turned)!;
    // Center (10 + 0.5 x 1000, 20 + 0.5 x 500) = (510, 270); sides 100 x 150 pixels.
    expect(place.rotation).toBe(20);
    expectRect(place, { left: 460, top: 195, width: 100, height: 150 });
  });

  it("draws the same corners as computeCardQuad, the hit test's outline", () => {
    for (const rotation of [-44, -7.5, 3, 20, 45]) {
      const card = { ...turned, rotation };
      const place = outlinePlace(picture, card)!;
      expect(place.rotation).toBe(rotation);
      const quad = computeCardQuad({ bounds: card.box, rotation, localWidth: card.localWidth, localHeight: card.localHeight }, { width: picture.width, height: picture.height });
      const css = cssCorners(place);
      quad.points.forEach((q, i) => {
        expect(css[i]!.x).toBeCloseTo(picture.left + q.x, 6);
        expect(css[i]!.y).toBeCloseTo(picture.top + q.y, 6);
      });
    }
  });

  // The four rows: three keep the upright box, the fourth is a turned outline.
  it("gives three upright boxes and one turned outline for the four rows", () => {
    const upright = { ...outlineRect(picture, turned.box)!, rotation: 0 };
    // Row 1: no turn, or a turn out of range.
    for (const rotation of [undefined, 0, 50, -45, Number.NaN]) expect(outlinePlace(picture, { ...turned, rotation })).toEqual(upright);
    // Row 2: a bad side.
    for (const bad of [{ localWidth: 0 }, { localHeight: 1.5 }, { localWidth: undefined }, { localHeight: Number.NaN }]) {
      expect(outlinePlace(picture, { ...turned, ...bad })).toEqual(upright);
    }
    // Row 3: a side under 4 px.
    expect(outlinePlace(picture, { ...turned, localWidth: (MIN_OUTLINE_SIDE - 1) / 1000 })).toEqual(upright);
    expect(outlinePlace(picture, { ...turned, localHeight: (MIN_OUTLINE_SIDE - 1) / 500 })).toEqual(upright);
    // Row 4: a turned outline whose turned extent reaches past the picture's edge is still drawn
    // turned, not as the upright box.
    const edge = { box: { x: 0.92, y: 0.3, width: 0.1, height: 0.4 }, rotation: 30, localWidth: 0.08, localHeight: 0.35 };
    const place = outlinePlace(picture, edge)!;
    expect(place.rotation).toBe(30);
    expect(place).not.toEqual({ ...outlineRect(picture, edge.box)!, rotation: 0 });
    expect(place.width).toBeCloseTo(0.08 * 1000, 6);
    expect(place.height).toBeCloseTo(0.35 * 500, 6);
  });

  it("draws nothing when the box draws nothing, turned or not", () => {
    expect(outlinePlace(picture, turned, false)).toBeNull();
    expect(outlinePlace(picture, { ...turned, box: { x: 1.2, y: 0.1, width: 0.1, height: 0.1 } })).toBeNull();
  });

  it("draws no outline for a held card, upright or turned (S-F4), and draws it again once released", () => {
    expect(outlinePlace(picture, { box, held: true })).toBeNull();
    expect(outlinePlace(picture, { ...turned, held: true })).toBeNull();
    expect(outlinePlace(picture, { ...turned })).not.toBeNull();
  });
});

describe("CardOutline", () => {
  it("never takes the pointer, is hidden from assistive tech, and has nothing focusable", () => {
    const body = fakeBody();
    const outline = outlineIn(body, { reducedMotion: () => true });
    const el = outline.element as unknown as FakeElement;
    expect(el.style.pointerEvents).toBe("none");
    expect(el.style.position).toBe("fixed");
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.hasAttribute("tabindex")).toBe(false);
    expect(el.getAttribute("data-example")).toBe("outline");
    expect(el.style.display).toBe("none");
    outline.show({ left: 10, top: 20, width: 30, height: 40 });
    expect([el.style.display, el.style.left, el.style.top, el.style.width, el.style.height]).toEqual(["block", "10px", "20px", "30px", "40px"]);
    expect(el.style.transform).toBe("none");
    outline.show({ left: 10, top: 20, width: 30, height: 40, rotation: -12.5 });
    expect(el.style.transform).toBe("rotate(-12.5deg)");
    outline.show({ left: 10, top: 20, width: 30, height: 40, rotation: 0 });
    expect(el.style.transform).toBe("none");
    outline.show(null);
    expect(el.style.display).toBe("none");
    expect(outline.shown).toBe(false);
    outline.remove();
    expect(el.isConnected).toBe(false);
  });

  it("fades in once when it appears, and not at all for reduced motion", () => {
    const animate = vi.fn();
    const body = fakeBody();
    const withFade = (reducedMotion: () => boolean): CardOutline => {
      const outline = outlineIn(body, { reducedMotion });
      // The fade runs on the edge element inside the shadow root.
      (outline as unknown as { edge: FakeElement }).edge.animate = animate;
      return outline;
    };
    {
      const outline = withFade(() => false);
      outline.show({ left: 0, top: 0, width: 30, height: 40 });
      outline.show({ left: 5, top: 0, width: 30, height: 40 });
      expect(animate).toHaveBeenCalledTimes(1);
      outline.hide();
      outline.show({ left: 5, top: 0, width: 30, height: 40 });
      expect(animate).toHaveBeenCalledTimes(2);
      const still = withFade(() => true);
      still.show({ left: 0, top: 0, width: 30, height: 40 });
      expect(animate).toHaveBeenCalledTimes(2);
    }
  });
});

describe("the outline's look", () => {
  it("is a solid edge in the configured color, fading into a glow, with a light hairline inside", () => {
    const style = outlineEdgeStyle(config.outline.edgeColor, config.outline.glowColor);
    expect(style.border).toBe(`${OUTLINE_WIDTH}px solid #123456`);
    expect(style.boxShadow).toBe(`0 0 10px 3px rgba(10, 20, 30, 0.5), inset 0 0 0 1px rgba(255, 255, 255, 0.35)`);
    expect(style.inset).toBe(`-${OUTLINE_WIDTH}px`);
    expect(style.pointerEvents).toBe("none");
  });
});
