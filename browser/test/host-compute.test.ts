// SPDX-License-Identifier: Apache-2.0
// The shared hover host's compute realm: the standard options (read out of docs/hover-spec.md, so a
// spec edit that breaks the preset fails here), the origin gate, the options that reach the
// toolkit's compute frame next to what each product passes today, and the order of the first calls.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComputeFrameEnv } from "../src/compute-frame.js";
import * as computeFrame from "../src/compute-frame.js";
import { computeProtocol, PROTOCOL_VERSION } from "../src/compute-messages.js";
import { DRIVER_TICK_MS } from "../src/frame-scheduler.js";
import { GEOMETRIC_OPTIONS, startHostCompute, STANDARD_PRESET, type HostComputeEnv } from "../src/host/compute.js";
import type { ProductConfig } from "../src/host/config.js";
import { READING_HOLD, SHOWN_HOLD } from "../src/session-core.js";
import type { WorkerLike } from "../src/worker-session.js";
import { memoryStorage } from "./support/host-storage.js";

vi.mock("../src/compute-frame.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/compute-frame.js")>();
  return { ...actual, startComputeFrame: vi.fn(actual.startComputeFrame) };
});

const SPEC = readFileSync(fileURLToPath(new URL("../../docs/hover-spec.md", import.meta.url)), "utf8");
const SITE = "https://www.youtube.com";
const TWITCH = "https://www.twitch.tv";
const LOCAL = "http://127.0.0.1:8770";
const TAG = "example";
const protocol = computeProtocol(TAG);

const config = (over: Partial<ProductConfig> = {}, geometricStage = false): ProductConfig => ({
  tag: TAG,
  name: "Example",
  sites: { youtube: true, twitch: true },
  dev: false,
  frames: { compute: "compute.html", view: "view.html" },
  outline: { edgeColor: "#fff", glowColor: "#000" },
  capabilities: { geometricStage },
  ...over,
});

const startSpy = vi.mocked(computeFrame.startComputeFrame);
const optionsReached = (): ComputeFrameEnv => startSpy.mock.calls.at(-1)![0];

class FakeWorker implements WorkerLike {
  posted: unknown[] = [];
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  terminate() {}
}

/** A compute page's window: a parent that records posts, and the listeners by event type. */
function fakeWindow(ancestors: ArrayLike<string> | undefined, log: string[] = []) {
  const posts: Array<{ message: { kind: string }; origin: string }> = [];
  const listeners = new Map<string, Set<(event: never) => void>>();
  const parent = {
    postMessage: (message: unknown, origin: string) => {
      posts.push({ message: message as { kind: string }, origin });
      log.push(`post:${(message as { kind: string }).kind}`);
    },
  };
  const win = {
    parent,
    location: { ancestorOrigins: ancestors },
    addEventListener: (type: string, fn: (event: never) => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type: string, fn: (event: never) => void) => void listeners.get(type)?.delete(fn),
  };
  const send = (data: unknown, origin = SITE) => {
    for (const fn of [...(listeners.get("message") ?? [])]) fn({ data, source: parent, origin } as never);
  };
  return { win: win as unknown as HostComputeEnv["win"], posts, listeners, parent, send };
}

const BUNDLED = { kind: "load" as const, releaseUrl: "extension://x/release/release.json", wasmPaths: "w/" };

const NONE = Symbol("no ancestorOrigins");
function env(over: Partial<HostComputeEnv> = {}, given: ArrayLike<string> | undefined | typeof NONE = [SITE]) {
  const ancestors = given === NONE ? undefined : given;
  const log: string[] = [];
  const page = fakeWindow(ancestors, log);
  const loadRequest = vi.fn(() => {
    log.push("loadRequest");
    return BUNDLED;
  });
  const workers: FakeWorker[] = [];
  const full: HostComputeEnv = {
    config: config(),
    win: page.win,
    storage: memoryStorage(),
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    loadRequest,
    now: () => 1_000,
    ...over,
  };
  return { env: full, page, log, loadRequest, workers };
}

beforeEach(() => {
  startSpy.mockClear();
});
afterEach(() => vi.useRealTimers());

