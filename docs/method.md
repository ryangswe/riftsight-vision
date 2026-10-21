<!-- SPDX-License-Identifier: Apache-2.0 -->

# Method: how to evaluate honestly

This page has two halves. The first is a method anyone can follow with the tools here. The
second says how the released models were tested and chosen, including one place where a rule
fixed beforehand was overridden.

## Part 1: a method you can follow

### Hold recordings out whole

Videos that share an origin, such as one channel or one event, form a **recording group**.
The same table, camera, lighting and sleeves recur throughout a group. If one video of a
group is in training and another in the test, the test measures memory of that table.

- Put every video in a group. Every row of a manifest carries its `group`.
- Give each group one role. Never split a group.
- Let a seeded shuffle decide, not a person:

  ```
  cardvision assign-roles NEW.manifest.jsonl --seed 20261010 --evaluation-share 0.3 \
      --published data/riftbound-train.manifest.jsonl --out ASSIGNED.manifest.jsonl
  ```

  The rule looks at no frame and no model output. Write the seed down with the result.

### Label the test without a model's help

A model's guess shown while you label pulls your answer towards it. That is fine for training
labels, where it only saves time. It is wrong for the labels a model is scored against.

The labeling tool enforces this by role: pre-fill is refused outside `training` sets, and a
`test` set allows no model output of any kind ([labeler/README.md](../labeler/README.md),
"Roles"). Decide the frames and the seed before you look at any result. Do not go back and
change a label because a model disagreed with it.

### Measure what a viewer sees: the hover event

The unit is a **hover event**: one position of one frame where a pointer could rest, with a
label saying what is there. The question is what would be shown at that position. The answer
is right, wrong or nothing.

Labeled positions come from two kinds of row:

- **points**: positions a person labeled one by one. Points drawn at random over the frame
  fall on and off cards alike, so an off-card point is a real negative;
- **box centers**: the center of each face, back or not-card box of an exhaustively boxed
  frame. A center that lies inside another labeled box gives no event, because the labels do
  not say which of two overlapping cards is on top there. Such centers are counted and
  reported.

`cardvision evaluate hover` runs the whole pipeline on each frame, applies the hover rule
([how-it-works.md](how-it-works.md), section 9) and classifies each event:

| Label | Right | Wrong | Nothing |
| --- | --- | --- | --- |
| A readable card face | the labeled card's name is shown | another name is shown | no name is shown |
| A card back | never | any name is shown | no name is shown |
| An off-card position | never | a name is shown that belongs to no card there | no name is shown |

One case is counted apart: a name shown on an off-card position when a face labeled with
that name, in the same frame, has its center inside the shown box. The neighboring card's
box reached the position. That is a miss of geometry, not of identity, and it is reported as
**adjacent**, in neither rate.

Faces labeled unreadable from the frame alone, and faces nobody named, are outside every
rate. They are counted and listed.

### Two rates, and why the second matters more

- **Named right** = right / (right + wrong + nothing), over readable faces.

  How often a card that could be named was named.

- **Wrong of shown** = (faces named wrong + names shown on backs + non-adjacent names shown
  on off-card positions) / (faces named right + those three).

  The share of counted tooltips that are wrong under this evaluation's target-sampling
  protocol.

The two rates do not share a denominator. A readable face that showed nothing is in the first
and not in the second.

**What wrong of shown does and does not measure.** Its events are a constructed mix: face
centers, back centers and sampled points, in the proportions the labels happen to hold. Add
more off-card points and the rate can change with the same model and the same frames. A real
viewer's pointer need not follow that mix, so the rate is not a measured frequency of wrong
tooltips in use. And a name shown on an off-card position next to the card it names is counted
as adjacent and left out of both rates, although a viewer may still see it as a wrong place.
So report the event composition (faces, backs, off-card positions) and the adjacent count
beside the rate, as `evaluate hover` does, and when you compare two datasets, keep the
sampling the same or show the kinds of event separately.

Wrong of shown is the number that matters most. A viewer cannot check a tooltip against
anything. If one tooltip in ten is wrong, a viewer learns to distrust all of them, however
many cards are named. The accept rule exists to trade some of the first rate for the second.

