// SPDX-License-Identifier: Apache-2.0
// The shared hover host's types, as a product sees them: an empty folder vendored with
// `host: true`, a small adapter and compute entry that import only the vendored declaration
// shims, and `tsc --noEmit` with the compiler options products use (strict). `@ts-expect-error`
// probes fail the check when a type collapsed to `any` (a declaration that cannot be resolved
// reads as `any`, and the probe then has no error to expect). Needs dist/ (npm run build):
// skipped without it, required when CARDVISION_REQUIRE_BROWSER=1. No network.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

// @ts-expect-error: a plain .mjs script without declarations
import { vendorInto } from "../scripts/vendor-lib.mjs";

const browser = fileURLToPath(new URL("..", import.meta.url));
const repo = join(browser, "..");
const dist = join(browser, "dist");
const tsc = join(browser, "node_modules", ".bin", "tsc");
const built = ["host-content.d.ts", "host-compute.d.ts", "host-settings.d.ts", "host-content.js"].every((name) => existsSync(join(dist, name))) && existsSync(join(dist, "types", "host"));
const required = process.env.CARDVISION_REQUIRE_BROWSER === "1";
// The products' extension typings, when this checkout has them (the toolkit does not depend on them).
const chromeTypes = existsSync(join(browser, "node_modules", "@types", "chrome"));

const adapter = `import { HIDE_DELAY_MS, pagePolicy, startHostContent, type HostContent, type HostContentEnv, type ProductConfig, type ViewAdapter, type ViewFrame } from "../vendor/cardvision/host-content.js";

const config: ProductConfig = {
  tag: "demo",
  name: "Demo",
  sites: { youtube: true, twitch: false },
  dev: false,
  frames: { compute: "compute.html", view: "view.html" },
  outline: { edgeColor: "#fff", glowColor: "#000" },
  capabilities: { geometricStage: true },
};

let frame: ViewFrame | null = null;
const view: ViewAdapter = {
  look: { title: "Demo", shadow: "none" },
  attach(next) {
    frame = next;
  },
  detach() {
    frame = null;
  },
  message: () => frame !== null,
  show: (card, layout) => card.name.length > 0 && layout.visible,
  hide() {},
};

export function start(win: Window, doc: Document): HostContent {
  const env: HostContentEnv = {
    config,
    win,
    doc,
    extensionUrl: (path) => "chrome-extension://id/" + path,
    storage: { get: async () => ({}) },
    storageChanges: { addListener() {}, removeListener() {} },
    view,
  };
  return startHostContent(env);
}

const delay: number = HIDE_DELAY_MS;
const route: string | null = pagePolicy(new URL("https://www.youtube.com/embed/clip"), config) === null ? null : "route";
export { delay, route };

// The types are real, not any: each of these must be an error.
// @ts-expect-error: a number is not a string
const wrongDelay: string = HIDE_DELAY_MS;
// @ts-expect-error: the product config needs every field
const thinConfig: ProductConfig = { tag: "x" };
// @ts-expect-error: the environment needs a view adapter, a window and the rest
startHostContent({});
// @ts-expect-error: the state is one of five words
const wrongState: HostContent["state"] = "sleeping";
// @ts-expect-error: show returns whether it showed, not a string
const wrongView: ViewAdapter = { ...view, show: () => "yes" };
export { thinConfig, wrongDelay, wrongState, wrongView };
`;

const compute = `import { GEOMETRIC_OPTIONS, STANDARD_PRESET, startHostCompute, type HostCompute, type HostComputeEnv, type ProductConfig, type WorkerLike } from "../vendor/cardvision/host-compute.js";

declare const config: ProductConfig;
declare const win: HostComputeEnv["win"];

const worker: WorkerLike = {
  postMessage() {},
  terminate() {},
  onmessage: null,
  onerror: null,
};

export async function start(): Promise<HostCompute | null> {
  return startHostCompute({
    config,
    win,
    storage: { get: async () => ({}) },
    createWorker: () => worker,
    loadRequest: () => ({ kind: "bundled" }) as never,
  });
}

const mode: "pointer" = STANDARD_PRESET.mode;
const scope: "focus" = GEOMETRIC_OPTIONS.geometricScope;
export { mode, scope };

// The types are real, not any: each of these must be an error.
// @ts-expect-error: the standard preset's mode is "pointer"
const wrongMode: "always-on" = STANDARD_PRESET.mode;
// @ts-expect-error: a worker needs terminate and the two handlers
const thinWorker: WorkerLike = { postMessage() {} };
// @ts-expect-error: the environment needs a config and the rest
startHostCompute({});
export { thinWorker, wrongMode };
`;

const settings = `import { createSettingsCore, createSwitches, compareVersions, type SettingsCore, type Switches } from "../vendor/cardvision/host-settings.js";

export const order: number = compareVersions("1.2.0", "1.10.0");
export type Core = SettingsCore<{ size: number }>;
export type Sw = Switches;
export { createSettingsCore, createSwitches };

// @ts-expect-error: compareVersions takes two strings
export const wrongOrder: string = compareVersions("1", "2");
`;

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An empty product folder with the runtime vendored into vendor/cardvision with the host, and the entries above. */
function consumer(): string {
  const dir = mkdtempSync(join(tmpdir(), "host-types-consumer-"));
  temps.push(dir);
  vendorInto({ root: repo, dist, into: join(dir, "vendor", "cardvision"), commit: "c".repeat(40), opencv: false, ortWasm: false, host: true });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "adapter.ts"), adapter);
  writeFileSync(join(dir, "src", "compute.ts"), compute);
  writeFileSync(join(dir, "src", "settings.ts"), settings);
  return dir;
}

function check(dir: string, extra: Record<string, unknown> = {}) {
  const options = {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    types: chromeTypes ? ["chrome"] : [],
    typeRoots: [join(browser, "node_modules", "@types")],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    ...extra,
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: options, include: ["src"] }));
  return spawnSync(tsc, ["-p", dir], { encoding: "utf-8" });
}

describe("host types from the emitted declarations", () => {
  if (!built && !required) {
    it.skip("needs a current dist/ (run npm run build)", () => {});
    return;
  }

  it("has been built", () => {
    expect(built).toBe(true);
  });

  it("type-checks an adapter and a compute entry that import only the vendored shims, and the probes see real types", () => {
    const result = check(consumer());
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 120_000);

  // The declarations reach types/ort.d.ts, which imports onnxruntime-web. A product that does not install
  // it (it ships the model runtime inside the toolkit's own files) type-checks with skipLibCheck, as above;
  // without skipLibCheck the only complaint may be that one module, in that one file.
  it("without onnxruntime-web installed, the only declaration error is its missing module in types/ort.d.ts", () => {
    const result = check(consumer(), { skipLibCheck: false });
    const errors = (result.stdout + result.stderr).split("\n").filter((line) => line.trim() !== "");
    for (const line of errors) expect(line, line).toMatch(/vendor\/cardvision\/types\/ort\.d\.ts\(\d+,\d+\): error TS2307: Cannot find module 'onnxruntime-web\/all'/);
  }, 120_000);
});
