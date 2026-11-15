// SPDX-License-Identifier: Apache-2.0
// The shared hover host's lifecycle reducer: one table per rule. Pure: no DOM, no timers.
import { describe, expect, it } from "vitest";

import {
  INITIAL_LIFECYCLE,
  type LifecycleEffect,
  type LifecycleEvent,
  type LifecycleFacts,
  type LifecyclePhase,
  type LifecycleState,
  lifecycleStep,
} from "../src/host/lifecycle.js";

type FactsIn = Partial<Omit<LifecycleFacts, "frames">> & { frames?: Partial<LifecycleFacts["frames"]> };

/** Defaults: the tab in front, a load-at-play page, the main video playing, no frames. */
function facts(over: FactsIn = {}): LifecycleFacts {
  const { frames, ...rest } = over;
  return Object.freeze({
    visible: true,
    page: "play" as const,
    mainPlaying: true,
    ...rest,
    frames: Object.freeze({ compute: false, view: false, ...frames }),
  });
}

const BOTH = { compute: true, view: true };
const NONE = { compute: false, view: false };

function state(phase: LifecyclePhase, over: Partial<LifecycleState> = {}): LifecycleState {
  return Object.freeze({ phase, remakeOwed: false, switchHeard: true, ...over });
}

const ON: LifecycleEvent = { type: "switch", on: true, from: "flip" };
const OFF: LifecycleEvent = { type: "switch", on: false, from: "flip" };
const READ_ON: LifecycleEvent = { type: "switch", on: true, from: "read" };
const READ_OFF: LifecycleEvent = { type: "switch", on: false, from: "read" };
const PLAYING: LifecycleEvent = { type: "playing", trusted: true };
const FAKE_PLAYING: LifecycleEvent = { type: "playing", trusted: false };
const POINTER: LifecycleEvent = { type: "pointer", trusted: true, overPicture: true };
const FRONT: LifecycleEvent = { type: "front" };
const IDLE_REMOVE: LifecycleEvent = { type: "idle-remove" };
const IDLE_MAKE: LifecycleEvent = { type: "idle-make" };
const KEEP_CARD: LifecycleEvent = { type: "keep-card" };
const SHOWN: LifecycleEvent = { type: "shown" };

const MAKE: LifecycleEffect = { type: "make", connect: true };
const CONTROL_MAKE: LifecycleEffect = { type: "make", connect: false };
const REMAKE: LifecycleEffect = { type: "remake-compute" };
const REMOVE: LifecycleEffect = { type: "remove" };
const DETACH: LifecycleEffect = { type: "detach-video" };
const SHOW: LifecycleEffect = { type: "show" };

/** Runs events in order, each with its facts, and returns the last state and every effect. */
function run(start: LifecycleState, steps: [LifecycleEvent, LifecycleFacts][]): { state: LifecycleState; effects: LifecycleEffect[] } {
  let current = start;
  const effects: LifecycleEffect[] = [];
  for (const [event, at] of steps) {
    const next = lifecycleStep(current, event, at);
    effects.push(...next.effects);
    current = next.state;
  }
  return { state: current, effects };
}

interface Row {
  name: string;
  from: LifecycleState;
  event: LifecycleEvent;
  facts: LifecycleFacts;
  phase: LifecyclePhase;
  effects: LifecycleEffect[];
  remakeOwed?: boolean;
}

function table(rows: Row[]): void {
  it.each(rows.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    const next = lifecycleStep(row.from, row.event, row.facts);
    expect(next.state.phase).toBe(row.phase);
    expect(next.effects).toEqual(row.effects);
    if (row.remakeOwed !== undefined) expect(next.state.remakeOwed).toBe(row.remakeOwed);
    // Nothing changed: the same state object comes back (a first switch value is heard, though).
    if (row.effects.length === 0 && row.phase === row.from.phase && row.remakeOwed === undefined && row.from.switchHeard) expect(next.state).toBe(row.from);
    if (row.event.type === "switch") expect(next.state.switchHeard).toBe(true);
  });
}