// The standard-options table of docs/hover-spec.md, by option name.
function specTable(): Map<string, string> {
  const start = SPEC.indexOf("### The standard options");
  const end = SPEC.indexOf("\nOut of scope here", start);
  const rows = new Map<string, string>();
  for (const line of SPEC.slice(start, end).split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4 || !cells[1]!.startsWith("`")) continue;
    for (const name of [...cells[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)) rows.set(name, cells[2]!);
  }
  return rows;
}
const ticks = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

describe("the standard preset", () => {
  it("equals the standard-options table of the hover spec", () => {
    const table = specTable();
    expect(JSON.parse(ticks(table.get("mode")!)[0]!)).toBe(STANDARD_PRESET.mode);
    expect(table.get("rotatedOutlines")).toBe("`true`");
    expect(STANDARD_PRESET.rotatedOutlines).toBe(true);
    expect(table.get("measuredPacing")).toMatch(/^`true`/);
    expect(STANDARD_PRESET.measuredPacing).toBe(true);
    expect(Number(table.get("idleUnloadMs")!.match(/^(\d+)/)![1])).toBe(STANDARD_PRESET.idleUnloadMs);
    // The pair of geometric options, in the order of the row's two names.
    expect(table.has("geometricLoad") && table.has("geometricScope")).toBe(true);
    const [load, scope] = ticks(table.get("geometricLoad")!).map((t) => JSON.parse(t) as string);
    expect({ geometricLoad: load, geometricScope: scope }).toEqual({ geometricLoad: GEOMETRIC_OPTIONS.geometricLoad, geometricScope: GEOMETRIC_OPTIONS.geometricScope });
    expect(Object.keys(STANDARD_PRESET).sort()).toEqual(["idleUnloadMs", "measuredPacing", "mode", "rotatedOutlines"]);
    expect(Object.keys(GEOMETRIC_OPTIONS).sort()).toEqual(["geometricLoad", "geometricScope"]);
  });

  it("is what reaches the compute frame, with the geometric pair only for a product that can have the stage", async () => {
    const plain = env();
    (await startHostCompute(plain.env))!.stop();
    expect(optionsReached()).toMatchObject({ ...STANDARD_PRESET });
    expect(optionsReached()).not.toHaveProperty("geometricScope");
    expect(optionsReached()).not.toHaveProperty("geometricLoad");
    const geo = env({ config: config({}, true) });
    (await startHostCompute(geo.env))!.stop();
    expect(optionsReached()).toMatchObject({ ...STANDARD_PRESET, ...GEOMETRIC_OPTIONS });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(STANDARD_PRESET) && Object.isFrozen(GEOMETRIC_OPTIONS)).toBe(true);
  });
});

describe("the hold", () => {
  it("names both holds in the spec's hold row", () => {
    const row = specTable().get("hold")!;
    expect(row).toContain("READING_HOLD");
    expect(row).toContain("SHOWN_HOLD");
  });

  it.each([
    ["no stored value", {}, READING_HOLD],
    ["keep-card stored on", { keepCard: true }, READING_HOLD],
    ["keep-card stored off", { keepCard: false }, SHOWN_HOLD],
    ["an unreadable stored value", { keepCard: "false" }, READING_HOLD],
    ["a stored null", { keepCard: null }, READING_HOLD],
  ])("follows keep-card: %s", async (_, stored, hold) => {
    const t = env({ storage: memoryStorage(stored) });
    (await startHostCompute(t.env))!.stop();
    expect(optionsReached().hold).toBe(hold);
  });

  it("gives the reading hold when the storage cannot be read", async () => {
    const t = env({ storage: { get: () => Promise.reject(new Error("no storage")) } });
    (await startHostCompute(t.env))!.stop();
    expect(optionsReached().hold).toBe(READING_HOLD);
  });
});