It also counts what no accuracy-on-crops figure can: a name shown where there is no card at
all. That needs real negatives in the labels.

### Calibrate the accept rule on real negatives, and not on the test

`tau` and `delta` decide when a match is shown. They belong to one model and one bank.

- Calibrate on **real footage**: crops cut by the real detector from real frames, including
  positions with no card and card backs. Do not set a threshold from clean card images or
  generated scenes alone.
- Calibrate on recordings that are **not** in the evaluation set. Use `--role train`, or a
  set of groups kept for the purpose.
- Then score the evaluation set once with the values you chose.

`cardvision calibrate` does it. It takes what `cardvision evaluate hover` takes, and its
default role is `train`; it refuses the evaluation rows unless you say otherwise:

```
cardvision calibrate --manifest CALIBRATION.manifest.jsonl --frames FRAMES \
    --detector detector.onnx --recognizer recognizer.onnx --bank bank.json --catalog catalog.json \
    --accept accept.json --max-wrong RATE --out calibration/
```

- Each frame is analyzed once. Every pair of a grid of `tau` and `delta` is then scored on
  the same looks, with the accept rule, the rotation retry and the hover rule applied as
  `evaluate hover` applies them. A pair's counts, rates and bootstrap intervals are the ones
  `evaluate hover` reports for those rows with that pair as its accept rule. A test holds the
  two to each other, pair by pair and event by event.
- `--max-wrong` is your limit on wrong of shown, as a fraction. There is no default: without
  it the report lists the pairs worth choosing between and recommends none. With it, the
  recommended pair is the one that names the most readable faces right among the pairs at or
  under the limit. Pairs that tie go to the lower wrong of shown, then the higher `tau`, then
  the higher `delta`.
- The recommendation is a measurement on the calibration rows, not a guarantee.
  `--max-wrong` constrains wrong of shown on the observed calibration data; it is not a
  population guarantee or a promise about future users. The report says how many events it
  rests on, and says that wrong of shown is weakly measured when the rows hold fewer than 30
  negative events (off-card positions and card backs). Thirty or more do not by themselves
  make it well measured: the number of shown events, the number of independent recording
  groups and the mix of targets matter as much.
- `--out` writes the grid as a table, the report, and the recommended pair as `accept.json`.
  It never replaces an `accept.json` that is already there.

To see which events a new rule changes, compare it with the current one event by event:

```
cardvision evaluate compare --role train --manifest CALIBRATION.manifest.jsonl --frames FRAMES \
    --detector detector.onnx --recognizer recognizer.onnx --bank bank.json --catalog catalog.json \
    --accept accept.json --other-accept calibration/accept.json
```

`cardvision evaluate crops --out DIR` also writes one line per labeled crop with its
similarity and margin, which shows where right and wrong matches separate.

The values in `games/riftbound/accept.json` belong to the released Riftbound models and their
bank. The adapt guide runs the command on a toy game
([measure.md](measure.md), tier 2).

### Report intervals by recording group

Events from one video are not independent: the same cards on the same table recur. An
interval that treats them as independent is too narrow.

Every rate from `cardvision evaluate` carries two intervals:

- **The group bootstrap.** Whole recording groups are resampled with replacement (10,000
  replicates by default), and the interval is the 2.5th to 97.5th percentile of the rate.
  With fewer than two groups there is no interval, and the report says so.
- **The exact bound: a reference.** A one-sided 95 % Clopper-Pearson bound. It assumes
  independent events and is labeled that way.

Group resampling accounts for dependence within recordings. With few groups or sparse errors,
its intervals can be unstable or misleadingly narrow, including 0–0 when no errors were
observed: when no group holds an error, no resample can hold one. Treat those results as
descriptive and collect more independent recordings before making a reliability claim. More
replicates do not help; more groups do. The report marks an interval "Read as descriptive" when
its two ends are equal or it rests on fewer than 5 groups (`FEW_GROUPS` in
`cardvision/evaluate/stats.py`, which says why 5). That mark is a floor: with more groups than
that, a percentile bootstrap still tends to run narrow.

