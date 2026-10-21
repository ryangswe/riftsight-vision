<!-- SPDX-License-Identifier: Apache-2.0 -->

# Instructions for coding agents

This file is for a coding agent asked to work in this repository, most often with a request
like "adapt this to my game". It has the rules of the repository and then the adapt guide as
numbered steps, each with a command, what to expect, and what to do if it fails: tier 0
(Try), then a browser extension, tier 1 (Train) and tier 2 (Measure).

The same guide for people, with more explanation, is
[docs/adapt-your-game.md](docs/adapt-your-game.md) and its pages:
[docs/your-game.md](docs/your-game.md) (tier 0 on the person's own files),
[docs/extension.md](docs/extension.md), [docs/train.md](docs/train.md) and
[docs/measure.md](docs/measure.md).

## What this repository is

Card detection and recognition for trading-card game video: two small models, a bank of
reference vectors computed from card images, an accept rule, label manifests, and the tools
that train, label and evaluate. The package is `cardvision`; the command is `cardvision`.
[docs/how-it-works.md](docs/how-it-works.md) describes the pipeline. `browser/` holds the same
pipeline for a web page (TypeScript, its own tests, a demo page for a local file); step 1.8
checks it.

## Rules you must follow here

1. **Never commit an image, a video, a frame, a crop, a screenshot or a model file.** Not
   card art, not test images, not weights. A check refuses them.
2. **Keep your own files outside the repository.** Put every file you generate or download
   under a folder outside the checkout (`$WORK` below). The set-up, test and build steps
   below make a few folders inside the checkout, and that is expected: `.venv`,
   `.pytest_cache`, `cardvision.egg-info`, `browser/node_modules` and `browser/dist`. Git
   ignores them all. After any run, if the folder is a git checkout,
   `git status --short` must show only files you meant to change. If it is not, list the
   files you created or changed.
3. **Do not download anything the person did not ask for.** `cardvision fetch --download`,
   `cardvision fetch-weights`, `cardvision try --download`, `cardvision fetch-textures`,
   `cardvision import-catalog --download` and
   `cardvision train-detector --download-pretrained` reach the network. Downloading video is the person's own act under the platform's terms: ask
   first, every time. **One exception:** the released weights of this repository, pinned by
   hash in `docs/release-files.md`, may be downloaded with `cardvision fetch-weights` or the block there (step S3). Tell
   the person before you run it: eight files from this repository's v0.1.0 release on GitHub,
   checked against the pinned hashes.
4. **Do not fetch card art.** The person supplies a folder of card images they are entitled
   to use. If there is none, stop and ask.
5. **Run the validator on every manifest you touch:**
   `cardvision validate-manifest FILE --catalog CATALOG` (add `--sources FILE` when the
   game has a sources file, and `--contribution` for labels being offered).
6. **Run the tests before you propose a change:** `python -m pytest`.
7. **Commits are signed off by the person, not by you.** Every commit needs a
   `Signed-off-by` line (`git commit -s`), made with the git identity of the person you work
   for. The sign-off is their statement under the Developer Certificate of Origin. Do not
   invent one and do not sign with a name of your own. If you cannot tell whose identity git
   is using, ask.
8. **Copy nothing from elsewhere.** No code, weights, data or labels from other
   card-recognition projects, and nothing under the GPL or the AGPL. Reading a public
   write-up for ideas is fine; copying is not. See [CONTRIBUTING.md](CONTRIBUTING.md).
9. **New files start with the license line** (`SPDX-License-Identifier: Apache-2.0` as a
   comment of that file type) in `cardvision/`, `tests/`, `labeler/`, `examples/`, `games/`,
   `data/`, `browser/`, `docs/`, `.github/` and at the top level. JSON and CSV files are the
   exception.
10. **Another game's catalog, bank or weights do not belong in this repository.** Keep them
    in the person's own repository or fork.
11. **Report what you measured, with the command.** A toy run proves that commands work. It is
    not evidence of accuracy. Never state a number you did not produce, and say when a result
    comes from stand-in models.

If a step fails and its "if it fails" line does not fix it, stop and show the person the
command and its full output. Do not edit the package to get past a step.

## Set-up

Run every command from the repository's root, in a POSIX shell: macOS or Linux, or Ubuntu under WSL 2 on Windows (docs/quickstart.md, "Which computer?"). A native Windows shell such as PowerShell is not covered.

### S1. Install

Check `python3 --version` first: the toolkit needs Python 3.11 or later. If it is older, find a newer
one (`python3.12 --version`, `python3.11 --version`) and use it for the first line; if there is none,
tell the person and ask before installing one (`brew install python@3.12` on macOS).

```
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-lock.txt
python -m pip install --no-deps -e .
cardvision --version
```

- **Expect:** `cardvision 0.2.0rc2`.
- **If it fails:** check `python3 --version` is 3.11 or later. If a pinned version has no
  build for this machine, use `python -m pip install -e ".[dev]"` in place of the two install
  lines and tell the person the lock file was not used. (This fallback was not run when this
  file was checked.)

### S2. A work folder outside the repository

```
export WORK="$HOME/Downloads/cardvision-toy"
mkdir -p "$WORK"
echo "$WORK"
```

- **Expect:** a path that is not inside the checkout, ending in `Downloads/cardvision-toy`.
  The folder is outside the repository on purpose, and visible so that the person can find
  its files; it can be deleted afterwards.
- **Note:** a new shell loses `WORK`. Set it again to the same path.
- **Note:** running a step again replaces what it wrote, except where a step refuses to
  (`... already holds generated scenes` and the like: add `--overwrite`, or delete that step's
  output folder). To start over from nothing: `rm -rf "$HOME/Downloads/cardvision-toy"`. It
  deletes everything in the folder without asking: run it only when the person agrees, and
  never while the folder holds files of theirs, such as their own catalog.

### S3. The released weights, or the toy stand-ins

**The released weights** are release assets of v0.1.0: `docs/release-files.md`, "Getting the
released weights", lists each file with its address and SHA-256. For the person's game you need
them. If the person has given you the files, put them in `$WEIGHTS`; otherwise tell the person
what you are about to fetch (rule 3) and run:

```
export WEIGHTS="$HOME/Downloads/cardvision-weights"
mkdir -p "$WEIGHTS"
cardvision fetch-weights "$WEIGHTS"
```

`--list` shows the files and addresses without a request. By hand, the block of
`docs/release-files.md`, "Download and check them by hand", does the same, in the same
`$WEIGHTS`:

```
for name in release.json detector.onnx recognizer.onnx bank.json identity-groups.json catalog.json accept.json SHA256SUMS; do
    curl -fL --proto '=https' -o "$WEIGHTS/$name" "https://github.com/ryangswe/riftsight-vision/releases/download/v0.1.0/$name"
done
(cd "$WEIGHTS" && echo "5054fc41bc3d85a66d934e494ef9f114a7b27ac08eca0a6328c95750428e0a73  release.json" | shasum -a 256 -c - && shasum -a 256 -c SHA256SUMS)
cardvision verify-release "$WEIGHTS/release.json"
```

- **Expect:** every file reported `OK`, then `release 201478a00d6ef6ba: ok` and what the
  release holds. (Not run when this file was checked: it needs the network.)
- **If it fails:** a checksum that is not `OK`, or a refused release: delete `$WEIGHTS` and
  run the block once more. If it fails again, stop and show the person the output. Never skip
  or edit a check. On Linux, use `sha256sum` in place of `shasum -a 256` if `shasum` is missing.
- **Use** `$WEIGHTS/detector.onnx`, `$WEIGHTS/recognizer.onnx` and `$WEIGHTS/accept.json`
  wherever a command takes `--detector`, `--recognizer` and `--accept`. The released bank,
  catalog, identity groups and release document belong to the released game, Riftbound.
- **Note:** a new shell loses `WEIGHTS`. Set it again to the same path.

**The toy game and two stand-in models** let you check every command without the released
weights:

```
python examples/toy_quickstart.py "$WORK/toy"
ls "$WORK/toy"
```

- **Expect:** `wrote .../toy/catalog.json and 20 images in .../toy/art`, then `wrote
  stand-in models, a staged bank and a test scene in .../toy`, then `table.png: 7 boxes`,
  seven lines (one per box) and `1 frame, 6 faces, 3 named`. `ls` prints `accept.json art
  bank.json catalog.json detector.onnx recognizer.onnx table.png`.
- **Know:** the stand-ins have no skill. The detector returns the same boxes for any image.
  The script imports them and the toy game from `tests/`. Its bank, `bank.json`, is staged:
  one card is left out and two cards share a row, so three faces are named nothing. Say so
  in anything you report.
- **If it fails** with a message about the onnx package: S1 did not use
  `requirements-lock.txt`.
- **If it fails** with `lies inside the repository`: `WORK` is not set, or points into the
  checkout. Do S2 again.

## Tier 0: Try

Goal: names on a video of the person's game, with the released models, or proof that the
commands work on the toy game.

### 0.0 The person's game in one command

For the person's game, use two folders outside the repository: `$GAME` (their card list
`cards.csv`, under their export's own name if they prefer, in quotes; their images in
`images/`; their video `video.mp4`) and `$WEIGHTS` (S3, filled by `fetch-weights`). Then:

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
  ids (ask the person if two could), and run it again. Other import messages: step 0.1.
