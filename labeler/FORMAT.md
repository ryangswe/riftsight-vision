<!-- SPDX-License-Identifier: Apache-2.0 -->

# Label format, and how to label

Two parts: what the labeling tool writes, and the rules a labeler follows so that two people
(or one person on two days) produce the same labels. `labelcore.py` enforces the first part on
every save; the second part is judgment, written down in [How to label](../docs/labeling.md).

## Part 1: the files

```
<labels-dir>/
  <set id>/
    meta.json       what the set is: its mode, its role, what it was made with
    frames.jsonl    one line of JSON per frame: the labels
    timing.jsonl    one line per action in the page: when the labeling happened
  labeler-project.json   optional, no label: what the project was opened with (below)
  removed-frames.json    optional, no label: the frames removed from the project (below)
```

A **set** is the labels of one video in one mode. Its id is the id of the asset in the sample
file (a repeat set made by `make_repeat_set.py` has its own id and points at the same frames).
Files are written whole, to a temporary file that then replaces the old one, so a crash never
leaves half a file. Text is UTF-8.

### Coordinates

- **Frame pixels**: origin at the frame's top-left corner, x to the right, y down, in the
  frame's own size. Every row records that size as `frameW` and `frameH`, as the browser decoded
  the image. Boxes and corners use frame pixels, stored to a tenth of a pixel.
- **Normalized**: the same axes divided by the frame's width and height, so 0 to 1. Points and
  centers use this, stored to six decimals.
- **Angles** are in degrees, clockwise on screen, in (−180, 180].

### `meta.json`

| Field | Meaning |
| --- | --- |
| `schemaVersion` | 2 |
| `tool` | `"labeler"` |
| `setId`, `frameAsset` | the set, and the asset whose frames it labels |
| `mode` | `box`, `corner`, `training`, `point` or `center`: fixed at the first save |
| `role` | `training`, `development` or `test`: fixed at the first save |
| `zoom` | the fixed zoom (screen pixels per frame pixel) of the one-at-a-time views |
| `pointRule` | point sets: `{generator, seed, k, inset, frameIndex}`, everything needed to compute the points again |
| `blind` | `true` until pre-fill was offered in this set (the verify pass records `blind` per center instead) |
| `prefillUsed`, `prefillSource` | set when pre-fill was offered: `true`, and the pre-fill file's name |
| `decklist` | the deck lists in use at the last save: `{lists: [{label, file, sha1, ids, unresolved, ambiguous, counts}], ids, unresolved}` |
| `recording` | optional tags about the footage (below) |
| `annotator`, `notes` | free text |
| `createdAt`, `labeledAt`, `identifiedAt` | ISO times: first save, last save, last save of the identity pass |
| `verify` | center sets named by the verify pass: `{arms: {<name>: {file, sha256}}, armsManifestSha256, blind, blindSha256, allBlind?, lastSavedAt, note}` |
| `repeatOf` | repeat sets: `{set, seed, n, drawn, pool, createdAt}` |

Files are recorded by name and checksum, never by path.

`recording` tags, all optional: `source` (`digital` or `physical`), `physicalGroup`
(`tournament`, `webcam`, `phone`), `cameraAngle` (`overhead`, `oblique`), `stability` (`steady`,
`some-motion`, `moving`), `lighting` (`even`, `uneven`, `low`), `upscaled` (`yes`, `no`,
`unknown`), and the free texts `sourceResolution` (the recording's native size, such as `720p`
or `1920x1080`), `language` and `client` (the name of the digital client).

### What a sample says about a video

The sample file (README, "The sample") lists the frames to label, one asset per video. Beside
`platform` and `videoId` (where the video is hosted, read by the manifest export), an asset may
say, all optional:

| Field | Meaning |
| --- | --- |
| `title` | the video's title: one line of at most 300 characters, with no line or paragraph separator and no bidirectional control character |
| `uploadDate` | the day the video was published, `YYYY-MM-DD`: a real day, from 1990 on and not after tomorrow |
| `language` | the language spoken in the video, a tag such as `en` or `pt-BR` |

