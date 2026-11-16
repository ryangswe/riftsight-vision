// SPDX-License-Identifier: Apache-2.0
// The shared hover host (experimental, not part of the public API): what a product tells the host
// about itself. Types are frozen here. The one function, `productConfigError`, runs in a service worker too, so
// it holds no DOM.

import { computeProtocol } from "../compute-messages.js";

export interface ProductConfig {
  /** Tag of the two-frame messages and of the outline's marker (data-<tag>="outline"). */
  tag: string;
  /** Shown in console lines only. */
  name: string;
  sites: { youtube: boolean; twitch: boolean };
  /** A development build: also serves http://127.0.0.1 and http://localhost. */
  dev: boolean;
  /** The extension's two pages, as paths inside it. */
  frames: { compute: string; view: string };
  outline: { edgeColor: string; glowColor: string };
  capabilities: {
    /** The product's releases can carry a geometric stage: focus scope, and the stage loads at
     *  the earliest pointer. False: a load request with geometric fields is refused at start. */
    geometricStage: boolean;
  };
}

type Raw = Record<string, unknown>;

const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keys of `raw` that are not in `allowed`, as a message; null when there are none. */
function unknownKeys(raw: Raw, allowed: readonly string[], where: string): string | null {
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return null;
  return `${where}: unknown key${extra.length > 1 ? "s" : ""} ${extra.map((k) => JSON.stringify(k)).join(", ")}`;
}

/** A path inside the extension: no scheme, no leading slash, no `..` part, no backslash. */
function extensionPathError(value: unknown, where: string): string | null {
  if (typeof value !== "string" || value.trim() === "") return `${where}: must be a non-empty string`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    return `${where}: must be a path inside the extension (no scheme, no leading slash): ${JSON.stringify(value)}`;
  }
  if (value.includes("\\") || value.split("/").includes("..")) return `${where}: must not climb out of the extension (no "..", no backslash): ${JSON.stringify(value)}`;
  return null;
}

function colorError(value: unknown, where: string): string | null {
  return typeof value === "string" && value.trim() !== "" ? null : `${where}: must be a non-empty color string`;
}

function booleansError(raw: unknown, keys: readonly string[], where: string): string | null {
  if (!isRecord(raw)) return `${where}: must be an object`;
  const extra = unknownKeys(raw, keys, where);
  if (extra) return extra;
  for (const k of keys) if (typeof raw[k] !== "boolean") return `${where}.${k}: must be a boolean`;
  return null;
}

/** What is wrong with a raw config, as one message; null when it is a valid ProductConfig. */
export function productConfigError(raw: unknown): string | null {
  if (!isRecord(raw)) return "config: must be an object";
  const extra = unknownKeys(raw, ["tag", "name", "sites", "dev", "frames", "outline", "capabilities"], "config");
  if (extra) return extra;

  // The tag names the messages and the outline's data attribute: the messages' own rule decides.
  if (typeof raw.tag !== "string") return "tag: must be a string";
  try {
    computeProtocol(raw.tag);
  } catch {
    return `tag: not usable (lowercase letters, digits and hyphens, starting with a letter, and not a field of the messages): ${JSON.stringify(raw.tag)}`;
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") return "name: must be a non-empty string";
  const sites = booleansError(raw.sites, ["youtube", "twitch"], "sites");
  if (sites) return sites;
  if (typeof raw.dev !== "boolean") return "dev: must be a boolean";

  if (!isRecord(raw.frames)) return "frames: must be an object";
  const frameKeys = unknownKeys(raw.frames, ["compute", "view"], "frames");
  if (frameKeys) return frameKeys;
  for (const k of ["compute", "view"]) {
    const bad = extensionPathError(raw.frames[k], `frames.${k}`);
    if (bad) return bad;
  }

  if (!isRecord(raw.outline)) return "outline: must be an object";
  const outlineKeys = unknownKeys(raw.outline, ["edgeColor", "glowColor"], "outline");
  if (outlineKeys) return outlineKeys;
  for (const k of ["edgeColor", "glowColor"]) {
    const bad = colorError(raw.outline[k], `outline.${k}`);
    if (bad) return bad;
  }

  return booleansError(raw.capabilities, ["geometricStage"], "capabilities");
}