describe("the origin gate", () => {
  it.each([
    ["a hidden origin (the string null)", ["null"]],
    ["another site", ["https://example.com"]],
    ["the local test page in a build that is not for development", [LOCAL]],
    ["an empty origin", [""]],
    ["no ancestor origins (an empty list)", []],
    ["no ancestorOrigins at all", NONE],
  ] as Array<[string, ArrayLike<string> | undefined | typeof NONE]>)("gives null for %s, and asks for no load request, worker or message", async (_, ancestors) => {
    const t = env({}, ancestors);
    expect(await startHostCompute(t.env)).toBeNull();
    expect(t.loadRequest).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(t.workers).toEqual([]);
    expect(t.page.posts).toEqual([]);
    expect(t.page.listeners.size).toBe(0);
  });

  it("gives null for a site the product does not serve", async () => {
    const t = env({ config: config({ sites: { youtube: false, twitch: true } }) });
    expect(await startHostCompute(t.env)).toBeNull();
    expect(t.loadRequest).not.toHaveBeenCalled();
  });

  it("gives null when the page is not framed", async () => {
    const t = env();
    const win = t.env.win as unknown as { parent: unknown };
    win.parent = win;
    expect(await startHostCompute(t.env)).toBeNull();
    expect(t.loadRequest).not.toHaveBeenCalled();
  });

  it("serves the allowed sites, and the local test page in a development build only", async () => {
    for (const [origin, dev, serves] of [
      [SITE, false, true],
      [TWITCH, false, true],
      [LOCAL, true, true],
      ["http://localhost:3000", true, true],
      [LOCAL, false, false],
    ] as const) {
      const t = env({ config: config({ dev }) }, [origin]);
      const host = await startHostCompute(t.env);
      expect(host !== null, `${origin} dev=${dev}`).toBe(serves);
      host?.stop();
    }
  });

  it("uses the first ancestor origin, and no fallback", async () => {
    const t = env({}, ["https://example.com", SITE]);
    expect(await startHostCompute(t.env)).toBeNull();
    const ok = env({}, [SITE, "https://example.com"]);
    (await startHostCompute(ok.env))!.stop();
    expect(optionsReached().parentOrigin).toBe(SITE);
  });
});

describe("framed and parentOrigin", () => {
  // Kenbunshoku: `window.parent !== window`; `location.ancestorOrigins?.[0] ?? null`, "null" gives null.
  // DuelSight: the same pair, with undefined or "null" giving null. The host computes both.
  const today = (ancestors: ArrayLike<string> | undefined, parentIsWindow = false) => {
    const first = ancestors?.[0] ?? null;
    return { framed: !parentIsWindow, parentOrigin: first === "null" ? null : first };
  };

  it.each([
    ["a YouTube parent", [SITE]],
    ["a Twitch parent", [TWITCH]],
    ["a parent and a grandparent", [TWITCH, SITE]],
  ])("come out as the products compute them: %s", async (_, ancestors) => {
    const t = env({}, ancestors);
    (await startHostCompute(t.env))!.stop();
    expect({ framed: optionsReached().framed, parentOrigin: optionsReached().parentOrigin }).toEqual(today(ancestors));
  });

  it("make no frame in a window with no ancestorOrigins (a browser without the property)", async () => {
    expect(today(undefined)).toEqual({ framed: true, parentOrigin: null });
    expect(await startHostCompute(env({}, NONE).env)).toBeNull();
  });

  it("answer `ready` to the parent's origin only, under the product's tag", async () => {
    const t = env({}, [TWITCH]);
    (await startHostCompute(t.env))!.stop();
    expect(t.page.posts.find((p) => p.message.kind === "ready")).toMatchObject({ origin: TWITCH, message: { example: 1, kind: "ready", version: PROTOCOL_VERSION } });
  });
});

describe("development builds", () => {
  it("refuse a shorter idle unload outside development", async () => {
    const t = env({ devIdleUnloadMs: 5_000 });
    await expect(startHostCompute(t.env)).rejects.toThrow(/development/);
    expect(t.loadRequest).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(t.page.posts).toEqual([]);
  });

  it("refuse it for any origin, including one that gives null", async () => {
    await expect(startHostCompute(env({ devIdleUnloadMs: 5_000 }, ["https://example.com"]).env)).rejects.toThrow();
  });

  it("take it in a development build, and keep 10 minutes otherwise", async () => {
    (await startHostCompute(env({ config: config({ dev: true }), devIdleUnloadMs: 5_000 }).env))!.stop();
    expect(optionsReached().idleUnloadMs).toBe(5_000);
    (await startHostCompute(env({ config: config({ dev: true }) }).env))!.stop();
    expect(optionsReached().idleUnloadMs).toBe(600_000);
  });

  it("leave an unusable value to the compute frame's own check", async () => {
    await expect(startHostCompute(env({ config: config({ dev: true }), devIdleUnloadMs: 0 }).env)).rejects.toThrow(RangeError);
  });
});

