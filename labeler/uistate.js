// SPDX-License-Identifier: Apache-2.0
// What the page says and offers, worked out from its state. Pure: no DOM, no fetch. Shared by
// the page (window.LabelerUiState) and Node (test_uistate.js).
//
//   describe(state)   the one instruction line, and the primary button: its words, the key it
//                     stands for and the action it runs. The page gives the button the action
//                     of that key, so the button and the key cannot drift apart.
//   progress(state)   the progress text of the top bar
//   setLabel(entry)   a set's line in the set menu, from the same counts
//   saveLabel(state)  the save indicator and the connection indicator, kept apart
//   finish(state)     the card shown when a set is finished: what was done and what is next
//   removeDialog(state)  the question before a frame is removed from the project, with the
//                     nearby frames that could be used instead
//   removedText(entry)   one removed frame, as the project screen lists it
//
// A key in a text is written {{Enter}}; the page draws it as a key cap (parts()).
(function (root) {
  "use strict";

  const PASS = { box: "Boxes", identify: "Names", corner: "Corners", training: "Corners from the model",
    point: "Points", center: "Centers", verify: "Check names" };
  const ROLE = { training: "Training", development: "Development", test: "Final test" };
  const WHAT = { box: "draw a box around every card", identify: "name each box", corner: "mark the four corners of every card",
    training: "check the model's corners and names", point: "say what is under each point",
    center: "click the center of every card", verify: "name each clicked center" };

  // The two questions about reading a card, and the rule that goes with each.
  const QUESTIONS = {
    frame: { title: "Can you read this card from this frame alone?",
      help: "Using only what this frame shows: not other frames, the deck list or what you know of the game." },
    crop: { title: "Is the name legible in this crop?",
      help: "Knowing the card from its art, the catalog or the game does not count." },
  };
  const ANSWERS = [{ key: "Y", value: "yes", label: "Yes" }, { key: "M", value: "uncertain", label: "Unsure" }, { key: "N", value: "no", label: "No" }];
  const READABLE = { yes: "yes", uncertain: "unsure", no: "no" };

  function passName(mode) { return PASS[mode] || String(mode || ""); }
  function roleName(role) { return ROLE[role] || String(role || ""); }
  function passWhat(mode) { return WHAT[mode] || ""; }
  function n(count, one, many) { return `${count} ${count === 1 ? one : many || one + "s"}`; }

  // "Press {{Enter}} now" → [{text: "Press "}, {key: "Enter"}, {text: " now"}]
  function parts(text) {
    const out = [];
    const re = /\{\{(.+?)\}\}/g;
    let at = 0, m;
    const s = String(text || "");
    while ((m = re.exec(s))) {
      if (m.index > at) out.push({ text: s.slice(at, m.index) });
      out.push({ key: m[1] });
      at = m.index + m[0].length;
    }
    if (at < s.length) out.push({ text: s.slice(at) });
    return out;
  }

  const ENTER = (label) => ({ label, key: "Enter", act: "enter" });
  const SEARCH = { label: "Search for the card", key: "/", act: "search" };
  const MOVE = { label: "Move the kept box to its card", key: "M", act: "move-kept" };
  // what the status line says after a turn fitted into the model's box, after `m`, and on an `m`
  // with nothing to move
  const NOTES = {
    moved: "The kept box is on the card's new place now, as the model's box. If the card is tilted, turn it with the knob, then E fits it to the card. Enter confirms it.",
    fitted: "Fitted to the tilted card, inside the model's box. If an edge is off, drag that corner onto the card.",
    fitsAlready: "This box already fits inside the model's box at its angle.",
    fitHelp: "Resize the turned box to fit inside the model's upright box, at its angle.",
    // why E does nothing (the disabled button's reason too)
    fitWhy: {
      none: "Select a model's box first: E fits a turned one to the tilted card.",
      edited: "Only the model's own box, turned but not moved or resized, can be fitted: drag the corners instead.",
      edge: "The model's box touches the frame's edge, so it is not the card's whole box: drag the corners instead.",
      upright: "The box is not turned: turn it to the card's angle first (the knob, R or Shift+R), then E fits it.",
    },
    noMove: "No card here has moved: M moves a kept box only where the model sees no card now and offers the same card elsewhere (marked ?).",
    notPaired: "The selected box is not one of a card that moved (joined by an arrow). Select one of those, or Esc and then M.",
    busy: "Let go of the box first, then M.",
    noModel: "This set has no model's boxes: M moves a kept box onto the model's box for its card, so there is nothing to move.",
    // a box with free corners (Shift+drag a corner in the Boxes pass)
    quad: {
      fold: "The corners would fold the box over or make a side shorter than 12 px: the box stops here.",
      names: "This box has free corners: move or reshape it in the Boxes pass. Its top edge can still be turned here.",
      arrows: "This box has free corners: drag a corner or an edge to reshape it, or press E to make it a rectangle again.",
      rect: "A rectangle again. Shift+drag a corner frees the corners again.",
      snapped: "Snapped to the card's edges.",
      snapKept: "Snap left the corners as they are.",
      noPicture: "Snap needs the frame's picture: nothing was changed.",
      beside: "Box added beside. Drag its far corners to fit.",
    },
  };

  // The keys of each pass, as the keys overlay lists them (README.md has the same tables). No
  // key does two things in one pass, and none changed its meaning when the buttons were added.
  const KEYS_BOX = [
    ["drag on the empty frame", "draw a box (Alt+drag: also on top of another box)"],
    ["click", "select the box under the pointer (the topmost one); on the empty frame: let go of the selection. A click never draws"],
    ["Shift+click / Shift+drag", "add or remove a box / select every box whose center is inside the rectangle"],
    ["drag a box", "move it (all selected boxes when it is one of them)"],
    ["drag a corner / an edge", "resize the selected box, in its own turned frame"],
    ["Shift+drag a corner", "free the selected box's corners, for a card seen at a slant: that corner moves on its own. From then on each corner and each edge moves on its own"],
    ["drag the knob above the top", "rotate the selected box about its center"],
    ["Option/Alt+click an edge", "of any box: that edge is the card's top. The box does not move"],
    ["double-click a box", "turn it a quarter, as W"],
    ["N then click", "place a box of the new-box size, centered on the click (the side panel shows the size)"],
    ["Enter", "confirm the box being adjusted and let go of it; with nothing selected: finish the frame and go to the next"],
    ["Shift+Enter", "reopen a finished frame"],
    ["Esc", "cancel a drag or N; else let go of the selection"],
    ["← ↑ → ↓", "move the selection 1 px (Shift: 10 px); with nothing selected, ← → previous / next frame"],
    ["Alt+arrows", "move the selected box's own right / bottom edge 1 px (Alt+Shift: 10 px)"],
    ["[ ] or PageUp / PageDown", "previous / next frame"],
    ["Tab / Shift+Tab", "next / previous box, from the bottom layer up"],
    ["Delete / Backspace", "remove the selected box or boxes"],
    ["B", "card back, on or off"],
    ["H", "too hidden to learn from: an ignored box, on or off. A card that is there but should count neither as found nor as missed (red cross)"],
    ["R / Shift+R", "tilt by −1° / +5°"],
    ["W / Shift+W", "turn a quarter clockwise / the other way. The white tick marks the card's top"],
    [". / ,", "one layer up / down among the boxes it overlaps (boxes elsewhere on the frame make no difference)"],
    ["> / <", "to the front / to the back"],
    ["D then an arrow", "a box of the same size and angle against that side of the selected box, of the same kind; then drag its far edge to fit (Alt+arrows move only its own right / bottom edge, not the far edge of a box added left or above)"],
    ["O", "stacking view on or off: each box shaded where no box above it covers it, with its layer in its stack (1 = the bottom). A visual aid only: nothing is saved"],
    ["X", "clear the boxes kept from the previous frame that you have not touched (never on a finished frame)"],
    ["Shift+X", "clear every box on the frame, after asking. Undo brings them back"],
    ["F", "snap on or off: with snap on, a click on a card places a box fitted to its edges (Shift+click: a card lying sideways)"],
    ["S", "a box with free corners: snap its corners to the card's edges; else, snap on: fit the selected box to the card again; snap off: the new-box size takes the selected box's size"],
    ["E", "a box with free corners: a rectangle again, with the same top edge"],
    ["Shift+S", "the selected box takes the new-box size (center and angle stay)"],
    ["G · + or = · - · L", "a row of cards: space it evenly · add a box after the last-clicked · take the last-clicked out · the layout of another finished frame with as many boxes"],
    ["V", "check top edges: every box of the set, one at a time and enlarged"],
    ["I or / · U · A", "with names shown (Options): search for the card's name · unknown card · another printing"],
    ["T / 0", "with names shown: show one kind of card only / all kinds"],
    ["P", "card previews on or off"],
    ["Cmd/Ctrl+Z", "undo (this frame)"],
    ["Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y", "redo (this frame)"],
    ["Cmd/Ctrl+C / V / D", "copy the selected box or boxes / paste them (12 px aside on their own frame, the same place on another; a group keeps its spacing) / duplicate them"],
    ["?", "this list"],
    ["F6", "move the keyboard focus to the side panel's controls (Tab goes on, Esc comes back to the frame)"],
  ];
  // checking top edges (the Boxes pass, V): listed instead of the others while it is on
  const KEYS_REVIEW = [
    ["yellow bar and TOP", "the card's own top, as saved; the other boxes are faint"],
    ["Enter, → or Space", "it is right: next box (a box just turned is confirmed; a model box not checked yet is accepted as it is)"],
    ["←", "previous box"],
    ["W / Shift+W", "turn the top a quarter clockwise / the other way, and stay on the box"],
    ["Option/Alt+click an edge", "that edge is the card's top (Option/Alt alone shows the edge)"],
    ["B / H", "card back, on or off · ignored box, on or off"],
    ["Delete / Backspace", "remove the box (undo brings it back; Enter goes on)"],
    ["Cmd/Ctrl+Z", "undo (this frame)"], ["Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y", "redo (this frame)"],
    ["J", "next box flagged to fix"],
    ["] / [ or PageDown / PageUp", "the first box of the next / previous frame that has boxes (or click the frame strip)"],
    ["V or Esc", "back to the frame, with this box selected"],
    ["?", "this list"],
  ];
  const KEYS_IDENTIFY = [
    ["/ or I", "put the keys in the search box (it does not undo a name: Backspace does). The deck list first; Tab switches to all cards; ↑ ↓ cards, ← → their printings, Enter picks, Esc leaves the search"],
    ["Y / M / N", "after a name: can you read the card from this frame alone? yes / unsure / no, and go on"],
    ["X · B · U", "not a card · card back · a card that cannot be read, and go on"],
    ["Enter, → or ]", "next card"], ["← or [", "previous card"],
    ["Space", "next card still without an answer"], ["Backspace", "clear this card's name (or other answer)"],
    ["PageDown / PageUp", "the first card of the next / previous frame"],
    ["yellow bar and TOP", "in a set of boxes: the card's own top, as saved"],
    ["W / Shift+W", "in a set of boxes: the top is the next edge clockwise / the other way. The box never moves"],
    ["Option/Alt+click an edge", "in a set of boxes: that edge is the card's top"],
    ["drag on the frame", "training and development box sets: a corner or edge of the box resizes it, the knob above its top rotates it, its inside moves it (saved as a Boxes edit); elsewhere a drag moves the picture"],
    ["F", "flag this box to fix its size or place later, in the Boxes pass"],
    ["A", "another printing: type the id of the printing on screen"],
    ["O", "how you knew the card: this frame → a later close-up → the deck list → other"],
    ["C · L · G · K", "face up · blur · glare · sleeve or foil: not set → yes → no → not set"],
    ["V", "how much of the card shows: full → most → half → little → not set"],
    ["T / 0", "show one kind of card only / all kinds"],
    ["Z / Shift+Z", "the card's view: the next / previous zoom of 1×, 2×, 4×, round (the wheel zooms at the pointer, a drag off the box moves it; a click on the small frame shows the whole frame)"],
    ["P", "card previews on or off"],
    ["Cmd/Ctrl+Z · Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y", "undo · redo (this frame): answers and turned tops"],
    ["?", "this list"],
    ["F6", "move the keyboard focus to the side panel's controls (Tab goes on, Esc comes back)"],
  ];
  const KEYS_ANSWER = [
    ["/ or I", "search for the card (↑ ↓ move, Enter picks, Tab: deck list or all cards, Esc leaves the search)"],
    ["X · B · U", "not a card · card back · a card that cannot be read"],
    ["Y / M / N", "after a name: can you read the card from this frame alone? yes / unsure / no"],
    ["O", "how you knew the card: this frame → a later close-up → the deck list → other"],
    ["C · L · G · K", "face up · blur · glare · sleeve or foil: not set → yes → no → not set"],
    ["V", "how much of the card shows: full → most → half → little → not set"],
  ];
  const KEYS_POINT = [
    ["X · B · U, and Y / M / N after a name", "answer, and go to the next point"],
    ["Enter, → or ]", "next point"], ["← or [", "previous point"],
    ["PageDown or } / PageUp or {", "next / previous frame"],
    ["Space", "next frame with points left"], ["Backspace", "clear this point's answer"],
    ["Z / Shift+Z", "a wider / closer view around the point. The center of the ring still decides"],
    ["click the whole frame", "it opens large, the point marked (Esc closes it)"],
    ["?", "this list"],
  ];
  const KEYS_CORNER = [
    ["click four times", "the card's corners in its own order: top-left (marked 1), top-right, bottom-right, bottom-left"],
    ["Shift+click", "a corner that is hidden, placed where it must be"],
    ["Backspace", "while placing: take the last corner back; else remove the selected card"],
    ["Esc", "cancel the corners being placed; else let go of the selection"], ["drag a corner", "move it (a click selects it)"],
    ["E", "the selected (or last placed) corner was placed by guess, or not"],
    ["R", "turn the corner order: the corner marked 1 moves on"],
    ["F", "snap on or off: new corners move to the card's edges"], ["S", "snap the selected card's corners now"],
    ["Tab / Shift+Tab", "next / previous card"], ["J", "next card that still needs an answer"],
    ["Delete", "remove the selected card"], ["Cmd/Ctrl+Z", "undo (this frame)"],
    ["Enter", "finish the frame, once every card on it is complete, and go to the next"], ["← → [ ]", "previous / next frame"],
    ["?", "this list"],
  ];

  // The center pass (a center census).
  const KEYS_CENTER = [
    ["click", "a marker on the center of a card face"],
    ["Shift+click", "a marker on the center of a card back"],
    ["click / drag a marker", "select it / move it (a click that close to a marker never adds a second one)"],
    ["B", "the selected marker: face or back"],
    ["Delete / Backspace", "remove the selected marker"],
    ["Tab / Shift+Tab", "next / previous marker, in the order they were clicked"],
    ["Esc", "cancel a drag (the marker goes back); else let go of the selection"],
    ["Enter", "confirm the frame: every face and back has its marker (no markers: no cards here), and go to the next frame, or the next set, with frames left"],
    ["Shift+Enter", "reopen a confirmed frame"],
    ["Cmd/Ctrl+Z", "undo (this frame)"], ["Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y", "redo (this frame)"],
    ["← → · [ ] · PageUp / PageDown", "previous / next frame"],
    ["which cards", "every card face and every card back. Not a card mostly covered by another card, such as the overlapped strips in a row of overlapping cards"],
    ["?", "this list"],
  ];

  // Check names: the keys of the verify pass.
  const KEYS_VERIFY = [
    ["step 1", "the crop: a fixed part of the frame around the clicked center, and the whole frame beside it; no name is shown"],
    ["Y / M / N", "step 1: is the name legible in this crop? yes / unsure / no. Knowing the card from its art, the catalog or the game does not count. The answer comes before any name and is fixed once a suggestion is shown"],
    ["Space / Enter", "after step 1: show the suggestion if it is not up; on a card already checked: the next one still open"],
    ["1", "accept the first model's name"], ["2", "accept the second model's name, when two are compared"], ["A", "accept, when both models show the same name"],
    ["/ or I", "after step 1: put the keys in the search box (T / 0 show one kind of card; ↑ ↓ cards, ← → their printings, Enter picks, Esc leaves the search)"],
    ["U", "after step 1: unknown card"],
    ["X", "not a card: the click was a mistake. On to the next"], ["B", "this is a card back. On to the next"],
    ["← / [", "previous card"], ["→ / ]", "next card"], ["Backspace", "clear this card's answer"],
    ["Z / Shift+Z", "the next / previous crop size, round"],
    ["P", "card previews on or off"],
    ["no suggestion (blind check)", "a card named without a model's suggestion: after step 1 the search takes the focus (Esc leaves it for U, X or B)"],
    ["answer again", "a card answered for another position of its marker, or for other suggestions, is asked again"],
    ["?", "this list"],
  ];

  // The keys overlay ("?") of the Boxes pass on a training set started with a model's
  // suggestions: listed above the others (sources.js keyTable).
  const KEYS_PREFILL = [
    ["dash-dot boxes marked “model”", "the model's suggestions, not checked yet; “?” marks one for a card none of your boxes covers yet"],
    ["A", "accept the selected model box as it is, then select the next one"],
    ["Enter (box selected)", "accept the selected model box and let go of it"],
    ["Enter (nothing selected)", "accept every model box you have not touched, as it is, and finish the frame. Look at each first. A box marked “?” is never accepted this way: the frame waits until each is accepted (A) or removed"],
    ["any edit", "moving, resizing, turning or marking a model box corrects it"],
    ["Delete / Backspace", "remove the model box: it does not come back"],
    ["J", "the next model box still to check on this frame, else the next box flagged to fix"],
    ["X", "also brings in the model boxes that were held back under the kept boxes it clears"],
    ["M", "a card that moved (an arrow): its kept box goes onto the model's “?” box, which goes away"],
    ["E", "fit to the tilted card: a model box turned (knob, R, Shift+R) but not moved or resized shrinks, at its angle, to fit inside the model's upright box. Turning alone never changes a box's size"],
  ];

  // One word of a command, quoted for a shell when it needs to be (as serve.py's shlex.quote).
  function shellWord(w) { const s = String(w); return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`; }

  // A model's box turned and still larger than its fit: the line says the fit is there.
  function describeBox(s) {
    const b = s.box || {}, d = describeBoxState(s);
    return b.fitHint && b.selected && !b.review && !(b.multi > 1) ? { text: `Turned. {{E}} fits the box to the tilted card. ${d.text}`, primary: d.primary } : d;
  }

  function describeBoxState(s) {
    const b = s.box || {};
    if (b.review) {
      return b.review.box
        ? { text: "Is the yellow bar on this card's top edge? {{Enter}} yes, next box · {{W}} turns the top · {{H}} too hidden to learn from: ignore · {{Esc}} goes back to the frame.",
          primary: ENTER("Top edge is right: next box") }
        : { text: "No box to check here. {{Enter}} goes on · {{Esc}} goes back to the frame.", primary: ENTER("Go on") };
    }
    if (b.placing) return { text: "Click on the frame to place a box of the new-box size. {{Esc}} cancels.", primary: null };
    if (b.multi > 1) {
      return { text: `${b.multi} boxes selected. Drag one or use the arrow keys to move them together. {{Delete}} removes them · {{Enter}} lets go.`,
        primary: ENTER("Done with these boxes") };
    }
    if (b.movedSel && (b.selected === "suggestion" || b.selected === "box")) {
      return { text: "The arrow joins a kept box where the model sees no card any more and the model's box for the same card: the card has moved. {{M}} moves the kept box onto the model's box and removes the suggestion · {{Delete}} removes the selected box.",
        primary: MOVE };
    }
    if (b.selected === "model" || b.selected === "suggestion") {
      return { text: "This box is the model's suggestion. Adjust it if it is off, then {{Enter}} accepts it. {{B}} marks a card back · {{H}} too hidden to learn from: ignore · {{Delete}} removes it.",
        primary: ENTER("Accept this box") };
    }
    if (b.selected === "adjusting") {
      return { text: "Adjust the box: drag it, a corner, or the knob above it. {{Enter}} confirms it · {{B}} marks a card back · {{H}} too hidden to learn from: ignore · {{Delete}} removes it.",
        primary: ENTER("Confirm this box") };
    }
    if (b.selected) {
      return { text: "Box selected. Drag to move it · {{W}} turns it a quarter · {{B}} marks a card back · {{H}} too hidden to learn from: ignore · {{Delete}} removes it · {{Enter}} lets go.",
        primary: ENTER("Done with this box") };
    }
    const frame = s.frame || {};
    if (frame.done) {
      return frame.last
        ? { text: "This frame is done, and it is the last of this set. {{Shift+Enter}} reopens it.", primary: ENTER("See what is next") }
        : { text: "This frame is done. {{Enter}} goes to the next frame · {{Shift+Enter}} reopens it.", primary: ENTER("Go to the next frame") };
    }
    if (b.moved > 0) {
      return { text: b.moved === 1
        ? "A card has moved: the arrow goes from its kept box, where the model sees no card now, to the model's ? box for the same card. {{M}} moves the kept box there and removes the suggestion."
        : `${b.moved} cards have moved: each arrow goes from a kept box, where the model sees no card now, to the model's ? box for the same card. {{M}} moves a kept box there and removes its suggestion, one card at a time.`,
        primary: MOVE };
    }
    if (b.suggestions > 0) {
      return { text: `${n(b.suggestions, "model suggestion")}, marked ?, for cards you have no box on yet. Accept or remove each one before you finish the frame.`,
        primary: ENTER(`Review ${n(b.suggestions, "suggestion")}`) };
    }
    if (b.model > 0) {
      return { text: `${n(b.model, "box", "boxes")} suggested by the model. Check each one and click any card it missed, then {{Enter}} accepts them all and finishes the frame.`,
        primary: ENTER(`Accept ${n(b.model, "model box", "model boxes")} and finish frame`) };
    }
    if (b.kept > 0) {
      return { text: `${n(b.kept, "box", "boxes")} kept from frame ${b.keptFrom || "before"}. Fix what moved and click any new card, then {{Enter}} finishes the frame.`,
        primary: ENTER("Finish frame") };
    }
    if (!b.total) {
      return { text: "No boxes yet. Click a card for a box of the new-box size, or drag across it. If this frame shows no cards, {{Enter}} finishes it as empty.",
        primary: ENTER("Finish frame with no cards") };
    }
    return { text: "Put a box on every card that has none: a click for the new-box size, or a drag. Then {{Enter}} finishes the frame.", primary: ENTER("Finish frame") };
  }

  // A card as the page names it: its name and its id, since different cards may share a name.
  function who(t) {
    if (!t || !t.identity || t.identity === "unknown") return "";
    return t.name && t.name !== t.identity ? `${t.name} · ${t.identity}` : String(t.identity);
  }

  // A target that takes a name: a box of the Names pass, a card in the Corners passes, a point.
  // t: {outcome, identity, name, eligible, asks, complete}. `asks`: it has a name and now waits
  // for the answer on reading it. `after`: what to say and offer once it is complete.
  function describeAnswer(t, after) {
    if (t.asks) return { text: `${who(t)}${who(t) ? ". " : ""}${QUESTIONS.frame.title} {{Y}} yes · {{M}} unsure · {{N}} no`, primary: null, question: "frame" };
    if (t.complete) {
      const what = t.outcome === "card-back" ? "Marked as a card back"
        : t.outcome === "not-card" ? "Marked as not a card"
          : t.outcome === "unreadable" ? "Marked as a card that cannot be read"
            : t.identity === "unknown" ? "Marked as an unknown card"
              : `${who(t)}, readable: ${READABLE[t.eligible] || t.eligible}`;
      return { text: `${what}. ${after.text}`, primary: after.primary };
    }
    return null; // not answered yet: the caller asks its own question
  }

  function describeSearch(q) {
    const typed = q.query ? ` “${q.query}”` : "";
    if (!q.matches) {
      return q.scope === "decklist"
        ? { text: `No card matches${typed} in the deck list. {{Tab}} searches all cards · {{Esc}} leaves the search.`,
          primary: { label: "Search all cards", key: "Tab", act: "search-all" } }
        : { text: `No card matches${typed}. {{Esc}} leaves the search; the card can then be marked as unknown.`, primary: null };
    }
    // several cards of one name: the id and the picture tell them apart (every card's picture is
    // in the grid; pointing at one shows it enlarged)
    if (q.sameName > 1) {
      return { text: `${q.sameName} cards are called “${q.highlightName}”. Check the picture and the id. {{↑}} {{↓}} cards · {{←}} {{→}} printings · {{Enter}} picks ${q.highlight} · {{Esc}} leaves the search.`,
        primary: { label: `Pick ${q.highlight}`, key: "Enter", act: "pick" } };
    }
    return { text: `Type to search${q.scope === "decklist" ? " the deck list" : " all cards"}. {{↑}} {{↓}} cards · {{←}} {{→}} printings · {{Enter}} picks ${q.highlight || "the highlighted card"} · {{Esc}} leaves the search.`,
      primary: q.highlight ? { label: `Pick ${q.highlight}`, key: "Enter", act: "pick" } : null };
  }

  function describeNames(s) {
    const w = s.names || {};
    if (!w.count) return { text: "Nothing to name in this set: every box has a name already, or is a card back or an ignored box.", primary: null };
    if (!w.target) return { text: "No box to show.", primary: null };
    if (s.search && s.search.focused) return describeSearch(s.search);
    const last = w.index >= w.count;
    const next = !last ? ENTER("Next card")
      : w.open > 0 ? { label: "Go to the next card without a name", key: "Space", act: "space" } : ENTER("See what is next");
    const done = describeAnswer(w.target, { text: `${last && w.open > 0 ? "{{Space}} next card without a name" : "{{Enter}} next card"} · {{Backspace}} clears the answer.`, primary: next });
    if (done) return done;
    return { text: "Which card is this? {{/}} then type to search, or click it in the list.", primary: SEARCH };
  }

  const CORNER_NAMES = ["top-left", "top-right", "bottom-right", "bottom-left"];

  function describeCorners(s) {
    const c = s.corner || {};
    const frame = s.frame || {};
    if (typeof c.placing === "number") {
      return { text: `Corner ${c.placing + 1} of 4: click the card's own ${CORNER_NAMES[c.placing] || "next"} corner. Shift-click a corner that is hidden · {{Backspace}} takes one back · {{Esc}} cancels.`, primary: null };
    }
    if (s.search && s.search.focused) return describeSearch(s.search);
    const framePrimary = frame.done ? ENTER("Go to the next frame")
      : !c.total ? ENTER("Finish frame with no cards")
        : c.incomplete > 0 ? ENTER("Show the next card that needs an answer") : ENTER("Finish frame");
    if (c.target) {
      const done = describeAnswer(c.target, { text: "Drag a corner to adjust it · {{Tab}} next card · {{Esc}} lets go.", primary: framePrimary });
      if (done) return done;
      return { text: "Which card is this? {{/}} then type to search · {{B}} a card back · {{X}} not a card · {{U}} a card that cannot be read.", primary: SEARCH };
    }
    if (frame.done) return { text: "This frame is done. {{Enter}} goes to the next frame.", primary: framePrimary };
    if (!c.total) {
      return { text: "Click the four corners of a card, in the card's own order: top-left, top-right, bottom-right, bottom-left. If this frame shows no cards, {{Enter}} finishes it as empty.",
        primary: framePrimary };
    }
    if (c.incomplete > 0) {
      const lead = s.mode === "training" ? `${n(c.incomplete, "card")} from the model still ${c.incomplete === 1 ? "needs" : "need"} checking: its corners, its name and whether it can be read.`
        : `${n(c.incomplete, "card")} still ${c.incomplete === 1 ? "needs" : "need"} an answer.`;
      return { text: `${lead} {{J}} goes to the next one.`, primary: framePrimary };
    }
    return { text: "Every card here is complete. Click four corners to add another, or {{Enter}} finishes the frame.", primary: framePrimary };
  }

  function describePoint(s) {
    const p = s.point || {};
    if (!p.target) return { text: "No point on this frame.", primary: null };
    if (s.search && s.search.focused) return describeSearch(s.search);
    const done = describeAnswer(p.target, { text: "{{Enter}} next point · {{Backspace}} clears the answer.", primary: ENTER("Next point") });
    if (done) return done;
    return { text: "What is under the ring? {{/}} a card: type to search · {{B}} a card back · {{X}} not a card · {{U}} a card that cannot be read.", primary: SEARCH };
  }

  function describeCenter(s) {
    const c = s.center || {};
    const frame = s.frame || {};
    const total = (c.faces || 0) + (c.backs || 0);
    const primary = frame.done ? ENTER("Go to the next frame to do")
      : !total ? ENTER("Confirm no cards in this frame")
        : ENTER(`Confirm frame: ${n(c.faces || 0, "face")}, ${n(c.backs || 0, "back")}`);
    if (c.selected) return { text: "Marker selected. Drag to move it · {{B}} switches face and back · {{Delete}} removes it.", primary };
    if (frame.done) return { text: "This frame is confirmed. {{Enter}} goes to the next frame still to do · {{Shift+Enter}} reopens it.", primary };
    const how = "Click the center of every face-up card. Shift-click the center of every face-down card.";
    if (!total) return { text: `${how} No cards in this frame? {{Enter}} confirms it as empty.`, primary };
    return { text: `${how} {{Enter}} when every card has a marker.`, primary };
  }

  function describeVerify(s) {
    const v = s.verify || {};
    if (!v.count) return { text: "No card centers to check in this set.", primary: null };
    if (!v.center) return { text: "No center to show.", primary: null };
    if (v.complete) {
      return { text: "Checked. {{Space}} goes to the next card still open · {{Backspace}} clears the answer.",
        primary: { label: "Next card still open", key: "Space", act: "space" } };
    }
    const again = v.stale ? "This card was answered for another position or another set of suggestions: answer it again. " : "";
    const keys = "{{Y}} yes · {{M}} unsure · {{N}} no";
    if (!v.readability) {
      const tail = v.blind ? " This card has no suggestion: after your answer you search for its name." : "";
      return { text: `${again}Step 1 of 2: ${QUESTIONS.crop.title.toLowerCase()} ${keys}.${tail}`, primary: null, question: "crop" };
    }
    if (v.needsReadability) return { text: `${v.name || "This card"}: ${QUESTIONS.crop.title.toLowerCase()} ${keys}`, primary: null, question: "crop" };
    if (s.search && s.search.focused) {
      const d = describeSearch(s.search);
      return v.blind ? { text: `Step 2 of 2: no suggestion for this card. ${d.text}`, primary: d.primary } : d;
    }
    const other = "{{U}} unknown · {{X}} not a card · {{B}} a card back";
    if (v.blind) return { text: `${again}Step 2 of 2: no suggestion for this card. {{/}} then type its name · ${other}.`, primary: SEARCH };
    if (v.revealed) {
      const arms = v.arms || [];
      const named = arms.filter((a) => a.name);
      if (!named.length) return { text: `${again}Step 2 of 2: the model shows no name here. {{/}} pick the card yourself · ${other}.`, primary: SEARCH };
      if (arms.length < 2) return { text: `${again}Step 2 of 2: is this ${named[0].name}${named[0].id ? " · " + named[0].id : ""}? {{1}} accepts the suggestion · {{/}} picks another card · ${other}.`, primary: null };
      return { text: `${again}Step 2 of 2: which name is right? {{1}} ${arms[0].label}'s · {{2}} ${arms[1].label}'s · {{A}} both, when they agree · {{/}} another card · ${other}.`, primary: null };
    }
    if (v.proposals) return { text: "Your answer is saved. {{Space}} shows the suggestion.", primary: { label: "Show the suggestion", key: "Space", act: "space" } };
    return { text: `${again}Step 2 of 2: no suggestion for this card. {{/}} pick the card yourself · ${other}.`, primary: SEARCH };
  }

  // The instruction line and the primary button for a state of the page.
  function describe(s) {
    if (!s || s.noSets) return { text: "This sample lists no frames, so there is nothing to label yet.", primary: null };
    if (s.otherRun) return { text: "The tool now runs other work (another pass or project), so this page saves nothing more. The banner says what was not saved and what to do.", primary: null };
    if (s.imageFailed) {
      return { text: `The picture of frame ${(s.frame && s.frame.index) || "?"} did not load, so this frame cannot be labeled. {{]}} next frame · {{[}} previous frame.`,
        primary: { label: "Try loading the picture again", key: null, act: "reload-frame" } };
    }
    if (s.readOnly) return { text: `You can look at this set but not change it. ${s.readOnly}`, primary: null };
    const by = { box: describeBox, identify: describeNames, corner: describeCorners, training: describeCorners,
      point: describePoint, center: describeCenter, verify: describeVerify };
    const d = (by[s.mode] || (() => ({ text: "", primary: null })))(s);
    return { text: d.text, primary: d.primary || null, question: d.question || null };
  }

  // ---- progress: one set of counts for the top bar and the set menu -----------------------------

  // counts: {unit: "frames" | "named" | "checked", done, total}. In the Names pass the total is
  // the boxes that waited for a name when the set was opened, so the text gives no "of".
  function progress(s) {
    const c = (s && s.counts) || { done: 0, total: 0, unit: "frames" };
    const fix = s && s.needFix ? ` · ${s.needFix} ${s.needFix === 1 ? "needs" : "need"} a fix` : "";
    if (c.unit === "named") return `${c.done} named · ${c.total - c.done} left`;
    if (c.unit === "checked") return `${c.done} of ${c.total} checked · ${c.total - c.done} left`;
    return `${c.done} of ${c.total} frames done${fix}`;
  }

  function setLabel(e) {
    const c = e.counts || { done: 0, total: 0, unit: "frames" };
    const unit = c.unit === "checked" ? " checked" : " frames";
    const count = c.unit === "frames" && !c.total && e.removed ? " · every frame removed"
      : c.total === null || c.total === undefined ? ""
      : c.unit === "named" ? (c.total - c.done > 0 ? ` · ${c.total - c.done} left to name` : " · all named") : ` · ${c.done} of ${c.total}${unit}`;
    return `${e.setId}${e.channel ? " · " + e.channel : ""}${count}${e.readOnly ? " · read-only" : ""}`;
  }

  function frameLabel(index, count) { return count ? `Frame ${index} of ${count}` : "No frames"; }

  // The save indicator and the connection indicator. `failed`: names of frames that did not save.
  // Each has a word and a shape, never a color alone.
  function saveLabel(s) {
    const failed = (s && s.failed) || [];
    // otherRun: the tool now runs other work (switched, or started again), and this page saves nothing more
    const other = !!(s && s.otherRun);
    const conn = s && s.connected === false
      ? { text: "Server stopped", kind: "error", mark: "×" }
      : other ? { text: "Tool on other work", kind: "error", mark: "×" }
        : { text: "Server running", kind: "ok", mark: "●" };
    let save;
    if (failed.length) save = { text: `Not saved: ${failed.length === 1 ? failed[0] : failed.length + " frames"}`, kind: "error", mark: "!" };
    else if (other) save = { text: "Not saving", kind: "error", mark: "!" };
    else if (s && s.saving) save = { text: "Saving…", kind: "busy", mark: "○" };
    else if (s && s.pending) save = { text: "Saving…", kind: "busy", mark: "○" };
    else if (s && s.connected === false) save = { text: "Saved before the stop", kind: "stale", mark: "✓" };
    else save = { text: "Saved", kind: "ok", mark: "✓" };
    return { save, conn };
  }

  // ---- the next step -------------------------------------------------------------------------

  // The card shown when a set is finished.
  //   f.mode, f.setId, f.stats {frames, total, boxes, named, faces, backs, checked, points}
  //   f.sets: the sets in menu order, each {setId, left, readOnly}
  //   f.after: what the project's screen says comes next (its report's `next`): {pass, startable},
  //     with `scripts`, the command of that pass for scripts; null when it could not be asked
  // → {title, detail, next: {kind: "set", setId, label}
  //                          | {kind: "switch", pass, lead, label, scripts}   (the tool switches to it, here)
  //                          | {kind: "project", lead, label} | {kind: "done", text}}
  function finish(f) {
    const st = f.stats || {};
    const frames = `${st.frames} of ${st.total} frames`;
    const title = f.mode === "box" ? `${f.setId}: ${frames}, ${n(st.boxes || 0, "box", "boxes")}`
      : f.mode === "identify" ? `${f.setId}: ${n(st.named || 0, "box", "boxes")} answered, none left to name`
        : f.mode === "center" ? `${f.setId}: ${frames}, ${n(st.faces || 0, "face")} and ${n(st.backs || 0, "back")}`
          : f.mode === "verify" ? `${f.setId}: ${st.checked} of ${st.total} cards checked`
            : f.mode === "point" ? `${f.setId}: ${frames}, ${n(st.points || 0, "point")} answered`
              : `${f.setId}: ${frames}, ${n(st.boxes || 0, "card")}`;
    const detail = f.mode === "identify" ? "Every box of this set has its answer." : f.mode === "verify" ? "Every clicked center of this set is checked."
      : "Every frame of this set is done.";
    const sets = f.sets || [];
    const at = sets.findIndex((x) => x.setId === f.setId);
    for (let k = 1; k <= sets.length; k++) {
      const x = sets[(Math.max(0, at) + k) % sets.length];
      if (x.setId !== f.setId && !x.readOnly && x.left > 0) return { title, detail, next: { kind: "set", setId: x.setId, label: `Next set: ${x.setId}` } };
    }
    const all = f.mode === "box" ? "All sets have their boxes." : f.mode === "center" ? "All sets have their centers."
      : f.mode === "identify" ? "All sets are named." : f.mode === "verify" ? "Every center is checked." : "All sets are done.";
    const after = f.after || null;
    if (after && after.pass && after.pass !== "export" && after.pass !== f.mode && after.startable) {
      return { title, detail, next: { kind: "switch", pass: after.pass, lead: `${all} Next: ${passWhat(after.pass)}, in the ${passName(after.pass)} pass.`,
        label: `Continue to ${passName(after.pass)}`, scripts: after.scripts || "" } };
    }
    if (after && after.pass === "export") {
      return { title, detail, next: { kind: "project", lead: `${all} Next: write the labels to a file, on the project screen.`, label: "Back to the project: Export is next" } };
    }
    if (after && after.pass && after.pass !== f.mode) {
      return { title, detail, next: { kind: "project", lead: `${all} Next: ${passName(after.pass)}. The project screen says what it needs first.`,
        label: `Back to the project: ${passName(after.pass)} is next` } };
    }
    if (after) return { title, detail, next: { kind: "project", lead: `${all} The project screen shows every pass and what each still needs.`, label: "Back to the project" } };
    // the project could not be asked: the pass's own next step
    const nextOf = { box: "identify", center: "verify" }[f.mode];
    if (nextOf) {
      return { title, detail, next: { kind: "project", lead: `${all} Next: ${passName(nextOf)}, from the project screen.`, label: `Back to the project: ${passName(nextOf)} is next` } };
    }
    if (f.mode === "identify" || f.mode === "corner" || f.mode === "training" || f.mode === "verify" || f.mode === "point") {
      return { title, detail, next: { kind: "project", lead: `${all} Next: write the labels to a file, on the project screen.`, label: "Back to the project: Export is next" } };
    }
    return { title, detail, next: { kind: "done", text: "Every set of this sample is done in this pass." } };
  }

  // ---- removing a frame from the project --------------------------------------------------------

  // Why a frame is removed: optional, one of these.
  const REMOVE_REASONS = [
    { value: "blurry-or-small", label: "Too blurry or too small" },
    { value: "no-cards", label: "No cards on it" },
    { value: "near-duplicate", label: "Nearly the same as another frame" },
    { value: "other", label: "Another reason" },
  ];
  function reasonLabel(value) { const r = REMOVE_REASONS.find((x) => x.value === value); return r ? r.label : ""; }

  // The question before a frame is removed. s: {name, labeled: the frame has labels, nearby:
  // [{name, t, modelBoxes}] or null while they are asked for, suggestions: this run offers the
  // model's boxes, measuring: the server's line when the set is for measuring (no nearby frame
  // is offered there), pick: the nearby frame chosen}
  // → {title, lead, reasons, nearby: {title, note, frames, unknownTime} | null, none: text when
  //    no nearby frame is offered | null, yes, no}
  function removeDialog(s) {
    const st = s || {};
    const near = st.nearby || null;
    const keep = st.labeled ? " Its labels stay in the label files" : " Nothing is deleted";
    const out = {
      title: `Remove ${st.name} from this project?`,
      lead: `It is then skipped: in the passes, in the counts and in the export.${keep}, and the project screen can restore it.`,
      reasons: REMOVE_REASONS.slice(), reasonTitle: "Why (optional)", nearby: null, none: null,
      yes: "Remove this frame", no: "Keep it", looking: "Looking for nearby frames…",
    };
    if (near && near.length) {
      out.nearby = { title: "Or use a nearby frame instead",
        note: st.suggestions ? "A frame chosen here is labeled like any other. It starts with the model's boxes only where the suggestions file has them (marked)."
          : "A frame chosen here is labeled like any other, from scratch.",
        frames: near.map((f) => ({ name: f.name, label: `${f.name} · ${typeof f.t === "number" ? `${f.t.toFixed(1)} s` : "time unknown"}${f.modelBoxes ? " · model's boxes" : ""}` })),
        yes: "Use this frame instead", unknownTime: null };
      const picked = near.find((f) => f.name === st.pick);
      if (picked && typeof picked.t !== "number") out.nearby.unknownTime = `The time of ${picked.name} in the video is unknown, so it cannot go into a measuring export.`;
    } else if (st.measuring) {
      out.none = st.measuring;
    } else if (near) {
      out.none = "No other frame of this video is in its folder. To have some to choose from, cut more frames from the video: the commands under “I have a video, not frames” on the start screen.";
    }
    return out;
  }

  const REMOVE_TEXT = {
    unsaved: "This frame can be removed once everything is saved. Wait until the top bar says Saved, then try again.",
    noAnswer: "The server did not answer. Nothing was removed.",
    otherRun: "The tool now runs other work, so nothing was removed.",
  };
  function removedStatus(name, added) {
    return added ? `Removed ${name}; ${added} is used instead. The project screen can restore ${name}.` : `Removed ${name}. The project screen can restore it.`;
  }

  // Why a frame cannot be removed, in one line, or null: the server refuses the same (serve.py,
  // remove_frame). s: {setId, frameAsset, mode, centers: the frame's centers}
  function removeRefusal(s) {
    const st = s || {};
    if (st.frameAsset && st.frameAsset !== st.setId) return `This is a repeat set: remove the frame from the set ${st.frameAsset} instead.`;
    if (st.mode === "verify") return "Frames are not removed in Check names: that would change which answers are measured.";
    if ((st.centers || []).some((c) => c && c.revealedAt)) return "This frame's answers have been shown; removing it now would bias the measurement.";
    return null;
  }

  // One removed frame on the project screen. e: {assetId, name, reason, replacedBy}
  function removedText(e) {
    const why = reasonLabel(e.reason);
    return `${e.assetId} · ${e.name}${why ? ` · ${why}` : ""}${e.replacedBy ? ` · ${e.replacedBy} used instead` : ""}`;
  }

  const api = { describe, progress, setLabel, frameLabel, saveLabel, finish, parts,
    passName, roleName, passWhat, QUESTIONS, ANSWERS, REMOVE_REASONS, reasonLabel, removeDialog, removeRefusal, removedText, REMOVE_TEXT, removedStatus, NOTES, shellWord, KEYS_PREFILL,
    KEYS_BOX, KEYS_REVIEW, KEYS_IDENTIFY, KEYS_ANSWER, KEYS_POINT, KEYS_CORNER, KEYS_CENTER, KEYS_VERIFY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LabelerUiState = api;
})(typeof window !== "undefined" ? window : globalThis);