Report per source type as well as overall. A rate over physical tables and digital clients
together hides the weaker one.

### Account for every row

A figure is only as honest as its denominator. Every row read ends in exactly one place:
**used**, **skipped** with a reason (another role, no labels for this measure), or
**unusable** with a reason (its frame is missing, or has another shape than the labeled
one). An unusable row is listed in the report with what it would have contributed. It is
never dropped silently.

### Tie the figure to the bytes

A figure belongs to one combination of detector, recognizer, bank, catalog and settings.
Score a **release document** where you can:

```
cardvision evaluate hover --manifest EVAL.manifest.jsonl --frames FRAMES --release release.json
```

The report then names the release id and the SHA-256 of every file and manifest. Without
`--release`, pass the four files and an accept file; the report hashes those.

### The other measures

| Command | Measures | Needs |
| --- | --- | --- |
| `cardvision evaluate hover` | What a pointer would show, per labeled position | Points or exhaustive boxes |
| `cardvision evaluate crops` | The recognizer alone, on crops cut from boxes a person drew: top-1, named right, named wrong, rejected | Exhaustive boxes |
| `cardvision evaluate detector` | The detector alone: recall at an overlap of 0.5 and of 0.3, read where false positives per frame are 0.5, 2.0 and 2.2 and at the detector's own threshold; and AP@0.5 | Exhaustive boxes |
| `cardvision evaluate compare` | Two configurations on the same hover events | Points or exhaustive boxes |
| `cardvision calibrate` | The hover measure under a grid of accept rules, to choose `tau` and `delta` | Points or exhaustive boxes, on rows outside the evaluation set |

The detector can only be scored on frames where every card has a box. A detection away from
every label is a false positive only when you know nothing was left unlabeled.

**How the detector's recall is measured.**

- A detection and a labeled card are compared as upright boxes: the detection's box against
  the upright box around the card's four corners (intersection over union).
- Detections and labels are matched one to one. Every pair that overlaps by 0.3 or more is
  ranked, highest overlap first, and a pair is taken when neither side is taken yet. Faces and
  backs are matched apart: a face detection never matches a back.
- A face is found when its pair overlaps by 0.5 or more. "Recall at 0.3" counts every matched
  face.
- An unmatched face detection is a false positive, unless half of it or more lies in a region
  marked ignore. One that overlaps a back's box by 0.3 or more is counted as a false positive
  on a back.
- There is no fixed minimum score. For each cap, the score threshold is found from all frames
  pooled: the lowest score such that it and every higher score keep false positives per frame
  at or below the cap. `--fp-caps` changes the caps. The cap holds for all frames together.
  The lines of one source type under a heading such as `falsePositivesPerFrame<=0.5` use that
  same threshold, so one source alone can show more than 0.5, and the report says so.

**AP@0.5 uses a different overlap.** It compares the detection's box with the card's outline
itself (the polygon of its four corners), and matches in score order. For an upright card
the two overlaps are equal. For a card at an angle the outline is the stricter one, so the
same detection can count for recall and not for AP. The report says which measure each
figure uses.

**The measures do not count the same faces.** On the same rows, `detector` reports *face
targets*, `crops` reports *crops* and `hover` reports *events*, and the three numbers can
differ. The detector measure reads boxes as the detector's trainer does: a face whose outline
does not have a whole card's proportions, because the frame cuts it off or the camera sees it
at a steep angle, is an ignore region there. It is still a crop, and a hover event. `crops`
leaves out a face too small to cut, and `hover` a center that lies inside another box. Each
report counts what it leaves out, and the detector's report says how many faces it set aside.
A generated scene can hold such faces too: its camera foreshortens some cards.

The module docstrings state each definition exactly: `cardvision/evaluate/events.py`,
`crops.py`, `detector.py`, `scoring.py`, `stats.py`.

### A first look on generated scenes

Before you have labeled footage, you can generate scenes from your card images
(`cardvision make-composites`). The generator knows where every card is and which card it is,
so `hover`, `crops` and `detector` can score such a folder directly:

```
cardvision evaluate hover --scenes SCENES --release release.json
```

