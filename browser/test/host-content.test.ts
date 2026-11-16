// SPDX-License-Identifier: Apache-2.0
// The shared hover host's content realm, with a stand-in window, document, videos, frames, storage
// and clock (no DOM, no network): what the view adapter is given, the trusted-message guard, the
// frames made and remade, full screen, the main-video pick, in-page navigation, the start-up read
// of the switch, and a stop that leaves nothing behind.
import { describe, expect, it, vi } from "vitest";

import { computeProtocol, PROTOCOL_VERSION, type ShownCard } from "../src/compute-messages.js";
import { NOT_POINTING } from "../src/capture-control.js";
import type { ProductConfig } from "../src/host/config.js";
import { HIDE_DELAY_MS, type HostContent, startHostContent } from "../src/host/content.js";
import type { KeyValueStorage } from "../src/host/settings-core.js";
import type { ViewAdapter, ViewFrame, ViewLayout } from "../src/host/view.js";
import { type ChangeBus, changeBus, memoryStorage } from "./support/host-storage.js";

const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PAGE = "https://www.youtube.com";
const WATCH = `${PAGE}/watch?v=abc`;
const INSTANCE_A = "0123456789abcdef";
const INSTANCE_B = "fedcba9876543210";
const RANGE = { min: 720, max: 1920 };

const config: ProductConfig = {
  tag: "example",
  name: "Example",
  sites: { youtube: true, twitch: true },
  dev: false,
  frames: { compute: "compute.html", view: "view.html" },
  outline: { edgeColor: "#123456", glowColor: "rgba(10, 20, 30, 0.5)" },
  capabilities: { geometricStage: false },
};
const protocol = computeProtocol(config.tag);

// ---------------------------------------------------------------------- stand-in page
type Fn = (event: unknown) => void;
type Options = boolean | { capture?: boolean; passive?: boolean } | undefined;
const captureOf = (o: Options): boolean => (typeof o === "boolean" ? o : o?.capture === true);

class Target {
  readonly listeners: Array<{ type: string; fn: Fn; capture: boolean }> = [];
  addEventListener(type: string, fn: Fn, options?: Options): void {
    const capture = captureOf(options);
    if (this.listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) return;
    this.listeners.push({ type, fn, capture });
  }
  removeEventListener(type: string, fn: Fn, options?: Options): void {
    const capture = captureOf(options);
    const at = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (at >= 0) this.listeners.splice(at, 1);
  }
  fire(type: string, event: object = {}): void {
    for (const l of this.listeners.filter((x) => x.type === type)) l.fn({ type, ...event });
  }
}

/** A frame's window: what was posted to it, and whether it holds the extension's page yet (before
 *  that its location is the page's own about:blank, readable from the page). */
class FrameWindow {
  readonly sent: Array<{ message: unknown; origin: string }> = [];
  loaded = true;
  get location(): { origin: string } {
    if (this.loaded) throw new DOMException("cross-origin", "SecurityError");
    return { origin: PAGE };
  }
  postMessage(message: unknown, origin: string): void {
    this.sent.push({ message, origin });
  }
  kinds(): string[] {
    return this.sent.map((s) => (s.message as { kind?: string }).kind ?? "?");
  }
}

function styleProxy(): Record<string, string> & { cssText: string } {
  const values: Record<string, string> = {};
  const camel = (name: string): string => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return new Proxy(values as Record<string, string> & { cssText: string }, {
    get: (target, key: string) => (key === "cssText" ? "" : target[key]),
    set: (target, key: string, value: unknown) => {
      if (key === "cssText") {
        for (const part of String(value).split(";")) {
          const at = part.indexOf(":");
          if (at > 0) target[camel(part.slice(0, at).trim())] = part.slice(at + 1).trim();
        }
      } else target[key] = String(value);
      return true;
    },
  });
}