describe("S-A1: a trusted playing of the main video on a load-at-play page makes the frames", () => {
  table([
    { name: "waiting, in front, main playing: made", from: state("waiting"), event: PLAYING, facts: facts(), phase: "live", effects: [MAKE] },
    { name: "waiting, the main video paused: nothing", from: state("waiting"), event: PLAYING, facts: facts({ mainPlaying: false }), phase: "waiting", effects: [] },
    { name: "waiting, a page that loads at the pointer: nothing", from: state("waiting"), event: PLAYING, facts: facts({ page: "pointer" }), phase: "waiting", effects: [] },
    { name: "waiting, a page that is not active: nothing", from: state("waiting"), event: PLAYING, facts: facts({ page: "inactive" }), phase: "waiting", effects: [] },
    { name: "an untrusted playing while waiting: nothing", from: state("waiting"), event: FAKE_PLAYING, facts: facts(), phase: "waiting", effects: [] },
    { name: "an untrusted playing after a frame was deleted: nothing", from: state("live"), event: FAKE_PLAYING, facts: facts({ frames: { compute: false, view: true } }), phase: "live", effects: [] },
    { name: "an untrusted playing while owed: nothing", from: state("owed"), event: FAKE_PLAYING, facts: facts(), phase: "owed", effects: [] },
    { name: "live with both frames: a repeated playing makes nothing", from: state("live"), event: PLAYING, facts: facts({ frames: BOTH }), phase: "live", effects: [] },
    { name: "off: nothing", from: state("off"), event: PLAYING, facts: facts(), phase: "off", effects: [] },
  ]);

  it("an untrusted playing reads no facts, so the host need not pick the video again", () => {
    const watched: LifecycleFacts = {
      get visible(): boolean {
        throw new Error("visible read");
      },
      get page(): never {
        throw new Error("page read");
      },
      get mainPlaying(): boolean {
        throw new Error("mainPlaying read");
      },
      get frames(): never {
        throw new Error("frames read");
      },
    };
    for (const phase of ["off", "waiting", "owed", "live", "idle"] as const) {
      const from = state(phase);
      expect(lifecycleStep(from, FAKE_PLAYING, watched)).toEqual({ state: from, effects: [] });
    }
  });
});

describe("S-G4: the re-picked main video decides, whatever the playing event's target", () => {
  table([
    // The host picks again on a trusted playing: a smaller video playing while the main one is
    // paused gives mainPlaying false.
    { name: "a smaller video plays, the main one is paused: nothing", from: state("waiting"), event: PLAYING, facts: facts({ mainPlaying: false }), phase: "waiting", effects: [] },
    { name: "the re-picked main video plays: made", from: state("waiting"), event: PLAYING, facts: facts({ mainPlaying: true }), phase: "live", effects: [MAKE] },
  ]);
});

describe("S-A2: elsewhere, a trusted pointer over the picture makes the frames", () => {
  table([
    { name: "waiting, a page that loads at the pointer: made", from: state("waiting"), event: POINTER, facts: facts({ page: "pointer", mainPlaying: false }), phase: "live", effects: [MAKE] },
    { name: "waiting, a paused video on a load-at-play page: made", from: state("waiting"), event: POINTER, facts: facts({ mainPlaying: false }), phase: "live", effects: [MAKE] },
    { name: "a pointer not over the picture: nothing", from: state("waiting"), event: { type: "pointer", trusted: true, overPicture: false }, facts: facts({ page: "pointer" }), phase: "waiting", effects: [] },
    { name: "an untrusted pointer: nothing", from: state("waiting"), event: { type: "pointer", trusted: false, overPicture: true }, facts: facts({ page: "pointer" }), phase: "waiting", effects: [] },
    { name: "a page that is not active: nothing", from: state("waiting"), event: POINTER, facts: facts({ page: "inactive" }), phase: "waiting", effects: [] },
    { name: "off: nothing", from: state("off"), event: POINTER, facts: facts({ page: "pointer" }), phase: "off", effects: [] },
    { name: "live with both frames: nothing", from: state("live"), event: POINTER, facts: facts({ frames: BOTH }), phase: "live", effects: [] },
  ]);
});