The scoring is the same code as for a manifest. What differs is what the rows are, and the
report says so in its first lines.

- **It is not a measurement on real video.** Generated scenes are a harder and a different
  test from a real table. A figure on them says whether the tools run and roughly where the
  models stand. Do not report it as accuracy, and do not calibrate the accept rule on it.
- **Every scene is an exhaustively boxed frame.** The pointer positions are the centers of the
  cards' boxes, by the rule above for box centers. No position is made up.
- **A card that is mostly hidden, or tiny, is left out,** as an ignore region is in a manifest:
  it gives no hover event and no crop, and a detection on it is neither a card found nor a
  false positive. The limits are the generator's own: less than half of the card showing, or a
  short side under 20 px. The report counts these cards.
- **A card back is a back.** Distractors, dice, hands and broadcast graphics have no box. They
  are background, so there are no off-card positions among the hover events.
- **All scenes are one recording group,** so there is no group bootstrap interval. The exact
  bound is still printed, and it assumes independent events, which the cards of one scene are
  not.

`cardvision/evaluate/scenes.py` states the mapping exactly.

### Comparing two configurations

Use this after you extend a bank, retrain a model or change the accept rule. Two overall
rates can be equal while individual cards changed, so the comparison is event by event:

```
cardvision evaluate compare --manifest EVAL.manifest.jsonl --frames FRAMES \
    --release old/release.json --other-release new/release.json
```

or name only the part that changed (`--other-bank`, `--other-recognizer`, `--other-detector`,
`--other-catalog`, `--other-accept`).

The report has:

- a **transition table**: how many events went from right to right, right to nothing, nothing
  to wrong, and so on;
- the **regressions**, listed one by one: right → nothing, right → wrong, nothing → wrong;
- the **paired differences** of the two rates, candidate minus base, with an interval from
  resampling whole recording groups. Both configurations are scored on the same resampled
  groups in every replicate.

Decide beforehand what would make you keep the old configuration. Write the rule down before
you run the comparison. State it in intervals, not in single events: a rule that turns on one
tooltip more or less is decided by chance at small sample sizes. Part 2 has an example of
that mistake.

For a bank that only gained cards, run the structural check first:

```
cardvision check-refresh old/bank.json new/bank.json
```

It passes only when the old rows are in the same order and each is byte-identical, or was
embedded again because its image changed (both banks then record a different image for it). `compare` then
measures what the new rows changed.

### Keep one test you do not look at

A set you score every week becomes a set you tune to. Keep three kinds of recording group
apart: training groups; development groups, on which every choice is made (a starting point,
the accept rule, a bank refresh, regressions read one by one); and a final test, scored once
after the whole release is frozen and never inspected row by row.

If you publish a set, expect it to end up in someone's training data, yours included. Keeping
a set private reduces that direct contamination. Repeated adoption decisions can still overfit
it. Record each use; once its feedback guides changes, it serves as a regression benchmark,
and a new independent sample is needed for a fresh generalization claim.

## Part 2: how the released models were tested and chosen

### The private held-out test

The figures in the [model card](model-card.md), section "Private held-out test", come from a
private held-out test set. It was scored once. They are historical: they belong to release
`5cd3a4bf37154976`, whose bank is older than the one published here.

**Where it ran.** In a web browser, on the video platforms' own watch pages, with the product
running the release. The unit was the hover event: what was shown with the pointer resting on
a target. It did not run through `cardvision evaluate`.

**The protocol was fixed beforehand,** including the reasons a target may be left out and the
limit for the check on the capture tool.

**From labels to targets.**

1. Seeded points: 1,408 (16 per frame on 88 frames, from a fixed low-discrepancy sequence),
   each labeled with what lies under it.
2. The labeled face centers and the card backs found in a census of each frame were added,
   giving 3,013 planned targets (Rift Atlas 999, TCG Arena 628, physical 1,386). A seeded
   point that lands on a face is a face target, on a back a back target, elsewhere an
   off-card target.