class Element_ extends Target {
  readonly children: Element_[] = [];
  readonly attrs = new Map<string, string>();
  readonly style = styleProxy();
  parent: Element_ | null = null;
  root = false;
  title = "";
  src = "";
  tabIndex = 0;
  animate: undefined;
  readonly frameWindow: FrameWindow | null;
  constructor(
    readonly tagName: string,
    readonly ownerDocument: Document_,
  ) {
    super();
    this.frameWindow = tagName === "IFRAME" ? new FrameWindow() : null;
  }
  get isConnected(): boolean {
    return this.root || (this.parent?.isConnected ?? false);
  }
  get parentElement(): Element_ | null {
    return this.parent;
  }
  get contentWindow(): FrameWindow | null {
    return this.isConnected ? this.frameWindow : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  attachShadow(): Element_ {
    return new Element_("#shadow", this.ownerDocument);
  }
  appendChild(child: Element_): Element_ {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  contains(node: Element_): boolean {
    for (let n: Element_ | null = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
  getContext(): object {
    return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) };
  }
  /** Every element under this one, in tree order. */
  all(): Element_[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

class Video extends Element_ {
  rect = { left: 0, top: 0, width: 1280, height: 720 };
  videoWidth = 1280;
  videoHeight = 720;
  paused = false;
  ended = false;
  readyState = 4;
  currentTime = 12.5;
  playbackRate = 1;
  constructor(doc: Document_) {
    super("VIDEO", doc);
  }
  getBoundingClientRect() {
    return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height, x: this.rect.left, y: this.rect.top };
  }
}

class Document_ extends Target {
  readonly documentElement: Element_;
  readonly body: Element_;
  visibilityState: "visible" | "hidden" = "visible";
  fullscreenElement: Element_ | null = null;
  defaultView: Window_ | null = null;
  constructor() {
    super();
    this.documentElement = new Element_("HTML", this);
    this.documentElement.root = true;
    this.body = this.documentElement.appendChild(new Element_("BODY", this));
  }
  get scrollingElement(): Element_ {
    return this.documentElement;
  }
  createElement(tag: string): Element_ {
    return new Element_(tag.toUpperCase(), this);
  }
  querySelectorAll(selector: string): Element_[] {
    return this.documentElement.all().filter((e) => e.tagName === selector.toUpperCase());
  }
}

/** The resize observers made, and which still observe. */
const observers: Array<{ observed: unknown[]; connected: boolean }> = [];
class ResizeObserver_ {
  readonly record = { observed: [] as unknown[], connected: true };
  constructor(readonly callback: () => void) {
    observers.push(this.record);
  }
  observe(target: unknown): void {
    this.record.observed.push(target);
  }
  disconnect(): void {
    this.record.connected = false;
  }
}
const observing = (video: unknown): number => observers.filter((o) => o.connected && o.observed.includes(video)).length;

class Window_ extends Target {
  readonly ResizeObserver = ResizeObserver_;
  readonly location = { href: WATCH };
  innerWidth = 1600;
  innerHeight = 900;
  readonly frames = new Map<number, () => void>();
  private nextFrame = 1;
  readonly bitmaps: Array<{ close(): void }> = [];
  requestAnimationFrame(fn: () => void): number {
    const id = this.nextFrame++;
    this.frames.set(id, fn);
    return id;
  }
  cancelAnimationFrame(id: number): void {
    this.frames.delete(id);
  }
  runFrames(): void {
    const due = [...this.frames.values()];
    this.frames.clear();
    for (const fn of due) fn();
  }
  getComputedStyle() {
    return { objectFit: "contain" };
  }
  createImageBitmap() {
    const bitmap = { width: 1280, height: 720, close: vi.fn() };
    this.bitmaps.push(bitmap);
    return Promise.resolve(bitmap);
  }
}

// ---------------------------------------------------------------------- the adapter
type Call = { name: "attach"; frame: ViewFrame } | { name: "detach" } | { name: "message"; data: unknown } | { name: "show"; card: ShownCard; layout: ViewLayout } | { name: "hide" };

function fakeAdapter() {
  const calls: Call[] = [];
  const adapter = {
    look: { title: "Card", shadow: "0 10px 30px rgba(0,0,0,.5)" },
    /** What show() answers: the frame has measured itself for the card. */
    measured: true,
    /** What message() answers. */
    changed: true,
    /** Run inside attach(), with the handle (as an adapter that places the new frame at once). */
    onAttach: null as ((frame: ViewFrame) => void) | null,
    attach(frame: ViewFrame) {
      calls.push({ name: "attach", frame });
      adapter.onAttach?.(frame);
    },
    detach() {
      calls.push({ name: "detach" });
    },
    message(data: unknown) {
      calls.push({ name: "message", data });
      return adapter.changed;
    },
    show(card: ShownCard, layout: ViewLayout) {
      calls.push({ name: "show", card, layout });
      return adapter.measured;
    },
    hide() {
      calls.push({ name: "hide" });
    },
  };
  return { adapter: adapter satisfies ViewAdapter, calls };
}

// ---------------------------------------------------------------------- the stand-in host
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

interface StandOptions {
  stored?: Record<string, unknown>;
  /** The storage, or a maker given the change events (for a change timed against the read). */
  storage?: Pick<KeyValueStorage, "get"> | ((bus: ChangeBus) => Pick<KeyValueStorage, "get">);
  paused?: boolean;
  href?: string;
  /** Start without awaiting the start-up read. */
  noSettle?: boolean;
}

async function stand(options: StandOptions = {}) {
  let t = 1_000;
  const timers: Array<{ fn: () => void; at: number; cleared: boolean; fired: boolean }> = [];
  const doc = new Document_();
  const win = new Window_();
  doc.defaultView = win;
  win.location.href = options.href ?? WATCH;
  const video = doc.body.appendChild(new Video(doc)) as Video;
  video.paused = options.paused ?? false;
  const memory = memoryStorage({ ...options.stored });
  const bus = changeBus();
  const { adapter, calls } = fakeAdapter();
  const host: HostContent = startHostContent({
    config,
    win: win as unknown as Window,
    doc: doc as unknown as Document,
    extensionUrl: (path) => `${EXT}/${path}`,
    storage: typeof options.storage === "function" ? options.storage(bus) : (options.storage ?? memory),
    storageChanges: bus,
    view: adapter,
    now: () => t,
    timers: {
      set: (fn, ms) => {
        const timer = { fn, at: t + ms, cleared: false, fired: false };
        timers.push(timer);
        return timer;
      },
      clear: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
  });
  if (!options.noSettle) await settle();

  const iframes = () => doc.documentElement.all().filter((e) => e.tagName === "IFRAME");
  const compute = () => iframes().find((f) => f.src === `${EXT}/compute.html`) ?? null;
  const view = () => iframes().find((f) => f.src === `${EXT}/view.html`) ?? null;
  const outline = () => doc.documentElement.all().find((e) => e.getAttribute(`data-${config.tag}`) === "outline") ?? null;
  const computeWindow = () => compute()?.frameWindow ?? null;

  const r = {
    host,
    doc,
    win,
    video,
    bus,
    memory,
    adapter,
    calls,
    timers,
    iframes,
    compute,
    view,
    outline,
    computeWindow,
    get now() {
      return t;
    },
    /** Move the clock, firing the timers that fall due, in order. */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => !x.cleared && !x.fired && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        due.fired = true;
        due.fn();
      }
      t = end;
    },
    pendingTimers: () => timers.filter((x) => !x.cleared && !x.fired).length,
    pointer(type: string, x = 640, y = 360, over: { isTrusted?: boolean; pointerType?: string } = {}) {
      win.fire(type, { isTrusted: over.isTrusted ?? true, pointerType: over.pointerType ?? "mouse", pointerId: 1, clientX: x, clientY: y, target: video });
    },
    move(x = 640, y = 360, isTrusted = true) {
      r.pointer("pointermove", x, y, { isTrusted });
    },
    playing(target: Element_ = video, isTrusted = true) {
      doc.fire("playing", { isTrusted, target });
    },
    /** A message to the page's window as the browser delivers it. */
    deliver(data: unknown, source: unknown, over: { isTrusted?: boolean; origin?: string } = {}) {
      win.fire("message", { isTrusted: over.isTrusted ?? true, source, origin: over.origin ?? EXT, data });
    },
    fromCompute(data: object) {
      r.deliver(protocol.tag(data), computeWindow());
    },
    ready(instance = INSTANCE_A) {
      r.fromCompute({ kind: "ready", version: PROTOCOL_VERSION, instance });
    },
    status(state: "loading" | "ready" | "failed" | "idle") {
      r.fromCompute({ kind: "status", state, error: null, backend: null });
    },
    shown(card: ShownCard | null) {
      r.fromCompute({ kind: "shown", card });
    },
    request(requestId = 1) {
      r.fromCompute({ kind: "capture", requestId, analysisWidth: RANGE });
    },
    /** The last capture answer the compute frame got. */
    answer: () =>
      computeWindow()
        ?.sent.map((s) => s.message as { kind: string; reason?: string; requestId?: number })
        .filter((m) => m.kind === "frame" || m.kind === "capture-failed")
        .at(-1),
    fromView(data: unknown, over: { isTrusted?: boolean; origin?: string; source?: unknown } = {}) {
      r.deliver(data, "source" in over ? over.source : view()?.frameWindow, over);
    },
    names: () => calls.map((c) => c.name),
    shows: () => calls.filter((c): c is Extract<Call, { name: "show" }> => c.name === "show"),
    setFlag(key: string, oldValue: unknown, newValue: unknown) {
      bus.emit({ [key]: { oldValue, newValue } });
    },
  };
  return r;
}
type Stand = Awaited<ReturnType<typeof stand>>;

const CARD: ShownCard = { cardId: "OGN-001", name: "Example card", box: { x: 0.4, y: 0.4, width: 0.1, height: 0.2 }, others: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.2 }] };