This `language` is the video's. It is not the recording tag `language` ("Language of the
cards", in `meta.json`'s `recording`), which says in which language the cards on screen are
printed.

The Names pass shows them under About this recording, with a link that opens a YouTube video
at the frame's time (`https://www.youtube.com/watch?v={video_id}&t={seconds}s`; none for `local`). A value not
of its form is left out when the sample is read and the page says how many were not used and
which; the rest of the asset is kept, and a sample without these fields is as valid as before. No label file stores them, and the tool fetches
nothing. `make_sample.py --title ID=TEXT --upload-date ID=YYYY-MM-DD --language ID=TAG` writes
them.

### `frames.jsonl`

One object per frame, sorted by time. Every row has:

| Field | Meaning |
| --- | --- |
| `name` | the frame's file name |
| `t` | its time in the video, seconds |
| `frameW`, `frameH` | the frame's own size in pixels |
| `done` | the frame was confirmed: everything on it is labeled |

and, by the set's mode, exactly one of `targets` (box, corner, training), `points` (point) or
`centers` (center). Box sets may also carry `prefillOffered` (pre-fill was offered on this
frame, so it is never offered again) and `prefillSuppressed` (the indices of the model's boxes
held back because the labeler's own boxes already covered them).

### A target: a box or a quad

```json
{"id": "B003", "corners": [[412.0, 96.5], [530.0, 96.5], [530.0, 261.0], [412.0, 261.0]],
 "estimated": [false, false, false, false], "cornerSource": "box",
 "outcome": "card", "identity": "TOY-001", "printing": null, "identitySource": "decklist",
 "eligible": "yes", "conditions": {"visibleShare": "full"}, "labelSource": "manual",
 "derived": {"aabb": [412.0, 96.5, 118.0, 164.5], "rotationDeg": 0.0, "shortSidePx": 118.0}}
```

**Geometry**

| Field | Meaning |
| --- | --- |
| `id` | unique within the frame |
| `corners` | four `[x, y]` in frame pixels, **in the card's own order: its top-left, top-right, bottom-right, bottom-left**. The order runs clockwise on screen and says which way up the card lies: an upside-down card starts at the corner that is bottom-right on screen. The edge from the first corner to the second is the card's top. |
| `estimated` | four booleans: that corner is hidden and was placed where it must be |
| `cornerSource` | how the corners were made: `box` (a box), `hand`, `snap`, `snap-edited` (quads), `prefill`, `prefill-edited` (from a model), `carried` (copied from the previous frame), `propagated` (written by a tracking script outside this tool) |
| `angle` | boxes only: the rectangle's rotation, present when it is not 0 |
| `zOrder` | boxes only: stacking order, larger on top; absent means the position in the list |
| `ignore` | boxes only, `true`: an ignore region (see Part 2) |
| `derived` | measured by the server on every save, never taken from the page (below) |

In a box set every target is a rectangle: its four corners are a parallelogram with equal
diagonals within half a pixel, every side at least one pixel. An unrotated box is the plain
case. The one exception is a box whose corners were freed in the Boxes pass (Shift+drag a
corner, for a card seen at an angle): it has `cornerSource` `hand` and no `angle`, and may be
any convex shape whose corners run clockwise, every side at least one pixel. A quad of a corner
set may be any convex shape.

`derived`: `aabb` (the upright box around the corners, `[x, y, w, h]`), `sides` (`top`, `right`,
`bottom`, `left` lengths), `widthPx`, `heightPx`, `shortSidePx` (the card's short side on
screen), `shortSideSourcePx` (the same in the recording's native pixels when `recording.
sourceResolution` is known, else null), `rotationDeg` (how far the card's up direction is
turned from screen-up), `foreshortening` (1 for a card seen flat, smaller the more it is
squeezed; the smallest of `foreshorteningParts.topBottom`, `.leftRight` and `.aspect`),
`cardAspect` (the upright shape assumed: 63:88, or 88:63 for a card of a landscape kind),
`clockwise` and `convex`.

**The answer**

| Field | Values |
| --- | --- |
| `outcome` | `card` · `card-back` · `not-card` · `unreadable` (a card whose face cannot be read) |
| `identity` | a card id of the catalog, or `unknown` |
| `printing` | the id of the alternate printing on screen, or null. When a printing is recorded, `identity` is its root card (its `printingOf`, followed to a card that is a printing of none) |
| `identitySource` | how the labeler knew: `current-frame` · `later-close-up` · `decklist` · `other` |
| `eligible` | readable **from this frame alone**: `yes` · `uncertain` · `no` |
| `conditions` | optional tags: `faceUp`, `blur`, `glare`, `sleeveOrFoil` (true / false), `visibleShare` (`full` · `most` · `half` · `little`) |

A card counts as labeled when it has an identity and an eligibility. In a box set an outcome
alone is enough; names come in the identity pass. A card back and an unreadable card are
`eligible: no`.

**Provenance**

| Field | Meaning |
| --- | --- |
| `labelSource` | `manual` · `prefill-accepted` (a model's box, taken as it was) · `prefill-corrected` (changed by the labeler) · `carried` · `carried-corrected` (the labeler's own box from the previous frame, as copied or changed) · `propagated` · `propagated-corrected` (a tracking script's box, training sets only) |
| `prefill` | the model's proposal this target started from: `{i, corners, outcome, score, cardId, sim, margin, flag, ...}`, kept as it was |
| `pending` | `true`: a model's box nobody has reviewed yet. A confirmed frame has none. |
| `carriedFrom`, `propagatedFrom` | `{frame, target}`: where a copied box came from |
| `orientationFixedIn` | `"identify"`: the identity pass turned this box's top edge |
| `boxFix` | a flag set in the identity pass: this box needs fixing in box mode |

The server refuses `prefill` provenance outside training sets, `carried` in test sets and
`propagated` outside training sets. In the identity pass it refuses any change to a target's
geometry or provenance, with two exceptions, both in box sets. The corner order may be turned
(the same four points, starting at another one) with `angle` turned to match; provenance stays.
And in a set of role `training` or `development`, an existing box's `corners` and `angle` may
change (moved, resized or rotated, still a rectangle); its `labelSource` and `cornerSource`
must then be what the same edit records in the Boxes pass: a model box `prefill-corrected`
with `cornerSource` `prefill-edited` and its `prefill` kept (`prefill-accepted` with `prefill`
only when it is back on its proposal with the proposal's outcome; back on it with another
outcome it is `prefill-corrected`), and its `pending` / `suggestion` may be dropped by that
edit, as the Boxes pass finalizes a box it edits; a kept or propagated box `carried-corrected` or
`propagated-corrected` with its `carriedFrom` / `propagatedFrom` kept; any other box as it was.
The server checks this against its own copy, so an undo back to the old place is an edit too:
a kept box stays `carried-corrected`. Boxes are never added or removed there, `ignore`,
`estimated` and `zOrder` never change, and `pending` / `suggestion` change only by an edit.
In a `test` set boxes are not moved, resized or rotated here; the top edge can still be turned.

### A point

```json
{"i": 4, "x": 0.283731, "y": 0.611204, "outcome": "card", "identity": "TOY-001", "eligible": "yes"}
```

`i` is the point's index within the frame, `x` and `y` are normalized. The answer fields are
those of a target. The positions come from `meta.pointRule` and the frame number alone.

### A center

```json
{"id": "C003", "x": 0.7, "y": 0.6, "kind": "face"}
```

`id` is `C` and a number, **never reused within a frame**: the row's `centerSeq` is the last
number given out, and it survives deletes and undo. `kind` is `face` or `back`.

The verify pass adds an answer to a center and changes nothing else:

| Field | Meaning |
| --- | --- |
| `eligible` | readable from the crop alone: `yes` · `uncertain` · `no`, answered **before** any proposal is shown |
| `readabilityAt` | `{x, y, at}`: stamped by the server when it stored that answer |
| `revealedAt` | stamped by the server when it released the proposals; never on a blind center |
| `verifiedBy` | `accept-<arm name>` · `accept-both` · `picked` · `unknown` · `not-card` · `back` |
| `identity`, `printing` | the card, for an accept or a pick; `unknown` for Unknown |
| `correction` | `not-card` or `back`: the click was not on a card face. The center's `kind` is left as it was clicked. |
| `blind` | this center was named with no proposals |
| `verifiedAt` | `{x, y, armsManifestSha256}`: the center's position and the run of the arms when it was answered |

An answer is **stale**, and asked again, when the center has moved since (`verifiedAt` no longer
matches its `x`, `y`) or the arms' files have changed (`armsManifestSha256` is a checksum over
each arm's name and file). The two stamps are the server's: values sent by the page are
replaced by the stored ones. A readability cannot change once `revealedAt` is set.

### `timing.jsonl`

One event per line: `{"ev": ..., "ts": <page clock, ms>, "mode": ..., "frame": ..., "target":
..., "serverAt": ...}`. The events: `session-open`, `shown`, `started`, `committed`,
`corrected`, `deleted`, `identified`, `frame-confirmed`, `frame-unconfirmed`, `frame-cleared`,
`carried-over`, `carry-over-cleared`, `pasted`, `duplicated`, `prefill-offered`,
`prefill-rejected`, `prefill-unrejected`, `kept-moved` (`m`: a kept box moved onto the model's
suggestion for its card; `suggestion` is the id of the suggestion it replaced), `review-start`,
`review-end`, `reviewed`, `review-turned`, `identify-turned`, `center-added`, `center-moved`, `center-deleted`,
`center-kind`, `verify-shown`, `verify-readability`, `verify-revealed`, `verify-answer`,
`verify-correction`, `verify-cleared`. `report_throughput.py` documents what it counts from
them. The log holds no label; deleting it loses only the timings.

### What the tool remembers

Two files that hold no label. Both are written when a person acts on a project on the page
(opens it from the start screen, chooses what its labels are for, changes a location, starts
a pass), never because a browser arrived at a project's address and never by a start with
`--mode` alone. The tool works without either.

**`<labels-dir>/labeler-project.json`**: what the project was opened with, so that a new
start of the tool can go on with it. A script may write it to prepare a project.

```json
{"schemaVersion": 1, "tool": "labeler", "sample": "../sample.json", "role": "training",
 "locations": {"catalog": "/games/toy/catalog.json", "art": "../pictures"},
 "modelBoxes": false, "savedAt": "2026-01-15T10:00:00+00:00"}
```

| Field | Meaning |
| --- | --- |
| `tool` | `"labeler"`; a file without it is not used |
| `sample` | the sample file the rest is about. A file that names another sample is not used. |
| `role` | what the labels will be used for, until a label is saved: after that the label sets' own `role` is the answer |
| `locations` | optional: `frames`, `catalog`, `art`, `decklists`, `prefill`, each a path (`art` may be an `http(s)` address). Only what is not found beside the sample anyway is stored. |
| `modelBoxes` | optional: `false` when the Boxes pass was started without the model's boxes |
| `savedAt` | when it was written |

A path is relative to the labels folder when the file lies in the sample's folder, so that the
folder can be moved as a whole, and in full otherwise. Flags given on the command line win
over this file, and no label file refers to it. A full path in it says where a file was on
your computer: leave the file out when you share a labels folder.

**`recent.json`**, in a folder of your user account (`labeler/README.md`, "What the tool
remembers", says where): the projects opened before, newest first, twenty at most.

```json
{"schemaVersion": 1, "tool": "labeler",
 "projects": [{"sample": "/work/toy/sample.json", "labels": "/work/toy/labels",
               "openedAt": "2026-01-15T10:00:00+00:00"}]}
```

### `removed-frames.json`

`<labels-dir>/removed-frames.json`: the frames a person removed from the project with
"Remove this frame" on the labeling page, and the nearby frames used instead. The sample file
is never rewritten and no label is deleted: a removed frame's row stays in its set's
`frames.jsonl`, and restoring it (the project's screen) takes it off this list, so its labels
come back as they were.

```json
{"schemaVersion": 1, "tool": "labeler",
 "removed": [{"assetId": "table-a", "name": "f00012.png", "reason": "blurry-or-small",
              "at": "2026-01-15T10:00:00+00:00"}],
 "replacements": [{"assetId": "table-a", "removed": "f00012.png",
                   "added": {"t": 23.5, "name": "f00013.png"}, "at": "2026-01-15T10:00:00+00:00"}]}
```

| Field | Meaning |
| --- | --- |
| `removed` | the frames left out: the video (`assetId`) and the frame's file `name`; `reason`, optional: `blurry-or-small`, `no-cards`, `near-duplicate`, `other` or null; `at`, when |
| `replacements` | the nearby frames put in: a frame file of the same video's folder that the sample does not list (`added`, with its time `t` when it is known), and the frame it was chosen for (`removed`) |

Every part of the tool reads the sample through this list: a removed frame is skipped by the
frame list, the counts, carry-over and the exports, and an added frame joins its video's frames
and sorts by time like any other frame. An added frame stays when the frame it replaced is
restored, and can itself be removed. Its `t` comes from the suggestions file when that has the
frame, else from its `fNNNNN` number on the line through the sample's numbered frames (with
one such frame, by `make_sample.py`'s rule t = (N − 0.5) / fps), else, for a name without a
number, from its place in the folder between two frames of known time. Otherwise `t` is left
out: the time is never guessed, and the manifest export refuses such a frame. A file that does not fit this
shape is not used: until it is corrected or deleted, the labeling page shows every frame of
the sample, nothing is removed or restored, and the export refuses to write. Deleting it brings
every removed frame back.

### Exports

`export.py coco` writes a COCO-style copy of the boxes, and `export.py manifest` writes them
in the repository's public label-manifest format, as fractions of the frame; the header of
`export.py` describes both mappings. The project's screen writes either from the page. The
files above remain the source of truth.

`export.py manifest` also writes the labels for measuring a model, censuses and point sets, as
rows with `completeness: "points"`:

| Label | Point in the manifest |
| --- | --- |
| a census frame (`centers`) | written only when `done` (the census was confirmed); a confirmed frame with no center is left out and counted in a note |
| a center | `origin: "center"`, its `x` and `y`, its `id` |
| a face named in Check names (`verifiedBy` an accept or `picked`) | `kind: "face"`, `identity: "named"`, `card_id` the printing when one is recorded, else the identity |
| Unknown (`verifiedBy: "unknown"`) | `kind: "face"`, `identity: "unknown"`, `card_id: null` |
| a face without a complete answer, or whose answer is stale (moved since, or another run of the arms than the set's last, `meta.verify.armsManifestSha256`) | `kind: "face"`, `identity: "unlabeled"`, `card_id: null`, `readable: null`; the note counts them |
| `correction: "not-card"` / `"back"` | `kind: "not-card"` / `"back"` |
| a clicked back (`kind: "back"`) | `kind: "back"` |
| a center's `eligible` (legible in the crop: yes, uncertain, no) | `readable`: `yes`, `maybe`, `no`, with `attributes.readable_from: "crop"` |
| a blind answer (`blind: true`) | `attributes.blind: true` |
| a point set's frame (`points`) | written once `done`; each answered point with `origin: "seeded"` and `id` `P` and its index; its answer mapped as a box's is (`eligible` → `readable`); a point with no answer is left out and counted |

The export does not write `verifiedBy`. The published evaluation set's points carry it as
`attributes.verified_by`, from the project's own labeling ([data/SCHEMA.md](../data/SCHEMA.md),
"Points").

A census and a point set of the same frame of the same video (two labels folders, each given to
`--labels-dir`) become one row, whose `points` hold both. Rows with boxes are never merged.

## Part 2: how to label

The rules for what gets a box, which kind and why, with the cases that make people hesitate,
are in [How to label](../docs/labeling.md).
