// SPDX-License-Identifier: Apache-2.0
// The fixture's view frame: it shows the picture of the card it is told about, measures itself
// when the picture has loaded, and says its size to the adapter. The pictures are the toy game's
// (colored shapes), shipped inside the extension: nothing is fetched.

import { allowedParentOrigin } from "@cardvision/host-settings";

import { CONFIG } from "./config.js";
import { type FromViewFrame, parseToView, VIEW_TAG } from "./messages.js";

const box = document.getElementById("box") as HTMLElement;
const art = document.getElementById("art") as HTMLElement;
const img = document.getElementById("img") as HTMLImageElement;
const pill = document.getElementById("pill") as HTMLElement;

// The embedding page's origin, the one place a message goes to; none that the host allows: none sent.
const ancestor = location.ancestorOrigins?.[0];
const parentOrigin = ancestor !== undefined && allowedParentOrigin(ancestor, CONFIG) ? ancestor : null;

function say(message: FromViewFrame): void {
  if (parentOrigin !== null) window.parent.postMessage(message, parentOrigin);
}

let current: { cardId: string; seq: number } | null = null;

/** The frame's size now: the box that holds the picture or the name. */
function measure(): void {
  if (!current) return;
  const rect = box.getBoundingClientRect();
  say({ tag: VIEW_TAG, kind: "size", cardId: current.cardId, seq: current.seq, width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
}

img.addEventListener("load", () => {
  art.classList.remove("loading");
  measure();
});
img.addEventListener("error", () => {
  // No picture: the name alone.
  art.hidden = true;
  pill.hidden = false;
  measure();
});

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== parentOrigin) return;
  const message = parseToView(event.data);
  if (!message) return;
  if (message.kind === "hide") return;
  current = { cardId: message.cardId, seq: message.seq };
  pill.textContent = message.name;
  pill.hidden = true;
  art.hidden = false;
  art.classList.add("loading");
  img.alt = message.name;
  img.src = `art/${message.cardId}.png`;
});

say({ tag: VIEW_TAG, kind: "ready" });
