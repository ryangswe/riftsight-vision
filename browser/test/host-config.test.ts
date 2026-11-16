// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { productConfigError } from "../src/host/config.js";

const valid = () => ({
  tag: "example",
  name: "Example",
  sites: { youtube: true, twitch: true },
  dev: false,
  frames: { compute: "compute.html", view: "view.html" },
  outline: { edgeColor: "#ffffff", glowColor: "rgba(0, 0, 0, 0.5)" },
  capabilities: { geometricStage: false },
});

/** A copy of the valid config with the dotted path set (or removed when `undefined`). */
function with_(path: string, value: unknown): unknown {
  const config = valid() as Record<string, unknown>;
  const parts = path.split(".");
  let at = config;
  for (const part of parts.slice(0, -1)) at = at[part] as Record<string, unknown>;
  const last = parts[parts.length - 1]!;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return config;
}

describe("productConfigError", () => {
  it("accepts a valid config, with either capability and a dev build", () => {
    expect(productConfigError(valid())).toBeNull();
    expect(productConfigError({ ...valid(), dev: true, capabilities: { geometricStage: true }, frames: { compute: "pages/compute.html", view: "tooltip.html" } })).toBeNull();
  });

  it.each([null, undefined, 3, "x", [], true])("says a non-object (%s) is not a config", (raw) => {
    expect(productConfigError(raw)).toMatch(/^config: must be an object/);
  });

  it("names an unknown key at each level", () => {
    expect(productConfigError({ ...valid(), tagg: "x" })).toContain('"tagg"');
    expect(productConfigError(with_("sites.vimeo", true))).toMatch(/sites: unknown key "vimeo"/);
    expect(productConfigError(with_("frames.extra", "a.html"))).toMatch(/frames: unknown key "extra"/);
    expect(productConfigError(with_("outline.width", "2px"))).toMatch(/outline: unknown key "width"/);
    expect(productConfigError(with_("capabilities.more", true))).toMatch(/capabilities: unknown key "more"/);
  });

  it.each([
    ["tag", undefined, /^tag:/],
    ["tag", 3, /^tag:/],
    ["tag", "", /^tag:/],
    ["tag", "Upper", /^tag:/],
    ["tag", "1abc", /^tag:/],
    ["tag", 'a"b', /^tag:/],
    ["tag", "kind", /^tag:/],
    ["name", undefined, /^name:/],
    ["name", "  ", /^name:/],
    ["name", 4, /^name:/],
    ["sites", undefined, /^sites:/],
    ["sites.youtube", undefined, /^sites\.youtube:/],
    ["sites.twitch", "yes", /^sites\.twitch:/],
    ["dev", undefined, /^dev:/],
    ["dev", "no", /^dev:/],
    ["frames", undefined, /^frames:/],
    ["frames.compute", undefined, /^frames\.compute:/],
    ["frames.compute", "", /^frames\.compute:/],
    ["frames.view", 5, /^frames\.view:/],
    ["frames.view", "/view.html", /^frames\.view:/],
    ["frames.view", "https://example.com/view.html", /^frames\.view:/],
    ["frames.view", "chrome-extension://abc/view.html", /^frames\.view:/],
    ["frames.compute", "../compute.html", /^frames\.compute:/],
    ["frames.compute", "a/../../compute.html", /^frames\.compute:/],
    ["frames.compute", "a\\b.html", /^frames\.compute:/],
    ["outline", undefined, /^outline:/],
    ["outline.edgeColor", undefined, /^outline\.edgeColor:/],
    ["outline.glowColor", "", /^outline\.glowColor:/],
    ["outline.edgeColor", 0xffffff, /^outline\.edgeColor:/],
    ["capabilities", undefined, /^capabilities:/],
    ["capabilities.geometricStage", undefined, /^capabilities\.geometricStage:/],
    ["capabilities.geometricStage", 1, /^capabilities\.geometricStage:/],
  ] as const)("names the field when %s is %j", (path, value, message) => {
    expect(productConfigError(with_(path, value))).toMatch(message);
  });
});