/** Frames made at play, the compute frame connected, the pointer over the picture, a card shown. */
async function showing(options: StandOptions = {}): Promise<Stand> {
  const r = await stand(options);
  r.move();
  r.ready();
  r.status("ready");
  r.shown(CARD);
  return r;
}

/** Frames made from now on start on their first about:blank. */
function onBlank(r: Stand): void {
  const original = r.doc.createElement.bind(r.doc);
  r.doc.createElement = (tag: string) => {
    const e = original(tag);
    if (e.frameWindow) e.frameWindow.loaded = false;
    return e;
  };
}

const outlineShown = (r: Stand): boolean => r.outline()?.style.display === "block";
const viewVisible = (r: Stand): boolean => r.view()?.style.visibility === "visible";

// ---------------------------------------------------------------------- the adapter's inputs
describe("the view adapter's inputs", () => {
  it("receives only the frame handle, the layout, the shown card and checked message data", async () => {
    const r = await showing();
    const attach = r.calls.find((c) => c.name === "attach") as Extract<Call, { name: "attach" }>;
    // The handle: place and post, nothing else; not the iframe, its window or its style.
    expect(Object.keys(attach.frame).sort()).toEqual(["place", "post"]);
    expect(Object.isFrozen(attach.frame)).toBe(true);
    expect(attach.frame).not.toBe(r.view());
    const show = r.shows().at(-1)!;
    expect(show.card).toEqual(CARD);
    expect(Object.keys(show.layout).sort()).toEqual(["card", "minTop", "others", "picture", "viewport", "visible"]);
    expect(show.layout).toEqual({
      picture: { left: 0, top: 0, width: 1280, height: 720 },
      card: { left: 512, top: 288, width: 128, height: 144 },
      others: [{ left: 128, top: 72, width: 128, height: 144 }],
      viewport: { width: 1600, height: 900 },
      minTop: 0,
      visible: false,
    });
    // A checked message: its data alone, not the event.
    const data = { kind: "size", width: 300, height: 420 };
    r.fromView(data);
    const message = r.calls.find((c) => c.name === "message") as Extract<Call, { name: "message" }>;
    expect(message.data).toBe(data);
    expect(new Set(r.names())).toEqual(new Set(["attach", "show", "message"]));
  });

  it("a forged view-frame message never reaches message()", async () => {
    const r = await showing();
    const own = r.view()!.frameWindow;
    r.fromView({ kind: "size" }, { isTrusted: false }); // made by a page script
    r.fromView({ kind: "size" }, { origin: PAGE }); // another origin
    r.fromView({ kind: "size" }, { source: r.computeWindow() }); // another of our frames
    r.fromView({ kind: "size" }, { source: {} }); // another window
    r.fromView({ kind: "size" }, { source: null });
    expect(r.names()).not.toContain("message");
    r.deliver({ kind: "size" }, own);
    expect(r.names().filter((n) => n === "message")).toHaveLength(1);
  });

  it("place() takes effect before the frame has loaded and while it is hidden", async () => {
    const r = await stand({ paused: true });
    const { adapter } = r;
    adapter.onAttach = (frame) => frame.place({ left: 10, top: 20, width: 320, height: 448, cornerRadius: 14 });
    r.move();
    const view = r.view()!;
    view.frameWindow!.loaded = false;
    expect(view.style.visibility).toBe("hidden");
    expect([view.style.left, view.style.top, view.style.width, view.style.height, view.style.borderRadius, view.style.overflow]).toEqual(["10px", "20px", "320px", "448px", "14px", "hidden"]);
    // The host keeps stacking and the pointer.
    expect(view.style.zIndex).toBe("2147483646");
    expect(view.style.pointerEvents).toBe("none");
  });

  it("place() sets the exact width and height given: no rounding, no deferral", async () => {
    const r = await showing();
    const frame = (r.calls.find((c) => c.name === "attach") as Extract<Call, { name: "attach" }>).frame;
    frame.place({ left: 0.25, top: 1.5, width: 123.456, height: 78.9012, cornerRadius: 3.3 });
    const s = r.view()!.style;
    expect([s.width, s.height, s.left, s.top, s.borderRadius]).toEqual(["123.456px", "78.9012px", "0.25px", "1.5px", "3.3px"]);
  });

  it("post() is false while the view frame is still on its first about:blank, and nothing is posted", async () => {
    const r = await stand({ paused: true });
    onBlank(r);
    r.move();
    const frame = (r.calls.find((c) => c.name === "attach") as Extract<Call, { name: "attach" }>).frame;
    const window = r.view()!.frameWindow!;
    expect(frame.post({ kind: "card" })).toBe(false);
    expect(window.sent).toEqual([]);
    window.loaded = true;
    expect(frame.post({ kind: "card" })).toBe(true);
  });

  it("the look's shadow cannot change what the host keeps: a value with a ';' leaves pointer-events and visibility", async () => {
    const r = await stand({ paused: true });
    (r.adapter.look as { shadow: string }).shadow = "0 0 1px red;pointer-events:auto;visibility:visible;z-index:1";
    r.move();
    const s = r.view()!.style;
    expect(s.pointerEvents).toBe("none");
    expect(s.visibility).toBe("hidden");
    expect(s.zIndex).toBe("2147483646");
  });

  it("post() goes to the view frame at the extension's origin, and is false with no window", async () => {
    const r = await showing();
    const frame = (r.calls.find((c) => c.name === "attach") as Extract<Call, { name: "attach" }>).frame;
    const element = r.view()!;
    expect(frame.post({ kind: "card" })).toBe(true);
    expect(element.frameWindow!.sent.at(-1)).toEqual({ message: { kind: "card" }, origin: EXT });
    element.remove();
    expect(frame.post({ kind: "card" })).toBe(false);
  });
});