describe("S-A6: after an idle removal only the control's make() or a switch-on makes frames", () => {
  table([
    { name: "live: the control's idle remove() removes both frames, the video stays", from: state("live"), event: IDLE_REMOVE, facts: facts({ frames: BOTH }), phase: "idle", effects: [REMOVE] },
    { name: "idle: a trusted playing makes nothing", from: state("idle"), event: PLAYING, facts: facts(), phase: "idle", effects: [] },
    { name: "idle: the host's pointer listener makes nothing (the control answers)", from: state("idle"), event: POINTER, facts: facts(), phase: "idle", effects: [] },
    { name: "idle: the tab coming to the front makes nothing", from: state("idle"), event: FRONT, facts: facts(), phase: "idle", effects: [] },
    { name: "idle: the control's make() makes them, and the control connects", from: state("idle"), event: IDLE_MAKE, facts: facts(), phase: "live", effects: [CONTROL_MAKE] },
    { name: "off: the control's make() makes nothing", from: state("off"), event: IDLE_MAKE, facts: facts(), phase: "off", effects: [] },
  ]);

  it("repeated playing after idle (a looping clip) makes nothing, then the control's make() does", () => {
    const loops = Array.from({ length: 5 }, (): [LifecycleEvent, LifecycleFacts] => [PLAYING, facts()]);
    const { state: after, effects } = run(state("live"), [[IDLE_REMOVE, facts({ frames: BOTH })], ...loops]);
    expect(after.phase).toBe("idle");
    expect(effects).toEqual([REMOVE]);
    expect(lifecycleStep(after, IDLE_MAKE, facts()).effects).toEqual([CONTROL_MAKE]);
  });
});

describe("S-A7: a switch-on, the start-up read included, is a fresh start", () => {
  it.each([
    ["in front", true, "live", [MAKE]],
    ["behind", false, "owed", []],
  ] as const)("switch-on after idle, %s", (_where, visible, phase, effects) => {
    const { state: after, effects: seen } = run(state("live"), [
      [IDLE_REMOVE, facts({ frames: BOTH, visible })],
      [OFF, facts({ visible })],
      [ON, facts({ visible })],
    ]);
    expect(after.phase).toBe(phase);
    expect(seen).toEqual([REMOVE, REMOVE, DETACH, ...effects]);
  });

  it("switch-on after idle, behind: paid when the tab comes to the front with the video playing", () => {
    const { state: after, effects } = run(state("idle"), [
      [OFF, facts({ visible: false })],
      [ON, facts({ visible: false })],
      [FRONT, facts()],
    ]);
    expect(after.phase).toBe("live");
    expect(effects).toEqual([REMOVE, DETACH, MAKE]);
  });

  it("switch-on after idle, behind: dropped when the tab comes to the front with the video paused", () => {
    const { state: after, effects } = run(state("idle"), [
      [OFF, facts({ visible: false })],
      [ON, facts({ visible: false })],
      [FRONT, facts({ mainPlaying: false })],
    ]);
    expect(after.phase).toBe("waiting");
    expect(effects).toEqual([REMOVE, DETACH]);
  });

  it("switch-on after idle, in front, with the video paused: waiting, then its playing makes the frames", () => {
    const { state: after, effects } = run(state("idle"), [
      [OFF, facts()],
      [ON, facts({ mainPlaying: false })],
      [PLAYING, facts()],
    ]);
    expect(after.phase).toBe("live");
    expect(effects).toEqual([REMOVE, DETACH, MAKE]);
  });

  it("a switch-on behind with frames never removed for idleness is owed, not made at once", () => {
    const first = run(state("live"), [
      [OFF, facts({ visible: false, frames: BOTH })],
      [ON, facts({ visible: false })],
    ]);
    expect(first.state.phase).toBe("owed");
    expect(first.effects).toEqual([REMOVE, DETACH]);
    const front = lifecycleStep(first.state, FRONT, facts());
    expect(front.state.phase).toBe("live");
    expect(front.effects).toEqual([MAKE]);
  });

  describe("the start-up read with the main video already playing", () => {
    table([
      { name: "a load-at-play page, in front: made at once", from: INITIAL_LIFECYCLE, event: READ_ON, facts: facts(), phase: "live", effects: [MAKE] },
      { name: "a load-at-play page, behind: owed", from: INITIAL_LIFECYCLE, event: READ_ON, facts: facts({ visible: false }), phase: "owed", effects: [] },
      { name: "a page that loads at the pointer, in front: waiting", from: INITIAL_LIFECYCLE, event: READ_ON, facts: facts({ page: "pointer" }), phase: "waiting", effects: [] },
      { name: "a page that loads at the pointer, behind: waiting (nothing is owed there)", from: INITIAL_LIFECYCLE, event: READ_ON, facts: facts({ page: "pointer", visible: false }), phase: "waiting", effects: [] },
      { name: "a page that is not active, in front: waiting", from: INITIAL_LIFECYCLE, event: READ_ON, facts: facts({ page: "inactive" }), phase: "waiting", effects: [] },
      { name: "a load-at-play page, in front, the video paused: waiting", from: INITIAL_LIFECYCLE, event: READ_ON, facts: facts({ mainPlaying: false }), phase: "waiting", effects: [] },
      { name: "the read answers off: off, nothing to remove", from: INITIAL_LIFECYCLE, event: READ_OFF, facts: facts(), phase: "off", effects: [] },
    ]);

    it.each([
      ["a load-at-play page", "play", "live", [MAKE]],
      ["a page that loads at the pointer", "pointer", "waiting", []],
    ] as const)("behind, then the tab comes to the front, %s", (_name, page, phase, effects) => {
      const { state: after, effects: seen } = run(INITIAL_LIFECYCLE, [
        [READ_ON, facts({ page, visible: false })],
        [FRONT, facts({ page })],
      ]);
      expect(after.phase).toBe(phase);
      expect(seen).toEqual(effects);
    });
  });

  table([
    { name: "a switch-on while already on changes nothing", from: state("live"), event: ON, facts: facts({ frames: BOTH }), phase: "live", effects: [] },
    { name: "a switch-off while off changes nothing", from: state("off"), event: OFF, facts: facts(), phase: "off", effects: [] },
  ]);
});