describe("the geometric capability", () => {
  const withStage = { ...BUNDLED, geometricUrl: "extension://x/geometric/index.json", geometricManifestSha256: "a".repeat(64) };

  it.each(Object.keys(withStage).filter((k) => k.startsWith("geometric")))("throws for a load request with %s when the product has no geometric stage", async (field) => {
    const t = env({ loadRequest: () => ({ ...BUNDLED, [field]: field === "geometricDebug" ? true : "x" }) });
    await expect(startHostCompute(t.env)).rejects.toThrow(field);
    expect(startSpy).not.toHaveBeenCalled();
    expect(t.page.posts).toEqual([]);
    expect(t.workers).toEqual([]);
  });

  it.each(["geometricUrl", "geometricManifestSha256", "geometricDebug", "geometricWatchdog"])("throws for %s, the other geometric fields too", async (field) => {
    const t = env({ loadRequest: () => ({ ...BUNDLED, [field]: field === "geometricDebug" || field === "geometricWatchdog" ? false : "x" }) });
    await expect(startHostCompute(t.env)).rejects.toThrow(field);
  });

  it("accepts the same request when the product can have the stage, and starts at pointer in focus scope", async () => {
    const t = env({ config: config({}, true), loadRequest: () => withStage });
    (await startHostCompute(t.env))!.stop();
    expect(optionsReached()).toMatchObject({ geometricScope: "focus", geometricLoad: "pointer", loadRequest: withStage });
  });

  it("accepts a request whose geometric fields are present but undefined, since no stage can load from them", async () => {
    const request = { ...BUNDLED, geometricUrl: undefined, geometricDebug: undefined };
    (await startHostCompute(env({ loadRequest: () => request }).env))!.stop();
    expect(optionsReached().loadRequest).toBe(request);
  });

  it("accepts a plain request without the capability", async () => {
    (await startHostCompute(env().env))!.stop();
    expect(optionsReached().loadRequest).toBe(BUNDLED);
  });
});

