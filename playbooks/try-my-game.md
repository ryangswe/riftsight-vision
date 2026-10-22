<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tier 0: Try

This playbook covers tier 0: names on a video of the person's game with the released models, or proof that the commands work on the toy game. It assumes set-up done: [setup.md](setup.md). The rules in [AGENTS.md](../AGENTS.md) apply to every step here.

Goal: names on a video of the person's game, with the released models, or proof that the
commands work on the toy game.

## 0.0 The person's game in one command

For the person's game, use two folders outside the repository: `$GAME` (their card list
`cards.csv`, under their export's own name if they prefer, in quotes; their images in
`images/`; their video `video.mp4`) and `$WEIGHTS` (step S3 in [setup.md](setup.md), filled by `fetch-weights`). Then:

```
export GAME="$HOME/Downloads/my-game"
export WEIGHTS="$HOME/Downloads/cardvision-weights"
cardvision try "$GAME/cards.csv" --images "$GAME/images" --video "$GAME/video.mp4" --weights "$WEIGHTS"
```

- **Expect:** one progress line per step, `[1/6] import-catalog: ...` to `[6/6] report: ...`,
  then three lines: the verdict (`Found and named: ...`, `Found, few named: ...` or
  `No cards found: ...`), `report: .../cardvision-try/report.html`, and the
  `cd browser && npm run demo -- ...` line that opens the demo page on this run. Everything is
  written into `$GAME/cardvision-try/`.
- **Show the person the report:** give them the path of `report.html` (or open it:
  `open` on macOS, `xdg-open` on Linux) and read the verdict to them. Say what it rests on:
  the released models, an accept rule calibrated for Riftbound, and their one video. Tell them
  that the report, `try.log` and the demo line hold absolute paths naming their home folder,
  before they share them.
- **If it stops at the import** with `no column for the card's id: name it with --map
  id=HEADER (the columns are [...])`: add `--map id="HEADER"` with the column that holds the
  ids (ask the person if two could), and run it again. Other import messages: step 0.1 below.
- **If a line says the video may not play in the demo:** it gives the `ffmpeg` command to
  convert it; tell the person, and ask before installing ffmpeg.
- **Running it again** needs `--overwrite`, which replaces only what an earlier `try` wrote; a
  file `try` did not write is never replaced.
- **Next:** found and named → the demo line (step 1.8 in [train.md](train.md) has the `npm ci` set-up), then
  "Tier 0 → an extension" ([make-extension.md](make-extension.md)). Few named or none → tier 1, after 0.4's reading of the
  no-box lines.

**The step-by-step fallback.** When `try` stops and the cause is not clear, or the person wants
to change one step, run the steps one at a time. The steps below show each command on the toy
game; [docs/your-game.md](../docs/your-game.md), "What `try` did, step by step", has every one on
`$GAME` and `$WEIGHTS`, and a test runs those blocks on toy files. Use them as written there.

## 0.1 Catalog

**For the person's game, import their card list first.** A spreadsheet must be exported as CSV
(UTF-8) by the person; a TSV file or a JSON list of rows works too. Their files go in a folder
outside the repository:

```
export GAME="$HOME/Downloads/my-game"
cardvision import-catalog "$GAME/cards.csv" --out "$GAME/catalog.json" --game my-game \
    --images "$GAME/images"
```

- **Expect:** a report ending in `wrote .../my-game/catalog.json: N card(s)`.
- **If it stops** with `no column for the card's id: name it with --map id=HEADER (the
  columns are [...])`: this is the expected turn when the id column has a header the importer
  does not know. Take the column that holds each card's id (ask the person if two could), and
  run the same command again with `--map id="HEADER"`. The same holds for `name`.
- **If it stops** with `NAME is a spreadsheet file: export it as CSV (UTF-8) first`: ask the
  person to export it. With `the header looks semicolon-separated`: add `--delimiter ';'`.
  With `catalog.json exists; pass --overwrite to replace it`: add `--overwrite` only when that
  file is an earlier import's output, never a catalog the person wrote.
