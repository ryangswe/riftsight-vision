// SPDX-License-Identifier: Apache-2.0
// The messages between the content script's adapter and the view frame (the fixture's own; the
// host never reads them).

export const VIEW_TAG = "toy-view";

/** The adapter to the view frame. */
export type ToViewFrame = { tag: typeof VIEW_TAG; kind: "card"; cardId: string; name: string; seq: number } | { tag: typeof VIEW_TAG; kind: "hide" };

/** The view frame to the adapter. */
export type FromViewFrame = { tag: typeof VIEW_TAG; kind: "ready" } | { tag: typeof VIEW_TAG; kind: "size"; cardId: string; seq: number; width: number; height: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function parseFromView(data: unknown): FromViewFrame | null {
  if (!isObject(data) || data.tag !== VIEW_TAG) return null;
  if (data.kind === "ready") return { tag: VIEW_TAG, kind: "ready" };
  if (data.kind === "size" && typeof data.cardId === "string" && Number.isFinite(data.seq) && Number.isFinite(data.width) && Number.isFinite(data.height)) {
    return { tag: VIEW_TAG, kind: "size", cardId: data.cardId, seq: Number(data.seq), width: Number(data.width), height: Number(data.height) };
  }
  return null;
}

export function parseToView(data: unknown): ToViewFrame | null {
  if (!isObject(data) || data.tag !== VIEW_TAG) return null;
  if (data.kind === "hide") return { tag: VIEW_TAG, kind: "hide" };
  if (data.kind === "card" && typeof data.cardId === "string" && typeof data.name === "string" && Number.isFinite(data.seq)) {
    return { tag: VIEW_TAG, kind: "card", cardId: data.cardId, name: data.name, seq: Number(data.seq) };
  }
  return null;
}