describe("the options that reach the compute frame, next to what each product passes today", () => {
  const hooks = {
    chooseRelease: async () => ({ source: "bundled" as const, reason: "x", pointer: null, downloaded: 0, ms: 0 }),
    recordSkip: () => undefined,
    onDecision: () => undefined,
    onGeometricStatus: () => undefined,
  };
  const onShown = () => undefined;
  const onAnalysis = () => undefined;
  const dataOf = (o: ComputeFrameEnv) => {
    const { win: _w, protocol: _p, ...rest } = o as ComputeFrameEnv & Record<string, unknown>;
    return Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v !== "function"));
  };
  const functionKeys = (o: object) => Object.keys(o).filter((k) => typeof (o as Record<string, unknown>)[k] === "function").sort();

  it("Kenbunshoku: the same options, with the session mode named", async () => {
    // Kenbunshoku's compute page (its production build) passes: win, framed, parentOrigin,
    // allowedParentOrigin, protocol, rotatedOutlines, geometricScope "focus", geometricLoad
    // "pointer", measuredPacing, hold, idleUnloadMs 600000, onShown, createWorker, loadRequest, now,
    // chooseRelease, recordSkip, onDecision, onGeometricStatus (and onAnalysis in a development build).
    const request = { ...BUNDLED, geometricUrl: "extension://x/geometric/index.json" };
    const t = env({ config: config({}, true), loadRequest: () => request, release: hooks, observe: { onShown, onAnalysis } });
    (await startHostCompute(t.env))!.stop();
    const reached = optionsReached();
    const product = {
      framed: true,
      parentOrigin: SITE,
      rotatedOutlines: true,
      geometricScope: "focus",
      geometricLoad: "pointer",
      measuredPacing: true,
      hold: READING_HOLD,
      idleUnloadMs: 600_000,
      loadRequest: request,
    };
    expect(dataOf(reached)).toEqual({ ...product, mode: "pointer" });
    expect(functionKeys(reached)).toEqual(["allowedParentOrigin", "chooseRelease", "createWorker", "now", "onAnalysis", "onDecision", "onGeometricStatus", "onShown", "recordSkip"]);
    expect(reached.onShown).toBe(onShown);
    expect(reached.chooseRelease).toBe(hooks.chooseRelease);
    expect(reached.protocol.tag({ kind: "x" })).toEqual(protocol.tag({ kind: "x" }));
    expect(reached.allowedParentOrigin(SITE)).toBe(true);
    expect(reached.allowedParentOrigin("https://example.com")).toBe(false);
  });

  it("Kenbunshoku: keep-card off gives the short hold, as its stored switch does", async () => {
    (await startHostCompute(env({ config: config({}, true), storage: memoryStorage({ keepCard: false }) }).env))!.stop();
    expect(optionsReached().hold).toBe(SHOWN_HOLD);
  });

  it("DuelSight: the same options, with the session mode named and no geometric pair", async () => {
    // DuelSight's frame (its production build) passes: win, framed, parentOrigin, allowedParentOrigin,
    // protocol, hold, rotatedOutlines, measuredPacing, idleUnloadMs 600000, onShown, createWorker,
    // loadRequest, now, chooseRelease, recordSkip, onDecision (and onAnalysis in a development build).
    const { onGeometricStatus: _g, ...ds } = hooks;
    const t = env({ release: ds, observe: { onShown, onAnalysis } });
    (await startHostCompute(t.env))!.stop();
    const reached = optionsReached();
    const product = { framed: true, parentOrigin: SITE, hold: READING_HOLD, rotatedOutlines: true, measuredPacing: true, idleUnloadMs: 600_000, loadRequest: BUNDLED };
    expect(dataOf(reached)).toEqual({ ...product, mode: "pointer" });
    expect(functionKeys(reached)).toEqual(["allowedParentOrigin", "chooseRelease", "createWorker", "now", "onAnalysis", "onDecision", "onShown", "recordSkip"]);
    expect(reached).not.toHaveProperty("geometricScope");
    expect(reached).not.toHaveProperty("geometricLoad");
  });

  it("DuelSight: keep-card off gives the short hold, and a dev build's idle unload replaces 10 minutes", async () => {
    (await startHostCompute(env({ config: config({ dev: true }), storage: memoryStorage({ keepCard: false }), devIdleUnloadMs: 60_000 }).env))!.stop();
    expect(optionsReached()).toMatchObject({ hold: SHOWN_HOLD, idleUnloadMs: 60_000 });
  });

  it("name the pointer mode, which is the session's default: the compute frame starts with it either way", async () => {
    const make = (extra: Partial<ComputeFrameEnv>) => {
      const t = env({ config: config({}, true) });
      const o = { win: t.env.win, framed: true, parentOrigin: SITE, allowedParentOrigin: () => true, protocol, ...STANDARD_PRESET, ...GEOMETRIC_OPTIONS, createWorker: t.env.createWorker, loadRequest: BUNDLED, now: () => 0, ...extra };
      return computeFrame.startComputeFrame(o as ComputeFrameEnv);
    };
    const { mode: _m, ...withoutMode } = { ...STANDARD_PRESET };
    expect(make({})).not.toBeNull();
    expect(make(withoutMode as Partial<ComputeFrameEnv>)).not.toBeNull();
  });
});