// ---------------------------------------------------------------------- shown card and outline
describe("the shown card and its outline", () => {
  it("shows the frame and the outline only when show() returns true, and no outline for a held card", async () => {
    const r = await stand();
    r.adapter.measured = false;
    r.move();
    r.ready();
    r.shown(CARD);
    expect(r.shows()).toHaveLength(1);
    expect(viewVisible(r)).toBe(false);
    expect(outlineShown(r)).toBe(false);
    // The frame measured itself for the card: the size message makes the host show again.
    r.adapter.measured = true;
    r.fromView({ kind: "size" });
    expect(r.shows()).toHaveLength(2);
    expect(viewVisible(r)).toBe(true);
    expect(outlineShown(r)).toBe(true);
    // Held (S-F4): the frame stays, the outline goes.
    r.shown({ ...CARD, held: true });
    expect(viewVisible(r)).toBe(true);
    expect(outlineShown(r)).toBe(false);
    r.shown(CARD);
    expect(outlineShown(r)).toBe(true);
  });

  it("a size message for an old seq (message() false) does not show again", async () => {
    const r = await showing();
    const before = r.shows().length;
    r.adapter.changed = false;
    r.fromView({ kind: "size", seq: 0 });
    expect(r.shows()).toHaveLength(before);
    r.adapter.changed = true;
    r.fromView({ kind: "size", seq: 1 });
    expect(r.shows()).toHaveLength(before + 1);
  });

  it("hides the card HIDE_DELAY_MS after the pointer leaves the picture", async () => {
    const r = await showing();
    expect(viewVisible(r)).toBe(true);
    r.move(1400, 800); // off the picture: the control resets
    r.shown(null);
    r.advance(HIDE_DELAY_MS - 1);
    expect(viewVisible(r)).toBe(true);
    r.advance(1);
    expect(viewVisible(r)).toBe(false);
    expect(outlineShown(r)).toBe(false);
    expect(r.names().at(-1)).toBe("hide");
  });

  it("places the card again at most once an animation frame on resize and on relayout()", async () => {
    const r = await showing();
    const before = r.shows().length;
    r.win.fire("resize");
    r.host.relayout();
    r.doc.fire("scroll", { target: r.doc });
    expect(r.shows()).toHaveLength(before);
    r.win.runFrames();
    expect(r.shows()).toHaveLength(before + 1);
    // A scroll that cannot move the video (a chat scrolling itself) is ignored.
    r.doc.fire("scroll", { target: r.doc.createElement("div") });
    expect(r.win.frames.size).toBe(0);
  });
});