- **If a line says the video may not play in the demo:** it gives the `ffmpeg` command to
  convert it; tell the person, and ask before installing ffmpeg.
- **Running it again** needs `--overwrite`, which replaces only what an earlier `try` wrote; a
  file `try` did not write is never replaced.
- **Next:** found and named → the demo line (step 1.8 has the `npm ci` set-up), then
  "Tier 0 → an extension" below. Few named or none → tier 1, after 0.4's reading of the
  no-box lines.

**The step-by-step fallback.** When `try` stops and the cause is not clear, or the person wants
to change one step, run the steps one at a time. The steps below show each command on the toy
game; [docs/your-game.md](docs/your-game.md), "What `try` did, step by step", has every one on
`$GAME` and `$WEIGHTS`, and a test runs those blocks on toy files. Use them as written there.

### 0.1 Catalog

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
  URLs stay URLs; do not add `--download` (rules 3 and 4). `games/_template/cards.example.csv`
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

### 0.2 Bank

```
cardvision build-bank --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" \
    --recognizer "$WORK/toy/recognizer.onnx" --out "$WORK/toy/bank-all.json"
```

- **Expect:** `bank: .../bank-all.json (20 rows of 128 values; 20 embedded, 0 kept from the
  base bank)` and a line naming the identity groups file.
