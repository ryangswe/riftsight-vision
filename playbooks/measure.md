<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tier 2: Measure

This playbook covers tier 2: measuring the models and keeping them current as cards are added. It assumes set-up done: [setup.md](setup.md). The rules in [AGENTS.md](../AGENTS.md) apply to every step here.

Goal: numbers the person can state, and a routine for new cards. Read
[docs/method.md](../docs/method.md) before reporting any figure.

**Three kinds of recording group.** Settle with the person which group is which before any
result is looked at:

- **training groups** train the models;
- **development (calibration) groups** are never trained on; every choice is made on them:
  the starting point to train from, the accept rule's thresholds (2.5), debugging a bank
  refresh (2.6) and regressions read one by one;
- **final-test groups** (the `evaluation` role) are never trained on and never used for a
  choice.

**Order for the person's game:** develop → calibrate on development groups → freeze the whole
release (1.6 in [train.md](train.md)) → score the final test once → report. The toy steps below show the commands in
another order; the scoring in 2.4 is a development run. Never score the final test before the
release is frozen, and never score it again to choose between options. Once its results have
guided a change, it is a regression benchmark: say so when you report it.

## 2.0 A recording of the person's own

For a new game, the recordings to measure on are most likely the person's own (a phone or
screen recording). A manifest names one with `platform` `local` and a `video_id` that is a
name they choose (`data/SCHEMA.md`, "Recordings of your own"). This step runs the whole
route on the toy video of step 0.4 in [try-my-game.md](try-my-game.md) under the name `table`.

```
cardvision infer "$WORK/toy/table.mp4" --every 5 --frame-format png \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json" \
    --frames "$WORK/own/frames/table" --prefill-out "$WORK/own/times.jsonl" > /dev/null
python3 labeler/make_sample.py --out "$WORK/own/sample.json" \
    --asset table="$WORK/own/frames/table" --all --times "$WORK/own/times.jsonl" --local
```

- **Expect:** `cardvision infer: 3 frame(s), 18 face(s), 3 back(s), 15 named`, then `wrote
  .../own/sample.json: 3 frames of 1 assets`.
- **Know:** `--local` records `"platform": "local"` and the asset id as the video id. The
  asset id must start with a letter or a digit. `--frame-format png` lets each row carry a
  fingerprint of its frame.
- **Know:** a phone or a screen recorder often writes a file of variable frame rate. `infer`
  and `fetch` read each frame's own timestamp, so in such a file too `--every 5` is five
  seconds of video and a row's time finds its frame again. Keep `--frame-format png` all the
  same: with the fingerprint, `fetch` also checks the frame by its content.

Labeling is a person's work. For their game, give them this command and
`labeler/README.md`, and wait:

```
python3 labeler/serve.py --mode box --role test --sample "$WORK/own/sample.json" \
    --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art"
```

- **Expect:** `labeling tool: http://127.0.0.1:8090/  mode=box role=test`.

**For the toy check only**, a script of the test suite stands in for the person. It labels
the toy scene and nothing else. Never use it, or anything like it, on real frames:

```
python - "$WORK/own/sample.json" "$WORK/toy/catalog.json" <<'EOF'
import sys
sys.path.insert(0, "tests")
from support_labeling import label_toy_scene
print("labeled", label_toy_scene(*sys.argv[1:]), "frames of the toy scene")
EOF
python3 labeler/export.py manifest --labels-dir "$WORK/own/labels" --sample "$WORK/own/sample.json" \
    --credit "Your Name" --source-type physical/phone --out "$WORK/own/manifest/own.manifest.jsonl"
cardvision validate-manifest "$WORK/own/manifest/own.manifest.jsonl" --catalog "$WORK/toy/catalog.json"
cardvision fetch "$WORK/own/manifest/own.manifest.jsonl" --out "$WORK/own/fetched" \
    --video-file table="$WORK/toy/table.mp4"
cardvision evaluate hover --role extra \
    --manifest "$WORK/own/manifest/own.manifest.jsonl" --frames "$WORK/own/fetched" \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json" --out "$WORK/own/results"
```

- **Expect:** `labeled 3 frames of the toy scene`; `wrote .../own.manifest.jsonl: 3 rows, 21
  boxes, 3 rows with a frame fingerprint`; `valid: 3 row(s) in 1 file(s); card ids checked
  against the catalog`; `3 frame(s) written, 0 already present, 0 unusable, 0 failed, 0
  without a video` with exit code 0; and from `evaluate`, `rows used: 3`, `**named right**: 15
  / 15 = 100.00 %` and `**wrong of shown**: 0 / 15 = 0.00 %`, each with `group bootstrap: no
  interval (fewer than two recording groups)`.