describe("the first calls", () => {
  it("calls loadRequest once, after the origin check and before the first message", async () => {
    const t = env();
    (await startHostCompute(t.env))!.stop();
    expect(t.loadRequest).toHaveBeenCalledTimes(1);
    expect(t.log[0]).toBe("loadRequest");
    expect(t.log.indexOf("loadRequest")).toBeLessThan(t.log.findIndex((e) => e.startsWith("post:")));
    expect(t.log.some((e) => e.startsWith("post:"))).toBe(true);
  });

  it("waits for an asynchronous loadRequest before it starts the compute frame", async () => {
    let release!: (r: typeof BUNDLED) => void;
    const t = env({ loadRequest: () => new Promise<typeof BUNDLED>((r) => (release = r)) });
    const started = startHostCompute(t.env);
    await Promise.resolve();
    expect(startSpy).not.toHaveBeenCalled();
    expect(t.page.posts).toEqual([]);
    release(BUNDLED);
    (await started)!.stop();
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("does not post a message when loadRequest rejects", async () => {
    const t = env({ loadRequest: () => Promise.reject(new Error("settings")) });
    await expect(startHostCompute(t.env)).rejects.toThrow("settings");
    expect(t.page.posts).toEqual([]);
  });
});

describe("observers", () => {
  it("runs observe.onShown synchronously, before the shown card is posted", async () => {
    const log: string[] = [];
    const seen: Array<unknown> = [];
    const t = env({ observe: { onShown: (card, release) => void (log.push("onShown"), seen.push([card, release.source])) } });
    // The observer's entry goes into the same log as the page's posts.
    const page = fakeWindow([SITE], log);
    const host = (await startHostCompute({ ...t.env, win: page.win }))!;
    log.length = 0;
    page.send(protocol.tag({ kind: "hello", version: PROTOCOL_VERSION }));
    // All inside the one synchronous delivery of the hello.
    expect(log).toEqual(["post:ready", "post:status", "onShown", "post:shown"]);
    expect(seen).toEqual([[null, "bundled"]]);
    host.stop();
  });

  it("passes the release hooks and analysis observer to the compute frame as given", async () => {
    const onAnalysis = () => undefined;
    const hooks = { recordSkip: () => undefined, onDecision: () => undefined };
    (await startHostCompute(env({ observe: { onAnalysis }, release: hooks }).env))!.stop();
    expect(optionsReached().onAnalysis).toBe(onAnalysis);
    expect(optionsReached().recordSkip).toBe(hooks.recordSkip);
    expect(optionsReached().onDecision).toBe(hooks.onDecision);
    expect(optionsReached()).not.toHaveProperty("chooseRelease");
  });

  it("never lets a stray field on the observers or release hooks replace an option the host sets", async () => {
    const onShown = () => undefined;
    const recordSkip = () => undefined;
    // Objects a product already had, carrying more than the hooks (only fresh literals are type-checked).
    const stray = { hold: SHOWN_HOLD, idleUnloadMs: 1, parentOrigin: "https://elsewhere.example", allowedParentOrigin: () => true, rotatedOutlines: false, mode: "auto" };
    const observe = { ...stray, onShown } as unknown as HostComputeEnv["observe"];
    const release = { ...stray, recordSkip } as unknown as HostComputeEnv["release"];
    (await startHostCompute(env({ observe, release }).env))!.stop();
    const reached = optionsReached();
    expect(reached).toMatchObject({ hold: READING_HOLD, idleUnloadMs: 600_000, parentOrigin: SITE, rotatedOutlines: true, mode: "pointer" });
    expect(reached.allowedParentOrigin("https://elsewhere.example")).toBe(false);
    expect(reached.onShown).toBe(onShown);
    expect(reached.recordSkip).toBe(recordSkip);
  });
});

describe("the driver tick and page hide", () => {
  it("ticks the frame every DRIVER_TICK_MS, and stops on page hide", async () => {
    vi.useFakeTimers();
    const t = env();
    const host = (await startHostCompute(t.env))!;
    const tick = vi.spyOn(host.frame, "tick");
    vi.advanceTimersByTime(DRIVER_TICK_MS * 4);
    expect(tick).toHaveBeenCalledTimes(4);
    for (const fn of [...t.page.listeners.get("pagehide")!]) fn(undefined as never);
    expect(host.frame.stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(DRIVER_TICK_MS * 4);
    expect(tick).toHaveBeenCalledTimes(4);
    expect(t.page.listeners.get("pagehide")!.size).toBe(0);
  });

  it("stop() is idempotent and leaves no timer or listener", async () => {
    vi.useFakeTimers();
    const t = env();
    const host = (await startHostCompute(t.env))!;
    host.stop();
    host.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(t.page.listeners.get("pagehide")!.size).toBe(0);
    expect(t.page.listeners.get("message")!.size).toBe(0);
    expect(host.frame.stopped).toBe(true);
  });

  it("starts no timer or listener for a page that gives null", async () => {
    vi.useFakeTimers();
    const t = env({}, ["https://example.com"]);
    expect(await startHostCompute(t.env)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(t.page.listeners.size).toBe(0);
  });
});