- **Know:** each row records the image it was computed from, as `artV`: the first 16
  hexadecimal digits of the SHA-256 of the image file's bytes. Step 2.6 uses it.
- **Know:** lines under `look at these before you rely on the bank:` name placeholders, image
  files that different cards share, and cards of different identities whose bank rows have a
  cosine of 0.99 or more. That last usually means the same picture filed under two cards, or
  one card's image filed under another's id. The toy game lists nothing; for the person's
  game, show them every line.
- **If it fails** with `no image for N card(s)`: the catalog's `art` names a file that is
  not in the `--art` folder. Fix the name, or pass `--skip-missing-art` and report how many
  cards were left out.

### 0.3 Inference on an image

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
  [what `cardvision infer` prints](docs/how-it-works.md#what-cardvision-infer-prints).
- **If it fails** with `no such ... file`: a path is wrong; check that `WORK` is set.

### 0.4 Inference on a video, with a contact sheet

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
  change of picture will work. Tier 1, step 1.7 shows the lines on a toy run.

### 0.5 Only card images, no video

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

### 0.6 A release folder, for the browser demo (optional)

The demo page of `browser/` (step 1.8) loads a release folder, and the steps above make
none. Make one from the released detector, the released recognizer and their accept rule,
with the person's own catalog and bank. Every file goes in one folder.

The toy check needs one more stand-in. The stand-in detector of S3 answers with nine rows,
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
  with the released models were calibrated for Riftbound (step 2.5).
- **Take exactly three files from the downloaded release:** the detector, the recognizer and,
  as a starting point only, the accept rule. The released bank, its catalog, its identity
  groups and its release document belong to the released game: never copy them into the
  person's folder.
- **If it fails:** `build-release` and `verify-release` list every reason. A file that is not
  in the release's folder is one of them: copy it there.

Then the demo page takes the folder, and a file to open. Step 1.8 has the set-up (`npm ci` in
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

## Tier 0 → an extension

Goal: a browser extension for the person's game that shows the card under the pointer on
YouTube or Twitch videos, built on the release folder of step 0.0 (`$GAME/cardvision-try/release`)
or of step 0.6 (`$GAME/release`), or, after tier 1, on the release of step 1.6. Go here when the
names on the person's video are good enough for them (the report of step 0.0, or step 0.4, and
the demo page). The human guide is
[docs/extension.md](docs/extension.md).

- **Tell the person how it reaches viewers.** Each viewer installs the extension from a
  browser's store (or loads it unpacked, for testing). It is not a stream-side overlay: a
  streamer cannot turn it on for their viewers.
- **Card pictures: names only, unless the person states their rights.** Never put another
  publisher's card art in a public repository, the person's copy of the extension included.
  Build names only (step E6) unless the person tells you they have the right to serve or bundle
  the pictures; then follow `cdn/SETTINGS.md` in the copy, with a host they run. Do not fetch
  card art (rule 4).
- **The base is Kenbunshoku** (<https://github.com/ryangswe/kenbunshoku>), an Apache-2.0
  Chrome extension for One Piece Card Game videos built on this repository's browser runtime.
  Its README says it is looking for a maintainer: the person's copy is theirs to maintain.
  Say so. Its guide, `docs/make-it-yours.md`, is the source of these steps; read it in the
  copy, and follow it where it differs from this list.
- **Status of these steps:** checked by Kenbunshoku's own guide on this repository's toy
  release (names only, the geometric stage off, no host, Twitch only); not run by this
  repository's tests. Report them as not run here.

Run the steps in the copy's folder, not in this repository. Its own rules apply there.

**E1. Copy the repository,** outside this checkout (tell the person: it downloads the
Kenbunshoku repository):

```
git clone https://github.com/ryangswe/kenbunshoku.git "$HOME/Downloads/my-game-extension"
cd "$HOME/Downloads/my-game-extension"
```

- **Expect:** git's lines and a folder with `kenbunshoku.config.json` in it.

**E2. Install and test,** with Node 22 or later:

```
npm ci
npm test
```

- **Expect:** the summary passes except one test, which fails by design until both the
  `packageName` (E3) and the extension's key (E8) are changed: a copy must not keep one of
  Kenbunshoku's and not the other. Tests of Kenbunshoku's own values are skipped once
  `packageName` is not `kenbunshoku`. `DOMException` lines and stack traces ("Failed to load
  iframe page ... Iframe page loading is disabled.") before the summary are harmless.

**E3. Edit `kenbunshoku.config.json`.** The keys are explained at the top of
`scripts/fork-config.mjs`. Ask the person for the names and the sites.

- `name`, `shortName`, `description`: the extension's names; `packageName`: the release zip's
  name.
- `icons`: a folder with `icon-16.png`, `icon-32.png`, `icon-48.png` and `icon-128.png`,
  square PNGs of those sizes in pixels. Make them from art of the person's own (ask them for
  it); never from the publisher's logo or card art (E12).
- `videoSites`: `{ "youtube": true|false, "twitch": true|false }`.
- `imageHosts`: `[]` for names only.
- `settingsUrl`: `null` (no fetch; the copy built into the extension is used).
- `printedNumber`: `"none"`, unless the person wants the number printed on a card in image
  addresses.
- `geometric`: `null` (E7).
- `projectUrl`, `modelUrl`, `maintainerContactUrl`, `updateUrlPrefix`: the person's, or
  `null`. Keep `runtimeUrl`: it credits the runtime.
- **Expect:** the build (E10) accepts the file; it refuses a file with a problem and says which.

**E4. The release's legal files.** Rewrite `release-legal/`: `LICENSE` (the models' license:
Apache-2.0 for the released weights), `NOTICE`, whose first line must contain
`(id <release id>)`, and `PROVENANCE.md` (what the models were trained and built from). The
release id is the 16 hexadecimal digits that `cardvision verify-release` prints for the
release folder.

- **Expect:** the build accepts this release, and refuses any other.

**E5. No picture source of Kenbunshoku's.** Replace `data/source-files.json` with `{}`, and
build without `--images-index`.

- **Expect:** the build prints a line such as `{sourceFile} map from data/source-files.json:
  optcgapi 0 of 20 cards`: expected in a copy that does not use that host.

**E6. Names only.** In `cdn/config.json` set `"namesOnly": true`, `"primary": null`,
`"fallbacks": []`, `"geometric": false` and `"cardLink": null`.

- **Expect:** the tooltip shows each card's name, from the release's catalog, and the
  extension requests no picture.

**E7. The geometric stage off.** `"geometric": null` in `kenbunshoku.config.json` (E3), and
delete `data/geometric.json`.

- **Expect:** the build needs no `data/geometric.json`, asks for no unlimited storage and
  ships no OpenCV.

**E8. The extension's own key pair,** with the private key in a private folder of the home
directory: outside Downloads, and outside the copy and any other repository:

```
mkdir -p "$HOME/.extension-keys" && chmod 700 "$HOME/.extension-keys"
openssl genrsa -out "$HOME/.extension-keys/private-key.pem" 2048
openssl rsa -in "$HOME/.extension-keys/private-key.pem" -pubout -out keys/unpacked-public.pem
```

- **Expect:** `keys/unpacked-public.pem` changed, and the private key in
  `$HOME/.extension-keys/`. Never commit the private key, and tell the person where it is:
  anyone who has it can publish an extension under their ID.

**E9. Delete the One Piece text** that no longer applies: the README and the pages in `docs/`
(their figures are for the One Piece models only), `PRIVACY.md` (rewrite it for the person's
hosts, none for names only) and `cdn/README.md`. Keep `LICENSE` and the attributions in
`NOTICE`, and add the person's own.

**E10. Test and build** on the person's release folder. `$GAME` is the game's folder of
step 0.1 (`export GAME="$HOME/Downloads/my-game"`); a new shell has lost it, so set it again,
and the release folder is the one `try` made in step 0.0 (`$GAME/release` if the person used
the step-by-step 0.6 instead; after tier 1, the release of step 1.6):

```
npm test
npm run build -- --dev --release "$GAME/cardvision-try/release"
```

- **Expect:** every test passes now (E3 and E8 done), and the build writes `dist/`.

**E11. Load it and check on a local video** (the person's, in `$GAME` as in E10). Loading is
the person's act, or yours in a browser you drive: in Chrome, `chrome://extensions`, **Developer mode** on, **Load unpacked**,
choose `dist/`. Then:

```
npm run manual -- --video "$GAME/video.mp4"
```

- **Expect:** a server on `http://127.0.0.1:8770/`. Open it, turn card hovers on with the
  button in the player, and rest the pointer on a card: its name shows. Stop the server
  afterwards. Then the person tries a video on the sites they turned on.

**E12. Before a store listing** (the person's act, not yours): a `--store` build, packaged with
`npm run package`; every permission and every requested host explained in the listing; the
extension said plainly to be unofficial and not affiliated with the game's publisher; the
publisher's logos kept out of the extension's name and icon; only pictures the person has the
right to serve. The store's own review and policies apply.

## Tier 1: Train

Goal: models trained for the person's game. The toy run trains for seconds from random
weights. It proves the commands and yields models that find nothing. Say so.

### 1.1 Training environment

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

### 1.2 Generated scenes

```
cardvision make-composites --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" \
    --out "$WORK/composites/train" --n 60 --seed 7 --check
```

- **Expect:** `wrote 60 scenes to .../composites/train: 860 positive faces showing 20 different
  cards, 542 more faces marked as ignore regions (too hidden or too small), 142 backs`, then a
  JSON report with `"problemCount": 0`. About 35 s on a laptop.
- **If it fails** with `already holds generated scenes`: add `--overwrite` or use a new
  folder.

### 1.3 Labeled real frames (a person's work)

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
"Offering labels", then steps 2.2 and 2.3 below. Step 2.0 runs the
whole route, export included, for a recording of the person's own.

### 1.4 Recognizer

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

### 1.5 Detector

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

### 1.6 Bank and release

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

### 1.7 Run the trained models

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

### 1.8 The browser runtime (optional; needs Node 22 or later)

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
  `&images=/images/`. Step 0.6 shows the whole output, and what the page says, on the toy
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
  or the sections that `cardvision fetch --download --keep-video DIR` keeps (rule 3 applies:
  do not download unless the person asks). Before a run the page says how many rows of the
  role it would read and how many have a matching video; with none, Start starts nothing and
  the page says what to do. When the run has ended it shows the scoring command with the file
  names filled in and each folder as a placeholder in capitals. Score that file with
  `cardvision evaluate hover --browser-events browser-events.jsonl --manifest ... --release ...`
  (or `--catalog ...`); no `--frames` and no model file is needed. Report its figures as
  browser figures, with the backend and the rows not kept, and never mix them with figures
  from `--frames`. [browser/README.md](browser/README.md) describes the page and the file.
- **The scoring page without a person:** `browser/examples/score-headless.mjs` runs it in a
  headless Chrome and writes the events file ([browser/README.md](browser/README.md),
  "Running the scoring page from a script"). It needs a Chrome on the machine and the package
  `puppeteer-core`, which `npm ci` does not install: ask before you install it.
- `browser/node_modules/` and `browser/dist/` are ignored by git. Never commit a build.

## Tier 2: Measure

Goal: numbers the person can state, and a routine for new cards. Read
[docs/method.md](docs/method.md) before reporting any figure.

**Three kinds of recording group.** Settle with the person which group is which before any
result is looked at:

- **training groups** train the models;
- **development (calibration) groups** are never trained on; every choice is made on them:
  the starting point to train from, the accept rule's thresholds (2.5), debugging a bank
  refresh (2.6) and regressions read one by one;
- **final-test groups** (the `evaluation` role) are never trained on and never used for a
  choice.

**Order for the person's game:** develop → calibrate on development groups → freeze the whole
release (1.6) → score the final test once → report. The toy steps below show the commands in
another order; the scoring in 2.4 is a development run. Never score the final test before the
release is frozen, and never score it again to choose between options. Once its results have
guided a change, it is a regression benchmark: say so when you report it.

### 2.0 A recording of the person's own

For a new game, the recordings to measure on are most likely the person's own (a phone or
screen recording). A manifest names one with `platform` `local` and a `video_id` that is a
name they choose (`data/SCHEMA.md`, "Recordings of your own"). This step runs the whole
route on the toy video of step 0.4 under the name `table`.

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

### 2.1 A toy labeled set

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

### 2.2 Validate the manifest

```
echo '{"sourceTypes": ["digital/toy-client"]}' > "$WORK/eval/sources.json"
cardvision validate-manifest "$WORK/eval/labels/toy.manifest.jsonl" \
    --catalog "$WORK/toy/catalog.json" --sources "$WORK/eval/sources.json"
```

- **Expect:** `valid: 4 row(s) in 1 file(s); card ids checked against the catalog`.
- **If it fails:** each line names the file, the row and the rule. `data/SCHEMA.md` lists the
  rules. Fix the labels at their source; do not hand-edit rows to make them pass.

### 2.3 Frames

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

### 2.4 Score (a development run)

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

With a release document, score that (this needs tier 1's toy release):

```
cardvision evaluate hover --manifest "$WORK/eval/labels/toy.manifest.jsonl" --frames "$WORK/frames" \
    --release "$WORK/release/release.json"
```

- **Expect, on the toy release:** `**named right**: 0 / 7 = 0.00 %`.

### 2.5 Calibrate the accept rule

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

### 2.6 Refresh the bank for new cards

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

### 2.7 Roles for new recordings

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

## Before you finish

Skip the `git status` line if the folder is not a git checkout.

```
git status --short
python -m pytest -q
```

- **Expect:** `git status --short` (if the folder is a git checkout; if it is not, list the
  files you created or changed instead) lists only files you meant to change, and no image,
  video or model file. The tests pass; in the base environment the only tests skipped are the ones
  that need PyTorch, the comparison with the browser runtime when `npm ci` has not been
  run in `browser/`, and, when the `ffmpeg` program is not installed, one test of
  `tests/test_data_extract.py` and the tests of `tests/test_data_frame_times.py` that read a
  recording of variable frame rate.
- Tell the person which steps ran on the toy game, which ran on their data, which you could
  not run, and every number you measured with its command.