- **Know:** these toy figures mean nothing. The stand-in detector returns the scene's boxes
  whatever the image, and the stand-in labels are the scene's own.
- **Know:** `--source-type` says what kind of footage the recording is: `physical/phone` for a
  phone over a table, `digital` for a screen recording of a client (`data/SCHEMA.md`, "Source
  types"). Without it the export stops with `no source type`, unless the person tagged the
  recording in the tool.
- **Know:** exported rows have the role `extra`, hence `--role extra`. One recording is one
  recording group, and one group gives no interval: say so, and ask for several recordings.
- **If `fetch` leaves the rows without a frame** and says `pass --video-file table=PATH`: the
  file was not given under the recording's name. `--download` never applies to a `local` row.
- **Rule:** rows of a recording of the person's own stay with the person. They cannot be
  offered to this repository (`validate-manifest --contribution` refuses them), because
  nobody else can obtain the video.

## 2.1 A toy labeled set

Skip this when the person has their own manifest and frames. This second toy set has what
one recording cannot show: rows that cannot be scored, several recording groups, and videos
on a platform.

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

- **Expect:** `$WORK/eval/labels/toy.manifest.jsonl` and `$WORK/eval/models/` exist.

## 2.2 Validate the manifest

```
echo '{"sourceTypes": ["digital/toy-client"]}' > "$WORK/eval/sources.json"
cardvision validate-manifest "$WORK/eval/labels/toy.manifest.jsonl" \
    --catalog "$WORK/toy/catalog.json" --sources "$WORK/eval/sources.json"
```

- **Expect:** `valid: 4 row(s) in 1 file(s); card ids checked against the catalog`.
- **If it fails:** each line names the file, the row and the rule. `data/SCHEMA.md` lists the
  rules. Fix the labels at their source; do not hand-edit rows to make them pass.

## 2.3 Frames

```
cardvision fetch "$WORK/eval/labels/toy.manifest.jsonl" --out "$WORK/frames" \
    --video-file VIDEOAAAAA1="$WORK/toy/table.mp4" \
    --video-file VIDEOBBBBB2="$WORK/toy/table.mp4" \
    --video-file VIDEODDDDD4="$WORK/toy/table.mp4"
```

- **Expect:** `3 frame(s) written, 0 already present, 0 unusable, 0 failed, 1 without a
  video`, and **exit code 1**. The toy manifest has one row with no video on purpose.
- **For real labels:** exit code 0 means every row has a frame. Exit code 1 means some do
  not; report which. Use video files the person already has. Do not pass `--download` unless
  they ask.
- **If `fetch --download` exits with code 3:** the run stopped early and rows were not tried.
  The platform refused a download (a rate limit or a bot check), or several downloads in a
  row failed. Do not run it again on your own. Show the person the
  message and wait for them: more requests make a refusal last longer.

## 2.4 Score (a development run)

```
cardvision evaluate hover --manifest "$WORK/eval/labels/toy.manifest.jsonl" --frames "$WORK/frames" \
    --detector "$WORK/eval/models/detector.onnx" --recognizer "$WORK/eval/models/recognizer.onnx" \
    --bank "$WORK/eval/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/eval/models/accept.json" --out "$WORK/results/hover"
```

- **Expect, on the toy set:** `rows used: 2`, `rows unusable (not scored): frame-missing 1`,
  `**named right**: 3 / 7 = 42.86 %` and `**wrong of shown**: 3 / 6 = 50.00 %`. The report is
  also in `$WORK/results/hover/evaluate-hover.md`.
- **When you report a result,** say whether it is a development run or the final test of a
  frozen release, and give: both rates with the group bootstrap interval, the number of
  recording groups, the rows not scored, and the hashes the report prints. Never give "named
  right" without "wrong of shown".
- **Pass on "Read as descriptive".** The report marks an interval so when it rests on fewer than
  5 recording groups or its two ends are equal (0 to 0 when no group holds an error). Such an
  interval is no reliability claim: say so, and do not present it as the rate's uncertainty.
  On the toy set both intervals carry the mark (2 groups).

The same arguments with `crops` or `detector` in place of `hover` score the recognizer alone
and the detector alone:

```
cardvision evaluate crops --manifest "$WORK/eval/labels/toy.manifest.jsonl" --frames "$WORK/frames" \
    --detector "$WORK/eval/models/detector.onnx" --recognizer "$WORK/eval/models/recognizer.onnx" \
    --bank "$WORK/eval/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/eval/models/accept.json" --out "$WORK/results/crops"
cardvision evaluate detector --manifest "$WORK/eval/labels/toy.manifest.jsonl" --frames "$WORK/frames" \
    --detector "$WORK/eval/models/detector.onnx" --recognizer "$WORK/eval/models/recognizer.onnx" \
    --bank "$WORK/eval/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/eval/models/accept.json" --out "$WORK/results/detector"
```

- **Expect, on the toy set:** `**top-1 right**: 3 / 5 = 60.00 %` from `crops`, and
  `**AP@0.5, face**: 1.0000` from `detector`.

With a release document, score that (this needs tier 1's toy release ([train.md](train.md))):

```
cardvision evaluate hover --manifest "$WORK/eval/labels/toy.manifest.jsonl" --frames "$WORK/frames" \
    --release "$WORK/release/release.json"
```

- **Expect, on the toy release:** `**named right**: 0 / 7 = 0.00 %`.

## 2.5 Calibrate the accept rule

`cardvision calibrate` scores a grid of `tau` and `delta` on labeled frames and recommends a
pair under a limit the person sets. Three rules, before any command:

- Calibrate on real footage with real negatives: positions with no card, and card backs.
- Never calibrate on the rows you report. The command reads the `train` rows by default and
  refuses `--role evaluation`. Do not add `--allow-evaluation-rows` unless the person asks.
- Afterwards, freeze the release and score the evaluation rows (the final test) once with
  the chosen rule, and report those figures.

A toy calibration set, with stand-in models of its own (the toy set of 2.1 has one training
row):

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
cardvision calibrate --manifest "$WORK/calibration/labels/toy-calibration.manifest.jsonl" \
    --frames "$WORK/calibration/frames" \
    --detector "$WORK/calibration/models/detector.onnx" --recognizer "$WORK/calibration/models/recognizer.onnx" \
    --bank "$WORK/calibration/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/calibration/models/accept.json"
```

- **Expect, on the toy set:** `- pairs scored: 286`, `- events: 48 in 3 recording groups: 36
  readable faces and 12 negative events (5 card backs, 7 off-card positions)`, a trade-off
  table of four rows from `| 0.9 | 0.07 | 21 / 36 = 58.33 % | 0 / 21 = 0.00 % |` to `| 0.78 |
  0.04 | 30 / 36 = 83.33 % | 18 / 48 = 37.50 % |`, and `No pair is recommended, because no
  limit was given.` Exit code 0.
- **Know:** each frame is analyzed once and every pair is scored on the same looks. A pair's
  figures are the ones `cardvision evaluate hover` gives for the same rows with that pair as
  its accept rule. The default grid is `--tau 0.40:0.90:0.02` by `--delta 0.00:0.10:0.01`; the
  rule the run starts from is added to it, and its `rotationRetry` is kept.
- **For the person's game:** show them the trade-off table and ask for their limit. There is
  no default limit, and you do not choose one for them.

With the person's limit (0.15 stands in for it here):

```
cardvision calibrate --manifest "$WORK/calibration/labels/toy-calibration.manifest.jsonl" \
    --frames "$WORK/calibration/frames" \
    --detector "$WORK/calibration/models/detector.onnx" --recognizer "$WORK/calibration/models/recognizer.onnx" \
    --bank "$WORK/calibration/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/calibration/models/accept.json" \
    --max-wrong 0.15 --out "$WORK/results/calibrate"
cardvision evaluate hover --manifest "$WORK/calibration/labels/toy-calibration.manifest.jsonl" \
    --frames "$WORK/calibration/frames" \
    --detector "$WORK/calibration/models/detector.onnx" --recognizer "$WORK/calibration/models/recognizer.onnx" \
    --bank "$WORK/calibration/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/results/calibrate/accept.json"
cardvision evaluate compare --manifest "$WORK/calibration/labels/toy-calibration.manifest.jsonl" \
    --frames "$WORK/calibration/frames" \
    --detector "$WORK/calibration/models/detector.onnx" --recognizer "$WORK/calibration/models/recognizer.onnx" \
    --bank "$WORK/calibration/models/bank.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/calibration/models/accept.json" --other-accept "$WORK/results/calibrate/accept.json"
```

- **Expect, from `calibrate`:** `- **recommended**: tau 0.9, delta 0.05, the turned looks
  retried`, `- it rests on 48 events in 3 recording groups: 36 readable faces and 12 negative
  events`, and on standard error `recommended: tau 0.9, delta 0.05`. `$WORK/results/calibrate/`
  holds `accept.json`, `calibrate-grid.csv`, `calibrate.json` and `calibrate.md`.
- **Expect, from `evaluate hover`:** `rows used: 2`, `**named right**: 8 / 12 = 66.67 %` and
  `**wrong of shown**: 1 / 9 = 11.11 %`. These, on the evaluation rows, are the figures to
  report, not the ones `calibrate` printed.
- **Expect, from `compare`:** `events compared: 16` and `**regressions**: 2`. It shows which
  events changed between the old rule and the new one.
- **Pass on the warnings.** The report says how many events the pair rests on, that it is the
  best pair on those rows and no guarantee, and, with fewer than 30 negative events, that
  wrong of shown is weakly measured (on the toy set: `the rows hold 12 negative event(s)`).
  Say all of it to the person. Also say that `--max-wrong` constrains the observed
  calibration rows, not future footage, and that 30 negative events or more do not by
  themselves make wrong of shown well measured.
- **Know:** `calibrate` never replaces an `accept.json`. Give `--out` a folder that holds
  none; a folder that has one stops the command with exit code 2 before any model runs.
- **If no pair is at or under the limit:** exit code 1, no `accept.json`, and the report
  gives the lowest wrong of shown that any pair reaches. Show the person; do not raise the
  limit yourself.
- **Know:** the values in `games/riftbound/accept.json` belong to the released Riftbound
  models and their bank. Do not keep them for other models without saying so.

## 2.6 Refresh the bank for new cards

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
cardvision build-bank --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" \
    --recognizer "$WORK/toy/recognizer.onnx" --base "$WORK/refresh/bank-v1.json" \
    --out "$WORK/refresh/bank-v2.json"
cardvision check-refresh "$WORK/refresh/bank-v1.json" "$WORK/refresh/bank-v2.json"
cardvision check-bank-art "$WORK/refresh/bank-v2.json" --catalog "$WORK/toy/catalog.json" \
    --art "$WORK/toy/art"
cardvision evaluate compare --manifest "$WORK/eval/labels/toy.manifest.jsonl" --frames "$WORK/frames" \
    --detector "$WORK/eval/models/detector.onnx" --recognizer "$WORK/eval/models/recognizer.onnx" \
    --bank "$WORK/refresh/bank-v1.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/eval/models/accept.json" --other-bank "$WORK/refresh/bank-v2.json"
```

- **Expect:** `18 cards in the old catalog`; `(20 rows of 128 values; 2 embedded, 18 kept
  from the base bank)`; `ok: 18 shared rows, in the same order: 18 byte-identical, 0
  re-embedded (image changed); 2 card id(s) added; identity groups only grew`; from
  `check-bank-art`, `(20 rows; 20 record their source image)` and `20 embedded from the image
  now under --art`; and from `compare`, `**regressions**: 0`.
- **Rule:** extend a published bank with `--base`. Never rebuild it from scratch. If
  `check-refresh` reports an error, stop: a row changed and nothing explains it.
- **Know:** `--base` compares each old row's `artV` with the hash of the image now in the art
  folder. Same image: the row is kept byte for byte. Different image: the row is computed
  again in the same position and listed under `re-embedded, image changed`. `check-refresh`
  accepts and lists such a row only when both banks record a different `artV` for it.
- **Know:** a row can lag behind its card's current image. A bank written before rows
  recorded their image has no `artV`: `--base` keeps those rows and lists them as `image not
  recorded, reused`. A row is also kept when its image is not in the art folder.
  `check-bank-art` counts both, and lists the rows computed from a different image. It only
  reports, and exits with 0 whatever it finds; it fails only when the bank or the catalog
  cannot be read.
- **If rows are re-embedded, or `check-bank-art` lists any:** show the list to the person.
  Do not pass `--reembed-unrecorded` unless they ask: it computes again every row that
  records no image, and `check-refresh` then refuses each one whose vector changed.
- **If `compare` lists regressions:** show them to the person. Do not ship the new bank on
  your own judgment. Run this comparison on development rows, not on the final test.
- **Know:** `evaluate` reads the `evaluation` rows by default. The toy commands score the toy
  `evaluation` rows only to show them; on the person's game, point `compare` at development
  rows (`--role extra`, or a manifest of their own).

## 2.7 Roles for new recordings

```
mkdir -p "$WORK/offer"
sed 's/"role":"[a-z]*"/"role":"extra"/' "$WORK/eval/labels/toy.manifest.jsonl" > "$WORK/offer/toy.manifest.jsonl"
cardvision validate-manifest "$WORK/offer/toy.manifest.jsonl" \
    --catalog "$WORK/toy/catalog.json" --sources "$WORK/eval/sources.json" --contribution
cardvision assign-roles "$WORK/offer/toy.manifest.jsonl" --seed 20261010 --evaluation-share 0.5 \
    --out "$WORK/assigned/toy.manifest.jsonl"
```

- **Expect:** `valid: 4 row(s) ...`, then four lines `g-...  train|evaluation  (assigned)`
  and `wrote 4 row(s) to .../assigned/toy.manifest.jsonl`.
- **Know:** the command creates the output's folder. It refuses to replace an existing
  file unless you pass `--overwrite`.
- **Rule:** never set a role by hand, and never move a recording group between roles after
  looking at results. Record the seed.