3. **Eligibility.** Rules fixed before any read decided which planned targets were eligible.
   One of them: a card face is outside every rate when its readability label, made before
   any read, is "no", or when it has no readability label.
   The others:
   - **All sources.** A face target is the labeled center of a card face whose readability
     label is "yes" or "uncertain". Tooltips were taken as the release shows them: the
     hover rule `accepted-nms`, with the board classifier off.
   - **TCG Arena.** Rune strips that overlap are not hover targets.
   - **Small sources.** A source with fewer than 15 recording groups that could be played,
     or fewer than 150 face-center events, was to be reported without a verdict.
   - Rules on cards that are covered, sleeved, hidden by the client's interface or face down
     were written per source before the final labels. They belong to the private test set
     and are not published.
4. **Reach.** An automated capture tool opened each frame on its watch page and recorded what
   was shown at each eligible target.

**What "reached" means.** A target was reached when the tool could read what was shown
there. It was **not reached** when it lay under the player's controls, when an advert was
served, because of the video quality, or when a frame check failed. These reasons were
decided before any read. Between 16 % and 31 % of eligible targets were not reached,
depending on the source.

**The rates are on reached targets.** Nothing is known about the others. Targets under the
player's controls sit at the bottom of the picture, and the direction of any bias from
leaving them out cannot be told from the record.

**Sources.** Rift Atlas, TCG Arena, and physical play. Physical play is reported in two rows:
near-overhead cameras, to about 30°, which is what the release is meant for, and steeper
cameras, reported apart. Cards of the Radiance set are reported as a stratum inside the two
digital rows.

**The check on the capture tool, and its amendment.** The automated tool was checked against
a pass made by hand on 198 pairs. No pair disagreed on identity or status. But 36 pairs could
not be compared, 18.2 % against a limit of 5 % fixed beforehand, so the check tripped. The
rule was amended **after scoring**: 162/162 comparable outcomes agreed; 16 more pairs agreed on
non-reach status; 20 were excluded under the post-scoring amendment. The model card gives the
full accounting. The per-source figures never depended on that rule, and the amendment did not
change them.

**The intervals.** The protocol reported an exact binomial bound, which treats events as
independent. The group-clustered intervals and bounds beside it were **added after scoring**,
from the per-group tallies fixed at scoring. They are for reference; no verdict depended on
them.

**What is not published.** The test set, and the driver that automates the watch pages. The
driver needs the product's private build, breaks often, and automating those pages is against
the platforms' terms.

**The protocol, step by step.** "Blind" below means made without seeing what the product
showed.

1. **Sources and videos.** Three sources: two digital clients (Rift Atlas and TCG Arena) and
   physical play. Each was a set of recording groups, grouped by where a recording came from,
   and selected before any output existed. One video per group was chosen by a seeded order
   that was frozen beforehand. No video was switched for its content, its camera angle or any
   output.
2. **Frames.** 88 frame slots were planned: 50 for physical play, 23 for Rift Atlas and 15
   for TCG Arena. Each slot had five timestamps, drawn with a seed, uniform over 10 % to 90 %
   of the video, and listed in advance. A draw was used if a blind census found at least one
   readable card face in gameplay; otherwise the next draw was tried. A slot whose five draws
   all failed is missing. It was never replenished.
3. **Targets.** On each frame: the center of every labeled card face, every labeled card
   back, and 16 random points from a fixed low-discrepancy sequence. Every face was labeled
   blind for readability (yes, uncertain or no) before any read. A face labeled "no", or
   not labeled, is outside every rate. The identity labels were made blind too.
   Readability is answered before any model proposal is shown and means that the name is
   legible in the crop itself; a card the labeler knows from its art, the catalog or the
   state of the game is still named but marked not readable, so the frame overview and
   catalog shown beside the crop do not change the answer.
4. **Reads.** One attempt per target, in a seeded order. After a seek the tool waited 5
   seconds as a warm-up and paused the video. It placed the pointer at the target, mapped to
   the player's coordinates and rounded to the nearest CSS pixel. It recorded what was
   displayed 2.0 seconds later, with the pointer's actual position, the video time displayed,
   and a 64-bit difference hash of the frame displayed.
