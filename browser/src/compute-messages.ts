// SPDX-License-Identifier: Apache-2.0
// The messages between a content script (in the video page) and the compute frame inside that
// page, which hosts the recognition worker: the two-frame contract (docs/extension-session.md).
//
// They travel by `window.postMessage`, so the page itself could post to the frame or read its
// replies. Every message is checked on arrival (`parseComputeIn`, `parseComputeOut`), and
// nothing in them is secret: frames are pictures the page already shows, replies are card names
// and boxes. Each message carries `<tag>: 1` (an extension's own tag) so that unrelated messages
// on the same window are told apart.
//
// A parser keeps only the fields it knows: extra fields on a message are ignored, never refused
// and never passed on.

/** A box in fractions of the analyzed frame (0 to 1). */
export interface FractionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The card a pointer position shows, as the compute frame reports it. */
export interface ShownCard {
  cardId: string;
  name: string;
  /** The remote release the card was recognized with; absent for the bundled release. */
  releaseId?: string;
  box: FractionBox;
  /** The other cards of the same analysis (at most `MAX_OTHER_BOXES`), so that a tooltip can be
   *  placed off them. */
  others?: FractionBox[];
}

/** The two-frame contract's version. A content script and a compute frame work together only
 *  when they speak the same one: `hello` and `ready` carry it, and each side compares. */
export const PROTOCOL_VERSION = 1;

/** Content script -> compute frame. */
export type ComputeIn =
  /** Asks the compute frame to say `ready` again, with its current status and shown card (a
   *  content script that started late, or came back). Any number of times; answered only once
   *  the frame can take messages. `version`: the content script's `PROTOCOL_VERSION`. */
  | { kind: "hello"; version: number }
  /** The pointer over the picture, in fractions of the picture; `mediaTime` is the video's time. */
  | { kind: "pointer"; x: number; y: number; mediaTime: number; touch: boolean }
  /** The pointer left the picture. */
  | { kind: "leave" }
  /** The video presented a new frame (playback, a seek ended, the video became ready). */
  | { kind: "presented"; mediaTime: number }
  /** A seek started, or the video was given another source (`newSource`). */
  | { kind: "discontinuity"; newSource: boolean }
  /** The picture was cut to another without a seek (reserved: no page helper sends it yet). */
  | { kind: "cut" }
  /** The picture asked for by `capture`, at analysis size. */
  | { kind: "frame"; requestId: number; bitmap: ImageBitmap; mediaTime: number }
  /** The picture asked for could not be had; `retry` when it is worth asking again. */
  | { kind: "capture-failed"; requestId: number; reason: string; retry?: boolean };

/** Compute frame -> content script. */
export type ComputeOut =
  /** The frame can take messages. `version`: its `PROTOCOL_VERSION`. `instance`: 16 lowercase
   *  hex characters, made once per compute frame, so that a content script tells a new frame
   *  (reloaded or replaced) from the one it spoke to. Not a secret: the page can read it. */
  | { kind: "ready"; version: number; instance: string }
  | { kind: "status"; state: "loading" | "ready" | "failed"; error: string | null; backend: string | null }
  /** Capture the current picture at a width within `analysisWidth` and send it back as `frame`. */
  | { kind: "capture"; requestId: number; analysisWidth: { min: number; max: number } }
  /** What a tooltip shows for the pointer's position now; null for nothing. */
  | { kind: "shown"; card: ShownCard | null };

/** The largest picture the compute frame takes, per side: above the widest analysis frame (1920)
 *  and any sane height at that width. A larger one (only a page posting to the frame could send
 *  it) is refused and closed. */
export const MAX_FRAME_SIDE = 4096;
/** The most other boxes a `shown` card carries; more are dropped. */
export const MAX_OTHER_BOXES = 40;
/** The longest `capture-failed` reason kept; a longer one is cut. */
export const MAX_REASON_LENGTH = 200;
/** The longest card id or name accepted; a status's longer error or backend is cut to it. */
export const MAX_TEXT_LENGTH = 200;

/** A message with the protocol's tag. */
export type Tagged<T> = T & { readonly [tag: string]: unknown };

export interface ComputeProtocol {
  /** The tag every message carries (`{ [tag]: 1 }`). */
  readonly name: string;
  /** The message with the tag added, ready to post. */
  tag<T extends object>(message: T): Tagged<T>;
  /** A content-script message, checked; null when it is not one. A bitmap in a `frame` message
   *  that is refused (too large, malformed) is closed. */
  parseComputeIn(data: unknown): ComputeIn | null;
  /** A compute-frame message, checked; null when it is not one. */
  parseComputeOut(data: unknown): ComputeOut | null;
}

type Raw = Record<string, unknown>;

const RELEASE_ID = /^[0-9a-f]{16}$/;
/** A compute frame's `instance`: 16 lowercase hex characters. */
const INSTANCE = /^[0-9a-f]{16}$/;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isFraction = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1;
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isText = (v: unknown, max = MAX_TEXT_LENGTH): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isVersion = isId;
/** An analysis width: a whole number of pixels, 1 to `MAX_FRAME_SIDE`. */
const isWidth = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_FRAME_SIDE;
/** A status's error or backend: null, or a string cut to `MAX_TEXT_LENGTH`; undefined when it is
 *  neither. */
const statusText = (v: unknown): string | null | undefined => (v === null ? null : typeof v === "string" ? v.slice(0, MAX_TEXT_LENGTH) : undefined);

