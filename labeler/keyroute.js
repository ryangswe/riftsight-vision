// SPDX-License-Identifier: Apache-2.0
// Who handles a key press, decided by where the keyboard focus is. Pure: no DOM. Shared by the
// page (window.LabelerKeyRoute) and Node (test_keyroute.js).
//
// The rule, in the order it is applied:
//   - A text field keeps every key: letters type. A menu (select) keeps its keys too.
//   - F6 moves the focus to the side panel's controls, from anywhere.
//   - The keys overlay takes `?` (open or close) and Esc (close) while it is open.
//   - With the focus on a button, a link or a disclosure, Enter and Space activate that control
//     and nothing else: they do not also confirm a frame. Space on a checkbox ticks it.
//   - Tab moves on from a focused control as in any page; Esc gives the focus back to the frame.
//   - Every other key goes to the editor of the pass in use, whatever control has the focus.
//
// And after a set was chosen in the set menu: the keys go back to the frame (a menu left in focus
// would take the letters), but the place in the page stays at the menu, so that Tab moves on
// from it as in any page (`tabFrom`).
(function (root) {
  "use strict";

  // The kind of the focused element, from its tag name, its `type` and whether it is editable.
  function focusKind(el) {
    if (!el) return "none";
    const tag = String(el.tag || "").toUpperCase();
    const type = String(el.type || "").toLowerCase();
    if (el.editable || tag === "TEXTAREA") return "text";
    if (tag === "SELECT") return "select";
    if (tag === "INPUT") {
      if (type === "checkbox" || type === "radio") return "checkbox";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "text"; // a text, search or number field, and any other input that holds a value
    }
    if (tag === "BUTTON") return "button";
    if (tag === "SUMMARY") return "summary";
    if (tag === "A") return "link";
    return "none"; // the page body, the frame canvas, a plain element
  }

  // → "field"   the focused text field or menu keeps the key (the page does nothing)
  //   "control" the focused control acts on it itself (the page does nothing)
  //   "browser" the browser moves the focus (Tab from a control)
  //   "help"    open or close the keys overlay
  //   "panel"   move the focus to the side panel's controls
  //   "finish"  close the finish card
  //   "leave"   give the focus back to the frame, and nothing else
  //   "editor"  the shortcut of the pass in use
  function route(ev) {
    const key = ev.key;
    const kind = ev.focus || "none";
    const combo = !!(ev.meta || ev.ctrl);
    if (key === "F6") return "panel";
    if (kind === "text" || kind === "select") return "field";
    if (combo) return "editor"; // undo, redo, copy and paste act on the frame from any control
    if (ev.helpOpen && (key === "Escape" || key === "?")) return "help";
    if (key === "?") return "help";
    if (kind === "button" || kind === "summary" || kind === "link") {
      if (key === "Enter" || key === " ") return "control";
      if (key === "Tab") return "browser";
      if (key === "Escape") return ev.finishOpen ? "finish" : "leave";
      return "editor";
    }
    if (kind === "checkbox") {
      if (key === " ") return "control";
      if (key === "Tab") return "browser";
      if (key === "Escape") return "leave";
      return "editor";
    }
    if (ev.finishOpen && key === "Escape") return "finish";
    return "editor";
  }

  // Where the next Tab starts once a set chosen in the menu has opened. focus: the kind of the
  // element that has the focus by then; onFrame: that element is the frame itself.
  // → "menu"   nothing holds the focus (the enlarged views have no frame to give it to): the
  //            place stays at the set menu, and Tab goes on to the control after it
  //   "as-is"  the frame has the focus, or the pass put it somewhere (the search box, the finish
  //            card), or the person moved it meanwhile: that is where they are
  function tabFrom(s) {
    const o = s || {};
    return (o.focus || "none") === "none" && !o.onFrame ? "menu" : "as-is";
  }

  // D arms "a box beside the selected one" for the next arrow. It stays armed only in the context
  // it was armed in: the same set, frame, pass and selection. `armedFor` records that context;
  // `stillArmed` is false once any of it changed (a click on another box, another frame, another
  // pass), so a later arrow moves the box or changes frame as usual.
  function armedFor(ctx) {
    const c = ctx || {};
    return JSON.stringify([c.set || null, c.frame == null ? null : c.frame, c.mode || null, (c.sel || []).slice().sort()]);
  }
  function stillArmed(armed, ctx) { return typeof armed === "string" && armed === armedFor(ctx); }

  const api = { focusKind, route, tabFrom, armedFor, stillArmed };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LabelerKeyRoute = api;
})(typeof window !== "undefined" ? window : globalThis);
