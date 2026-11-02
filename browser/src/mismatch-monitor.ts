// SPDX-License-Identifier: Apache-2.0
// Does the candidate layout describe the picture at all? A membership monitor.
//
// Over the last `window` *counted* analyses (an analysis counts when the product's source
// offered some identities around that instant), take the distinct identities the recognizer
// accepted, leaving out those the product's `exclude` names (card types every layout shares).
// An identity counts as *in* when the source offered it on any counted analysis where it was
// accepted. With at least `minIdentities` distinct identities, a share of in-identities below
// `trip` trips the monitor; once tripped, it recovers only after `window` consecutive counted
// analyses at a share of at least `recover`. Between the two thresholds the state holds, so it
// cannot flap.
//
// What it guarantees: a layout whose identities overlap the picture's accepted identities at a
// share below `trip` trips it within `window` counted analyses once `minIdentities` distinct
// identities are accepted. What it cannot do: tell apart layouts that share most identities
// (the same deck shown elsewhere, a near-copy). Geometry (layout-state.ts) carries those.

export interface MonitorParams {
  /** Counted analyses in the window; also the length of the recovery run. */
  window: number;
  /** Distinct accepted identities needed before the share means anything. */
  minIdentities: number;
  /** Trip when the share falls strictly below this. */
  trip: number;
  /** Recover after `window` consecutive counted analyses at or above this. */
  recover: number;
}

/** The toolkit's defaults: 10 counted analyses, 3 identities, trip below 0.4, recover at 0.7. */
export const MONITOR_DEFAULTS: MonitorParams = { window: 10, minIdentities: 3, trip: 0.4, recover: 0.7 };

export type MonitorState = "unknown" | "in" | "tripped";

export interface MonitorInput {
  /** The identities the product's source offered around this instant; empty: not counted. */
  windowIdentities: ReadonlySet<string>;
  /** Identities the recognizer accepted in this analysis. */
  accepted: Iterable<string>;
}

export interface MonitorStep {
  state: MonitorState;
  /** "trip" or "recover" when this analysis changed the state that way; else null. */
  event: "trip" | "recover" | null;
  /** Distinct accepted identities in the window. */
  identities: number;
  /** Their in-share, or null when there are none. */
  share: number | null;
  /** Whether this analysis was counted. */
  counted: boolean;
}

export class MismatchMonitor {
  private readonly params: MonitorParams;
  private readonly exclude: (identity: string) => boolean;
  private window: Array<Map<string, boolean>> = [];
  private stateValue: MonitorState = "unknown";
  private recoverRun = 0;

  constructor(options: { exclude?: (identity: string) => boolean; params?: MonitorParams } = {}) {
    this.params = options.params ?? MONITOR_DEFAULTS;
    this.exclude = options.exclude ?? (() => false);
  }

  get state(): MonitorState {
    return this.stateValue;
  }

  get tripped(): boolean {
    return this.stateValue === "tripped";
  }

  /** The share over the current window, or null with no identities. */
  get share(): number | null {
    return this.summary().share;
  }

  observe(input: MonitorInput): MonitorStep {
    if (input.windowIdentities.size === 0) {
      return { state: this.stateValue, event: null, ...this.summary(), counted: false };
    }
    const seen = new Map<string, boolean>();
    for (const id of input.accepted) {
      if (this.exclude(id)) continue;
      seen.set(id, (seen.get(id) ?? false) || input.windowIdentities.has(id));
    }
    this.window.push(seen);
    if (this.window.length > this.params.window) this.window.shift();

    const { identities, share } = this.summary();
    const enough = identities >= this.params.minIdentities && share !== null;
    let event: MonitorStep["event"] = null;
    if (this.stateValue === "tripped") {
      this.recoverRun = enough && share >= this.params.recover ? this.recoverRun + 1 : 0;
      if (this.recoverRun >= this.params.window) {
        this.stateValue = "in";
        this.recoverRun = 0;
        event = "recover";
      }
    } else if (enough) {
      if (share < this.params.trip) {
        this.stateValue = "tripped";
        this.recoverRun = 0;
        event = "trip";
      } else {
        this.stateValue = "in";
      }
    }
    return { state: this.stateValue, event, identities, share, counted: true };
  }

  /** Geometry confirmed the layout: forget the trip and the identities behind it, so that only
   *  evidence gathered after the confirmation can trip it again. A scene with a persistently low
   *  share beside a board that keeps verifying can still trip and clear at the window's period. */
  clearTrip(): void {
    if (this.stateValue !== "tripped") return;
    this.reset();
  }

  reset(): void {
    this.window = [];
    this.stateValue = "unknown";
    this.recoverRun = 0;
  }

  private summary(): { identities: number; share: number | null } {
    const merged = new Map<string, boolean>();
    for (const frame of this.window) {
      for (const [id, inSet] of frame) merged.set(id, (merged.get(id) ?? false) || inSet);
    }
    if (merged.size === 0) return { identities: 0, share: null };
    let hits = 0;
    for (const v of merged.values()) if (v) hits += 1;
    return { identities: merged.size, share: hits / merged.size };
  }
}
