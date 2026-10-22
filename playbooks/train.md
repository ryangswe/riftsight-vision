<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tier 1: Train

This playbook covers tier 1: training the models for the person's game. It assumes set-up done: [setup.md](setup.md). The rules in [AGENTS.md](../AGENTS.md) apply to every step here.

Goal: models trained for the person's game. The toy run trains for seconds from random
weights. It proves the commands and yields models that find nothing. Say so.

## 1.1 Training environment

```
python -m pip install -r requirements-lock-train.txt
python -m pip install --no-deps -e .
python -m pip install setuptools wheel
python -m pip install --no-deps --no-build-isolation "yolox @ git+https://github.com/Megvii-BaseDetection/YOLOX@6ddff4824372906469a7fae2dc3206c7aa4bbaee"
python -c "import torch, torchvision, yolox; print('torch', torch.__version__, 'torchvision', torchvision.__version__)"
```

- **Expect:** `torch 2.14.1 torchvision 0.29.1`.
- **If it fails:** a pinned PyTorch may have no build for this machine. Use
  `python -m pip install -e ".[dev,train]"`, then the YOLOX line, and tell the person. (This
  fallback was not run when this file was checked.)

## 1.2 Generated scenes

```
cardvision make-composites --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" \
    --out "$WORK/composites/train" --n 60 --seed 7 --check
```

- **Expect:** `wrote 60 scenes to .../composites/train: 860 positive faces showing 20 different
  cards, 542 more faces marked as ignore regions (too hidden or too small), 142 backs`, then a
  JSON report with `"problemCount": 0`. About 35 s on a laptop.
- **If it fails** with `already holds generated scenes`: add `--overwrite` or use a new
  folder.

## 1.3 Labeled real frames (a person's work)

You cannot do this step alone. Prepare it and hand over.

```
cardvision infer "$WORK/toy/table.mp4" --every 5 \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json" \
    --frames "$WORK/label/frames/table" --prefill-out "$WORK/label/prefill.jsonl"
python3 labeler/make_sample.py --out "$WORK/label/sample.json" \
    --asset table="$WORK/label/frames/table" --all --times "$WORK/label/prefill.jsonl"
```

- **Expect:** `wrote .../label/sample.json: 3 frames of 1 assets`.

Then give the person this command to run, and `labeler/README.md` to read:

```
python3 labeler/serve.py --mode box --role training --sample "$WORK/label/sample.json" \
    --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" --prefill "$WORK/label/prefill.jsonl"
```

- **Expect:** `labeling tool: http://127.0.0.1:8090/  mode=box role=training`. The server
  runs until stopped.
- The flags open straight into the Boxes pass. When it is finished the page offers the next
  pass (the names) and switches the running tool to it, with no new start; **← Project** leads
  to the project's screen, which shows how far each pass is and writes the export from the page.
  Started with no arguments, `python3 labeler/serve.py` asks on its page what to label
  (`labeler/README.md`, "Starting the tool, and a project's screen").
- **Do not** label on the person's behalf, and do not turn a model's pre-fill into labels
  without a person checking each frame. Labels for measuring a model must be made without any
  model's help (`--role test`).

When they have labeled, the export (the project screen's Export row, or
`labeler/export.py manifest` for scripts) and the checks are as in `labeler/README.md`,
"Offering labels", then steps 2.2 and 2.3 in [measure.md](measure.md). Step 2.0 in [measure.md](measure.md) runs the
whole route, export included, for a recording of the person's own.

## 1.4 Recognizer

```
cat > "$WORK/toy-recognizer.toml" <<'EOF'
seed = 0
epochs = 2
batch = 32
workers = 0

[model]
init = "random"

[data]
catalog = "toy/catalog.json"
art = "toy/art"
composites = "composites/train"

[validation]
unseen_pick = 2
unseen_count = 50
every = 1

[epoch]
base = 200
EOF
cardvision train-recognizer --config "$WORK/toy-recognizer.toml" --out "$WORK/runs/recognizer"
cardvision export recognizer "$WORK/runs/recognizer/best.pt" --out "$WORK/release" --name recognizer
```

- **Expect:** two `epoch N/2` lines, then `done: best criterion ... at epoch ...;
  .../runs/recognizer/best.pt`. The export prints a JSON report and writes
  `$WORK/release/recognizer.onnx`. Seconds on a GPU, a few minutes on a CPU.
- **Expect also:** three `note:` lines about empty streams. They are right for this config,
  which has no labeled frames.
- **If it fails** with `already holds a run`: add `--overwrite`.
- **For the person's game:** copy `cardvision/train_recognizer/default.toml`, set the paths
  under `[data]`, and keep `init = "imagenet"` unless they ask for random weights. That
  setting downloads torchvision's weights on first use: ask first. To compare starting points,
  score them on development groups, never on the final test.

## 1.5 Detector

```
cat > "$WORK/toy-detector.toml" <<EOF
steps = 10
batch_size = 16

[streams.composites]
folder = "$WORK/composites/train"

[mix]
primary = [{ stream = "composites", tiles = 16 }]
mosaic_extra = [{ stream = "composites", share = 1.0 }]

[loader]
workers = 0
EOF
cardvision train-detector --config "$WORK/toy-detector.toml" --out "$WORK/runs/detector" --init random
cardvision export detector "$WORK/runs/detector/last.pth" --out "$WORK/release" --name detector
```

- **Expect:** `training 10 steps of 16 on ...`, `step 10/10 ...`, `wrote
  .../runs/detector/last.pth`. The export writes `$WORK/release/detector.onnx`. About a
  minute on a laptop's CPU.