5. **Reached, or not.** A read counts when all four hold:
   - the displayed time is within 0.05 s of the labeled second;
   - the displayed frame's hash is within a Hamming distance of 6 of the labeled still's;
   - the mean absolute difference between the displayed frame and the labeled still,
     computed on a 480 × 270 gray downscale, is at most 4.0 (6.0 on Twitch, whose player
     re-encodes);
   - the pointer is within 1 CSS pixel of the prescribed point.

   Anything else is a capture mismatch and is excluded. A target that could not be attempted,
   for a reason decided before any read, is "could not reach" and is outside every rate. The
   reasons: it lay under the player's controls; an advert was showing, or no picture; the
   frame was not delivered at the wanted quality; the GPU was lost after two attempts. The
   reasons were recorded with their counts.
6. **The check on the capture tool.** A 25 % subsample of the target keys was listed and
   hashed before any observation was exposed. Those targets were read by hand from the same
   displayed state. Agreement is identity-sensitive: two reads that both show a name agree
   only when it is the same name. The rule that the check fails above 5 % of pairs that
   cannot be compared tripped, on capture losses. It was amended after scoring, as disclosed
   above and in the model card.
7. **Scoring.** One run of a frozen scorer, which was locked by hash before the test. Nothing
   was scored again.

The thresholds for passing or failing were product decisions. They are not part of this page
or of the model card.

**Video quality.** Reads were made at 1080p, or the highest quality the video offers,
recorded per video. A frame delivered below the wanted height is "could not reach", and was
never read at a lower quality. Videos whose maximum is 720p were read at 720p and are
reported as a stratum.

The runtime that test ran on is published in `browser/`: the pipeline, the rule for when a
frame is analyzed, the capture of a frame from a video element, and the rules for which result
may still be shown. Its demo page runs them on a video file from your own disk and shows the
card under the pointer. It is not the test harness: it does not score anything, and it does not
attach to a watch page.

### Scoring the browser runtime on a video file

`cardvision evaluate` analyzes frames in Python, as `cardvision fetch` read them from the
video. A viewer gets frames from a browser's video decoder, through a canvas. The scoring page
of `browser/` measures the runtime there, on video files from your own disk
([browser/README.md](../browser/README.md), "The scoring page").

**What it measures.** For each manifest row of the role you choose: what the browser runtime
would show at every labeled position, on the frame the browser decoded. The frame goes through
the runtime's own capture and its worker. Each row is judged alone, as `cardvision evaluate
hover` judges each frame alone.

**How a frame is chosen.** By the rule of `cardvision fetch`
([data/SCHEMA.md](../data/SCHEMA.md), "Which frame, when the row has a fingerprint"):

1. The page seeks the video to one second before the row's time and steps through the decoded
   frames to one second after it. A browser has no "next frame", so the page steps in time:
   never by more than 16 ms, so that no frame that is on screen for 16 ms or longer is passed
   over, whatever the frame rate, and also where it varies within a recording.
2. It computes the fingerprint of each frame and takes the nearest to the row's `frame_dhash`.
   A tie goes to the frame nearest the row's time, then to the earlier one.
3. It keeps that frame if the distance is at most 6 bits.

A row without a fingerprint takes the frame on screen at its time. A row whose window starts
after the end of the video file is recorded as failed, with the reason.

Some browsers report each frame's own time. Others report the time the page asked for. The
page finds out which, for each file. In the second kind it cannot tell one frame from the
next, so it fingerprints every step. The time it then records for a frame is a time at which
the frame was on screen, not the time the frame starts, and the row's line says so
(`exactTime` false).

**Whole videos, or sections of them.** `cardvision fetch --download` takes the few seconds
around each row and not the whole video. With `--keep-video DIR` it keeps those sections, and
the scoring page reads them:

```
cardvision fetch EVAL.manifest.jsonl --out FRAMES --download --keep-video CLIPS
```

- A kept file's name says where it starts in the video: `youtube-EXAMPLE0001+77.mp4` starts
  77 seconds in ([data/SCHEMA.md](../data/SCHEMA.md), "Kept video files").
- The page looks for a row at its time less that start. The frame is chosen by the same rule.
  The window of one second either side ends where the file starts and ends.
- A row's line in the events file names the file that served it and gives that start.
- The same files give `cardvision evaluate` its frames and the browser its video, so the two
  sides are not given different videos. Their figures can still differ, in three ways:
  - the decoder: a browser's decoder does not give the pixels `cardvision fetch` reads for the
    same frame;
  - the frame kept: where the picture hardly changes within the window, several frames match
    the fingerprint, and each side may keep another one of them;
  - the frame file: `cardvision fetch` saves each frame as JPEG unless you pass `--format png`,
    and the browser analyzes the decoded frame itself.
- A section is encoded again when it is cut out of the video, so its pixels are not exactly
  the platform's own. That holds for both sides alike.

If a whole-video file and sections are given for one video, the whole-video file serves all
its rows.

**What "unreachable" means.** No frame within a second of the row's time was within 6 bits of
its fingerprint. The row is recorded with the smallest distance seen. It is never scored on
another frame. A row with no video file, a row whose video has another shape than the labeled
frame, and a row whose frame could not be read are recorded too, each with its reason. A row
whose time lies in no section given for its video has no video file.

**How to score the file.** The page writes one JSON Lines file. The same command scores it:

```
cardvision evaluate hover --browser-events browser-events.jsonl \
    --manifest EVAL.manifest.jsonl --release release.json
