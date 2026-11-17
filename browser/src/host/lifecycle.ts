// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): when the two frames are made and removed, as a pure
// reducer. It reads no DOM and holds no timer: the content realm feeds it events with the facts
// of the moment, and carries out the effects it returns.
//
// Phases:
//   - off: hovers are switched off (also before the start-up read of the switch has answered);
//   - waiting: on, no frames, and no load is owed;
//   - owed: on, a load is wanted, and the tab is hidden: it is paid when the tab comes to the
//     front with the main video still playing on a load-at-play page, and dropped otherwise;
//   - live: the host made the frames (the page may have removed one since: see `frames`);
//   - idle: the capture control removed the frames for idleness and owes its own make().
// One flag beside the phase: `remakeOwed`, a keep-card flip made while the tab was hidden.

/** Where a `playing` loads (S-G3): a load-at-play page, a page that loads at the pointer, or a page
 *  that is not active. */
export type LifecyclePage = "play" | "pointer" | "inactive";

export type LifecyclePhase = "off" | "waiting" | "owed" | "live" | "idle";

export interface LifecycleState {
  readonly phase: LifecyclePhase;
  /** A keep-card flip arrived while the tab was hidden and a compute frame ran: the compute frame
   *  is made again when the tab comes to the front. Any new compute frame clears it. */
  readonly remakeOwed: boolean;
  /** A switch value has been applied, from the start-up read or from a flip. A start-up read that
   *  answers after a flip is dropped: the flip is newer (S-H1). */
  readonly switchHeard: boolean;
}

/** What the host knows at the moment of the event. An untrusted event reads no fact, so the host
 *  need not work any out for one. For every other event the host works the facts out itself,
 *  whatever the reducer reads: on every trusted `playing` while hovers are on and the page is
 *  active, it picks the main video again (S-G4), in every phase, also with both frames made and
 *  after an idle removal. On a page that is not active it picks nothing (S-G5). */
export interface LifecycleFacts {
  /** The tab is in front (`document.visibilityState !== "hidden"`). */
  readonly visible: boolean;
  /** The page policy now, from `location.href`. */
  readonly page: LifecyclePage;
  /** The main video exists and is not paused. On every trusted `playing` while hovers are on and
   *  the page is active, the host picks the main video again before the step, whatever the event's
   *  target and whether or not the reducer reads this (S-G4); on an untrusted one, or on a page
   *  that is not active, it picks nothing. */
  readonly mainPlaying: boolean;
  /** Which of the host's frames are in the page now (a page script may have removed one). */
  readonly frames: { readonly compute: boolean; readonly view: boolean };
}

export type LifecycleEvent =
  /** The `enabled` switch: the start-up read (`from: "read"`), which counts as a switch-on when it
   *  answers on, or a real flip seen by the watch (`from: "flip"`). The host subscribes before it
   *  reads. */
  | { readonly type: "switch"; readonly on: boolean; readonly from: "read" | "flip" }
  /** A `playing` event in the page, with whether the browser made it. */
  | { readonly type: "playing"; readonly trusted: boolean }
  /** A pointer move or tap, with whether it is the viewer's own and is over the main video's
   *  picture. */
  | { readonly type: "pointer"; readonly trusted: boolean; readonly overPicture: boolean }
  /** The tab came to the front. */
  | { readonly type: "front" }
  /** The capture control's idle `remove()`. */
  | { readonly type: "idle-remove" }
  /** The capture control's `make()` after an idle removal (on a trusted move over the picture). */
  | { readonly type: "idle-make" }
  /** A real flip of the keep-card switch. */
  | { readonly type: "keep-card" }
  /** A `shown` card from the compute frame. */
  | { readonly type: "shown" };

export type LifecycleEffect =
  /** Make whichever of the two frames is not in the page. `connect`: the host says hello to a new
   *  compute frame; false when the capture control made the call (its make() connects itself). */
  | { readonly type: "make"; readonly connect: boolean }
  /** Remove the compute frame and hide the shown card, keep the view frame, then make a new compute
   *  frame (and a missing view frame) and say hello (S-H3). */
  | { readonly type: "remake-compute" }
  /** Remove both frames, the outline and the shown card. */
  | { readonly type: "remove" }
  /** Stop following the video: the capture control is given none. */
  | { readonly type: "detach-video" }
  /** Pass the shown card on to the view. */
  | { readonly type: "show" };

export interface LifecycleStep {
  readonly state: LifecycleState;
  readonly effects: readonly LifecycleEffect[];
}

export const INITIAL_LIFECYCLE: LifecycleState = Object.freeze({ phase: "off", remakeOwed: false, switchHeard: false });

const MAKE: LifecycleEffect = Object.freeze({ type: "make", connect: true });

function step(state: LifecycleState, patch: Partial<LifecycleState>, effects: LifecycleEffect[] = []): LifecycleStep {
  return { state: { ...state, ...patch }, effects };
}

function unchanged(state: LifecycleState): LifecycleStep {
  return { state, effects: [] };
}

function owed(state: LifecycleState): LifecycleStep {
  return state.phase === "owed" ? unchanged(state) : step(state, { phase: "owed" });
}

/** "At once" (S-A1, S-A7): the main video is playing now, on a load-at-play page. */
function playsNow(facts: LifecycleFacts): boolean {
  return facts.page === "play" && facts.mainPlaying;
}

function bothFrames(facts: LifecycleFacts): boolean {
  return facts.frames.compute && facts.frames.view;
}

/** The host makes the frames: a new compute frame reads keep-card as it starts. */
function made(state: LifecycleState, facts: LifecycleFacts, connect = true): LifecycleStep {
  const remakeOwed = state.remakeOwed && facts.frames.compute;
  return step(state, { phase: "live", remakeOwed }, [connect ? MAKE : { type: "make", connect: false }]);
}

