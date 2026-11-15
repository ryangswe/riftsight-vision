// SPDX-License-Identifier: Apache-2.0
// The host's two switches, on and keep-card: reads, flips and the start-up race (hover spec S-H1).
import { describe, expect, it } from "vitest";

import { createSwitches, ENABLED_KEY, KEEP_CARD_KEY } from "../src/host/switches.js";
import { changeBus, memoryStorage } from "./support/host-storage.js";

const KEYS = [
  ["enabled", ENABLED_KEY],
  ["keepCard", KEEP_CARD_KEY],
] as const;

function spy() {
  const calls: string[] = [];
  return { calls, on: { enabled: (v: boolean) => void calls.push(`enabled:${v}`), keepCard: (v: boolean) => void calls.push(`keepCard:${v}`) } };
}

describe.each(KEYS)("the %s switch", (name, key) => {
  it("is on unless stored false", async () => {
    expect(await createSwitches(memoryStorage(), changeBus())[name]()).toBe(true);
    for (const value of [true, null, "false", 0, {}]) expect(await createSwitches(memoryStorage({ [key]: value }), changeBus())[name]()).toBe(true);
    expect(await createSwitches(memoryStorage({ [key]: false }), changeBus())[name]()).toBe(false);
  });

  it("reads as on when the storage cannot be read", async () => {
    const broken = { get: () => Promise.reject(new Error("no storage")) };
    expect(await createSwitches(broken, changeBus())[name]()).toBe(true);
  });

  it("calls back for a flip, each way", () => {
    const bus = changeBus();
    const { calls, on } = spy();
    createSwitches(memoryStorage(), bus).watch(on);
    bus.emit({ [key]: { oldValue: true, newValue: false } });
    bus.emit({ [key]: { oldValue: false, newValue: true } });
    // The first press on a fresh install stores false over nothing: on to off.
    bus.emit({ [key]: { newValue: false } });
    // Cleared storage after off is on again.
    bus.emit({ [key]: { oldValue: false } });
    expect(calls).toEqual([`${name}:false`, `${name}:true`, `${name}:false`, `${name}:true`]);
  });

  it("calls nothing for a write of the same state", () => {
    const bus = changeBus();
    const { calls, on } = spy();
    createSwitches(memoryStorage(), bus).watch(on);
    bus.emit({ [key]: { oldValue: true, newValue: true } });
    bus.emit({ [key]: { oldValue: false, newValue: false } });
    bus.emit({ [key]: { oldValue: "x", newValue: true } });
    expect(calls).toEqual([]);
  });

  it("calls nothing for a missing value written as true (no flip)", () => {
    const bus = changeBus();
    const { calls, on } = spy();
    createSwitches(memoryStorage(), bus).watch(on);
    bus.emit({ [key]: { newValue: true } });
    expect(calls).toEqual([]);
  });

  it("calls nothing when a key is removed and it was on or missing", () => {
    const bus = changeBus();
    const { calls, on } = spy();
    createSwitches(memoryStorage(), bus).watch(on);
    bus.emit({ [key]: { oldValue: true } });
    bus.emit({ [key]: {} });
    bus.emit({ [key]: undefined });
    expect(calls).toEqual([]);
  });

  it("ignores another storage area", () => {
    const bus = changeBus();
    const { calls, on } = spy();
    createSwitches(memoryStorage(), bus).watch(on);
    bus.emit({ [key]: { oldValue: true, newValue: false } }, "sync");
    expect(calls).toEqual([]);
  });
});

describe("watch", () => {
  it("passes each switch on to its own callback, and ignores other keys", () => {
    const bus = changeBus();
    const { calls, on } = spy();
    createSwitches(memoryStorage(), bus).watch(on);
    bus.emit({ cardSize: { newValue: 120 }, details: { newValue: false } });
    bus.emit({ enabled: { newValue: false }, keepCard: { newValue: false } });
    expect(calls).toEqual(["enabled:false", "keepCard:false"]);
  });

  it("serves a watcher that wants only one switch", () => {
    const bus = changeBus();
    const calls: boolean[] = [];
    createSwitches(memoryStorage(), bus).watch({ keepCard: (v) => void calls.push(v) });
    bus.emit({ enabled: { newValue: false } });
    bus.emit({ keepCard: { newValue: false } });
    expect(calls).toEqual([false]);
  });

  it("stops when the returned stop is called", () => {
    const bus = changeBus();
    const { calls, on } = spy();
    const stop = createSwitches(memoryStorage(), bus).watch(on);
    expect(bus.listeners).toBe(1);
    stop();
    expect(bus.listeners).toBe(0);
    bus.emit({ enabled: { newValue: false } });
    expect(calls).toEqual([]);
  });
});

describe("the start-up read (S-H1)", () => {
  /** A storage whose read answers only when released. */
  function pending(stored: Record<string, unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const storage = { get: async (key: string) => (await gate, key in stored ? { [key]: stored[key] } : {}) };
    return { storage, release };
  }

  it("subscribes before it reads", async () => {
    const bus = changeBus();
    const { storage, release } = pending({});
    const result = createSwitches(storage, bus).enabled();
    expect(bus.listeners).toBe(1);
    release();
    await result;
    expect(bus.listeners).toBe(0);
  });

  it("keeps a flip to off that arrives while the read is pending, though the read returns on", async () => {
    const bus = changeBus();
    const { storage, release } = pending({ enabled: true });
    const result = createSwitches(storage, bus).enabled();
    bus.emit({ enabled: { oldValue: true, newValue: false } });
    release();
    expect(await result).toBe(false);
  });

  it("keeps a flip to on that arrives while the read is pending, though the read returns off", async () => {
    const bus = changeBus();
    const { storage, release } = pending({ enabled: false });
    const result = createSwitches(storage, bus).enabled();
    bus.emit({ enabled: { oldValue: false, newValue: true } });
    release();
    expect(await result).toBe(true);
  });

  it("lets the last of several flips win", async () => {
    const bus = changeBus();
    const { storage, release } = pending({});
    const result = createSwitches(storage, bus).enabled();
    bus.emit({ enabled: { newValue: false } });
    bus.emit({ enabled: { oldValue: false, newValue: true } });
    release();
    expect(await result).toBe(true);
  });

  it("keeps a flip when the read fails too", async () => {
    const bus = changeBus();
    let fail!: () => void;
    const gate = new Promise<void>((_, reject) => (fail = () => reject(new Error("gone"))));
    const result = createSwitches({ get: () => gate.then(() => ({})) }, bus).enabled();
    bus.emit({ enabled: { newValue: false } });
    fail();
    expect(await result).toBe(false);
  });

  it("ignores a flip of another switch, another key or another area", async () => {
    const bus = changeBus();
    const { storage, release } = pending({ enabled: false });
    const result = createSwitches(storage, bus).enabled();
    bus.emit({ keepCard: { newValue: true } });
    bus.emit({ cardSize: { newValue: 120 } });
    bus.emit({ enabled: { newValue: true } }, "sync");
    release();
    expect(await result).toBe(false);
  });

  it("applies the same rule to keep-card", async () => {
    const bus = changeBus();
    const { storage, release } = pending({ keepCard: true });
    const result = createSwitches(storage, bus).keepCard();
    bus.emit({ keepCard: { oldValue: true, newValue: false } });
    release();
    expect(await result).toBe(false);
  });

  it("stores nothing and reads the stored value when nothing flips", async () => {
    const bus = changeBus();
    const storage = memoryStorage({ enabled: false });
    expect(await createSwitches(storage, bus).enabled()).toBe(false);
    expect(storage.data).toEqual({ enabled: false });
  });
});