```

- The command first checks what the file records about the choice of frames. It refuses a
  file in which:
  - a kept row's frame is further from the row's fingerprint than the limit the file's own
    header states, or further than this package's limit of 6 bits;
  - a kept row's frame lies after the window the header states, that is, more than one
    second after the row's time. Where the browser did not report frame times, a frame before
    the window is refused too. Where it did, a frame that starts before the window is
    accepted: the frame on screen when the window starts belongs to the window, however long
    it had been on screen;
  - the header states a window or a limit that is not this package's (one second, 6 bits).
- It warns, and goes on, when a manifest you give is not, byte for byte, a manifest the
  browser read. The header records each manifest's name and SHA-256, and the warning names
  the manifest and the hashes.
- It then checks that the file describes the rows being scored: the same role, one
  line per row, the same number of points and boxes, the same positions. It refuses a file
  that does not.
- It then applies the same event definitions, rates, bounds and group bootstrap as it does to
  frames it analyzes itself. No second scorer exists.
- The report says that the outcomes came from a browser run, and names the backend and the
  browser's user agent. Rows that were not kept are listed as rows not scored, with the reason.
- `--catalog catalog.json` can stand in for `--release`. The release id in the report is
  then the one the browser recorded, and is not checked.
- The header records the identity rule of the release the browser ran
  (`release.identity.level`). The command refuses a catalog that states another rule: the
  rule decided what was shown, and the same rule must decide what is right. A file written
  before the header recorded the rule is read as `name`, so it is refused under a catalog
  that states `printing`.

**What it is not.**

- It does not attach to a watch page. It reads video files from your disk.
- It is not the harness that ran the private test. That harness is not published.
- It is not a measurement of a live session. One frame per row is analyzed, the labeled one.
  When a frame is analyzed around pointer activity, and how long a result stays shown, are not
  measured.
- Its figures are not `cardvision evaluate`'s figures on the same rows. A browser's decoder
  does not give the pixels `cardvision fetch` reads from the same video. The fingerprint
  allows for that, which is what its 6-bit threshold is for. Even so, a few rows may be
  reachable on one side and not on the other, and a score close to `tau` can fall on either
  side. Compare a browser figure with a Python figure only on rows that both kept.
- Even on rows that both kept, the two may not have kept the same frame. On footage where the
  picture barely changes, several neighboring frames can be within the fingerprint limit, and
  the two sides may keep different ones of them. A card that is found on one frame and missed
  on the next can then make the figures differ.

### Scoring a challenger beside the released model

A new recognizer or detector is not adopted because it looks better. It is scored as a
**candidate** beside the model in use, on the same events, under rules written down before
the run. `cardvision evaluate compare` is the public form of that practice.

The rules have two kinds of clause:

- **accuracy clauses**: the candidate must be better by a stated amount, with its interval;
- **harm clauses**: the candidate must not show more names where nothing should be shown
  (off-card positions, card backs).

The rule for the released recognizer also looked at a second training seed of the candidate.

### How the released recognizer was chosen: an override, stated plainly

The released recognizer was a candidate under such a rule. The rule, as it was written:

> The candidate replaces the incumbent iff the earlier rule passes AND, on a private
> development set's physical center faces, (candidate - incumbent) correct-over-named is at
> least +3.0 points as a point estimate with the 95 % video-clustered lower bound above zero;
> the candidate's wrong-tooltip count exceeds the incumbent's by at most one on physical
> center faces, center negatives and random non-card points; the paired lower bounds on a
> second private set (digital client) and on the development set's TCG Arena rows are at
> least -1.0 points; and neither the candidate nor its pair seed shows a tooltip on any card
> back on either set.

The incumbent is the recognizer that was in use. The pair seed is a second training run of
the candidate's recipe with another seed. The rule builds on "the earlier rule", an adoption
rule written before it. It had three parts:

- (a) the paired difference in correct-over-named (candidate minus incumbent) has a 95 %
  video-clustered lower bound of at least −1 point on both private sets, and above zero on at
  least one;
- (b) on every reading (center faces, center negatives and random non-card points; strict and
  adjacency-aware) the candidate shows at most one more wrong tooltip than the incumbent;
- (c) the same paired bound holds for the candidate's pair seed.

- **It passed the accuracy clauses.** For example, +7.0 points on a private development set,
  with an interval of +4.0 to +11.1.
- **It failed three clauses.** On each of two sets it showed two more tooltips on off-card
  points than the recognizer it replaced. And a card back was named by the second training
  seed, which is not the released candidate.
- **Under the rule the answer was: do not adopt.**
- **The rule was overridden.** Two outside reviews found the three failed clauses
  mis-specified for their sample sizes: they turned on one or two events. (The reviews were
  by other AI models; [how-this-was-built.md](how-this-was-built.md) says what kind of
  review that was.) The override was made under conditions stated at the time: the artifacts
  frozen by hash, and a fresh, independently labeled screen before the private test. It
  accepted a stated cost.

The cost, as it was stated when the rule was overridden:

> The override accepted, on the development read, about two more off-card tooltips per 742
> random points than the incumbent and a wrong-of-shown rate of 10/601 (1.66 %) against the
> incumbent's 9/599 (1.50 %) on the digital set, in exchange for +7 to +9 points of
> correct-over-named on physical and Arena rows; the backs clause had been tripped by the
> pair seed, not the shipped seed.

An override of a rule fixed beforehand weakens what the rule was for. That is why it is
written here and in the model card, and not left for a reader to find. What followed it:

1. the fresh screen, labeled independently, was scored. Its labels are planned to be part
   of the public evaluation set;
2. the private held-out test was scored once, with the artifacts frozen.

The lesson taken: state adoption rules in intervals, compare against the model in use, and
do not let a single event decide.

### Python and the browser

`cardvision evaluate` runs in Python on the CPU. The private test ran in a browser. Both
follow the same steps, and the Python code states the precision of each step so that another
runtime can match it. Even so, floating-point results can differ in their last bits between
runtimes and between processor architectures. A score exactly at `tau` can fall either side.

The browser runtime in `browser/` and the Python package are compared by a test,
`tests/test_browser_agreement.py`, on generated frames of the toy game: the same boxes to
0.001 px, the same accept decision, look and name for every face, similarities to 0.00001, and
the same card under every position of a pointer grid, under each of the three hover
selections. That is agreement on stand-in models and generated frames. It is not a measurement
of the released models in a browser. The differences that remain are listed in
[how-it-works.md](how-it-works.md#where-it-runs).

- Figures from Python and figures from a browser are labeled as such and are not mixed. A
  report scored from a browser's outcomes says so under "What was scored".
- For a figure you mean to compare over time, score on one machine.
- The published scoring code gave identical results under NumPy 1.26 and 2.2.
