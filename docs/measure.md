<!-- SPDX-License-Identifier: Apache-2.0 -->

# Measure: numbers you can state

This is tier 2, **Measure**, of the [adapt guide](adapt-your-game.md): calibrate the accept
rule, score held-out recordings once, and keep the bank current when cards are added. Its toy
steps use the toy game's files of [Train](train.md#the-toy-game-these-steps-run-on), and some
use the toy release of Train, step 6. Every command was run on the toy game; the toy figures
mean nothing about a real game.

## Tier 2: Measure

**You need:** labeled frames from recordings that were never trained on. They can be
recordings of your own.

**Video:** [Measure it](https://www.youtube.com/watch?v=sznZuj5Z6Uw) runs this tier on the toy game's manifest.

**Time:** ongoing. Each command below runs in about a second on the toy data. On Riftbound,
`cardvision evaluate hover` scored the 53 frames of the public evaluation set with the
released weights in about 6 to 10 s on the CPU of the Apple M3 Max laptop, with the frames
already on disk.

**What you get:** two rates you can state, with intervals, and a routine for new cards.
[method.md](method.md) explains the measures. Read it before you quote a number.

### Three kinds of recording group

Decide which recording group is which before you look at any result, and keep them apart:

- **Training groups** train the models.
- **Development groups**, also called calibration groups, are never trained on, and every
  choice is made on them: which starting point to train from, the accept rule's thresholds
  (step 4), debugging a bank refresh (step 5) and reading regressions one by one. Look at them
  as often as you need. Whatever you chose on them, they flatter.
- **Final-test groups** are never trained on and never used for a choice. You score them
  once, after the whole release is frozen.

In a manifest, the final test is the `evaluation` role, which `cardvision assign-roles` deals.
Development groups can be a manifest of their own, or rows with the role `extra` that you
score with `--role extra`. `calibrate` reads the `train` rows unless you name another role:
for development, calibrate on groups kept out of training (`--role extra`, or a manifest of
their own), not on rows the models were trained on.

**The order for a real adaptation:**

1. **Develop.** Train, and compare your choices on development groups.
2. **Calibrate** the accept rule on development groups (step 4).
3. **Freeze the whole release:** models, bank, catalog, accept rule and settings, pinned in
   one release document (tier 1, step 6). Change nothing after this.
4. **Score the final test once,** with that release (`cardvision evaluate hover --release`).
5. **Report** those figures, with the release id, the number of recording groups and the
   rows not scored.

The toy steps below run in another order, so that each command is shown: step 3 scores the toy
set before step 4 calibrates. Read the scoring examples before step 4 as development runs. On
your game, the final-test score comes last.

**Reusing a final test.** Keeping the set private reduces direct contamination. Repeated
adoption decisions can still overfit it. Record each use; once its feedback guides changes, it
serves as a regression benchmark, and a new independent sample is needed for a fresh
generalization claim.

### Start here: a recording of your own

For a new game, the recordings you measure on are most likely your own: a phone on a stand
over your table, or a screen recording of a client. A manifest can name such a recording. Its
`platform` is `local` and its `video_id` is a name you choose
([data/SCHEMA.md](../data/SCHEMA.md), "Recordings of your own"). Nothing is uploaded and
nothing is downloaded.

The route: cut frames from the recording, label them, export a manifest, get the frames back
from the recording, score. The toy check runs it on the toy video of
[Train](train.md#the-toy-game-these-steps-run-on), `$WORK/toy/table.mp4`, under the name `table`.

**a. Cut frames from the recording, with their times.** From the repository's root (if you are
in `browser/`, run `cd ..` first), paste this into the terminal:

```
cardvision infer "$WORK/toy/table.mp4" --every 5 --frame-format png \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json" \
    --frames "$WORK/own/frames/table" --prefill-out "$WORK/own/times.jsonl" > /dev/null
```

You should see something like:

```
cardvision infer: 3 frame(s), 18 face(s), 3 back(s), 15 named
cardvision infer: boxes per frame, fewest / median / most: faces 6 / 6 / 6, backs 1 / 1 / 1
```

`--frame-format png` stores the frames without loss, so that each row of the manifest can
carry a fingerprint of its frame. `times.jsonl` holds each frame's time in the video. It
also holds the model's boxes, which this route does not use: labels you measure a model with
are made without any model's help.

Keep `--frame-format png` for a recording of your own. A frame's time is one at which the
frame is on screen, and that time finds the same frame again in the same file. Phones and
screen recorders often record at a variable frame rate. That changes nothing here: `infer`
and `fetch` read each frame's own timestamp, and `--every 5` is five seconds of video. The
fingerprint adds a check by content: `fetch` keeps a frame only if it looks like the one you
labeled, and still finds that picture in a copy of the recording that was cut or encoded
again.

**b. List the frames as a recording of your own.** The asset's id, `table`, becomes the
recording's name in the manifest.
Paste this into the terminal, from the repository's root:

```
python3 labeler/make_sample.py --out "$WORK/own/sample.json" \
    --asset table="$WORK/own/frames/table" --all --times "$WORK/own/times.jsonl" --local
```

You should see something like:

```
wrote $WORK/own/sample.json: 3 frames of 1 assets
```

**c. Label the frames.** Start the tool in the role `test`, which shows no model output, and
box and name every card on every frame.
Paste this into the terminal, from the repository's root:

```
python3 labeler/serve.py --mode box --role test --sample "$WORK/own/sample.json" \
    --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art"
```

You should see something like:

```
labeling tool: http://127.0.0.1:8090/  mode=box role=test
```

Here the server was started and its page loaded (HTTP 200). **The labeling itself was not
done here**: it is a person's work. For the toy check, a script of the test suite stands in
for the person. It labels the toy scene, which the test suite drew, and can label nothing
else.
Paste this into the terminal, from the repository's root:

```
python - "$WORK/own/sample.json" "$WORK/toy/catalog.json" <<'EOF'
import sys
sys.path.insert(0, "tests")
from support_labeling import label_toy_scene
print("labeled", label_toy_scene(*sys.argv[1:]), "frames of the toy scene")
EOF
```

You should see something like:

```
labeled 3 frames of the toy scene
```

**d. Export a manifest**, into a folder of its own. Paste this into the terminal, from the
repository's root:

```
python3 labeler/export.py manifest --labels-dir "$WORK/own/labels" --sample "$WORK/own/sample.json" \
    --credit "Your Name" --source-type physical/phone --out "$WORK/own/manifest/own.manifest.jsonl"
```

You should see something like:

```
wrote $WORK/own/manifest/own.manifest.jsonl: 3 rows, 21 boxes, 3 rows with a frame fingerprint
check it: cardvision validate-manifest $WORK/own/manifest/own.manifest.jsonl
  rows of your own recordings (platform local) cannot be offered: nobody else can obtain the video
```

`--source-type` says what kind of footage the recording is: `physical/phone` for a phone over a
table, `physical/webcam`, `physical/tournament`, or `digital` for a screen recording of a client
([data/SCHEMA.md](../data/SCHEMA.md), "Source types"). Without it the export stops with `no
source type`, unless you said so under About this recording in the tool.

**e. Check the manifest, and get its frames from the recording.** `--video-file` takes the
recording's name and the file.
Paste this into the terminal, from the repository's root:

```
cardvision validate-manifest "$WORK/own/manifest/own.manifest.jsonl" --catalog "$WORK/toy/catalog.json"
cardvision fetch "$WORK/own/manifest/own.manifest.jsonl" --out "$WORK/own/fetched" \
    --video-file table="$WORK/toy/table.mp4"
```

You should see something like:

```
valid: 3 row(s) in 1 file(s); card ids checked against the catalog
local table: 3 frame(s) from $WORK/toy/table.mp4
3 frame(s) written, 0 already present, 0 unusable, 0 failed, 0 without a video; index: $WORK/own/fetched/index.jsonl
```

Without `--video-file`, the rows are left without a frame and the command says to pass it.
`--download` never applies to a recording of your own.

**f. Score.** Exported rows have the role `extra`, so name that role. Paste this into the
terminal, from the repository's root:

```
cardvision evaluate hover --role extra \
    --manifest "$WORK/own/manifest/own.manifest.jsonl" --frames "$WORK/own/fetched" \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json" --out "$WORK/own/results"
```

Among the report's lines, you should see something like:

```
- role evaluated: `extra`
- rows read: 3
- rows used: 3
- rows skipped: none
- rows unusable (not scored): none

- events: 18 in 1 recording groups
- readable faces: right 15, wrong 0, nothing 0
- backs: name shown 0, nothing 3
- **named right**: 15 / 15 = 100.00 %; exact one-sided 95 % lower bound 81.90 % (assumes independent events); group bootstrap: no interval (fewer than two recording groups)
- **wrong of shown**: 0 / 15 = 0.00 %; exact one-sided 95 % upper bound 18.10 % (assumes independent events); group bootstrap: no interval (fewer than two recording groups)
```

These toy figures mean nothing: the stand-in detector returns the scene's own boxes whatever
the image, and the stand-in labels are the scene's own too. What the run shows is that a
recording of your own goes all the way from the file to a score.

For your game:

- **One recording is one recording group**, and one group gives no interval, as the report
  says. Measure on several recordings, made on different days or tables, and put each
  session in a group of its own (`--group` of the export).
- **Never measure on a recording you trained on.** With several recordings, deal the roles
  with the seeded shuffle of step 6 rather than choosing them.
- **Such a manifest stays with you.** Nobody else can obtain your recording, so its rows
  cannot be offered to this repository; `cardvision validate-manifest --contribution` refuses
  them. Rows of public videos can be offered.
- [labeler/README.md](../labeler/README.md), "A recording of your own", has the same route
  without the toy game.

### A toy set with every case

The steps below use a second toy set. It shows what one recording of your own cannot: rows
that cannot be scored, several recording groups, and videos on a platform. The test suite can
write it: a manifest of four rows about four made-up videos, in three recording groups, with
stand-in models whose answers are known.
Paste this into the terminal, from the repository's root:

```
python - "$WORK/toy" "$WORK/eval" <<'EOF'
import sys
from pathlib import Path
sys.path.insert(0, "tests")
from test_evaluate_cli import Evaluation
toy, out = sys.argv[1:]
Path(out).mkdir()
Evaluation(Path(out), f"{toy}/catalog.json", f"{toy}/art")
print("wrote a toy manifest and stand-in models in", out)
EOF
```

It writes `$WORK/eval/labels/toy.manifest.jsonl` and `$WORK/eval/models/`. (It also writes a
`frames` folder of its own, which the tests use. Below, the frames come from
`cardvision fetch`, as they would for real labels.)

### 1. Check the manifest

The toy manifest names a kind of footage of its own, `digital/toy-client`. A game lists such
kinds in a sources file.
Paste this into the terminal, from the repository's root:

```
echo '{"sourceTypes": ["digital/toy-client"]}' > "$WORK/eval/sources.json"
cardvision validate-manifest "$WORK/eval/labels/toy.manifest.jsonl" \
    --catalog "$WORK/toy/catalog.json" --sources "$WORK/eval/sources.json"
```

You should see something like:

```
valid: 4 row(s) in 1 file(s); card ids checked against the catalog
```

The validator reads files and nothing else. It refuses, among other things, a group with two
roles, a card id the catalog lacks, and any image in the manifest's folder.

### 2. Get the frames

A manifest row points at a frame of a video. `cardvision fetch` cuts the frames out of video
files you give it, one `--video-file ID=PATH` per video.
Paste this into the terminal, from the repository's root:

```
cardvision fetch "$WORK/eval/labels/toy.manifest.jsonl" --out "$WORK/frames" \
    --video-file VIDEOAAAAA1="$WORK/toy/table.mp4" \
    --video-file VIDEOBBBBB2="$WORK/toy/table.mp4" \
    --video-file VIDEODDDDD4="$WORK/toy/table.mp4"
```

You should see something like:

```
youtube VIDEOAAAAA1: 1 frame(s) from $WORK/toy/table.mp4
youtube VIDEOBBBBB2: 1 frame(s) from $WORK/toy/table.mp4
youtube VIDEOCCCCC3: no video file given; 1 row(s) left without a frame
youtube VIDEODDDDD4: 1 frame(s) from $WORK/toy/table.mp4
3 frame(s) written, 0 already present, 0 unusable, 0 failed, 1 without a video; index: $WORK/frames/index.jsonl
Rows without a video: give the file with --video-file ID=PATH, or pass --download.
```

The command **exits with code 1** here, on purpose: one row has no video, and a fetch that
left a row without a frame says so. (The toy video is the same scene for every id; the
made-up ids name no real video.)

`cardvision fetch --download` fetches the videos for you (**not run here**: it downloads from
a video platform). It needs the optional downloader, installed from the repository's root
with `python -m pip install -e ".[video,download]"`. Downloading is your own act. The
platform's terms apply to you, and they may restrict downloading and automated access. If
the platform refuses a download, the command stops at once and exits with code 3: wait
before you run it again. It stops with the same code when several downloads in a row fail.
[data/README.md](../data/README.md) says more.

### 3. Score labeled recordings (a development run)

On your game, a run like this belongs on development groups. The final test is scored once,
at the end ("Three kinds of recording group" above).

**What a pointer would show** at each labeled position. Paste this into the terminal, from the
repository's root:

```
cardvision evaluate hover --manifest "$WORK/eval/labels/toy.manifest.jsonl" --frames "$WORK/frames" \
    --detector "$WORK/eval/models/detector.onnx" --recognizer "$WORK/eval/models/recognizer.onnx" \
    --bank "$WORK/eval/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/eval/models/accept.json" --out "$WORK/results/hover"
```

The report is printed and written to `$WORK/results/hover/`. Among its main parts, you should
see something like this (from this run):

```
- role evaluated: `evaluation`
- rows read: 4
- rows used: 2
- rows skipped: role 1
- rows unusable (not scored): frame-missing 1

Rows not scored. They are in no numerator and no denominator below:

- youtube VIDEOCCCCC3 t=12.517 (physical/webcam, group g-three): frame-missing; would have given face 2

### Overall

- events: 15 in 2 recording groups
- readable faces: right 3, wrong 1, nothing 3
- backs: name shown 1, nothing 1
- off-card positions: name shown, not adjacent 1; name shown, adjacent 1; nothing 1
- **named right**: 3 / 7 = 42.86 %; exact one-sided 95 % lower bound 12.88 % (assumes independent events); group bootstrap 95 % interval 40.00 % to 50.00 % (2 groups, resamples whole recording groups). **Read as descriptive:** 2 recording groups, fewer than 5: the interval can be unstable or misleadingly narrow. Collect more independent recordings before making a reliability claim
- **wrong of shown**: 3 / 6 = 50.00 %; exact one-sided 95 % upper bound 84.68 % (assumes independent events); group bootstrap 95 % interval 0.00 % to 60.00 % (2 groups, resamples whole recording groups). **Read as descriptive:** 2 recording groups, fewer than 5: the interval can be unstable or misleadingly narrow. Collect more independent recordings before making a reliability claim
```

Read it in this order:

1. **The rows.** One row was not scored because its frame is missing. It is listed, with what
   it would have added. It is in no rate.
2. **Wrong of shown.** The share of counted tooltips that are wrong, under this
   evaluation's target-sampling protocol: the labeled faces, backs and off-card points, in the
   mix the labels hold ([method.md](method.md), "Two rates"). This is the number that matters
   most, and it is not a measured frequency of wrong tooltips for real viewers.
3. **Named right.** How often a readable card was named.
4. **The group bootstrap interval,** not the exact bound, which assumes independent events.
   The group bootstrap accounts for dependence within recordings, but two groups are far too
   few for it to say how reliable a rate is, and the report marks the interval to be read as
   descriptive. It does so under 5 groups, and whenever the interval's two ends are equal: 0
   to 0 when no group holds an error shows no spread, not a zero rate. Collect more independent
   recordings before you make a reliability claim.

The toy figures are staged by the test suite to hit every case. They mean nothing.

**The recognizer alone**, on crops cut from boxes a person drew. Paste this into the terminal,
from the repository's root:

```
cardvision evaluate crops --manifest "$WORK/eval/labels/toy.manifest.jsonl" --frames "$WORK/frames" \
    --detector "$WORK/eval/models/detector.onnx" --recognizer "$WORK/eval/models/recognizer.onnx" \
    --bank "$WORK/eval/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/eval/models/accept.json" --out "$WORK/results/crops"
```

You should see something like:

```
- crops: 5 in 1 recording groups
- **top-1 right**: 3 / 5 = 60.00 %; ...
- **named right**: 2 / 5 = 40.00 %; ...
- **named wrong**: 1 / 5 = 20.00 %; ...
- **rejected**: 2 / 5 = 40.00 %; ...
- **wrong of named**: 1 / 3 = 33.33 %; ...
```

**The detector alone**, on frames where every card has a box. Paste this into the terminal, from
the repository's root:

```
cardvision evaluate detector --manifest "$WORK/eval/labels/toy.manifest.jsonl" --frames "$WORK/frames" \
    --detector "$WORK/eval/models/detector.onnx" --recognizer "$WORK/eval/models/recognizer.onnx" \
    --bank "$WORK/eval/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/eval/models/accept.json" --out "$WORK/results/detector"
```

You should see something like:

```
- frames: 1; face targets 6, back targets 1, ignore regions 0, not-card boxes 1
- at `operatingPoint` (score threshold 0.3):
  - **recall**: 6 / 6 = 100.00 %; ...
  - false positives per frame: 0 / 1 = 0.000; ...
- **AP@0.5, face**: 1.0000 (6 targets, 7 detections: 6 true positives, 1 false positives, 0 left out)
- **AP@0.5, back**: 1.0000 (1 targets, 1 detections: 1 true positives, 0 false positives, 0 left out)
```

**A release as a whole.** When you have a release document, score that, so the report names
the release id and every file's hash. This scores the toy release from tier 1 (skip it if you
skipped tier 1).
Paste this into the terminal, from the repository's root:

```
cardvision evaluate hover --manifest "$WORK/eval/labels/toy.manifest.jsonl" --frames "$WORK/frames" \
    --release "$WORK/release/release.json"
```

You should see something like:

```
- **named right**: 0 / 7 = 0.00 %; ...
- **wrong of shown**: 0 / 0 = undefined; ...
```

Nothing named and nothing shown: the ten-step toy detector finds no cards.

### 4. Calibrate the accept rule

`tau` and `delta` decide when a match is shown. The values in `games/riftbound/accept.json`
belong to the released Riftbound models and their bank. **Your models and your bank need
their own.** `cardvision calibrate` scores a grid of pairs on labeled frames, and recommends
one under a limit that you set.

- Calibrate on real footage, with real negatives: positions with no card, and card backs.
- Calibrate on recordings that are **not** in your evaluation set. The command reads the
  manifest's `train` rows unless you name another role. It refuses the `evaluation` rows
  unless you add `--allow-evaluation-rows`, and then the report carries a warning.
- Then score the evaluation set once with the values you chose.

The toy set of step 3 has one training row, which shows nothing. The test suite can write a
toy calibration set: eight rows about eight made-up videos, six of them training rows, with
stand-in models of its own and frames on which the two thresholds matter.
Paste this into the terminal, from the repository's root:

