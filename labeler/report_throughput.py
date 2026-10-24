# SPDX-License-Identifier: Apache-2.0
"""Labeling throughput from the tool's timing log.

    python3 report_throughput.py <SET> [<SET> ...] --labels-dir DIR [--idle 120] [--json]
    python3 report_throughput.py --all [--total-only] --labels-dir DIR [--labels-dir DIR2 ...]

With several sets (or --all: every set with a timing log in each root) a TOTAL follows: all the
sets' events merged on one time line (a switch between sets is one capped gap), active minutes and
labels per page mode.

Reads labels/<set>/timing.jsonl (appended by the page: shown, started, committed, corrected,
deleted, prefill-offered, prefill-rejected, frame-confirmed, session-open) and frames.jsonl.

- verified labels: points/targets committed (first complete answer), counted once each per mode,
  less those deleted after their commit;
- active time: the sum of gaps between consecutive events of the set, a gap longer than --idle
  seconds counting as --idle (a break is not labeling time; nothing limits the labeler);
- verified labels per active hour, and per wall hour (first to last event) beside it;
- correction rate: corrections (a change to an already committed answer or its corners) per
  committed label;
- the share of each outcome over the set's CURRENT labels (and eligibility among cards);
- training mode: the share of prefill-accepted / prefill-corrected / manual.
- per mode (every event carries the page's mode): box mode's commits (net of boxes deleted after
  their commit) are BOXES, identify mode's
  are IDENTITIES (answers of the identity pass: a card identity, `unknown`, or a back / not a
  card / unreadable). Each mode gets its own count, active time (a gap is booked to the mode of
  the event that ends it), rate per active hour and corrections. A box set later walked by the
  identity pass shares one timing log; the two are reported separately, never summed.
- reviewed boxes: targets on frames confirmed with Enter (`frame-confirmed` n), e.g. a
  set of tracked boxes reviewed in box mode, per active hour. A frame confirmed again counts its latest
  n once; `frame-unconfirmed` (Shift+Enter) takes it back out.
- tool-made boxes: a commit with `origin` paste / duplicate / insert (a box the tool placed:
  Cmd+V, Cmd+D, the row tool `+`) is NOT a drawn box: counted apart (`toolMade`), never in the
  box rate. Carried-over boxes (`carried-over` n, box mode, any role but test) are never committed:
  they count as reviewed on the frame's confirmation, like tracked boxes; a frame's carry-over
  counts once (its latest).
- corrections by origin: box-mode `corrected` events carry the box's `origin` (drawn, paste,
  duplicate, insert, carried, propagated, prefill; snap / default-box are drawn by a click). The
  correction RATE is corrections of drawn boxes over drawn boxes (same base); the others are
  listed apart. An event without an origin (other modes) counts as drawn.
- box-mode prefill (role=training sets): a detector box the labeler reviewed is NEVER a drawn
  box. Each is counted once by its latest state: accepted (committed as proposed; how: `a`, Enter
  on it, or Enter on the frame, which accepts every untouched one), corrected (committed or later
  changed away from the proposal) or rejected (`prefill-rejected`; an undo's
  `prefill-unrejected` takes it back). Time per reviewed detector box = the box-mode active time
  booked to frames that were offered prefill (a gap goes to the frame of the event that ends it;
  it includes any boxes drawn there, shown beside it) over the boxes reviewed. The correction rate
  on drawn boxes and the drawn box count do not include them.
- box-mode naming: a box named in box mode (picker, `u`, printing) logs `identified`
  (`first`: it had no identity; `pickerMs`: picker open → pick). Counted apart as box-mode
  identities (boxes named, net of boxes deleted after; picks and picker time gross), never as
  boxes or corrections.
- review walk (box mode, `v`): every event logged while it is on carries `review:
  true`; a gap ending in such an event is review time (inside box mode's active time, not added to
  it). `reviewed` = a box passed with Enter / → / Space, `review-turned` = a box turned (w / W, or
  Option+click an edge). Reported as review boxes (distinct boxes passed) per review active hour,
  and how many were turned.
- identify-mode turns: `identify-turned` (`via` w / W / edge, the new `angle`; `undo`
  / `redo` when Cmd+Z / Cmd+Shift+Z turned a box back or again, `refused` when a refused save put it
  back) = the identity pass changed which
  edge of a box is the top. Neither an identity nor a correction: reported on the identify line
  as boxes turned (distinct boxes with a w / W / edge turn) and turns (those events), time inside
  the identify active time.
- center mode (a center census): `center-added` (kind), `center-moved`,
  `center-deleted`, `center-kind`, `frame-confirmed` (n, faces, backs); an undo / redo logs the
  same events with `via: undo | redo`. Clicks = `center-added` without a `via` (gross: a click
  later deleted still counts as a click); the [center] line's count is the NET centers (added less
  deleted, undo/redo included). Reported: clicks per active minute (center-mode active time) and
  clicks per confirmed frame, beside the centers now per confirmed frame (faces, backs, mean, max).
- verify mode (naming a center census): `verify-shown` (`center`, `blind`),
  `verify-revealed` (`ms` from shown), `verify-answer` (`verifiedBy`, `blind`, `ms` from shown,
  `revealed`), `verify-correction` (`correction`: not-card / back), `verify-cleared` (Backspace).
  Answers = centers whose latest answer stands (a re-answer counts once, a cleared one not at
  all), split by the center's `blind` (the blind subsample, named with no proposals) vs assisted.
  Active time: a gap goes to the center on screen during it (the latest verify event before the
  gap), so blind and assisted minutes add up to the verify-mode active time less the time before
  the first center. Reported: verify answers per active minute overall, blind and assisted.
- coverage check: confirmed frames in frames.jsonl that no event names (a page that could not
  reach the server, a log edited by hand): such a frame means the times above miss work.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.dont_write_bytecode = True
import labelcore as lc  # noqa: E402



def load(root: Path, set_id: str):
    d = root / set_id
    events = []
    if (d / "timing.jsonl").exists():
        with (d / "timing.jsonl").open(encoding="utf-8") as f:
            events = [json.loads(line) for line in f if line.strip()]
    frames = []
    if (d / "frames.jsonl").exists():
        with (d / "frames.jsonl").open(encoding="utf-8") as f:
            frames = [json.loads(line) for line in f if line.strip()]
    return events, frames


def report(root: Path, set_id: str, idle: float = 120.0) -> dict:
    events, frames = load(root, set_id)
    events = sorted((e for e in events if isinstance(e.get("ts"), (int, float))), key=lambda e: e["ts"])
    active = 0.0
    for a, b in zip(events, events[1:]):
        active += min(max(0.0, (b["ts"] - a["ts"]) / 1000.0), idle)
    wall = (events[-1]["ts"] - events[0]["ts"]) / 1000.0 if len(events) > 1 else 0.0
    corrections = sum(1 for e in events if e.get("ev") == "corrected")
    by_mode = per_mode(events, idle)
    corrections_drawn = sum(m["correctionsDrawn"] for m in by_mode.values())
    # labels = first commits, per mode (a box and its later identity are two labels), net of
    # labels deleted after their commit
    n_committed = sum(m["committed"] for m in by_mode.values())
    items = [it for fr in frames for it in (fr.get("points") or fr.get("targets") or [])]
    labeled = [it for it in items if lc.target_complete(it) and not it.get("pending")]  # an unreviewed detector box is no label
    try:
        set_mode = json.loads((root / set_id / "meta.json").read_text(encoding="utf-8")).get("mode")
    except (OSError, ValueError, AttributeError):
        set_mode = None
    # a training-mode (corner) target with prefill corners is not a box; a box set's prefill box is
    box_sources = lc.BOX_CORNER_SOURCES + (lc.BOX_QUAD_SOURCE,) if set_mode == "box" else ("box", "propagated", "carried")
    boxes = [it for it in items if it.get("cornerSource") in box_sources]
    outcomes = Counter(it["outcome"] for it in labeled)
    elig = Counter(it.get("eligible") for it in labeled if it["outcome"] == "card")
    sources = Counter(it.get("labelSource") or "manual" for it in labeled)
    unknown = sum(1 for it in labeled if it["outcome"] == "card" and it.get("identity") == "unknown")
    n = len(labeled)
    # a frame confirmed in the labels but never in the log (box / corner / training: Enter logs
    # `frame-confirmed`; point and identify frames are not confirmed that way)
    logged_frames = {e.get("frame") for e in events if e.get("ev") == "frame-confirmed"} if set_mode in ("box", "corner", "training", "center") \
        else {e.get("frame") for e in events}
    unlogged = sorted(fr.get("name") for fr in frames if fr.get("done") and fr.get("name") not in logged_frames)
    share = lambda c: {k: round(v / n, 4) for k, v in sorted(c.items(), key=lambda kv: str(kv[0]))} if n else {}  # noqa: E731
    centers = center_stats(events, frames, by_mode) if set_mode == "center" or "center" in by_mode else None
    verify = verify_stats(events, by_mode, idle) if "verify" in by_mode else None
    return {
        "setMode": set_mode, "centers": centers, "verify": verify,
        "set": set_id, "events": len(events), "activeSec": round(active, 1), "wallSec": round(wall, 1),
        "idleCapSec": idle, "committed": n_committed, "corrections": corrections, "correctionsDrawn": corrections_drawn,
        "correctionRate": round(corrections_drawn / n_committed, 4) if n_committed else None,
        "perActiveHour": round(n_committed / (active / 3600.0), 1) if active > 0 else None,
        "perWallHour": round(n_committed / (wall / 3600.0), 1) if wall > 0 else None,
        "labeledNow": n, "outcomes": dict(outcomes), "outcomeShare": share(outcomes),
        "unknownIdentity": unknown, "eligibilityAmongCards": dict(elig),
        "labelSources": dict(sources), "labelSourceShare": share(sources),
        "framesDone": sum(1 for fr in frames if fr.get("done")), "frames": len(frames),
        "byMode": by_mode,
        "framesDoneWithoutEvents": unlogged,
        "boxesNow": {"total": len(boxes), "backs": sum(1 for b in boxes if b.get("outcome") == "card-back"),
                     "ignored": sum(1 for b in boxes if b.get("ignore")),
                     "withIdentity": sum(1 for b in boxes if b.get("identity")),
                     "unknownIdentity": sum(1 for b in boxes if b.get("identity") == "unknown"),
                     "propagated": sum(1 for b in boxes if str(b.get("labelSource") or "").startswith("propagated")),
                     "carried": sum(1 for b in boxes if str(b.get("labelSource") or "").startswith("carried")),
                     "prefillAccepted": sum(1 for b in boxes if b.get("labelSource") == "prefill-accepted"),
                     "prefillCorrected": sum(1 for b in boxes if b.get("labelSource") == "prefill-corrected"),
                     "prefillUnreviewed": sum(1 for b in boxes if b.get("pending"))},
    }


TOOL_ORIGINS = ("paste", "duplicate", "insert")
DRAWN_ORIGINS = (None, "drawn", "snap", "default-box")  # placed by the labeler's own drag or click
CLICK_ORIGINS = ("snap", "default-box")

UNIT = {"box": "boxes", "identify": "identities", "point": "points", "corner": "targets", "training": "targets", "center": "centers",
        "verify": "verified centers"}
VERIFY_EVENTS = ("verify-shown", "verify-revealed", "verify-answer", "verify-correction", "verify-cleared")
CENTER_EVENTS = ("center-added", "center-moved", "center-deleted", "center-kind")


def center_stats(events: list, frames: list, by_mode: dict) -> dict:
    """Center mode: clicks (gross `center-added` without a via) per active minute and per
    confirmed frame, the edits apart, and the centers now on confirmed frames."""
    ev = [e for e in events if e.get("mode") == "center" or e.get("ev") in CENTER_EVENTS]
    own = Counter(e.get("ev") for e in ev if e.get("ev") in CENTER_EVENTS and not e.get("via"))
    hist = Counter(e.get("ev") for e in ev if e.get("ev") in CENTER_EVENTS and e.get("via"))
    kinds = Counter(e.get("kind") for e in ev if e.get("ev") == "center-added" and not e.get("via"))
    done = [fr for fr in frames if fr.get("done")]
    per = [fr.get("centers") or [] for fr in done]
    faces = sum(1 for cs in per for c in cs if c.get("kind") == "face")
    backs = sum(1 for cs in per for c in cs if c.get("kind") == "back")
    sec = (by_mode.get("center") or {}).get("activeSec") or 0.0
    clicks = own["center-added"]
    return {
        "clicks": clicks, "clicksFace": kinds["face"], "clicksBack": kinds["back"],
        "moved": own["center-moved"], "deleted": own["center-deleted"], "kindToggled": own["center-kind"],
        "viaHistory": dict(hist), "activeSec": round(sec, 1),
        "clicksPerActiveMin": round(clicks / (sec / 60.0), 2) if sec > 0 else None,
        "framesConfirmed": len(done), "clicksPerConfirmedFrame": round(clicks / len(done), 2) if done else None,
        "centersNow": {"faces": faces, "backs": backs, "total": faces + backs,
                       "perFrameMean": round((faces + backs) / len(done), 2) if done else None,
                       "perFrameMax": max((len(cs) for cs in per), default=0),
                       "framesWithNone": sum(1 for cs in per if not cs)},
    }


def verify_stats(events: list, by_mode: dict, idle: float) -> dict:
    """Verify mode: answers per active minute, blind vs assisted (see the module doc)."""
    ev = [e for e in events if e.get("mode") == "verify"]
    latest = {}  # (frame, center) → the latest verify-answer, or None once cleared
    for e in ev:
        k = (e.get("frame"), e.get("center"))
        if e.get("ev") == "verify-answer":
            latest[k] = e
        elif e.get("ev") == "verify-cleared":
            latest[k] = None
    answered = [e for e in latest.values() if e]
    sec = {"blind": 0.0, "assisted": 0.0, "none": 0.0}
    cur = None
    for a, b in zip(events, events[1:]):
        if a.get("mode") == "verify" and a.get("ev") in VERIFY_EVENTS:
            cur = "blind" if a.get("blind") else "assisted"
        elif a.get("mode") != "verify":
            cur = None
        if b.get("mode") == "verify":
            sec[cur or "none"] += min(max(0.0, (b["ts"] - a["ts"]) / 1000.0), idle)
    total = (by_mode.get("verify") or {}).get("activeSec") or 0.0
    rate = lambda n, s: round(n / (s / 60.0), 2) if s > 0 else None  # noqa: E731
    split = {}
    for kind in ("assisted", "blind"):
        n = sum(1 for e in answered if bool(e.get("blind")) == (kind == "blind"))
        split[kind] = {"answers": n, "activeSec": round(sec[kind], 1), "answersPerActiveMin": rate(n, sec[kind])}
    reveal = sorted(e["ms"] for e in ev if e.get("ev") == "verify-revealed" and isinstance(e.get("ms"), (int, float)))
    return {
        "answers": len(answered), "answerEvents": sum(1 for e in ev if e.get("ev") == "verify-answer"),
        "cleared": sum(1 for e in ev if e.get("ev") == "verify-cleared"),
        "corrections": sum(1 for e in ev if e.get("ev") == "verify-correction"),
        "byVerifiedBy": dict(Counter(e.get("verifiedBy") for e in answered)),
        "activeSec": round(total, 1), "answersPerActiveMin": rate(len(answered), total),
        "assisted": split["assisted"], "blind": split["blind"], "beforeFirstCenterSec": round(sec["none"], 1),
        "revealed": len(reveal), "medianRevealSec": round(reveal[len(reveal) // 2] / 1000.0, 1) if reveal else None,
    }


def per_mode(events: list, idle: float) -> dict:
    """Counts and active time per page mode (events without a mode: key "unknown")."""
    out: dict = {}

    def slot(m):
        return out.setdefault(m or "unknown", {"unit": UNIT.get(m or "", "labels"), "committed": set(), "deleted": 0, "corrections": 0,
                                                "activeSec": 0.0, "confirmed": {},
                                                "identityKnown": 0, "identityUnknown": 0, "backs": 0, "ignored": 0,
                                                "toolMade": {o: set() for o in TOOL_ORIGINS}, "carriedOver": {},
                                                "correctionsByOrigin": Counter(), "placedByClick": {o: set() for o in CLICK_ORIGINS},
                                                "frameSec": Counter(), "drawnFrames": Counter(),
                                                "named": {}, "renamed": 0, "pickerMs": [],
                                                "review": {"sec": 0.0, "boxes": set(), "passes": 0, "turned": set()},
                                                "idTurned": {"boxes": set(), "turns": 0, "via": Counter()},
                                                "prefill": {"state": {}, "via": {}, "offered": 0, "suggestions": 0, "frames": set()}})
    for a, b in zip(events, events[1:]):
        gap = min(max(0.0, (b["ts"] - a["ts"]) / 1000.0), idle)
        slot(b.get("mode"))["activeSec"] += gap
        slot(b.get("mode"))["frameSec"][b.get("frame")] += gap
        if b.get("review"):
            slot(b.get("mode"))["review"]["sec"] += gap
    for e in events:
        s = slot(e.get("mode"))
        ev = e.get("ev")
        pf = s["prefill"]
        k = (e.get("frame"), e.get("target"))
        if ev in ("committed", "corrected") and e.get("origin") == "prefill":  # a reviewed detector box
            pf["state"][k] = "accepted" if e.get("labelSource") == "prefill-accepted" else "corrected"
            if ev == "committed":
                pf["via"][k] = e.get("via") or "edit"
            if ev == "corrected":
                s["corrections"] += 1
                s["correctionsByOrigin"]["prefill"] += 1
            continue
        if ev == "prefill-rejected" and e.get("mode") == "box":
            s["named"].pop(k, None)
            pf["state"][k] = "rejected"
            pf["via"].pop(k, None)
            continue
        if ev == "prefill-unrejected":
            if pf["state"].get(k) == "rejected":
                del pf["state"][k]
            continue
        if ev == "prefill-offered" and e.get("mode") == "box":
            pf["offered"] += int(e.get("n") or 0)
            pf["suggestions"] += int(e.get("suggestions") or 0)
            pf["frames"].add(e.get("frame"))
            continue
        if ev == "reviewed":  # the review walk: a box passed as OK (not a box, not a correction)
            s["review"]["boxes"].add(k)
            s["review"]["passes"] += 1
            continue
        if ev == "review-turned":
            s["review"]["turned"].add(k)
            continue
        if ev == "identify-turned":  # the identity pass turned a box's top edge (not an identity, not a correction)
            it = s["idTurned"]
            it["via"][e.get("via") or "?"] += 1
            if e.get("via") not in ("undo", "redo", "refused"):
                it["boxes"].add(k)
                it["turns"] += 1
            continue
        if ev == "center-added":  # center mode: a center (net of deletes, undo/redo included)
            s["committed"].add((e.get("frame"), e.get("center")))
            continue
        if ev == "center-deleted":
            ck = (e.get("frame"), e.get("center"))
            if ck in s["committed"]:
                s["committed"].discard(ck)
                s["deleted"] += 1
            continue
        if ev in ("center-moved", "center-kind"):  # an edit, not a correction of an answer
            continue
        if ev in VERIFY_EVENTS:  # verify mode: a center counts once its answer stands (net of Backspace)
            ck = (e.get("frame"), e.get("center"))
            if ev == "verify-answer":
                s["committed"].add(ck)
            elif ev == "verify-cleared":
                s["committed"].discard(ck)
            continue
        if ev == "identified":  # box mode: a box named, not a box (and not a correction)
            if e.get("first") is False and k in s["named"]:
                s["renamed"] += 1
            s["named"][k] = e.get("identityKnown") is not False
            if isinstance(e.get("pickerMs"), (int, float)):
                s["pickerMs"].append(e["pickerMs"])
            continue
        if ev == "committed" and e.get("origin") in TOOL_ORIGINS:
            s["toolMade"][e["origin"]].add((e.get("frame"), e.get("target")))
        elif ev == "committed":
            k = (e.get("frame"), e.get("target"))
            if e.get("origin") in CLICK_ORIGINS:
                s["placedByClick"][e["origin"]].add(k)
            if k not in s["committed"]:
                s["committed"].add(k)
                s["drawnFrames"][e.get("frame")] += 1
                if e.get("identityKnown") is True:
                    s["identityKnown"] += 1
                elif e.get("identityKnown") is False:
                    s["identityUnknown"] += 1
                if e.get("outcome") == "card-back":
                    s["backs"] += 1
                if e.get("ignore"):
                    s["ignored"] += 1
        elif ev == "corrected":
            s["corrections"] += 1
            s["correctionsByOrigin"][e.get("origin") or "drawn"] += 1
        elif ev in ("deleted", "prefill-rejected"):
            k = (e.get("frame"), e.get("target"))
            s["named"].pop(k, None)  # a named box removed: not named any more (its id may be reused)
            if k in s["committed"]:  # a box drawn and then removed is not a label
                s["committed"].discard(k)
                s["deleted"] += 1
                s["drawnFrames"][e.get("frame")] -= 1
            for made in list(s["toolMade"].values()) + list(s["placedByClick"].values()):
                made.discard(k)
        elif ev == "frame-confirmed":
            s["confirmed"][e.get("frame")] = int(e.get("n") or 0)
        elif ev == "frame-unconfirmed":
            s["confirmed"].pop(e.get("frame"), None)
        elif ev == "carried-over":
            s["carriedOver"][e.get("frame")] = int(e.get("n") or 0)  # a frame's latest carry-over
    res = {}
    for m, s in out.items():
        n = len(s["committed"])
        hours = s["activeSec"] / 3600.0
        reviewed = sum(s["confirmed"].values())
        by_origin = s["correctionsByOrigin"]
        drawn_corr = sum(v for o, v in by_origin.items() if o in ("drawn", "snap", "default-box"))
        res[m] = {"unit": s["unit"], "committed": n, "deletedAfterCommit": s["deleted"], "corrections": s["corrections"],
                  "correctionsDrawn": drawn_corr, "correctionsByOrigin": dict(by_origin),
                  "correctionRate": round(drawn_corr / n, 4) if n else None,
                  "placedByClick": {o: len(v) for o, v in s["placedByClick"].items()},
                  "activeSec": round(s["activeSec"], 1),
                  "perActiveHour": round(n / hours, 1) if hours > 0 else None,
                  "framesConfirmed": len(s["confirmed"]), "reviewedTargets": reviewed,
                  "reviewedPerActiveHour": round(reviewed / hours, 1) if hours > 0 and reviewed else None,
                  "toolMade": {o: len(v) for o, v in s["toolMade"].items()}, "carriedOver": sum(s["carriedOver"].values()),
                  "identityKnown": s["identityKnown"], "identityUnknown": s["identityUnknown"],
                  "backs": s["backs"], "ignored": s["ignored"]}
        if s["named"]:
            pm = sorted(s["pickerMs"])
            res[m]["named"] = {"boxes": len(s["named"]), "known": sum(1 for v in s["named"].values() if v),
                               "unknown": sum(1 for v in s["named"].values() if not v), "renamed": s["renamed"],
                               "picks": len(pm), "medianPickerSec": round(pm[len(pm) // 2] / 1000.0, 1) if pm else None,
                               "pickerSec": round(sum(pm) / 1000.0, 1)}
        it = s["idTurned"]
        if sum(it["via"].values()):
            res[m]["turned"] = {"boxes": len(it["boxes"]), "turns": it["turns"], "via": dict(it["via"])}
        rv = s["review"]
        if rv["passes"] or rv["turned"] or rv["sec"]:
            rh = rv["sec"] / 3600.0
            res[m]["review"] = {"boxes": len(rv["boxes"]), "passes": rv["passes"], "turned": len(rv["turned"]),
                                "activeSec": round(rv["sec"], 1),
                                "boxesPerActiveHour": round(len(rv["boxes"]) / rh, 1) if rh > 0 and rv["boxes"] else None}
        pf = s["prefill"]
        if pf["offered"] or pf["state"]:
            st = Counter(pf["state"].values())
            reviewed = sum(st.values())
            sec = sum(v for f, v in s["frameSec"].items() if f in pf["frames"])
            accepted_keys = [k for k, v in pf["state"].items() if v == "accepted"]
            res[m]["prefill"] = {
                "offered": pf["offered"], "suggestions": pf["suggestions"], "framesOffered": len(pf["frames"]),
                "accepted": st["accepted"], "corrected": st["corrected"], "rejected": st["rejected"], "reviewed": reviewed,
                "acceptedBy": dict(Counter(pf["via"].get(k, "edit") for k in accepted_keys)),
                "activeSecOnPrefillFrames": round(sec, 1),
                "drawnOnPrefillFrames": sum(v for f, v in s["drawnFrames"].items() if f in pf["frames"]),
                "secPerReviewed": round(sec / reviewed, 1) if reviewed else None,
            }
    return res


def total(pairs: list, idle: float = 120.0) -> dict:
    """One total over several sets (and labels roots): every set's events merged into one time line,
    so a switch between sets is one gap (capped at `idle`) rather than counted in each set. Active
    time per page mode (a gap goes to the mode of the event that ends it), wall time first to last
    event, and per mode the labels committed (the per-set counts summed)."""
    events, committed, sets = [], Counter(), 0
    for root, set_id in pairs:
        ev, _ = load(root, set_id)
        ev = [e for e in ev if isinstance(e.get("ts"), (int, float))]
        if not ev:
            continue
        sets += 1
        events += ev
        for m, s in per_mode(sorted(ev, key=lambda e: e["ts"]), idle).items():
            committed[m] += len(s["committed"]) if isinstance(s["committed"], set) else s["committed"]
    events.sort(key=lambda e: e["ts"])
    by_mode = Counter()
    for a, b in zip(events, events[1:]):
        by_mode[b.get("mode") or "unknown"] += min(max(0.0, (b["ts"] - a["ts"]) / 1000.0), idle)
    active = sum(by_mode.values())
    wall = (events[-1]["ts"] - events[0]["ts"]) / 1000.0 if len(events) > 1 else 0.0
    return {"sets": sets, "activeSec": round(active, 1), "wallSec": round(wall, 1), "idleCapSec": idle,
            "byMode": {m: {"activeSec": round(by_mode[m], 1), "committed": committed[m], "unit": UNIT.get(m, "labels")}
                       for m in sorted(set(by_mode) | set(committed))}}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("sets", nargs="*", help="set ids (or --all)")
    p.add_argument("--labels-dir", action="append", required=True,
                   help="labels root (repeatable: the sets are looked up in each; with --all, every set of every root)")
    p.add_argument("--all", action="store_true", help="every set (a directory with a timing.jsonl) of the labels root(s)")
    p.add_argument("--total-only", action="store_true", help="print only the combined total")
    p.add_argument("--idle", type=float, default=120.0, help="a longer gap between events counts as this many seconds")
    p.add_argument("--json", action="store_true")
    a = p.parse_args()
    roots = [Path(d).expanduser().resolve() for d in a.labels_dir]
    # a shell that does not split words (zsh) may pass several ids as one argument
    names = [x for s in a.sets for x in s.split()]
    pairs = []
    for root in roots:
        ids = sorted(d.name for d in root.iterdir() if (d / "timing.jsonl").exists()) if a.all else names
        for s in ids:
            if (root / s).is_dir():
                pairs.append((root, s))
            elif not a.all:
                print(f"note: no set {s!r} under {root}", file=sys.stderr)
    if not pairs:
        p.error("no sets found (give set ids or --all)")
    rows = [] if a.total_only else [dict(report(root, s, a.idle), root=str(root)) for root, s in pairs]
    tot = total(pairs, a.idle) if len(pairs) > 1 or a.total_only else None
    if a.json:
        print(json.dumps({"sets": rows, "total": tot} if tot else rows, indent=1))
        return
    for r in rows:
        det = sum(((m.get("prefill") or {}).get("reviewed") or 0) for m in r["byMode"].values())
        print(f"{r['set']}: {r['committed']} verified labels{f' (+ {det} detector boxes reviewed, below)' if det else ''} "
              f"in {r['activeSec'] / 60:.1f} active min (wall {r['wallSec'] / 60:.1f} min, gaps capped at {r['idleCapSec']:.0f} s)")
        if r["framesDoneWithoutEvents"]:
            print(f"  WARNING: {len(r['framesDoneWithoutEvents'])}/{r['framesDone']} confirmed frames were never logged as confirmed "
                  f"({', '.join(r['framesDoneWithoutEvents'][:5])}{' …' if len(r['framesDoneWithoutEvents']) > 5 else ''}): "
                  "the log misses work on them, so the times and rates here undercount")
        print(f"  per active hour {r['perActiveHour']}, per wall hour {r['perWallHour']}")
        ce = r.get("centers")
        if ce:
            now = ce["centersNow"]
            cpm = "—" if ce["clicksPerActiveMin"] is None else ce["clicksPerActiveMin"]
            cpf = "—" if ce["clicksPerConfirmedFrame"] is None else ce["clicksPerConfirmedFrame"]
            print(f"  center census: {ce['clicks']} clicks (face {ce['clicksFace']}, back {ce['clicksBack']}) in {ce['activeSec'] / 60:.1f} active min: "
                  f"{cpm} clicks per active minute; {cpf} clicks per confirmed frame ({ce['framesConfirmed']} confirmed)")
            print(f"    edits: moved {ce['moved']}, deleted {ce['deleted']}, face/back toggled {ce['kindToggled']}"
                  + (f"; undo/redo {ce['viaHistory']}" if ce["viaHistory"] else ""))
            print(f"    centers now on confirmed frames: {now['total']} (faces {now['faces']}, backs {now['backs']}); "
                  f"per frame mean {now['perFrameMean']}, max {now['perFrameMax']}; frames with none {now['framesWithNone']}")
        vs = r.get("verify")
        if vs:
            dash = lambda v: "—" if v is None else v  # noqa: E731
            a, b = vs["assisted"], vs["blind"]
            print(f"  verify (naming the census): {vs['answers']} centers answered in {vs['activeSec'] / 60:.1f} active min: "
                  f"{dash(vs['answersPerActiveMin'])} verify answers per active minute")
            print(f"    assisted {a['answers']} in {a['activeSec'] / 60:.1f} min ({dash(a['answersPerActiveMin'])}/min) · "
                  f"blind {b['answers']} in {b['activeSec'] / 60:.1f} min ({dash(b['answersPerActiveMin'])}/min); "
                  f"by {vs['byVerifiedBy']}; corrections {vs['corrections']}; {vs['answerEvents']} answer events (re-answers included), "
                  f"cleared {vs['cleared']}; median reveal {dash(vs['medianRevealSec'])} s after the crop")
        if r.get("setMode") != "center":  # outcomes, eligibility and label sources do not exist in a census
            cr = r["correctionRate"]
            print(f"  corrections {r['corrections']}, of drawn labels {r['correctionsDrawn']} "
                  f"(rate on drawn labels {'—' if cr is None else f'{100 * cr:.1f} %'})")
            print(f"  current labels {r['labeledNow']} on {r['framesDone']}/{r['frames']} done frames; outcome share "
                  + ", ".join(f"{k} {100 * v:.1f} %" for k, v in r["outcomeShare"].items()))
            print(f"  eligibility among cards {r['eligibilityAmongCards']}; unknown identity {r['unknownIdentity']}")
            print(f"  label source share " + ", ".join(f"{k} {100 * v:.1f} %" for k, v in r["labelSourceShare"].items()))
        for m, s in sorted(r["byMode"].items()):
            extra = ""
            if m == "box":
                pc = s["placedByClick"]
                rate = "—" if s["correctionRate"] is None else f"{100 * s['correctionRate']:.1f} %"
                extra = f"; backs {s['backs']}, ignored {s['ignored']}; correction rate on drawn boxes {rate}"
                other = {o: v for o, v in s["correctionsByOrigin"].items() if o not in ("drawn", "snap", "default-box")}
                if other:
                    extra += "; corrections of boxes not drawn: " + ", ".join(f"{o} {v}" for o, v in sorted(other.items()))
            elif m == "identify":
                extra = f"; card identities {s['identityKnown']}, unknown {s['identityUnknown']}"
                tu = s.get("turned")
                if tu:
                    back = tu["via"].get("undo", 0)
                    extra += (f"; top edges turned on {tu['boxes']} boxes ({tu['turns']} turns"
                              + (f", {back} undone" if back else "") + ")")
            rev = f"; reviewed {s['reviewedTargets']} on {s['framesConfirmed']} confirmed frames ({s['reviewedPerActiveHour']}/active h)" if s["framesConfirmed"] else ""
            made = {o: v for o, v in s["toolMade"].items() if v}
            if made or s["carriedOver"]:
                rev += "; not drawn (not in the rate): " + ", ".join([f"{o} {v}" for o, v in made.items()]
                                                                     + ([f"carried over {s['carriedOver']}"] if s["carriedOver"] else []))
            placed = ""
            if m == "box":
                placed = f" drawn (of them placed with n+click {s['placedByClick']['default-box']}, snap {s['placedByClick']['snap']})"
            print(f"  [{m}] {s['committed']} {s['unit']}{placed} in {s['activeSec'] / 60:.1f} active min: "
                  f"{s['perActiveHour']} {s['unit']} per active hour; corrections {s['corrections']}{extra}{rev}")
            nm = s.get("named")
            if nm:
                med = "—" if nm["medianPickerSec"] is None else f"{nm['medianPickerSec']} s"
                print(f"    named in box mode (not boxes, not corrections): {nm['boxes']} boxes (card {nm['known']}, unknown {nm['unknown']}), "
                      f"{nm['renamed']} re-picks; {nm['picks']} picks from the picker, median {med} from opening it, {nm['pickerSec'] / 60:.1f} min in all")
            rv = s.get("review")
            if rv:
                print(f"    review walk (inside the time above): {rv['boxes']} boxes passed ({rv['passes']} passes), {rv['turned']} turned, "
                      f"in {rv['activeSec'] / 60:.1f} active min: {rv['boxesPerActiveHour'] or '—'} review boxes per active hour")
            pf = s.get("prefill")
            if pf:
                by = ", ".join(f"{k} {v}" for k, v in sorted(pf["acceptedBy"].items()))
                spr = "—" if pf["secPerReviewed"] is None else f"{pf['secPerReviewed']} s"
                print(f"    prefill (detector boxes, not drawn): {pf['offered']} offered on {pf['framesOffered']} frames "
                      f"({pf['suggestions']} as suggestions); reviewed {pf['reviewed']}: accepted {pf['accepted']}"
                      f"{f' ({by})' if by else ''}, corrected {pf['corrected']}, rejected {pf['rejected']}; "
                      f"{pf['activeSecOnPrefillFrames'] / 60:.1f} active min on those frames (incl. {pf['drawnOnPrefillFrames']} boxes drawn there): "
                      f"{spr} per reviewed detector box")
        b = r["boxesNow"]
        if b["total"]:
            print(f"  boxes now {b['total']}: backs {b['backs']}, ignored {b['ignored']}, with identity {b['withIdentity']} "
                  f"(unknown {b['unknownIdentity']}), propagated {b['propagated']}"
                  + (f", prefill accepted {b['prefillAccepted']}, corrected {b['prefillCorrected']}, unreviewed {b['prefillUnreviewed']}"
                     if b["prefillAccepted"] or b["prefillCorrected"] or b["prefillUnreviewed"] else ""))


    if tot:
        print(f"TOTAL over {tot['sets']} set(s) in {len(roots)} labels root(s): {tot['activeSec'] / 60:.1f} active min "
              f"(wall {tot['wallSec'] / 60:.1f} min, gaps capped at {tot['idleCapSec']:.0f} s; sets merged on one time line)")
        for m, v in tot["byMode"].items():
            rate = f", {round(v['committed'] / (v['activeSec'] / 3600), 1)} per active hour" if v["activeSec"] else ""
            print(f"  [{m}] {v['committed']} {v['unit']} in {v['activeSec'] / 60:.1f} active min{rate}")


if __name__ == "__main__":
    main()