describe("S-H1: the host subscribes before it reads; a flip during the read wins", () => {
  it("the popup turns hovers off while the read is pending, the read answers on: off", () => {
    const { state: after, effects } = run(INITIAL_LIFECYCLE, [
      [OFF, facts()],
      [READ_ON, facts()],
    ]);
    expect(after.phase).toBe("off");
    expect(effects).toEqual([]);
  });

  it("the popup turns hovers on while the read is pending, the read answers off: on", () => {
    const { state: after, effects } = run(INITIAL_LIFECYCLE, [
      [ON, facts()],
      [READ_OFF, facts({ frames: BOTH })],
    ]);
    expect(after.phase).toBe("live");
    expect(effects).toEqual([MAKE]);
  });

  it("after the read has answered, later flips apply", () => {
    const { state: after, effects } = run(INITIAL_LIFECYCLE, [
      [READ_OFF, facts()],
      [ON, facts()],
    ]);
    expect(after.phase).toBe("live");
    expect(effects).toEqual([MAKE]);
  });
});

describe("S-A8: in a hidden tab the load is owed, paid at the front with the video playing", () => {
  table([
    { name: "waiting, a trusted playing behind: owed, nothing made", from: state("waiting"), event: PLAYING, facts: facts({ visible: false }), phase: "owed", effects: [] },
    { name: "owed, another playing behind: still owed", from: state("owed"), event: PLAYING, facts: facts({ visible: false }), phase: "owed", effects: [] },
    { name: "owed, a playing on a page that loads at the pointer: still owed", from: state("owed"), event: PLAYING, facts: facts({ visible: false, page: "pointer" }), phase: "owed", effects: [] },
    { name: "owed, front with the video playing: made", from: state("owed"), event: FRONT, facts: facts(), phase: "live", effects: [MAKE] },
    { name: "owed, front with the video paused: dropped", from: state("owed"), event: FRONT, facts: facts({ mainPlaying: false }), phase: "waiting", effects: [] },
    { name: "owed, front after navigating to a page that loads at the pointer: dropped", from: state("owed"), event: FRONT, facts: facts({ page: "pointer" }), phase: "waiting", effects: [] },
    { name: "owed, switched off: off", from: state("owed"), event: OFF, facts: facts({ visible: false }), phase: "off", effects: [REMOVE, DETACH] },
    { name: "waiting, front: nothing owed, nothing made", from: state("waiting"), event: FRONT, facts: facts(), phase: "waiting", effects: [] },
  ]);

  it("five tabs start playing behind: none loads until it comes to the front", () => {
    const tabs = Array.from({ length: 5 }, () => run(state("waiting"), [[PLAYING, facts({ visible: false })]]));
    for (const tab of tabs) expect(tab).toEqual({ state: state("owed"), effects: [] });
    expect(lifecycleStep(tabs[0]!.state, FRONT, facts()).effects).toEqual([MAKE]);
  });
});