function isBitmap(v: unknown): v is ImageBitmap {
  return typeof ImageBitmap !== "undefined" && v instanceof ImageBitmap;
}

function frameSizeOk(bitmap: ImageBitmap): boolean {
  const { width, height } = bitmap;
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= MAX_FRAME_SIDE && height <= MAX_FRAME_SIDE;
}

function parseBox(v: unknown): FractionBox | null {
  if (typeof v !== "object" || v === null) return null;
  const b = v as Raw;
  return isNum(b.x) && isNum(b.y) && isNum(b.width) && isNum(b.height) && b.width > 0 && b.height > 0
    ? { x: b.x, y: b.y, width: b.width, height: b.height }
    : null;
}

/** The fields of the contract's messages, both directions: a tag may not be one of them. */
const CONTRACT_FIELDS = new Set([
  "kind",
  "x",
  "y",
  "mediaTime",
  "touch",
  "newSource",
  "requestId",
  "bitmap",
  "reason",
  "retry",
  "state",
  "error",
  "backend",
  "analysisWidth",
  "card",
  "version",
  "instance",
]);
/** A tag's shape: lowercase letters, digits and hyphens, starting with a letter. */
const TAG_SHAPE = /^[a-z][a-z0-9-]*$/;

/** The messages of the two-frame contract, under an extension's own tag (lowercase letters,
 *  digits and hyphens, starting with a letter, and not a field of the messages). */
export function computeProtocol(tag = "cardvision"): ComputeProtocol {
  if (typeof tag !== "string" || !TAG_SHAPE.test(tag) || CONTRACT_FIELDS.has(tag)) throw new TypeError(`computeProtocol: not a usable tag: ${String(tag)}`);

  function tagged(data: unknown): Raw | null {
    if (typeof data !== "object" || data === null) return null;
    const raw = data as Raw;
    return raw[tag] === 1 && typeof raw.kind === "string" ? raw : null;
  }

  function parseFrame(m: Raw): ComputeIn | null {
    if (!isBitmap(m.bitmap)) return null;
    if (isId(m.requestId) && isNum(m.mediaTime) && frameSizeOk(m.bitmap)) {
      return { kind: "frame", requestId: m.requestId, bitmap: m.bitmap, mediaTime: m.mediaTime };
    }
    // Transferred to this frame and not taken: let its memory go now.
    m.bitmap.close();
    return null;
  }

  function parseComputeIn(data: unknown): ComputeIn | null {
    const m = tagged(data);
    if (!m) return null;
    switch (m.kind) {
      case "hello":
        return isVersion(m.version) ? { kind: "hello", version: m.version } : null;
      case "pointer":
        return isFraction(m.x) && isFraction(m.y) && isNum(m.mediaTime) && typeof m.touch === "boolean"
          ? { kind: "pointer", x: m.x, y: m.y, mediaTime: m.mediaTime, touch: m.touch }
          : null;
      case "leave":
        return { kind: "leave" };
      case "presented":
        return isNum(m.mediaTime) ? { kind: "presented", mediaTime: m.mediaTime } : null;
      case "discontinuity":
        return typeof m.newSource === "boolean" ? { kind: "discontinuity", newSource: m.newSource } : null;
      case "cut":
        return { kind: "cut" };
      case "frame":
        return parseFrame(m);
      case "capture-failed":
        return isId(m.requestId) && typeof m.reason === "string"
          ? { kind: "capture-failed", requestId: m.requestId, reason: m.reason.slice(0, MAX_REASON_LENGTH), retry: m.retry === true }
          : null;
      default:
        return null;
    }
  }

  function parseComputeOut(data: unknown): ComputeOut | null {
    const m = tagged(data);
    if (!m) return null;
    switch (m.kind) {
      case "ready":
        return isVersion(m.version) && typeof m.instance === "string" && INSTANCE.test(m.instance)
          ? { kind: "ready", version: m.version, instance: m.instance }
          : null;
      case "status": {
        const error = statusText(m.error);
        const backend = statusText(m.backend);
        return (m.state === "loading" || m.state === "ready" || m.state === "failed") && error !== undefined && backend !== undefined
          ? { kind: "status", state: m.state, error, backend }
          : null;
      }
      case "capture": {
        const w = m.analysisWidth as Raw | undefined;
        return isId(m.requestId) && typeof w === "object" && w !== null && isWidth(w.min) && isWidth(w.max) && w.max >= w.min
          ? { kind: "capture", requestId: m.requestId, analysisWidth: { min: w.min, max: w.max } }
          : null;
      }
      case "shown": {
        if (m.card === null) return { kind: "shown", card: null };
        const c = m.card as Raw | undefined;
        const box = typeof c === "object" && c !== null ? parseBox(c.box) : null;
        if (!(c && isText(c.cardId) && isText(c.name) && box)) return null;
        const others = Array.isArray(c.others) ? c.others.slice(0, MAX_OTHER_BOXES).map(parseBox).filter((b): b is FractionBox => b !== null) : [];
        const releaseId = typeof c.releaseId === "string" && RELEASE_ID.test(c.releaseId) ? c.releaseId : undefined;
        return { kind: "shown", card: { cardId: c.cardId, name: c.name, ...(releaseId ? { releaseId } : {}), box, others } };
      }
      default:
        return null;
    }
  }

  return {
    name: tag,
    tag: <T extends object>(message: T): Tagged<T> => ({ ...message, [tag]: 1 }) as Tagged<T>,
    parseComputeIn,
    parseComputeOut,
  };
}