/** A switch-on is a fresh start (S-A7), whatever came before it, an idle removal included. */
function switchOn(state: LifecycleState, facts: LifecycleFacts): LifecycleStep {
  const base: LifecycleState = { ...state, remakeOwed: false };
  if (!facts.visible) return step(base, { phase: facts.page === "play" ? "owed" : "waiting" });
  if (playsNow(facts)) return made(base, facts);
  return step(base, { phase: "waiting" });
}

function onSwitch(state: LifecycleState, event: { on: boolean; from: "read" | "flip" }, facts: LifecycleFacts): LifecycleStep {
  // S-H1: a flip that arrived while the start-up read was pending stands.
  if (event.from === "read" && state.switchHeard) return unchanged(state);
  const heard: LifecycleState = state.switchHeard ? state : { ...state, switchHeard: true };
  const isOn = state.phase !== "off";
  if (event.on === isOn) return unchanged(heard);
  // S-B11: off removes both frames and stops following the video.
  if (!event.on) return step(heard, { phase: "off", remakeOwed: false }, [{ type: "remove" }, { type: "detach-video" }]);
  return switchOn(heard, facts);
}

/** A trusted `playing` (S-A1, S-A8, S-A10, S-G4). */
function onPlaying(state: LifecycleState, facts: LifecycleFacts): LifecycleStep {
  switch (state.phase) {
    case "off":
    case "idle": // S-A6: a looping clip does not undo an idle removal.
      return unchanged(state);
    case "live":
      // S-A10: a frame the page removed is made again at a trusted play on a load-at-play page.
      if (bothFrames(facts) || !playsNow(facts)) return unchanged(state);
      return facts.visible ? made(state, facts) : owed(state);
    case "waiting":
    case "owed":
      if (!playsNow(facts)) return unchanged(state);
      // S-A8: a background tab waits for the front.
      return facts.visible ? made(state, facts) : owed(state);
  }
}

/** A trusted pointer over the picture (S-A2, S-A6, S-A10). */
function onPointer(state: LifecycleState, facts: LifecycleFacts): LifecycleStep {
  switch (state.phase) {
    case "off":
    case "idle": // S-A6: the capture control's make() answers this move, not the host.
      return unchanged(state);
    case "live":
      return bothFrames(facts) ? unchanged(state) : made(state, facts);
    case "waiting":
    case "owed":
      return made(state, facts);
  }
}

/** The tab came to the front (S-A7, S-A8, S-H3). */
function onFront(state: LifecycleState, facts: LifecycleFacts): LifecycleStep {
  if (state.phase === "off" || state.phase === "idle") return state.remakeOwed ? step(state, { remakeOwed: false }) : unchanged(state);
  // A keep-card flip owed while a compute frame runs is paid now, by a remake that also makes a
  // missing view frame, and so pays an owed load too.
  if (state.remakeOwed && facts.frames.compute) return step(state, { phase: "live", remakeOwed: false }, [{ type: "remake-compute" }]);
  if (state.phase === "owed" && playsNow(facts)) return made(state, facts);
  // No compute frame to remake: the next one reads the new value.
  const remakeOwed = false;
  if (state.phase !== "owed") return state.remakeOwed ? step(state, { remakeOwed }) : unchanged(state);
  // The owed load is dropped (the video is paused, or the page no longer loads at play). A frame
  // still in the page keeps the phase live: the next trusted play or pointer makes the missing one
  // (S-A10). With none, the tab waits.
  const anyFrame = facts.frames.compute || facts.frames.view;
  return step(state, { phase: anyFrame ? "live" : "waiting", remakeOwed });
}

/** A keep-card flip (S-H3). */
function onKeepCard(state: LifecycleState, facts: LifecycleFacts): LifecycleStep {
  if (state.phase === "off" || state.phase === "idle" || !facts.frames.compute) return unchanged(state);
  if (!facts.visible) return step(state, { remakeOwed: true });
  return step(state, { remakeOwed: false }, [{ type: "remake-compute" }]);
}

/** One event: the next state and the effects to carry out, in order. Pure: it reads only its
 *  arguments, and returns the same state object when nothing changes. */
export function lifecycleStep(state: LifecycleState, event: LifecycleEvent, facts: LifecycleFacts): LifecycleStep {
  switch (event.type) {
    case "switch":
      return onSwitch(state, event, facts);
    case "playing":
      // S-A1: a `playing` the page made is ignored.
      return event.trusted ? onPlaying(state, facts) : unchanged(state);
    case "pointer":
      if (!event.trusted) return unchanged(state);
      // S-G5: off an active page a pointer counts for nothing, and the video is no longer followed.
      if (facts.page === "inactive") return state.phase === "off" ? unchanged(state) : { state, effects: [{ type: "detach-video" }] };
      return event.overPicture ? onPointer(state, facts) : unchanged(state);
    case "front":
      return onFront(state, facts);
    case "idle-remove":
      if (state.phase === "off" || state.phase === "idle") return unchanged(state);
      // The video stays followed; the next trusted move over it has the control make the frames.
      return step(state, { phase: "idle", remakeOwed: false }, [{ type: "remove" }]);
    case "idle-make":
      if (state.phase === "off") return unchanged(state);
      return made(state, facts, false);
    case "keep-card":
      return onKeepCard(state, facts);
    case "shown":
      // S-B11: a card that arrives after off (or after the frames went idle) shows nothing.
      return state.phase === "off" || state.phase === "idle" ? unchanged(state) : { state, effects: [{ type: "show" }] };
  }
}