- **If it fails** with a message about YOLOX: step 1.1 is incomplete.
- **For the person's game:** copy `cardvision/train_detector/default.toml`. Drop
  `--init random` and add `--download-pretrained` to start from the public pretrained
  weights. That downloads one file: ask first. The file is fetched and checked before
  PyTorch is needed, and the command prints `pretrained weights: ... (SHA-256 verified)`.
  To compare starting points, score them on development groups, never on the final test.

## 1.6 Bank and release

```
cp "$WORK/toy/catalog.json" "$WORK/toy/accept.json" "$WORK/release/"
cardvision build-bank --catalog "$WORK/release/catalog.json" --art "$WORK/toy/art" \
    --recognizer "$WORK/release/recognizer.onnx" --out "$WORK/release/bank.json"
cardvision build-release --detector "$WORK/release/detector.onnx" \
    --recognizer "$WORK/release/recognizer.onnx" --bank "$WORK/release/bank.json" \
    --catalog "$WORK/release/catalog.json" --accept "$WORK/release/accept.json" \
    --out "$WORK/release/release.json"
cardvision verify-release "$WORK/release/release.json"
```

- **Expect:** `release <16 hex digits>: ok (toy, 20 cards in the bank, 20 in the catalog;
  every file present, unchanged and consistent)`, then `bank: 20 of 20 rows record their
  source image (artV)`.
- **If it fails:** `verify-release` lists every reason. Any reason means the release must not
  be used. Rebuild the part it names; never edit `release.json` by hand.
- **Always** rebuild the bank after retraining the recognizer.

## 1.7 Run the trained models

```
cardvision infer "$WORK/toy/table.png" --release "$WORK/release/release.json"
```

`--release` takes every file and setting from the release document, after checking them. The
separate files (`--detector`, `--recognizer`, `--bank`, `--catalog`, `--accept`) also work,
but not together with `--release`.

- **Expect, on the toy run:** a JSON line with `"boxes": []` and, on standard error, these
  three lines. Ten steps from random weights find nothing. This is the expected toy result,
  not a failure.

```
cardvision infer: no box in 1 of 1 frame(s); the detector keeps a box at a score of 0.30 or more
cardvision infer: table.png: highest score 0.00, threshold 0.30
cardvision infer: 1 frame(s), 0 face(s), 0 back(s), 0 named
```

## 1.8 The browser runtime (optional; needs Node 22 or later)

`browser/` runs the pipeline in a web page from a release folder. Its tests need no browser:

```
cd browser
npm ci
npm test
npm run build
cd ..
python -m pytest tests/test_browser_fixtures.py tests/test_browser_agreement.py -q
```

- **Expect:** a `Tests` line with no failures (6 are skipped when OpenCV.js is not built); a line `dist/cardvision.js ... KB, dist/worker.js ...
  KB, ...`; then `49 passed`.
- **If it fails:** `node --version` must be 22 or later. If the last command reports the
  agreement tests as skipped, `npm ci` did not run in `browser/`. If a comparison fails after a
  change to `cardvision/` or `browser/src/`, the two sides no longer agree: show the person the
  failing assertion, do not loosen it.
- **The demo page** shows what the pipeline would display under the pointer on a video or
  image file from the disk. It is not a browser extension and does not attach to any website.
  `npm run demo -- --release "$WORK/release" --file "$WORK/toy/table.png"` (in `browser/`)
  serves it on `127.0.0.1` until it is stopped, and prints the address that opens the file:
  `open the file in the demo: http://127.0.0.1:8765/?file=/file/table.png`. Add
  `--images FOLDER` to show card images in the tooltip; the address then ends in
  `&images=/images/`. Step 0.6 in [try-my-game.md](try-my-game.md) shows the whole output, and what the page says, on the toy
  release. Start the page when the person asks to see it, or to check it yourself in a browser
  you drive. Tell the person the address, and stop the server afterwards.
- **To check the page yourself:** open the printed address and wait until the state line under
  the picture reads `Ready. Move over a face-up card.` (the first line of the element `panel`
  then reads `state: ready`). Move the pointer onto a card and read the tooltip, or the
  panel's last line, `under the pointer: ...`. The file comes from the address, so set no
  file field by script. A person opens `http://127.0.0.1:8765/` and drops a file on the page,
  or chooses one: there is no Start button, and choosing starts.
- **The scoring page** is on the same server, at `/score.html`. A person gives it manifests
  and their video files; it writes `browser-events.jsonl`. The video files are whole videos,
  or the sections that `cardvision fetch --download --keep-video DIR` keeps ("Stop and ask the person" in [AGENTS.md](../AGENTS.md#stop-and-ask-the-person) applies:
  do not download unless the person asks). Before a run the page says how many rows of the
  role it would read and how many have a matching video; with none, Start starts nothing and
  the page says what to do. When the run has ended it shows the scoring command with the file
  names filled in and each folder as a placeholder in capitals. Score that file with
  `cardvision evaluate hover --browser-events browser-events.jsonl --manifest ... --release ...`
  (or `--catalog ...`); no `--frames` and no model file is needed. Report its figures as
  browser figures, with the backend and the rows not kept, and never mix them with figures
  from `--frames`. [browser/README.md](../browser/README.md) describes the page and the file.
- **The scoring page without a person:** `browser/examples/score-headless.mjs` runs it in a
  headless Chrome and writes the events file ([browser/README.md](../browser/README.md),
  "Running the scoring page from a script"). It needs a Chrome on the machine and the package
  `puppeteer-core`, which `npm ci` does not install: ask before you install it.
- `browser/node_modules/` and `browser/dist/` are ignored by git. Never commit a build.