describe("S-A10: a frame the page deleted is made again at a trusted play or pointer", () => {
  const VIEW_GONE = { compute: true, view: false };
  const COMPUTE_GONE = { compute: false, view: true };
  table([
    { name: "the view frame deleted, a trusted play on a load-at-play page: made again", from: state("live"), event: PLAYING, facts: facts({ frames: VIEW_GONE }), phase: "live", effects: [MAKE] },
    { name: "the compute frame deleted, a trusted play: made again", from: state("live"), event: PLAYING, facts: facts({ frames: COMPUTE_GONE }), phase: "live", effects: [MAKE] },
    { name: "a frame deleted, a trusted play on a page that loads at the pointer: nothing", from: state("live"), event: PLAYING, facts: facts({ frames: VIEW_GONE, page: "pointer" }), phase: "live", effects: [] },
    { name: "a frame deleted, a trusted play with the main video paused: nothing", from: state("live"), event: PLAYING, facts: facts({ frames: VIEW_GONE, mainPlaying: false }), phase: "live", effects: [] },
    { name: "a frame deleted, an untrusted play: nothing", from: state("live"), event: FAKE_PLAYING, facts: facts({ frames: VIEW_GONE }), phase: "live", effects: [] },
    { name: "a frame deleted, a trusted pointer over the picture: made again", from: state("live"), event: POINTER, facts: facts({ frames: COMPUTE_GONE, page: "pointer" }), phase: "live", effects: [MAKE] },
    { name: "a frame deleted, an untrusted pointer: nothing", from: state("live"), event: { type: "pointer", trusted: false, overPicture: true }, facts: facts({ frames: COMPUTE_GONE }), phase: "live", effects: [] },
    { name: "a frame deleted, the tab coming to the front: nothing", from: state("live"), event: FRONT, facts: facts({ frames: NONE }), phase: "live", effects: [] },
    { name: "a frame deleted, a trusted play behind: owed", from: state("live"), event: PLAYING, facts: facts({ frames: VIEW_GONE, visible: false }), phase: "owed", effects: [] },
  ]);
});

describe("S-H3: a keep-card flip remakes the compute frame, now in front, later behind", () => {
  table([
    { name: "live, in front: remade now", from: state("live"), event: KEEP_CARD, facts: facts({ frames: BOTH }), phase: "live", effects: [REMAKE], remakeOwed: false },
    { name: "live, behind: owed", from: state("live"), event: KEEP_CARD, facts: facts({ frames: BOTH, visible: false }), phase: "live", effects: [], remakeOwed: true },
    { name: "waiting, no compute frame: nothing", from: state("waiting"), event: KEEP_CARD, facts: facts(), phase: "waiting", effects: [] },
    { name: "idle, no compute frame: nothing", from: state("idle"), event: KEEP_CARD, facts: facts(), phase: "idle", effects: [] },
    { name: "off: nothing", from: state("off"), event: KEEP_CARD, facts: facts({ visible: false }), phase: "off", effects: [] },
    { name: "live, the compute frame deleted: nothing", from: state("live"), event: KEEP_CARD, facts: facts({ frames: { compute: false, view: true } }), phase: "live", effects: [] },
  ]);

  it("a background tab with a pending flip remakes once, however many flips came", () => {
    const behind = facts({ frames: BOTH, visible: false });
    const { state: after, effects } = run(state("live"), [
      [KEEP_CARD, behind],
      [KEEP_CARD, behind],
      [KEEP_CARD, behind],
      [FRONT, facts({ frames: BOTH })],
      [FRONT, facts({ frames: BOTH })],
    ]);
    expect(effects).toEqual([REMAKE]);
    expect(after).toEqual(state("live"));
  });

  it("an owed load and an owed flip are paid together by one remake", () => {
    const { state: after, effects } = run(state("live"), [
      [KEEP_CARD, facts({ frames: BOTH, visible: false })],
      [PLAYING, facts({ frames: { compute: true, view: false }, visible: false })],
      [FRONT, facts({ frames: { compute: true, view: false } })],
    ]);
    expect(effects).toEqual([REMAKE]);
    expect(after).toEqual(state("live"));
  });

  it("a new compute frame clears the flag", () => {
    const owed = run(state("live"), [[KEEP_CARD, facts({ frames: BOTH, visible: false })]]).state;
    expect(owed.remakeOwed).toBe(true);
    // The page deleted the compute frame; a trusted pointer makes a new one (the tab is in front).
    const made = lifecycleStep(owed, POINTER, facts({ frames: { compute: false, view: true } }));
    expect(made.effects).toEqual([MAKE]);
    expect(made.state.remakeOwed).toBe(false);
    expect(lifecycleStep(made.state, FRONT, facts({ frames: BOTH })).effects).toEqual([]);
  });

  it.each([
    ["the frames go idle", IDLE_REMOVE],
    ["hovers are switched off", OFF],
  ] as const)("the flag goes when %s, and the tab coming to the front remakes nothing", (_name, event) => {
    const { state: after, effects } = run(state("live"), [
      [KEEP_CARD, facts({ frames: BOTH, visible: false })],
      [event, facts({ frames: BOTH, visible: false })],
      [FRONT, facts()],
    ]);
    expect(after.remakeOwed).toBe(false);
    expect(effects).not.toContainEqual(REMAKE);
  });

  it("the compute frame deleted while a flip is owed: the tab coming to the front remakes nothing", () => {
    const { state: after, effects } = run(state("live"), [
      [KEEP_CARD, facts({ frames: BOTH, visible: false })],
      [FRONT, facts({ frames: { compute: false, view: true } })],
    ]);
    expect(after.remakeOwed).toBe(false);
    expect(effects).toEqual([]);
  });
});