```
python - "$WORK/toy" "$WORK/calibration" <<'EOF'
import sys
from pathlib import Path
sys.path.insert(0, "tests")
from support_calibration import Calibration
toy, out = sys.argv[1:]
Calibration(Path(out), f"{toy}/catalog.json", f"{toy}/art")
print("wrote a toy calibration set in", out)
EOF
```

It writes `$WORK/calibration/labels/toy-calibration.manifest.jsonl`, `$WORK/calibration/frames/`
and `$WORK/calibration/models/`.

**Look at the trade-off first.** The command takes what `cardvision evaluate hover` takes.
Paste this into the terminal, from the repository's root:

```
cardvision calibrate --manifest "$WORK/calibration/labels/toy-calibration.manifest.jsonl" \
    --frames "$WORK/calibration/frames" \
    --detector "$WORK/calibration/models/detector.onnx" --recognizer "$WORK/calibration/models/recognizer.onnx" \
    --bank "$WORK/calibration/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/calibration/models/accept.json"
```

It analyzes each frame once, and then scores every pair on the same looks without running a
model again. The default grid is 26 values of `tau` (0.40 to 0.90 in steps of 0.02) by 11 of
`delta` (0.00 to 0.10 in steps of 0.01). `--tau` and `--delta` take other values, as a list
or as a range `START:STOP:STEP`: `--tau 0.5,0.62,0.7`, `--delta 0:0.2:0.02`. The accept rule
you start from (`--accept`, or the release's) is added to the grid, and its `rotationRetry` is
kept. A pair's figures are the ones `cardvision evaluate hover` prints for the same rows with
that pair as its accept rule. Among the report's lines, you should see something like:

```
- tau: 26 values from 0.4 to 0.9
- delta: 11 values from 0 to 0.1
- pairs scored: 286, each with the turned looks retried. The pair the run started from, tau 0.62 and delta 0.05, is one of them
- every frame was analyzed once. Every pair was then scored on the same looks, with the accept rule and the hover rule that `cardvision evaluate hover` applies
- events: 48 in 3 recording groups: 36 readable faces and 12 negative events (5 card backs, 7 off-card positions)
- pairs that show no name at all: 0

**Warning:** wrong of shown is weakly measured: the rows hold 12 negative event(s) (card backs and positions with no card), fewer than 30. A name shown where there is no card can only be counted on such events.

### The pair the run started from

- tau 0.62, delta 0.05
- **named right**: 26 / 36 = 72.22 %; ...
- **wrong of shown**: 13 / 39 = 33.33 %; ...

### The trade-off

The pairs worth choosing between. Each row names more readable faces right than the row above it, at a higher wrong of shown. `--max-wrong` picks the last row that is at or under its limit. Where several pairs have a row's figures, the row shows the one with the highest tau, then the highest delta. `calibrate-grid.csv`, written with `--out`, has every pair.

| tau | delta | Named right | Wrong of shown |
| --- | --- | --- | --- |
| 0.9 | 0.07 | 21 / 36 = 58.33 % | 0 / 21 = 0.00 % |
| 0.9 | 0.05 | 23 / 36 = 63.89 % | 4 / 27 = 14.81 % |
| 0.9 | 0.04 | 27 / 36 = 75.00 % | 9 / 36 = 25.00 % |
| 0.78 | 0.04 | 30 / 36 = 83.33 % | 18 / 48 = 37.50 % |

## Recommendation

No pair is recommended, because no limit was given. The limit is yours to set: look at the trade-off above, decide the highest wrong of shown you accept, and run again with `--max-wrong RATE` (a fraction: 0.02 is 2 %). `accept.json` is written then, with `--out`.
```

There is no default limit. How many wrong names you accept is your decision, and it is easier
to make once you have seen what your footage allows.

**Then set your limit.** `--max-wrong 0.15` asks for the pair that names the most faces right
while at most 15 % of the names shown on these calibration rows are wrong. The limit constrains
the observed calibration data; it is not a guarantee for other footage or for future users.
Add `--out` to have it written.
Paste this into the terminal, from the repository's root:

```
cardvision calibrate --manifest "$WORK/calibration/labels/toy-calibration.manifest.jsonl" \
    --frames "$WORK/calibration/frames" \
    --detector "$WORK/calibration/models/detector.onnx" --recognizer "$WORK/calibration/models/recognizer.onnx" \
    --bank "$WORK/calibration/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/calibration/models/accept.json" \
    --max-wrong 0.15 --out "$WORK/results/calibrate"
```

You should see something like:

```
- limit: wrong of shown at or under 15.00 % (`--max-wrong 0.15`)
- **recommended**: tau 0.9, delta 0.05, the turned looks retried
- it rests on 48 events in 3 recording groups: 36 readable faces and 12 negative events
- It is the best pair on these rows, and that is a measurement, not a guarantee. Other footage will give other figures, and with few events one event more or less changes which pair is picked.
- These rows chose the pair, so their figures flatter it. Score your evaluation rows once with it, and report those figures.

### Overall, with the recommended pair

- events: 48 in 3 recording groups
- readable faces: right 23, wrong 0, nothing 13
- backs: name shown 0, nothing 5
- off-card positions: name shown, not adjacent 4; name shown, adjacent 0; nothing 3
- **named right**: 23 / 36 = 63.89 %; ...
- **wrong of shown**: 4 / 27 = 14.81 %; ...
```

On standard error it says what it did and what it wrote. You should see something like the
lines below. In a terminal they mix with the report: the two `analyzing` / `analyzed` lines
come before the report, and the warning, the `wrote` lines and the `recommended` line after
it. They are shown here as one block.

```
cardvision calibrate: analyzing the frames of 6 row(s) of role train, each once
cardvision calibrate: 6 frame(s) analyzed, 0 row(s) not scored; scoring 286 pairs on them
cardvision calibrate: warning: wrong of shown is weakly measured: the rows hold 12 negative event(s) (card backs and positions with no card), fewer than 30. A name shown where there is no card can only be counted on such events
cardvision calibrate: wrote $WORK/results/calibrate/calibrate.json
cardvision calibrate: wrote $WORK/results/calibrate/calibrate.md
cardvision calibrate: wrote $WORK/results/calibrate/calibrate-grid.csv
cardvision calibrate: wrote $WORK/results/calibrate/accept.json
cardvision calibrate: recommended: tau 0.9, delta 0.05
```

- `accept.json` is the recommended pair in the format `--accept` reads: here `tau` 0.9,
  `delta` 0.05 and `rotationRetry` true.
- `calibrate-grid.csv` has one line per pair, with every count. Open it in a spreadsheet when
  the trade-off table is not enough.
- **The command never replaces an `accept.json`.** Give `--out` a folder that holds none,
  look at the result, and copy the file to where your game keeps its own.
- When no pair is at or under your limit, the report says so and gives the lowest wrong of
  shown that any pair reaches. Nothing is recommended, and the command exits with code 1.

Read the warnings as they are meant. The pair is the best one on these rows, and no more
than that. Twelve negative events, as here, say little about names shown where there is no
card: label more positions with no card, and more card backs. Thirty or more do not by
themselves make wrong of shown well measured either: the number of shown events, the number of
independent recording groups and the mix of targets matter as much.

**Score the evaluation set once**, with the rule you chose. On your game this is the final
test: freeze the whole release beforehand (tier 1, step 6), and score it once. The toy
calibration set has two rows with the role `evaluation`.
Paste this into the terminal, from the repository's root:

```
cardvision evaluate hover --manifest "$WORK/calibration/labels/toy-calibration.manifest.jsonl" \
    --frames "$WORK/calibration/frames" \
    --detector "$WORK/calibration/models/detector.onnx" --recognizer "$WORK/calibration/models/recognizer.onnx" \
    --bank "$WORK/calibration/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/results/calibrate/accept.json"
```

You should see something like:

```
- role evaluated: `evaluation`
- rows read: 8
- rows used: 2
- rows skipped: role 6
- rows unusable (not scored): none

- events: 16 in 2 recording groups
- readable faces: right 8, wrong 0, nothing 4
- backs: name shown 0, nothing 2
- off-card positions: name shown, not adjacent 1; name shown, adjacent 0; nothing 1
- **named right**: 8 / 12 = 66.67 %; ...
- **wrong of shown**: 1 / 9 = 11.11 %; ...
```

These are the figures to report, not the ones the calibration printed.

**To see which events a new rule changes**, compare it with the old one, event by event.
The toy command scores the toy `evaluation` rows only to show it; on your game, point it at
development rows (`--role extra`, or a manifest of their own).
Paste this into the terminal, from the repository's root:

```
cardvision evaluate compare --manifest "$WORK/calibration/labels/toy-calibration.manifest.jsonl" \
    --frames "$WORK/calibration/frames" \
    --detector "$WORK/calibration/models/detector.onnx" --recognizer "$WORK/calibration/models/recognizer.onnx" \
    --bank "$WORK/calibration/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/calibration/models/accept.json" --other-accept "$WORK/results/calibrate/accept.json"
```

You should see something like:

```
- events compared: 16

| Transition (base -> candidate) | Events |
| --- | --- |
| nothing -> nothing | 3 |
| right -> nothing | 2 |
| right -> right | 7 |
| wrong -> nothing | 2 |
| wrong -> right | 1 |
| wrong -> wrong | 1 |

- **regressions**: 2
```

The toy figures mean nothing: the set is staged by the test suite so that the thresholds
matter. `cardvision evaluate crops --out DIR` also writes each crop's similarity and margin
to a listing, which shows where right and wrong matches part.

### 5. Refresh the bank when cards are added

New cards need no retraining. Add them to the catalog, and **extend** the bank: the new
cards are appended, and an old row is kept byte for byte unless its card's image has changed.

For the toy check, make an "old" catalog without two of the cards, and a bank for it.
Paste this into the terminal, from the repository's root:

```
python - "$WORK/toy/catalog.json" "$WORK/refresh/catalog-v1.json" <<'EOF'
import json, sys
from pathlib import Path
doc = json.loads(Path(sys.argv[1]).read_text())
doc["cards"] = [card for card in doc["cards"] if card["id"] not in ("TOY-018", "TOY-P01")]
Path(sys.argv[2]).parent.mkdir(parents=True, exist_ok=True)
Path(sys.argv[2]).write_text(json.dumps(doc, indent=1))
print(len(doc["cards"]), "cards in the old catalog")
EOF
cardvision build-bank --catalog "$WORK/refresh/catalog-v1.json" --art "$WORK/toy/art" \
    --recognizer "$WORK/toy/recognizer.onnx" --out "$WORK/refresh/bank-v1.json"
```

Now the refresh itself: the full catalog, with `--base` naming the old bank.
Paste this into the terminal, from the repository's root:

```
cardvision build-bank --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" \
    --recognizer "$WORK/toy/recognizer.onnx" --base "$WORK/refresh/bank-v1.json" \
    --out "$WORK/refresh/bank-v2.json"
cardvision check-refresh "$WORK/refresh/bank-v1.json" "$WORK/refresh/bank-v2.json"
```

You should see something like:

```
  2 / 2 cards
bank: $WORK/refresh/bank-v2.json (20 rows of 128 values; 2 embedded, 18 kept from the base bank)
identity groups: $WORK/refresh/bank-v2.identity-groups.json
ok: 18 shared rows, in the same order: 18 byte-identical, 0 re-embedded (image changed); 2 card id(s) added; identity groups only grew
```

**When a card's image has changed.** For each old row, `build-bank --base` compares the row's
`artV` with the hash of the image now in the art folder. A row whose image is the same is
kept byte for byte. A row whose image differs is computed again from the current image, in
the same position, and the command lists it under "re-embedded, image changed" with both
hashes. `check-refresh` accepts such a row, because both banks record a different image for
it, and lists it too. A row that changed for any other reason is an error that names the row.

**A row can lag behind its card's image** in two cases. A bank written before rows recorded
their image has no `artV`, so the refresh cannot tell: it keeps those rows and lists them as
"image not recorded, reused". Pass `--reembed-unrecorded` to compute them again;
`check-refresh` then refuses any of them whose vector changed, and names it. And a row is
kept, and listed, when its image is not in the art folder to compare. To see where a bank
stands against the images you have now.
Paste this into the terminal, from the repository's root:

```
cardvision check-bank-art "$WORK/refresh/bank-v2.json" --catalog "$WORK/toy/catalog.json" \
    --art "$WORK/toy/art"
```

You should see something like:

```
bank: $WORK/refresh/bank-v2.json (20 rows; 20 record their source image)
  20 embedded from the image now under --art
  0 embedded from a different image
  0 with no recorded image
  0 with no image under --art
```

Rows computed from a different image are listed with both hashes. The command only reports:
it changes nothing, and it exits with 0 whatever it finds. It fails only when the bank or the
catalog cannot be read.

A new card can still change a decision on an old one, by coming close to it, and so can a row
that was computed again. So compare the two banks on your development events, not on a final
test. The toy command scores the toy `evaluation` rows only to show it; on your game, point it
at development rows (`--role extra`, or a manifest of their own).
Paste this into the terminal, from the repository's root:

```
cardvision evaluate compare --manifest "$WORK/eval/labels/toy.manifest.jsonl" --frames "$WORK/frames" \
    --detector "$WORK/eval/models/detector.onnx" --recognizer "$WORK/eval/models/recognizer.onnx" \
    --bank "$WORK/refresh/bank-v1.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/eval/models/accept.json" --other-bank "$WORK/refresh/bank-v2.json"
```

You should see something like:

```
- events compared: 12

| Transition (base -> candidate) | Events |
| --- | --- |
| nothing -> nothing | 3 |
| right -> right | 6 |
| wrong -> wrong | 3 |

- **regressions**: 0
```

Regressions are listed one by one when there are any: right → nothing, right → wrong,
nothing → wrong. Decide before you look what number of them you will accept. Read them one by
one on development groups, never on a final test: a test read row by row stops being a test.

Then build and verify a new release with the new bank (tier 1, step 6).

### 6. Give new recordings a role by a seeded shuffle

Nobody chooses which recordings are held out. New labels arrive as an offer (`role` is
`extra`), and a seeded shuffle of whole recording groups deals the roles.

For the toy check, turn the toy manifest into an offer, check it as one, and deal roles.
Paste this into the terminal, from the repository's root:

```
mkdir -p "$WORK/offer"
sed 's/"role":"[a-z]*"/"role":"extra"/' "$WORK/eval/labels/toy.manifest.jsonl" > "$WORK/offer/toy.manifest.jsonl"
cardvision validate-manifest "$WORK/offer/toy.manifest.jsonl" \
    --catalog "$WORK/toy/catalog.json" --sources "$WORK/eval/sources.json" --contribution
cardvision assign-roles "$WORK/offer/toy.manifest.jsonl" --seed 20261010 --evaluation-share 0.5 \
    --out "$WORK/assigned/toy.manifest.jsonl"
```

You should see something like:

```
valid: 4 row(s) in 1 file(s); card ids checked against the catalog
seed 20261010; evaluation share 0.5
  g-four  train  (assigned)
  g-one  evaluation  (assigned)
  g-three  train  (assigned)
  g-two  evaluation  (assigned)
digital/toy-client: evaluation 1, train 1
physical/webcam: evaluation 1, train 1
wrote 4 row(s) to $WORK/assigned/toy.manifest.jsonl
```

- Write the seed down with the result.
- The command creates the output's folder. It refuses to replace an existing file unless
  you pass `--overwrite`.
- `--published FILE` names a manifest whose groups already have roles. Those groups keep
  them, and count towards the shares.

### 7. Optional: check the candidates with local features

The geometric stage looks again at the recognizer's best few cards by matching keypoints of
the crop with keypoints of each card's image ([how-it-works.md](how-it-works.md), section 10).
It is optional: it needs the `geometric` extra, it is not part of a release, and without
`--geometric` nothing changes. The browser runtime has a port of one configuration of it, which
runs only with WebGPU (same section). On the One Piece Card Game it helped on real footage
([Measured on another game](adapt-your-game.md#measured-on-another-game-the-one-piece-card-game)). Try it when
your misses are near misses: the right card among the recognizer's first few but not first
(use it as a **re-ranker**, `"reorder": true`), or first but under `tau` (an **accept booster**,
`"reorder": false`).
Paste this into the terminal, from the repository's root:

```
python -m pip install -e ".[geometric]"
echo '{"candidates": {"embeddingTopK": 3}, "fusion": {"baseline": "median"}}' > "$WORK/toy/geometric.json"
cardvision build-features --config "$WORK/toy/geometric.json" --catalog "$WORK/toy/catalog.json" \
    --art "$WORK/toy/art" --bank "$WORK/toy/bank.json" --pin
cardvision infer "$WORK/toy/table.png" --detector "$WORK/toy/detector.onnx" \
    --recognizer "$WORK/toy/recognizer.onnx" --bank "$WORK/toy/bank.json" \
    --catalog "$WORK/toy/catalog.json" --accept "$WORK/toy/accept.json" \
    --geometric "$WORK/toy/geometric.json"
```

You should see something like:

```
  19 / 19 cards
index: $WORK/toy/bank.features.json (19 cards, 5402 keypoints, 0.3 MB)
sha256: <64 hex digits>
pinned in $WORK/toy/geometric.json
...
cardvision infer: 1 frame(s), 6 face(s), 1 back(s), 4 named
```

Four named where the toy script named three: the staged bank gives two cards the same row, so the
recognizer alone cannot tell them apart, and the keypoints can. Each face now carries a
`geometric` field with what the recognizer would have said and every candidate's inliers. The
counts of keypoints may differ slightly with another OpenCV version.

For your game, build the index once beside your bank (about 15 KB per card with the default
settings) and choose the settings on data you do not test on. Score it against the same
configuration without it, under a rule written down first.
Paste this into the terminal, from the repository's root:

```
cardvision evaluate compare --release release.json --manifest FILE --frames DIR \
    --other-geometric geometric.json
```

**The stage changes what the accept rule means.** `tau` and `delta` were calibrated on cosines
and a fused score is not one: with the stage on, `minInliers` and `weight` decide in practice
what is named. Choose them on data you do not test on, under a bar on wrong names you write
down first and measure on real negatives (off-card positions, card backs), and check with
`evaluate compare` as above. `cardvision calibrate` does not cover the stage.

**Keep it where it helps.** If it helps one kind of footage and not another, gate it:
`"gate": {"sources": ["physical/*"]}` runs it only on rows of those source types, and
`"gate": {"belowAccept": true}` only on crops the embedding did not already accept. Both are
off by default.

The index serves the bank it was built beside (or another bank of the same images). With a new
bank, build the index again; in `evaluate compare`, a candidate with another bank or release
needs `--other-geometric FILE` (or `--other-geometric none`).

The stage costs time on the CPU (tens of milliseconds a crop with the default `homography`
model, a few with `affine`) and an index file. The vote (`voteTopN`) is the expensive option:
it compares each crop keypoint with every keypoint of the catalog, about a quarter of a second
of wall time a crop on several cores for a catalog of 5,000 cards ([how-it-works.md](how-it-works.md),
section 10). If the catalog's images carry a watermark that real cards do not, keep keypoints
out of it with `features.mask`, and look at how a physical recording fares separately.

### 8. Keep going

- Keep a final test that you score once, after the release is frozen, and never tune on.
  Record each use. Once its results have guided a change, it is a regression benchmark, and a
  fresh claim about generalization needs a new independent sample.
- When you change a model, the bank or the accept rule, run `cardvision evaluate compare`
  before you switch, under a rule you wrote down first ([method.md](method.md)).
- State what your numbers are on: which release, which manifest, how many recording groups.
