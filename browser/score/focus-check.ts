// SPDX-License-Identifier: Apache-2.0
// A development check for session option `geometricScope: "focus"` (README.md, "Checking the
// focus scope"): for each frame the scoring page analyzes, every face is also analyzed with the
// pointer on its center in focus scope, and the answer for the faces the stage verified in that
// analysis is compared, field for field, with the answer of the full analysis of the same
// picture. A field that differs is reported with its path. It decides nothing and is off unless
// the scoring page is opened with `?focusCheck`; the runtime's bundle does not include it.

import type { FrameAnalysis } from "../src/pipeline.js";
import { hoverAt } from "../src/pipeline.js";
import { focusGroup } from "../src/recognition.js";
import type { Analyzer } from "./video.js";

/** One field that differs. */
export interface FocusDifference {
  /** Where, e.g. `boxes[2].face.geometric.candidates[0].inliers`. */
  path: string;
  all: unknown;
  focus: unknown;
}

/** The comparison for the pointer on one face's center. */
export interface FocusFace {
  /** The face's index in `boxes`, and the pointer, in the frame's pixels. */
  box: number;
  point: { x: number; y: number };
  /** The `boxes` indices the stage verified (the pointer's group), as the runtime picks them. */
  group: number[];
  differences: FocusDifference[];
}

export interface FocusCheckReport {
  frames: number;
  faces: number;
  /** Faces with at least one difference. */
  differing: number;
  details: FocusFace[];
}

/** Every field of `value` but the timings (`ms`), which a batch changes by itself. */
function withoutTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTimes);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "ms").map(([key, v]) => [key, withoutTimes(v)]));
  }
  return value;
}

/** The fields that differ between two values, by path (numbers compared exactly). */
export function differences(a: unknown, b: unknown, path: string, out: FocusDifference[] = []): FocusDifference[] {
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      differences((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`, out);
    }
  } else if (!Object.is(a, b)) {
    out.push({ path, all: a ?? null, focus: b ?? null });
  }
  return out;
}

/** The pointer on the center of face `index` of `all`, and what `focus` (the analysis of the
 *  same picture with that pointer in focus scope) gives for the faces the stage verified. */
export function compareFocus(all: FrameAnalysis, focus: FrameAnalysis, index: number): FocusFace {
  const [x, y, width, height] = all.boxes[index]!.box;
  const point = { x: x + width / 2, y: y + height / 2 };
  const faceBoxes = all.boxes.map((b, i) => ({ i, b })).filter(({ b }) => b.face !== null);
  const group = [...focusGroup(faceBoxes.map(({ b }) => ({ x: b.box[0], y: b.box[1], width: b.box[2], height: b.box[3] })), point)].map((k) => faceBoxes[k]!.i);
  const found: FocusDifference[] = [];
  differences(all.boxes.map((b) => b.box), focus.boxes.map((b) => b.box), "boxes[].box", found);
  for (const i of group) differences(withoutTimes(all.boxes[i]), withoutTimes(focus.boxes[i]), `boxes[${i}]`, found);
  // What the pointer shows: the card and its box. The layer's stacking order is left out: it
  // counts the named cards of the frame, and a frame in focus scope names fewer.
  const shown = (analysis: FrameAnalysis): unknown => {
    const { cardId, name, boxIndex, box } = hoverAt(analysis, point.x, point.y);
    return { cardId, name, boxIndex, box };
  };
  differences(shown(all), shown(focus), "hoverAt(point)", found);
  return { box: index, point, group, differences: found };
}

/** A running check and the analyzer that feeds it. */
export function focusChecked(inner: Analyzer, report: FocusCheckReport): Analyzer {
  return {
    ...inner,
    async analyze(video, point) {
      const all = await inner.analyze(video);
      if (point !== undefined) return all;
      report.frames += 1;
      for (const [index, b] of all.boxes.entries()) {
        if (b.face === null) continue;
        const [x, y, width, height] = b.box;
        const focus = await inner.analyze(video, { x: x + width / 2, y: y + height / 2 });
        const face = compareFocus(all, focus, index);
        report.faces += 1;
        if (face.differences.length > 0) {
          report.differing += 1;
          report.details.push(face);
        }
      }
      return all;
    },
  };
}

/** The lines the scoring page shows for a finished check. */
export function focusCheckLines(report: FocusCheckReport): string[] {
  const lines = [`focus check: ${report.faces} faces in ${report.frames} frames compared, ${report.differing} differ`];
  for (const face of report.details.slice(0, 10)) {
    for (const d of face.differences.slice(0, 3)) lines.push(`  frame face ${face.box} at ${face.point.x.toFixed(0)},${face.point.y.toFixed(0)}: ${d.path}: all ${JSON.stringify(d.all)}, focus ${JSON.stringify(d.focus)}`);
  }
  return lines;
}