describe("S-B11: off removes both frames and detaches the video; a later shown is dropped", () => {
  table([
    { name: "live, off: both frames removed, the video detached", from: state("live"), event: OFF, facts: facts({ frames: BOTH }), phase: "off", effects: [REMOVE, DETACH] },
    { name: "idle, off: the video detached", from: state("idle"), event: OFF, facts: facts(), phase: "off", effects: [REMOVE, DETACH] },
    { name: "live: a shown card is shown", from: state("live"), event: SHOWN, facts: facts({ frames: BOTH }), phase: "live", effects: [SHOW] },
    { name: "idle: a shown card is dropped", from: state("idle"), event: SHOWN, facts: facts(), phase: "idle", effects: [] },
  ]);

  it("off with a late shown: nothing is shown, and a pointer or playing after off makes nothing", () => {
    const { state: after, effects } = run(state("live"), [
      [OFF, facts({ frames: BOTH })],
      [SHOWN, facts()],
      [POINTER, facts()],
      [PLAYING, facts()],
      [IDLE_MAKE, facts()],
    ]);
    expect(after.phase).toBe("off");
    expect(effects).toEqual([REMOVE, DETACH]);
  });
});

describe("the reducer is pure", () => {
  it("never changes the state or facts it is given, and gives the same answer twice", () => {
    const events: LifecycleEvent[] = [ON, OFF, READ_ON, READ_OFF, PLAYING, FAKE_PLAYING, POINTER, FRONT, IDLE_REMOVE, IDLE_MAKE, KEEP_CARD, SHOWN];
    const phases: LifecyclePhase[] = ["off", "waiting", "owed", "live", "idle"];
    for (const phase of phases) {
      for (const remakeOwed of [false, true]) {
        for (const switchHeard of [false, true]) {
          const from = state(phase, { remakeOwed, switchHeard });
          for (const event of events) {
            for (const visible of [false, true]) {
              const at = facts({ visible, frames: { compute: true, view: false } });
              // Frozen inputs: a write would throw in strict mode.
              const once = lifecycleStep(from, event, at);
              expect(lifecycleStep(from, event, at)).toEqual(once);
            }
          }
        }
      }
    }
  });

  it("starts off, with no switch value heard yet", () => {
    expect(INITIAL_LIFECYCLE).toEqual({ phase: "off", remakeOwed: false, switchHeard: false });
    expect(Object.isFrozen(INITIAL_LIFECYCLE)).toBe(true);
  });
});
