// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental): the content realm.
//
// `startHostContent` runs in a video page. It
//   - follows the page's main video (video-pick.ts, S-G4) and hands it to the toolkit's capture
//     control, which gives the compute frame pictures only on the authority of the viewer's own
//     (trusted) pointer events (capture-control.ts). Where a point counts is checked at each event
//     and at each capture: over the main video's picture, on an active page (site-policy.ts, S-G1,
//     S-G5), while hovers are on;
//   - makes and removes the two frames as the lifecycle reducer says (lifecycle.ts), feeding it the
//     switch, trusted `playing` events, trusted pointer events, the tab coming to the front, the
//     control's idle removal and make, and keep-card flips, with the facts of the moment;
//   - shows the card the compute frame names through the product's view adapter (view.ts), with
//     the outline around it (outline.ts), and hides both `HIDE_DELAY_MS` after the pointer no longer
//     holds authority over a card.
// It reads the `enabled` switch once at start, after it has begun listening for changes, so a
// change made while the read is pending wins (S-H1).

import { type ClientBox, fractionIn } from "../capture.js";
import { createCaptureControl } from "../capture-control.js";
import { computeProtocol, type FractionBox, type ShownCard } from "../compute-messages.js";
import type { ProductConfig } from "./config.js";
import { INITIAL_LIFECYCLE, type LifecycleEvent, type LifecycleFacts, type LifecyclePage, type LifecycleState, lifecycleStep } from "./lifecycle.js";
import { CardOutline, outlinePlace } from "./outline.js";
import type { KeyValueStorage, StorageChange, StorageChanges } from "./settings-core.js";
import { type PagePolicy, pagePolicy } from "./site-policy.js";
import { createSwitches, ENABLED_KEY } from "./switches.js";
import { createVideoPick, pictureOf } from "./video-pick.js";
import { createViewFrame, FRAME_STYLE, fromViewFrame, mountHost, type ViewAdapter, type ViewFrame, viewFrameHandle } from "./view.js";

/** The time the shown card stays after the pointer leaves it. */
export const HIDE_DELAY_MS = 120;