- Show the person its report: the columns it took for each field, the columns it sent to
  `extra` (ask which should be `--facets` filters instead), the names under several ids and
  the identity rule it suggests, and the cards without art. Duplicate ids or a `printing_of`
  that names no card stop it, and nothing is written: fix the list, not the command. Image
  URLs stay URLs; do not add `--download` (see "Stop and ask the person" in [AGENTS.md](../AGENTS.md#stop-and-ask-the-person)). `games/_template/cards.example.csv`
  shows the columns.
- **Never copy `games/_template` into `$GAME`,** or into any folder an import writes its
  catalog to: the template's `catalog.json` is in the way. Copy the template only when there
  is no list to import and the catalog is written by hand, into a folder of its own:
  `cp -r games/_template "$WORK/my-game"`. `games/_template/README.md` explains each field.
  `id` is unique; `art` is a file name inside the folder passed as `--art`.

- **Decide first what counts as the same card.** By default (no `"identity"` field, or
  `"identity": "name"`) equal `name` means the same card: right when a name is one card and its
  printings differ only in their picture. If different cards share a name in the person's
  game, write `"identity": "printing"` above `"cards"`: an entry is then a card of its own
  unless its `printingOf` names the card it is a printing of, and equal names join nothing.
  If the card list does not tell you which holds, ask the person.
- **Do not change a name to tell cards apart** (an id added to it, for instance). The name is
  what a viewer is shown, and the id is reported beside it.
- **Give an entry that has no usable image `"art": null`** (none, a placeholder, a vector
  file): a card without art keeps its id for labels and gets no row in a bank built from this
  catalog (a bank extended from one that had a row keeps it). Tell the person which entries
  have no art.
- **Know:** the card images should look like the cards as they appear on screen. An overprint,
  a watermark or a border that the real cards do not have is a difference the models have to
  bridge, and only real footage will show how well they do. Say so if the images have one.

Check any catalog:

```
cardvision check-catalog "$WORK/toy/catalog.json"
```

- **Expect:** `20 cards (0 without art), identity rule: name, game: toy` for the toy game.
  For the person's game, `cardvision check-catalog "$GAME/catalog.json" --art "$GAME/images"`
  gives their counts and then the image listing that `check-bank-art` gives below.
- **If it fails:** exit code 1, and the message names the card id and the position of the
  first problem. Fix the catalog (or the list, and import again), not the loader.

Look at the images before any bank is built:

```
cardvision check-bank-art --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art"
```

- **Expect:** `card images: .../toy/art (20 catalog cards; 20 with a usable image)`, then
  `0 with no image under --art`, `0 with a file that holds no picture` and `0 with a picture
  that looks like a placeholder`. Exit code 0, whatever it lists.
- **For the person's game:** it names every entry whose image is missing, is not a picture or
  looks like a placeholder, and every image file that different cards share. Show the person
  the list; do not guess which card an image belongs to.

## 0.2 Bank

```
cardvision build-bank --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" \
    --recognizer "$WORK/toy/recognizer.onnx" --out "$WORK/toy/bank-all.json"
```

- **Expect:** `bank: .../bank-all.json (20 rows of 128 values; 20 embedded, 0 kept from the
  base bank)` and a line naming the identity groups file.
- **Know:** each row records the image it was computed from, as `artV`: the first 16
  hexadecimal digits of the SHA-256 of the image file's bytes. Step 2.6 in [measure.md](measure.md) uses it.
- **Know:** lines under `look at these before you rely on the bank:` name placeholders, image
  files that different cards share, and cards of different identities whose bank rows have a
  cosine of 0.99 or more. That last usually means the same picture filed under two cards, or
  one card's image filed under another's id. The toy game lists nothing; for the person's
  game, show them every line.
- **If it fails** with `no image for N card(s)`: the catalog's `art` names a file that is
  not in the `--art` folder. Fix the name, or pass `--skip-missing-art` and report how many
  cards were left out.

## 0.3 Inference on an image

```
cardvision infer "$WORK/toy/table.png" \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json" --annotate "$WORK/out"
```

- **Expect:** one JSON line on standard output, and on standard error
  `cardvision infer: 1 frame(s), 6 face(s), 1 back(s), 5 named`. `$WORK/out/table.jpg` exists.
- **Know:** each entry of `boxes` has `"box": [x, y, width, height]`: the card's top-left
  corner and size, in pixels of the original frame (`frameW` by `frameH`). See
  [what `cardvision infer` prints](../docs/how-it-works.md#what-cardvision-infer-prints).
- **If it fails** with `no such ... file`: a path is wrong; check that `WORK` is set.

## 0.4 Inference on a video, with a contact sheet

Make a toy video (skip this for a real video):

```
python - "$WORK/toy/table.png" "$WORK/toy/table.mp4" <<'EOF'
import sys
import cv2
image = cv2.imread(sys.argv[1])
height, width = image.shape[:2]
writer = cv2.VideoWriter(sys.argv[2], cv2.VideoWriter_fourcc(*"mp4v"), 5.0, (width, height))
for _ in range(75):  # 15 seconds at 5 frames a second
    writer.write(image)
writer.release()
print("wrote", sys.argv[2])
EOF
cardvision infer "$WORK/toy/table.mp4" --every 5 \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json" \
    --annotate "$WORK/tier0/annotated" --crops "$WORK/tier0/crops" \
    --contact-sheet "$WORK/tier0/sheet.png" --art "$WORK/toy/art"
```

- **Expect:** `cardvision infer: 3 frame(s), 18 face(s), 3 back(s), 15 named`, and the files
  `$WORK/tier0/sheet.png` and `$WORK/tier0/annotated/table-f00001.jpg`.
- **Know:** `--every 5` takes one frame every 5 seconds of video. It is not every fifth frame.
- **Know:** with more than one frame, a last line counts the boxes per frame: here `boxes per
  frame, fewest / median / most: faces 6 / 6 / 6, backs 1 / 1 / 1`. Card backs are a separate
  class and may be missed on a new game; compare the count with what is on the table.
- **Know:** a contact sheet of more than 20 crops is written as pages, `sheet-1.png`,
  `sheet-2.png` and so on, and the command names the files. `--contact-sheet-rows` (default
  60) limits the crops over all pages.
- **For the person's game:** show them the contact sheet and the annotated frames. They are
  the evidence for tier 0. The contact sheet shows only the cards the detector found, so it
  answers whether those are named correctly (is the right card the first match?). Whether
  cards are found at all is answered by the annotated frames (`--annotate`) and by comparing
  the number of boxes with the number of cards on screen. On one other game the released models
  named 31.4 % of readable faces right as they stood (docs/adapt-your-game.md, "Measured on
  another game"); a game can do better or worse, so do not promise a result.
- **If there are no boxes,** standard error says why, before the summary line: how many
  frames had no box, the detector's score threshold, and for each such frame the highest
  score the detector gave anything. A highest score far below the threshold means the
  detector does not see these cards as cards: the remedy is tier 1 (train the detector on
  generated scenes of the person's cards). A score just under the threshold can mean small,
  blurred or partly hidden cards: try a clearer, larger view first. Do not promise that any
  change of picture will work. Tier 1, step 1.7 in [train.md](train.md) shows the lines on a toy run.

## 0.5 Only card images, no video

A photo or a screenshot works as input: `cardvision infer` takes images as well as video
(`cardvision infer --help`). If the person has only card images and no picture of a table,
draw a few test scenes from the card images, with exact labels:

```
cardvision make-composites --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" \
    --out "$WORK/tier0/scenes" --n 3 --seed 1 --split val
```

- **Expect:** `wrote 3 scenes to .../tier0/scenes: 25 positive faces showing 14 different
  cards, 10 more faces marked as ignore regions (too hidden or too small), 3 backs`,
  the scenes in `$WORK/tier0/scenes/images/` and their exact labels in `labels.jsonl`. Run
  step 0.3 on one of them (on the toy game the stand-in detector ignores the image).
- **Know:** `--split val` keeps these scenes apart from the training scenes of tier 1. Generated
  scenes are a harder test than a clean table: the cards are small, turned, overlapped and
  blurred, and some are shown face down. Say so when you report the result.

Then score the scenes against their exact labels. Do not write a script of your own to match
boxes to `labels.jsonl`: this is the scorer of tier 2, with its rules and its intervals.

```
cardvision evaluate hover --scenes "$WORK/tier0/scenes" \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json"
```

- **Expect:** on standard error, `cardvision evaluate: 3 row(s) scored, 0 not scored`. The
  report opens with `**These rows are generated scenes, not footage.**`, and under
  `### Overall` it has these lines:

```
- events: 24 in 1 recording groups
- readable faces: right 0, wrong 0, nothing 22
- backs: name shown 0, nothing 2
- **named right**: 0 / 22 = 0.00 %; exact one-sided 95 % lower bound 0.00 % (assumes independent events); group bootstrap: no interval (fewer than two recording groups)
- **wrong of shown**: 0 / 0 = undefined; group bootstrap: no interval (fewer than two recording groups)
```

- **How to read it:** *named right* is how often the pointer, resting on the middle of a card,
  would show that card's name, and *wrong of shown* is how much of what was shown was wrong.
  On the toy game every face reads `nothing`, because the stand-in detector ignores the image.
- **Know:** `evaluate crops --scenes` scores the recognizer alone on the labeled cards, and
  `evaluate detector --scenes` the detector alone. `--out DIR` writes the report and a line
  per event.
- **Know:** a card that shows less than half of itself, or whose short side is under 20 px, is
  left out of every rate, as an ignore region is in a manifest. The report counts them (here
  `faces 10, backs 1`). All scenes are one recording group, so no rate has a group bootstrap
  interval.
- **Report it as what it is:** a figure on generated scenes says whether the tools run and
  roughly where the models stand. It does not say how they do on real video. Tier 2 measures
  that.
- **If it fails** with `not a folder of generated scenes` or `the labels fail the check`: pass
  the folder that `make-composites` wrote, unchanged, and the catalog it was made from.

## 0.6 A release folder, for the browser demo (optional)

The demo page of `browser/` (step 1.8 in [train.md](train.md)) loads a release folder, and the steps above make
none. Make one from the released detector, the released recognizer and their accept rule,
with the person's own catalog and bank. Every file goes in one folder.

The toy check needs one more stand-in. The stand-in detector of step S3 in [setup.md](setup.md) answers with nine rows,
which is not the output of a real detector, and a release refuses it. The test suite writes a
stand-in release, and a table to look at. Its folder, `$WORK/demo/release`, stands in for
`$WEIGHTS`: take the same three files from it as from the released weights (its recognizer is
the toy one, which built `bank-all.json`):

```
python tests/test_browser_fixtures.py --demo "$WORK/demo"
mkdir -p "$WORK/tier0/release"
cp "$WORK/demo/release"/{detector.onnx,recognizer.onnx,accept.json} "$WORK/tier0/release/"
cp "$WORK/toy/catalog.json" "$WORK/toy/bank-all.json" "$WORK/toy/bank-all.identity-groups.json" \
    "$WORK/tier0/release/"
cardvision build-release --detector "$WORK/tier0/release/detector.onnx" \
    --recognizer "$WORK/tier0/release/recognizer.onnx" --bank "$WORK/tier0/release/bank-all.json" \
    --catalog "$WORK/tier0/release/catalog.json" --accept "$WORK/tier0/release/accept.json" \
    --out "$WORK/tier0/release/release.json"
cardvision verify-release "$WORK/tier0/release/release.json"
```

- **Expect:** from the first command, `wrote .../demo/release/release.json, .../demo/art and
  .../demo/table.png` and two more lines; then `release <16 hex digits>:
  .../tier0/release/release.json`; then `release <16 hex digits>: ok (toy, 20 cards in the
  bank, 20 in the catalog; every file present, unchanged and consistent)` and `bank: 20 of
  20 rows record their source image (artV)`.
- **For the person's game:** the same three-file copy from `$WEIGHTS`, with their catalog,
  the bank of step 0.2 and the identity groups file that step wrote beside the bank, then the
  same two `cardvision` commands on that folder (docs/your-game.md, step 6):

  ```
  mkdir -p "$GAME/release"
  cp "$WEIGHTS"/{detector.onnx,recognizer.onnx,accept.json} "$GAME/release/"
  cp "$GAME/catalog.json" "$GAME/bank.json" "$GAME/bank.identity-groups.json" "$GAME/release/"
  ```

  The accept rule is a JSON file with `tau`, `delta` and `rotationRetry`. The values that come
  with the released models were calibrated for Riftbound (step 2.5 in [measure.md](measure.md)).
- **Take exactly three files from the downloaded release:** the detector, the recognizer and,
  as a starting point only, the accept rule. The released bank, its catalog, its identity
  groups and its release document belong to the released game: never copy them into the
  person's folder.
- **If it fails:** `build-release` and `verify-release` list every reason. A file that is not
  in the release's folder is one of them: copy it there.

Then the demo page takes the folder, and a file to open. Step 1.8 in [train.md](train.md) has the set-up (`npm ci` in
`browser/`), and says when to start the page. On the toy game the file is `$WORK/demo/table.png`:

```
(cd browser && npm run demo -- --release "$WORK/tier0/release" --images "$WORK/toy/art" \
    --file "$WORK/demo/table.png")
```

- **Expect:** a line with the build's sizes, then:

```
demo: http://127.0.0.1:8765/
scoring page: http://127.0.0.1:8765/score.html
release folder: $WORK/tier0/release (served at /release/)
image folder: $WORK/toy/art (served at /images/; the demo page shows card images from it)
file: $WORK/demo/table.png (served at /file/table.png)
open the file in the demo: http://127.0.0.1:8765/?file=/file/table.png&images=/images/
```

- **Open the last address.** The page opens the file by itself. Under the picture it says
  `table.png opened from this page's address (/file/table.png on the local server)`, then
  `Model: toy · 20 cards`, then the state line, which reaches `Ready. Move over a face-up
  card.` The text panel is under `Details`, in `Raw text`, both closed; the panel (the
  element `panel`) is filled in all the same, and its first line reads `state: ready`. With
  the pointer on the first card, a tooltip shows the card's image, `Amber Circle` and
  `TOY-001`, and the panel's last line reads `under the pointer: Amber Circle (TOY-001)`. On the card back and on the
  bare table there is no tooltip, and that line reads `under the pointer: nothing shown`.
- **If it is not ready:** the page says why, where the fault is. `NAME is not a picture or
  video this browser can open` is in the drop zone. `Could not load the model at ADDRESS
  (REASON)` is beside the model line, with a `Retry` button. The page says `Ready` only when
  the model has loaded and the file decoded to a picture.
- **Know:** `--file` is how you open the demo in a browser that you drive. Do not copy the file
  into a served folder, and do not set the page's file field by script. The address can name
  that one file and the server's own `/images/`, and nothing else: the page refuses any other
  value and says why.
- **Know:** the server runs until it is stopped. Stop it when you are done. If port 8765 is in
  use, add `--port 0` for any free port; the printed addresses then carry that port.