// ---------------------------------------------------------------------- frames remade
describe("frames made again", () => {
  it("after full screen, the shown card is shown in the new frame straight after attach(), and only the view frame is remade", async () => {
    const r = await showing();
    const compute = r.compute();
    const oldView = r.view();
    const player = r.doc.body.appendChild(r.doc.createElement("div"));
    r.doc.fullscreenElement = player;
    const at = r.calls.length;
    r.doc.fire("fullscreenchange");
    expect(r.names().slice(at)).toEqual(["attach", "show"]);
    expect((r.calls[at + 1] as Extract<Call, { name: "show" }>).card).toEqual(CARD);
    expect(r.compute()).toBe(compute);
    expect(r.view()).not.toBe(oldView);
    expect(oldView!.isConnected).toBe(false);
    // Inside the full-screen element, with the outline.
    expect(r.view()!.parent).toBe(player);
    expect(r.outline()!.parent).toBe(player);
    expect(outlineShown(r)).toBe(true);
    // No new hello to the compute frame.
    expect(r.computeWindow()!.kinds().filter((k) => k === "hello")).toHaveLength(1);
  });

  it("full screen with a card held on a paused video: show runs again with no pointer move", async () => {
    const r = await showing();
    r.video.paused = true;
    const held = { ...CARD, held: true as const };
    r.shown(held);
    const compute = r.compute();
    const at = r.calls.length;
    r.doc.fullscreenElement = r.doc.body.appendChild(r.doc.createElement("div"));
    r.doc.fire("fullscreenchange");
    expect(r.names().slice(at)).toEqual(["attach", "show"]);
    expect((r.calls[at + 1] as Extract<Call, { name: "show" }>).card).toEqual(held);
    expect(r.compute()).toBe(compute);
    expect(outlineShown(r)).toBe(false);
  });

  it("after the page removed the view frame, a trusted move makes it again and shows the card straight after attach()", async () => {
    const r = await showing();
    const compute = r.compute();
    r.view()!.remove();
    const at = r.calls.length;
    r.move(641, 360);
    expect(r.names().slice(at, at + 3)).toEqual(["detach", "attach", "show"]);
    expect((r.calls[at + 2] as Extract<Call, { name: "show" }>).card).toEqual(CARD);
    expect(r.view()).not.toBeNull();
    // Only the missing frame is made, and the running compute frame hears no new hello.
    expect(r.compute()).toBe(compute);
    expect(r.computeWindow()!.kinds().filter((k) => k === "hello")).toHaveLength(1);
  });

  it("after the page removed the view frame, a trusted playing makes it again (S-A10) and shows the card straight after attach()", async () => {
    const r = await showing();
    r.view()!.remove();
    const at = r.calls.length;
    r.playing();
    expect(r.names().slice(at, at + 3)).toEqual(["detach", "attach", "show"]);
    expect(r.computeWindow()!.kinds().filter((k) => k === "hello")).toHaveLength(1);
  });

  it("after the page removed the view frame, a new shown card with no pointer move gives detach, attach, show", async () => {
    const r = await showing();
    r.view()!.remove();
    const at = r.calls.length;
    const next = { ...CARD, cardId: "OGN-004" };
    r.shown(next);
    expect(r.names().slice(at)).toEqual(["detach", "attach", "show"]);
    expect((r.calls[at + 2] as Extract<Call, { name: "show" }>).card).toEqual(next);
    expect(r.view()!.isConnected).toBe(true);
  });

  it("a view frame removed while the compute frame is loaded but not ready is made again with no second hello", async () => {
    const r = await stand({ paused: true });
    r.move();
    expect(r.computeWindow()!.kinds()).toEqual(["hello"]);
    r.view()!.remove();
    r.move(650, 370);
    expect(r.view()).not.toBeNull();
    expect(r.computeWindow()!.kinds()).toEqual(["hello"]);
  });

  it("a compute frame the page removed is made again, alone, and is said hello to", async () => {
    const r = await showing();
    const view = r.view();
    r.compute()!.remove();
    r.playing();
    expect(r.view()).toBe(view);
    expect(r.compute()).not.toBeNull();
    expect(r.computeWindow()!.kinds()).toContain("hello");
    expect(r.names().filter((n) => n === "attach")).toHaveLength(1);
  });

  it("a keep-card flip remakes the compute frame, keeps the view frame and hides the card", async () => {
    const r = await showing();
    const compute = r.compute();
    const view = r.view();
    r.setFlag("keepCard", true, false);
    expect(r.compute()).not.toBe(compute);
    expect(r.view()).toBe(view);
    expect(viewVisible(r)).toBe(false);
    expect(r.names().at(-1)).toBe("hide");
    expect(r.computeWindow()!.kinds()).toEqual(["hello"]);
  });

  it("idle: both frames and the outline go; the next trusted move over the picture makes them once and says hello", async () => {
    const r = await showing();
    r.shown(null);
    r.advance(HIDE_DELAY_MS);
    r.status("idle");
    expect(r.iframes()).toHaveLength(0);
    expect(r.outline()).toBeNull();
    expect(r.host.state).toBe("idle");
    expect(r.names().at(-1)).toBe("detach");
    r.playing(); // a looping clip does not undo an idle removal (S-A6)
    expect(r.iframes()).toHaveLength(0);
    r.move(700, 400);
    expect(r.iframes()).toHaveLength(2);
    expect(r.host.state).toBe("live");
    expect(r.computeWindow()!.kinds().filter((k) => k === "hello")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------- pointer authority
describe("pointer authority", () => {
  it("the host's pointer listener runs before the control's, and a frame that connects late still gets the one picture", async () => {
    const r = await stand({ paused: true });
    // Ours first, on the window, in the capture phase.
    const moves = r.win.listeners.filter((l) => l.type === "pointermove");
    expect(moves.length).toBeGreaterThanOrEqual(2);
    expect(moves.every((l) => l.capture)).toBe(true);
    expect(r.iframes()).toHaveLength(0);
    onBlank(r);
    // The player comes into the page after the start-up read: nothing follows it yet.
    r.video.remove();
    r.advance(1_000);
    r.move(100, 100);
    r.doc.body.appendChild(r.video);
    r.advance(1_000);
    // One trusted move over the paused video's picture picks it and makes the frames, and the
    // control takes the same move as its authority.
    r.move();
    expect(r.iframes()).toHaveLength(2);
    const frame = r.computeWindow()!;
    // The frame is slow: it loads 15 s later, past the pointer's grace period, the mouse resting.
    r.advance(15_000);
    expect(frame.kinds()).not.toContain("hello");
    frame.loaded = true;
    r.advance(250);
    expect(frame.kinds()).toContain("hello");
    r.ready();
    const pointer = frame.sent.map((s) => s.message as { kind: string; restedMs?: number }).find((m) => m.kind === "pointer");
    expect(pointer?.restedMs).toBeGreaterThanOrEqual(15_000);
    r.status("ready");
    r.request(1);
    await settle();
    expect(r.answer()).toMatchObject({ kind: "frame", requestId: 1 });
    // One picture.
    r.request(2);
    await settle();
    expect(r.answer()).toMatchObject({ kind: "capture-failed", requestId: 2, reason: NOT_POINTING });
  });

  it("no picture is taken off an active page, nor after in-page navigation under a resting pointer (S-G5)", async () => {
    const r = await showing();
    r.request(1);
    await settle();
    expect(r.answer()).toMatchObject({ kind: "frame", requestId: 1 });
    // The page navigates away (the miniplayer goes on), the pointer resting.
    r.win.location.href = `${PAGE}/`;
    r.request(2);
    await settle();
    expect(r.answer()).toMatchObject({ kind: "capture-failed", requestId: 2, reason: NOT_POINTING });
    r.move();
    r.request(3);
    await settle();
    expect(r.answer()).toMatchObject({ kind: "capture-failed", requestId: 3, reason: NOT_POINTING });
    expect(r.win.bitmaps).toHaveLength(1);
  });

  it("a playing in a background tab owes the load; the tab coming to the front with the video playing pays it (S-A8)", async () => {
    const r = await stand({ paused: true });
    r.doc.visibilityState = "hidden";
    r.video.paused = false;
    r.playing();
    expect(r.host.state).toBe("owed");
    expect(r.iframes()).toHaveLength(0);
    r.doc.visibilityState = "visible";
    r.doc.fire("visibilitychange");
    expect(r.host.state).toBe("live");
    expect(r.iframes()).toHaveLength(2);
  });

  it("a pointer a page script made counts for nothing", async () => {
    const r = await stand({ paused: true });
    r.move(640, 360, false);
    expect(r.iframes()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------- the main video
describe("the main video", () => {
  it("a playing of a non-main video while the main one is paused loads nothing", async () => {
    const r = await stand({ paused: true });
    const small = r.doc.body.appendChild(new Video(r.doc)) as Video;
    small.rect = { left: 0, top: 800, width: 400, height: 225 };
    r.playing(small);
    expect(r.iframes()).toHaveLength(0);
    expect(r.host.state).toBe("waiting");
    // The main one playing does.
    r.video.paused = false;
    r.playing(r.video);
    expect(r.iframes()).toHaveLength(2);
  });

  it("every trusted playing picks the main video again at once, whatever its target; an untrusted one never does", async () => {
    const r = await showing();
    const frame = r.computeWindow()!;
    // A larger video takes over (another element), within the second the pick is kept.
    const larger = r.doc.body.appendChild(new Video(r.doc)) as Video;
    larger.rect = { left: 0, top: 0, width: 1600, height: 900 };
    const before = frame.kinds().filter((k) => k === "discontinuity").length;
    r.playing(larger, false);
    expect(frame.kinds().filter((k) => k === "discontinuity")).toHaveLength(before);
    // Still within the second of the last pick (no clock move): a trusted playing whose target is
    // neither video picks again now, where a pointer move would keep the old pick.
    r.move(641, 360);
    expect(frame.kinds().filter((k) => k === "discontinuity")).toHaveLength(before);
    r.playing(r.doc.body.appendChild(r.doc.createElement("audio")));
    expect(frame.kinds().filter((k) => k === "discontinuity")).toHaveLength(before + 1);
    // The new main video counts for the pointer at once.
    r.move(1500, 850);
    expect(frame.sent.map((s) => s.message as { kind: string }).at(-1)?.kind).toBe("pointer");
  });

  it("an untrusted playing past the second a pick is kept picks nothing either", async () => {
    const r = await showing();
    const frame = r.computeWindow()!;
    const larger = r.doc.body.appendChild(new Video(r.doc)) as Video;
    larger.rect = { left: 0, top: 0, width: 1600, height: 900 };
    const before = frame.kinds().filter((k) => k === "discontinuity").length;
    r.advance(1_500);
    r.playing(larger, false);
    expect(frame.kinds().filter((k) => k === "discontinuity")).toHaveLength(before);
  });

  it("leaving a watch page for the miniplayer detaches the video; back on /watch with no new playing, the next pointer picks it again and hovers work", async () => {
    const r = await showing();
    const frame = r.computeWindow()!;
    // The miniplayer: another address, a smaller player.
    r.win.location.href = `${PAGE}/`;
    r.video.rect = { left: 1100, top: 600, width: 400, height: 225 };
    const discontinuities = () => frame.kinds().filter((k) => k === "discontinuity").length;
    const before = discontinuities();
    r.move(1200, 700);
    expect(discontinuities()).toBe(before + 1); // the control was given no video
    r.move(1210, 700);
    expect(discontinuities()).toBe(before + 1); // no video followed: nothing to detach again
    // Back on /watch, the player full size again, no new playing, within the second.
    r.win.location.href = WATCH;
    r.video.rect = { left: 0, top: 0, width: 1280, height: 720 };
    r.advance(100);
    frame.sent.length = 0;
    r.move();
    expect(frame.kinds()).toEqual(["discontinuity", "pointer"]);
    r.status("ready");
    r.request(7);
    await settle();
    expect(r.answer()).toMatchObject({ kind: "frame", requestId: 7 });
    const shows = r.shows().length;
    r.shown({ ...CARD, cardId: "OGN-002" });
    expect(r.shows()).toHaveLength(shows + 1);
    expect(viewVisible(r)).toBe(true);
  });

  it("back on /watch with the player still under 320 px at the first move: no pick for up to a second, then hovers work once it grows", async () => {
    const r = await showing();
    const frame = r.computeWindow()!;
    r.win.location.href = `${PAGE}/`;
    r.video.rect = { left: 1100, top: 600, width: 300, height: 169 };
    r.move(1200, 700);
    r.win.location.href = WATCH;
    frame.sent.length = 0;
    r.move(1200, 700); // the player is still small: no main video, kept for a second
    expect(frame.kinds()).toEqual([]);
    r.video.rect = { left: 0, top: 0, width: 1280, height: 720 };
    r.advance(500);
    r.move();
    expect(frame.kinds()).toEqual([]);
    r.advance(500);
    r.move();
    expect(frame.kinds()).toEqual(["discontinuity", "pointer"]);
    r.request(3);
    await settle();
    expect(r.answer()).toMatchObject({ kind: "frame", requestId: 3 });
    r.shown({ ...CARD, cardId: "OGN-003" });
    expect(viewVisible(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------- the switch
describe("the enabled switch", () => {
  it("start-up race: hovers turned off while the start-up read is pending, the read answering on, end off", async () => {
    let answer!: (v: Record<string, unknown>) => void;
    const storage = { get: () => new Promise<Record<string, unknown>>((resolve) => (answer = resolve)) };
    const r = await stand({ storage, noSettle: true });
    r.setFlag("enabled", true, false);
    answer({ enabled: true });
    await settle();
    expect(r.host.state).toBe("off");
    expect(r.iframes()).toHaveLength(0);
  });

  it("a flip to off that lands after the read has its answer, but before the host applies it, leaves no video followed", async () => {
    // The read answers on; the change comes in the moment between (a reaction queued behind the
    // switch's own). The flip is newer, so the answer is dropped, and no video is picked for it.
    const r = await stand({
      noSettle: true,
      storage: (bus) => ({
        get: () => {
          const answer = Promise.resolve({ enabled: true });
          void answer.then(() => undefined).then(() => bus.emit({ enabled: { oldValue: true, newValue: false } }));
          return answer;
        },
      }),
    });
    await settle();
    expect(r.host.state).toBe("off");
    expect(r.iframes()).toHaveLength(0);
    expect(r.video.listeners).toEqual([]);
  });

  it("a failed start-up read runs on; a write of false over a stored false still turns hovers off", async () => {
    const storage = { get: () => Promise.reject(new Error("storage unavailable")) };
    const r = await stand({ storage });
    expect(r.host.state).toBe("live");
    expect(r.iframes()).toHaveLength(2);
    r.setFlag("enabled", false, false);
    expect(r.host.state).toBe("off");
    expect(r.iframes()).toHaveLength(0);
    expect(r.names().at(-1)).toBe("detach");
  });

  it("an off-to-on flip during the start-up read is one switch-on: the read's answer after it changes nothing", async () => {
    let answer!: (v: Record<string, unknown>) => void;
    const storage = { get: () => new Promise<Record<string, unknown>>((resolve) => (answer = resolve)) };
    const r = await stand({ storage, noSettle: true });
    r.setFlag("enabled", false, true);
    expect(r.iframes()).toHaveLength(2);
    const compute = r.compute();
    answer({ enabled: false });
    await settle();
    expect(r.host.state).toBe("live");
    expect(r.compute()).toBe(compute);
    expect(r.iframes()).toHaveLength(2);
    expect(r.names().filter((n) => n === "attach")).toHaveLength(1);
    expect(r.computeWindow()!.kinds().filter((k) => k === "hello")).toHaveLength(1);
  });

  it("off removes both frames and the outline, detaches the video, and a later shown card shows nothing (S-B11)", async () => {
    const r = await showing();
    const frame = r.computeWindow()!;
    r.setFlag("enabled", true, false);
    expect(r.iframes()).toHaveLength(0);
    expect(r.outline()).toBeNull();
    // The video is no longer followed: the control's watch on it and the box observer are gone.
    expect(r.video.listeners).toEqual([]);
    expect(observing(r.video)).toBe(0);
    const at = r.calls.length;
    r.deliver(protocol.tag({ kind: "shown", card: CARD }), frame);
    r.move();
    r.playing();
    expect(r.calls.length).toBe(at);
    // Not followed again by a trusted playing while off.
    expect(r.video.listeners).toEqual([]);
    expect(observing(r.video)).toBe(0);
    expect(r.iframes()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------- the hello
describe("the hello to a new compute frame", () => {
  it("is sent once the frame leaves its first about:blank, within one 250 ms look, and never into the blank page", async () => {
    // Timing the fixture can compare against a wait for the iframe's `load`: the first hello goes
    // at most one look (250 ms) after the frame holds the extension's page.
    const r = await stand({ paused: true });
    r.move();
    const frame = r.computeWindow()!;
    expect(frame.kinds()).toEqual(["hello"]);
    const late = await stand({ paused: true });
    onBlank(late);
    late.move();
    const blank = late.computeWindow()!;
    late.advance(1_000);
    expect(blank.sent).toHaveLength(0);
    blank.loaded = true;
    late.advance(249);
    expect(blank.kinds()).toEqual([]);
    late.advance(1);
    expect(blank.kinds()).toEqual(["hello"]);
  });
});

// ---------------------------------------------------------------------- stop
describe("stop()", () => {
  it("leaves no listener, timer or element", async () => {
    const r = await showing();
    // A hide timer, a hello timer and an animation frame pending.
    r.move(1400, 800);
    r.shown(null);
    r.host.relayout();
    r.compute()!.remove();
    r.playing();
    expect(r.pendingTimers()).toBeGreaterThan(0);
    expect(r.win.frames.size).toBe(1);
    expect(observing(r.video)).toBe(1);
    r.host.stop();
    expect(r.win.listeners).toEqual([]);
    expect(r.doc.listeners).toEqual([]);
    expect(r.video.listeners).toEqual([]);
    expect(r.bus.listeners).toBe(0);
    expect(observing(r.video)).toBe(0);
    expect(r.pendingTimers()).toBe(0);
    expect(r.win.frames.size).toBe(0);
    expect(r.iframes()).toHaveLength(0);
    expect(r.outline()).toBeNull();
    expect(r.doc.documentElement.all().map((e) => e.tagName)).toEqual(["BODY", "VIDEO"]);
    expect(r.names().at(-1)).toBe("detach");
    expect(r.host.state).toBe("off");
    // Nothing comes back.
    r.playing();
    r.move();
    expect(r.iframes()).toHaveLength(0);
  });

  it("stopped before the start-up read answers: the answer does nothing", async () => {
    let answer!: (v: Record<string, unknown>) => void;
    const storage = { get: () => new Promise<Record<string, unknown>>((resolve) => (answer = resolve)) };
    const r = await stand({ storage, noSettle: true });
    r.host.stop();
    answer({ enabled: true });
    await settle();
    expect(r.iframes()).toHaveLength(0);
    expect(r.bus.listeners).toBe(0);
  });
});