export interface HostContentEnv {
  config: ProductConfig;
  win: Window;
  doc: Document;
  extensionUrl(path: string): string;
  storage: Pick<KeyValueStorage, "get">;
  storageChanges: StorageChanges;
  view: ViewAdapter;
  now?: () => number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export interface HostContent {
  /** The adapter's own inputs changed (card size, language): place the shown card again. */
  relayout(): void;
  readonly state: "off" | "waiting" | "owed" | "live" | "idle";
  stop(): void;
}

type Changes = Record<string, StorageChange | undefined>;

const defaultTimers = {
  set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The view frame the host made, with the handle the adapter was given. */
interface ViewSlot {
  element: HTMLIFrameElement;
  handle: ViewFrame;
}

export function startHostContent(env: HostContentEnv): HostContent {
  const { config, win, doc, view: adapter } = env;
  const now = env.now ?? ((): number => performance.now());
  const timers = env.timers ?? defaultTimers;
  /** `chrome-extension://<id>`: the extension's base address without its trailing slash. */
  const origin = env.extensionUrl("").replace(/\/$/, "");
  const switches = createSwitches(env.storage, env.storageChanges);

  let lifecycle: LifecycleState = INITIAL_LIFECYCLE;
  let stopped = false;
  /** The video the capture control watches now, and the observer that follows its box. */
  let followed: HTMLVideoElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let computeFrame: HTMLIFrameElement | null = null;
  let viewSlot: ViewSlot | null = null;
  let outline: CardOutline | null = null;
  /** The view frame is on show (the host's own visibility). */
  let frameVisible = false;
  /** The card the compute frame names now (null: none). */
  let shown: ShownCard | null = null;
  /** The card on show, or held for the quick hide; null once hidden. */
  let displayed: ShownCard | null = null;
  let hideTimer: unknown = null;
  let layoutFrame: number | null = null;
  let loadError: string | null = null;

  const pick = createVideoPick({ doc, now, onChange: (video) => follow(video) });

  const control = createCaptureControl({
    protocol: computeProtocol(config.tag),
    frame: () => computeFrame?.contentWindow ?? null,
    frameOrigin: origin,
    now,
    timers,
    // Asked on every pointer event and again before every capture, so a page left by in-page
    // navigation (a miniplayer going on) gives no picture, also under a resting pointer (S-G5).
    eligible: (x, y, video) => {
      if (lifecycle.phase === "off" || video !== followed || !video.isConnected || !policyNow().active) return null;
      return fractionIn(pictureOf(video), x, y);
    },
    onShown: (card) => dispatch({ type: "shown" }, card),
    onStatus: (status) => {
      if (status.state === "failed" && status.error !== loadError) {
        loadError = status.error;
        // The page's own console only; nothing is reported anywhere.
        console.warn(`${config.name}: the card recognition model did not load (${status.error ?? "unknown reason"}).`);
      }
    },
    onProblem: (problem) => {
      // A compute frame of another version (an update half applied): nothing is captured.
      if (problem.kind === "version") console.warn(`${config.name}: reload the page to finish updating the extension.`);
    },
    // Idle: both frames go (the view frame's renderer too, or the memory does not come back), and
    // the next trusted move over the video makes them again; the control then connects (S-A4).
    whenIdle: { remove: () => dispatch({ type: "idle-remove" }), make: () => dispatch({ type: "idle-make" }) },
    grab: {
      createCanvas: () => doc.createElement("canvas"),
      createImageBitmap: (canvas) => win.createImageBitmap(canvas),
    },
  });

  // ------------------------------------------------------------------ facts
  function policyNow(): PagePolicy {
    try {
      return pagePolicy(new URL(win.location.href), config);
    } catch {
      return { active: false };
    }
  }

  const pageOf = (policy: PagePolicy): LifecyclePage => (policy.active ? policy.load : "inactive");

  function framesNow(): LifecycleFacts["frames"] {
    return { compute: computeFrame?.isConnected === true, view: viewSlot?.element.isConnected === true };
  }

  /** The facts now. `video`: the main video as picked for this event (null: none or not picked). */
  function factsWith(policy: PagePolicy, video: HTMLVideoElement | null): LifecycleFacts {
    return {
      visible: doc.visibilityState !== "hidden",
      page: pageOf(policy),
      mainPlaying: video !== null && !video.paused && !video.ended,
      frames: framesNow(),
    };
  }

  /** The facts for an event that is not a pointer or a `playing`: the main video is picked (at most
   *  once a second) only while hovers are on or turning on, and only on an active page (S-G5). */
  function facts(pickVideo: boolean): LifecycleFacts {
    const policy = policyNow();
    return factsWith(policy, pickVideo && policy.active ? pick.current() : null);
  }

  /** Whether the reducer may read whether the main video plays for this event: the tab coming to
   *  the front while on, and a switch-on the reducer applies (not a start-up read a flip beat). */
  function picksFor(event: LifecycleEvent): boolean {
    if (event.type === "front") return lifecycle.phase !== "off";
    if (event.type !== "switch" || !event.on) return false;
    return !(event.from === "read" && lifecycle.switchHeard) && lifecycle.phase === "off";
  }

  // ------------------------------------------------------------------ the reducer
  function dispatch(event: LifecycleEvent, card?: ShownCard | null, given?: LifecycleFacts): void {
    if (stopped) return;
    const step = lifecycleStep(lifecycle, event, given ?? facts(picksFor(event)));
    lifecycle = step.state;
    for (const effect of step.effects) {
      switch (effect.type) {
        case "make":
          makeMissing(effect.connect);
          break;
        case "remake-compute":
          remakeCompute();
          break;
        case "remove":
          removeFrames();
          break;
        case "detach-video":
          detachVideo();
          break;
        case "show":
          shown = card ?? null;
          updateCard();
          break;
      }
    }
  }

  // ------------------------------------------------------------------ the video
  /** Hand the video to the control (another video clears the gate and is a new source to the
   *  frame), and follow its box for the shown card. */
  function follow(video: HTMLVideoElement | null): void {
    if (video === followed) return;
    resizeObserver?.disconnect();
    resizeObserver = null;
    followed = video;
    control.attach(video);
    if (!video) return;
    // The player resized (theater mode, the site's own layout): place the card again.
    const Observer = (win as Window & typeof globalThis).ResizeObserver;
    if (typeof Observer === "function") {
      resizeObserver = new Observer(() => onLayout());
      resizeObserver.observe(video);
    }
  }

  /** Stop following the video; the next trusted pointer on an active page picks at once. */
  function detachVideo(): void {
    if (followed !== null) follow(null);
    pick.clear();
  }

  // ------------------------------------------------------------------ the frames
  function makeCompute(): void {
    const frame = doc.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    // Not display:none: a hidden frame keeps running, and the browser may slow a frame that is
    // not rendered.
    frame.style.cssText = `${FRAME_STYLE}width:1px;height:1px;left:-10px;top:-10px;opacity:0;pointer-events:none;`;
    frame.src = env.extensionUrl(config.frames.compute);
    doc.documentElement.appendChild(frame);
    computeFrame = frame;
  }

  /** Forget the view frame (removed or gone): the adapter detaches, the outline goes. */
  function dropView(): void {
    if (!viewSlot) return;
    viewSlot.element.remove();
    viewSlot = null;
    frameVisible = false;
    outline?.remove();
    outline = null;
    adapter.detach();
  }

  /** A new view frame where it is drawn, and the outline beside it; the adapter attaches. The
   *  caller shows the displayed card again straight after. */
  function makeView(): void {
    const host = mountHost(doc);
    const element = createViewFrame(doc, host, env.extensionUrl(config.frames.view), adapter.look);
    viewSlot = { element, handle: viewFrameHandle(element, origin) };
    frameVisible = false;
    outline?.remove();
    outline = new CardOutline(host, config);
    adapter.attach(viewSlot.handle);
  }

  /** The displayed (or held) card, shown again in a new view frame without waiting for a new one. */
  function showAgain(): void {
    const card = displayed;
    displayed = null;
    if (card && followed) showCard(card);
  }

  /** Make whichever frame is not in the page; say hello to a new compute frame when `connect`. */
  function makeMissing(connect: boolean): void {
    let newCompute = false;
    if (!computeFrame?.isConnected) {
      computeFrame?.remove();
      makeCompute();
      newCompute = true;
    }
    if (!viewSlot?.element.isConnected) {
      dropView();
      makeView();
      showAgain();
    }
    // Hello until the new frame says ready; the control then tells it the picture's time and the
    // pointer that started it. Right after the append: `connect` waits out the first about:blank.
    if (newCompute && connect) control.connect();
  }

  /** Keep-card flip (S-H3): a new compute frame, the view frame kept, the card on show gone. */
  function remakeCompute(): void {
    clearHide();
    shown = null;
    hideCard();
    computeFrame?.remove();
    computeFrame = null;
    makeMissing(true);
  }

  /** Both frames, the outline and the card on show go (off, idle). The video stays followed. */
  function removeFrames(): void {
    clearHide();
    shown = null;
    displayed = null;
    computeFrame?.remove();
    computeFrame = null;
    dropView();
  }

  // ------------------------------------------------------------------ the card
  function clearHide(): void {
    if (hideTimer !== null) timers.clear(hideTimer);
    hideTimer = null;
  }

  /** Whether the viewer's pointer holds capture authority now (the control's gate). */
  const pointing = (): boolean => control.gateState().inside;

  /** The card named now, shown while the pointer holds authority; else hidden a moment later. */
  function updateCard(): void {
    const card = shown;
    if (card && followed && pointing()) {
      clearHide();
      showCard(card);
      return;
    }
    if (displayed === null || hideTimer !== null) return;
    hideTimer = timers.set(() => {
      hideTimer = null;
      if (shown && pointing()) return;
      hideCard();
    }, HIDE_DELAY_MS);
  }

  function setVisible(visible: boolean): void {
    frameVisible = visible;
    if (viewSlot) viewSlot.element.style.visibility = visible ? "visible" : "hidden";
  }

  function showCard(card: ShownCard): void {
    const video = followed;
    if (!video || lifecycle.phase === "off" || lifecycle.phase === "idle") return;
    // The page removed the view frame: make it again (the card is sent again below).
    if (!viewSlot?.element.isConnected) {
      dropView();
      makeView();
    }
    const picture = pictureOf(video);
    const toBox = (b: FractionBox): ClientBox => ({
      left: picture.left + b.x * picture.width,
      top: picture.top + b.y * picture.height,
      width: b.width * picture.width,
      height: b.height * picture.height,
    });
    const layout = {
      picture,
      card: toBox(card.box),
      others: (card.others ?? []).map(toBox),
      viewport: { width: win.innerWidth, height: win.innerHeight },
      // Off the cards around the shown one, and below the player's top (a site's header).
      minTop: video.getBoundingClientRect().top,
      visible: frameVisible,
    };
    displayed = card;
    // Shown once the frame has measured itself for this card; the outline comes with it. A card
    // the reading hold keeps after it was seen gone (`held`) keeps its frame but has no outline
    // (S-F4).
    const ready = adapter.show(card, layout);
    setVisible(ready);
    if (outline && !outline.element.isConnected) outline = new CardOutline(viewSlot?.element.parentElement ?? mountHost(doc), config);
    outline?.show(ready ? outlinePlace(picture, card, video.videoWidth > 0 && video.videoHeight > 0) : null);
  }

  function hideCard(): void {
    setVisible(false);
    if (displayed !== null) adapter.hide();
    displayed = null;
    outline?.hide();
  }

  // ------------------------------------------------------------------ page events
  /** The window was resized or scrolled, or the video's box changed: while a card is shown,
   *  place it and its outline again, at most once an animation frame. */
  function onLayout(): void {
    if (stopped || displayed === null || layoutFrame !== null) return;
    layoutFrame = win.requestAnimationFrame(() => {
      layoutFrame = null;
      if (displayed && followed) showCard(displayed);
    });
  }

  /** A scroll that can move the video: the page's own, or a box holding the player. Others (a
   *  chat that scrolls itself) are ignored, so they do not force a layout every frame. */
  const onScroll = (event: Event): void => {
    const target = event.target as (Node & { contains?: (node: Node) => boolean }) | null;
    if (target === doc || target === doc.documentElement || target === doc.body || target === doc.scrollingElement) {
      onLayout();
      return;
    }
    if (followed && typeof target?.contains === "function" && target.contains(followed)) onLayout();
  };

  /** The host's pointer authority: picks the video and has the reducer make the frames. It listens
   *  before the capture control, on the same target and phase, so the same trusted move that first
   *  comes over a picture attaches the video before the control reads that move. */
  const onPointer = (event: Event): void => {
    const e = event as PointerEvent;
    // Only the viewer's own pointer counts: events a page script makes are ignored.
    if (stopped || e.isTrusted !== true || lifecycle.phase === "off") return;
    const policy = policyNow();
    if (!policy.active) {
      // S-G5: off an active page a pointer counts for nothing, and the video is not followed.
      dispatch({ type: "pointer", trusted: true, overPicture: false }, undefined, factsWith(policy, null));
      return;
    }
    const video = pick.current();
    const frames = framesNow();
    // Both frames there: nothing more to do (the control measures the picture itself; a second
    // measure per move would only cost the page a layout).
    if (lifecycle.phase === "live" && frames.compute && frames.view) return;
    const overPicture = video !== null && fractionIn(pictureOf(video), e.clientX, e.clientY) !== null;
    dispatch({ type: "pointer", trusted: true, overPicture }, undefined, factsWith(policy, video));
  };

  /** A video started playing. Media events do not bubble, but a capturing listener on the document
   *  hears every video in it. A trusted one picks the main video again at once, whatever its target
   *  (S-G4); a page script's made-up one is ignored (S-A1). */
  const onPlaying = (event: Event): void => {
    if (stopped || event.isTrusted !== true || lifecycle.phase === "off") return;
    const policy = policyNow();
    const video = policy.active ? pick.onPlaying(event) : null;
    dispatch({ type: "playing", trusted: true }, undefined, factsWith(policy, video));
  };

  const onVisibility = (): void => {
    if (doc.visibilityState !== "hidden") dispatch({ type: "front" });
  };

  /** Moving a frame reloads it: in full screen, a new view frame where it is drawn, and the card
   *  shown (or held, on a paused video) shown in it at once, without a pointer move. The compute
   *  frame stays. */
  const onFullscreen = (): void => {
    if (stopped || !viewSlot) return;
    viewSlot.element.remove();
    viewSlot = null;
    makeView();
    showAgain();
  };

  const onMessage = (event: Event): void => {
    const e = event as MessageEvent;
    // The compute frame's messages are the control's (checked: trusted, that frame, our origin).
    if (stopped || control.onMessage(e)) return;
    if (!viewSlot || !fromViewFrame(e, viewSlot.element, origin)) return;
    if (adapter.message(e.data)) updateCard();
  };

  // ------------------------------------------------------------------ the switches
  /** Any write of `enabled`, applied when it differs from the state applied last (the reducer
   *  compares), not only on a stored flip: after a failed start-up read the host runs on, and a
   *  write of false over a stored false still turns it off. */
  const onStorage = (changes: Changes, area: string): void => {
    if (area !== "local" || !(ENABLED_KEY in changes)) return;
    dispatch({ type: "switch", on: changes[ENABLED_KEY]?.newValue !== false, from: "flip" });
  };

  // ------------------------------------------------------------------ start
  const capture = { capture: true, passive: true } as const;
  // Ours first: on the window, in the capture phase, before the control's own listeners.
  win.addEventListener("pointermove", onPointer, capture);
  win.addEventListener("pointerdown", onPointer, capture);
  const stopListening = control.listen(win, doc);
  win.addEventListener("message", onMessage);
  doc.addEventListener("playing", onPlaying, capture);
  doc.addEventListener("visibilitychange", onVisibility);
  doc.addEventListener("fullscreenchange", onFullscreen);
  // The page moving under a held card: the card and the outline follow it.
  win.addEventListener("resize", onLayout, { passive: true });
  doc.addEventListener("scroll", onScroll, capture);
  // Subscribed before the read (S-H1): a change while it is pending stands over its answer.
  env.storageChanges.addListener(onStorage);
  const stopKeepCard = switches.watch({ keepCard: () => dispatch({ type: "keep-card" }) });
  void switches.enabled().then(
    (on) => dispatch({ type: "switch", on, from: "read" }),
    () => dispatch({ type: "switch", on: true, from: "read" }),
  );

  return {
    relayout: onLayout,
    get state() {
      return stopped ? "off" : lifecycle.phase;
    },
    stop() {
      if (stopped) return;
      win.removeEventListener("pointermove", onPointer, capture);
      win.removeEventListener("pointerdown", onPointer, capture);
      win.removeEventListener("message", onMessage);
      doc.removeEventListener("playing", onPlaying, capture);
      doc.removeEventListener("visibilitychange", onVisibility);
      doc.removeEventListener("fullscreenchange", onFullscreen);
      win.removeEventListener("resize", onLayout);
      doc.removeEventListener("scroll", onScroll, capture);
      env.storageChanges.removeListener(onStorage);
      stopKeepCard();
      removeFrames();
      if (layoutFrame !== null) win.cancelAnimationFrame(layoutFrame);
      layoutFrame = null;
      follow(null);
      pick.clear();
      stopListening();
      control.stop();
      stopped = true;
      lifecycle = INITIAL_LIFECYCLE;
    },
  };
}
