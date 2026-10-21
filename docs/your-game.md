<!-- SPDX-License-Identifier: Apache-2.0 -->

# Your game: names on your own video

You have a list of your game's cards, most likely a spreadsheet, a folder of card images and a
video. Three lines take you to card names on that video and a report that says what came out;
the demo page then lets you rest the pointer on a card to read its name. It uses the released
models as they are: no GPU, on a laptop. It is tier 0, **Try**, of the
[adapt guide](adapt-your-game.md).

**What to expect.** On the One Piece Card Game, the released models as they stood named
31.4 % of readable card faces right
([Measured on another game](adapt-your-game.md#measured-on-another-game-the-one-piece-card-game)).
Yours may do better or worse; this page finds out.

**You need:**

- the repository and its Python environment: steps 0 and 1 of the [quickstart](quickstart.md);
- for the demo page only, Node 22 or later (on macOS: <https://nodejs.org> or `brew install node`);
- card images you are entitled to use. This repository contains no card art.

**How to read the steps.** Paste a block after "Paste this into the terminal" whole, from the
repository's root with the virtual environment active (`. .venv/bin/activate`). A block after
"You should see something like" is what it prints, here from toy files standing in for yours:
`tests/test_your_game_path.py` runs every block on them, except the download, opening the
report and the `npm` lines.

## Your folders

Paste this into the terminal, from the repository's root:

```
export GAME="$HOME/Downloads/my-game"
export WEIGHTS="$HOME/Downloads/cardvision-weights"
mkdir -p "$GAME" "$WEIGHTS"
```

`$GAME` holds your files and what the steps write; `$WEIGHTS`, the released models. Both
are outside the repository on purpose. Put three things in `$GAME` (`open "$GAME"` shows the folder on macOS, `xdg-open "$GAME"` on Linux,
`(cd "$GAME" && explorer.exe .)` in WSL):

- **`cards.csv`**: your card list, exported from Excel, Numbers or Google Sheets as CSV (UTF-8);
  a TSV file or a JSON list of rows works too. Keep the export's own name if you like: then
  write it wherever the steps write `cards.csv`, inside the quotes, as in
  `"$GAME/My Cards.csv"`.
- **`images/`**: one cleanly cropped image per card, named as your list's image column says. A
  path with a folder (`HD/x.jpg`) keeps that folder inside `images/` (`images/HD/x.jpg`).
- **`video.mp4`**: a video of your game. A photo, a screenshot or a folder of them works too:
  use its name in place of `video.mp4`.

A new terminal forgets `$GAME`, `$WEIGHTS` and the virtual environment: paste
`. .venv/bin/activate` and the two `export` lines again.

## The three lines

**1. Get the released weights.** One command downloads the eight files of this repository's
[v0.1.0 release](https://github.com/ryangswe/riftsight-vision/releases/tag/v0.1.0) into
`$WEIGHTS`, checks each against the hashes this repository pins and runs `verify-release`
([Getting the released weights](release-files.md) has the same by hand). **Checked, not run
here:** it needs the network. Paste this into the terminal, from the repository's root:

```
cardvision fetch-weights "$WEIGHTS"
```

You should see the notice, then one line per file, then the release check:

```
downloading 8 files (about 8.5 MB) from https://github.com/ryangswe/riftsight-vision/releases/download/v0.1.0/ into ...
  SHA256SUMS: ok (561 bytes)
  release.json: ok (2601 bytes)
  ...
release 201478a00d6ef6ba: ok (...)
```

You use three of these files, `detector.onnx`, `recognizer.onnx` and `accept.json`; the rest
belongs to the released game, Riftbound.

**2. Try it on your cards.** `cardvision try` runs the commands of steps 1 to 6 below in one go.
Paste this into the terminal, from the repository's root:

```
cardvision try "$GAME/cards.csv" --images "$GAME/images" --video "$GAME/video.mp4" --weights "$WEIGHTS"
```

You should see something like:

```
[1/6] import-catalog: cards.csv -> $GAME/cardvision-try/catalog.json
[2/6] check-catalog: the catalog and the images in $GAME/images
[3/6] build-bank: one row per card image -> $GAME/cardvision-try/bank.json
  20 / 20 cards
[4/6] build-release and verify-release: the release folder $GAME/cardvision-try/release
[5/6] infer: one frame every 1 s, at most 16 frame(s) of 15 s (never over 60; --every or --max-frames to change)
[6/6] report: $GAME/cardvision-try/report.html
if the video does not play in the demo (MPEG-4 Part 2), convert it first: ffmpeg -i $GAME/video.mp4 -c:v libx264 -pix_fmt yuv420p $GAME/video-h264.mp4, then give $GAME/video-h264.mp4 to --file
Found and named: cards found in 15 of 15 frame(s), 75 of 75 face(s) named, 5 distinct card(s). Next: open the demo with the last line.
report: $GAME/cardvision-try/report.html
cd browser && npm ci && npm run demo -- --release $GAME/cardvision-try/release --images $GAME/images --file $GAME/video.mp4
```

It writes everything into `$GAME/cardvision-try/`. On a fresh clone the demo line starts with
`npm ci &&`, which installs the page's packages once (Node 22 or later). If the import stops and names your columns,
add `--map id="HEADER"` with the header of your id column, as step 1 below explains.
**Running it again** needs `--overwrite`, which replaces only what an earlier `try` wrote.

**3. Open the report.** Paste this into the terminal, from the repository's root (on Linux,
`xdg-open` in place of `open`; in WSL, `explorer.exe "$(wslpath -w "$GAME/cardvision-try/report.html")"`):

```
open "$GAME/cardvision-try/report.html"
```

The report says which of three outcomes it was, with the numbers, the contact sheet and the
annotated frames:

- **Found and named:** the released models carry over. Run the last line `try` printed to see
  it in the demo page (step 6 below), then [Extension](extension.md).
- **Found, few named:** the recognizer does not separate your cards: [Train](train.md).
- **No cards found:** read step 5 below.

The report, `try.log` and the demo line hold absolute paths that name your home folder, and
often your user name: check them before you share them.

## What `try` did, step by step

The same commands, one at a time, for when you want to see or change one. They write into
`$GAME` itself, where `try` wrote into `$GAME/cardvision-try/`.

### 1. Import your card list

`cardvision import-catalog` turns your list into a **catalog**, the one file your game has to
supply: every card's id, name, kind and image. Paste this into the terminal, from the
repository's root:

```
cardvision import-catalog "$GAME/cards.csv" --out "$GAME/catalog.json" --game my-game \
    --images "$GAME/images"
```

You should see something like:

```
read $GAME/cards.csv (csv): 20 row(s)
columns: id <- 'Card No.', name <- 'Card Name', kind <- 'Type', image <- 'Image'
extra (every column that is no field and no facet): Text
  Choose with --extra COL,... (only those), --facets COL,... (filters), or --no-extra.
identity: "name" (suggested; pass --identity to choose). ...
one name under several ids (2 name(s)):
  'Coral Triangle': TOY-003, TOY-003A
...
check-bank-art on $GAME/images: 20 with a usable image, 0 with no image, 0 unreadable
wrote $GAME/catalog.json: 20 card(s)
```

The report says which column fed each field. It knows the usual headers (`Card No.`,
`Set Code`, `Card Title`, `Picture` and others); when it cannot tell which column holds the
id, it stops, writes nothing and names your columns: run it again with
`--map id="HEADER"`, your id column's header. Ids cannot hold spaces: replace them in the sheet
before exporting (`SET-049 (p1)` as `SET-049_(p1)`, as the error suggests). Other columns, such
as rules text, go to each card's `extra`, which no model reads.

**Images as web links, or none?** Links stay links; `--download --art-out "$GAME/images"`
fetches them, only for images you are allowed to download. With no image column, every card
gets `"art": null` and the bank has nothing to compare with: add the images first.

**Decide what counts as the same card.** Under `"name"`, the default, entries with the same
name are one card. If different cards in your game share a name, import with
`--identity printing` and fill in `printing_of` for alternate printings; do not change names.

**Cards without a usable image** (none, a placeholder, a vector file) keep their id and get no
bank row. Images should look like the cards on screen, without overprints or watermarks the
real cards lack.

**If it stops for another reason:**

- `NAME is a spreadsheet file`: export it as CSV (UTF-8) and import the `.csv`.
- `the header looks semicolon-separated`: add `--delimiter ';'`.
- `catalog.json exists; pass --overwrite to replace it`: you are running it again, and it
  refuses whenever the catalog exists. Add `--overwrite`.
- Duplicate ids, or a `printing_of` that names no card: fix the list, then import again.

[docs/commands.md](commands.md#cardvision-import-catalog) has every option;
[games/_template/README.md](../games/_template/README.md), every field. To write a catalog by
hand, copy the template into a folder of its own, never into `$GAME`.

### 2. Check the catalog and the images

Paste this into the terminal, from the repository's root:

```
cardvision check-catalog "$GAME/catalog.json" --art "$GAME/images"
```

You should see something like:

```
20 cards (0 without art), identity rule: name, game: my-game
card images: $GAME/images (20 catalog cards; 20 with a usable image)
  0 with no image under --art
  0 with a file that holds no picture
  0 with a picture that looks like a placeholder
```

It names every card whose image is missing, is not a picture or looks like a placeholder, and
every image file (the same bytes) under cards of different identities. A reprint sharing its
base card's picture under the default name rule is one identity, fine, and not listed. Fix the
file or the list, and import again with `--overwrite`.

### 3. Build a bank

The bank holds one row per card: the recognizer turns each card image into a list of 128
numbers, a fingerprint that a crop from video is compared with. Paste this into the terminal,
from the repository's root:

```
cardvision build-bank --catalog "$GAME/catalog.json" --art "$GAME/images" \
    --recognizer "$WEIGHTS/recognizer.onnx" --out "$GAME/bank.json"
```

You should see something like:

```
  20 / 20 cards
bank: $GAME/bank.json (20 rows of 128 values; 20 embedded, 0 kept from the base bank)
identity groups: $GAME/bank.identity-groups.json
```

Lines under `look at these before you rely on the bank:` name doubtful pictures, and cards of
different identities with nearly the same row (usually one picture filed under two cards): fix
the file or the list. Add `--skip-missing-art` to leave out cards whose
image file is not there. **Running it again after a fix:** add `--overwrite`; without it, a
bank that came out different is refused (one that came out the same is left as it is). A bank
of 1,472 cards took 157 s on an Apple M3 Max laptop.

### 4. Run it on your video

Paste this into the terminal, from the repository's root:

```
mkdir -p "$GAME/out"
cardvision infer "$GAME/video.mp4" --every 5 \
    --detector "$WEIGHTS/detector.onnx" --recognizer "$WEIGHTS/recognizer.onnx" \
    --accept "$WEIGHTS/accept.json" --bank "$GAME/bank.json" --catalog "$GAME/catalog.json" \
    --annotate "$GAME/out/annotated" --crops "$GAME/out/crops" \
    --contact-sheet "$GAME/out/sheet.png" --art "$GAME/images" > "$GAME/out/results.jsonl"
```

You should see something like:

```
cardvision infer: the contact sheet is $GAME/out/sheet.png
cardvision infer: 3 frame(s), 15 face(s), 3 back(s), 15 named
cardvision infer: boxes per frame, fewest / median / most: faces 5 / 5 / 5, backs 1 / 1 / 1
```

`--every 5` takes one frame every five seconds, not every fifth frame: for a clip of a few
seconds use `--every 1`; for a long video, a larger number. In `$GAME/out` it wrote:

`annotated/` (frames with boxes and names), `crops/`, `sheet.png` (the **contact sheet**:
each crop beside its three best matches, in pages beyond 20 crops) and `results.jsonl`
([the fields](how-it-works.md#what-cardvision-infer-prints)).

The accept rule in `accept.json` decides when a match is named: `tau` 0.62 is how sure the
match must be, and `delta` 0.05 how far ahead of the runner-up. It was calibrated for the
released game, not for yours: treat the names as provisional until you
[Measure](measure.md).

**No video yet?** `infer` takes a photo, a screenshot or a folder of images too. With only
card images, draw a few test scenes. Paste this into the terminal, from the repository's root:

```
cardvision make-composites --catalog "$GAME/catalog.json" --art "$GAME/images" \
    --out "$GAME/scenes" --n 3 --seed 1 --split val
```

You should see something like:

```
  3 / 3 scenes
wrote 3 scenes to $GAME/scenes: 25 positive faces showing 14 different cards, 10 more faces marked as ignore regions (too hidden or too small), 3 backs
```

The scenes are a harder test than a clear photo. Run the models on them, into a folder of
their own. Paste this into the terminal, from the
repository's root:

```
mkdir -p "$GAME/out-scenes"
cardvision infer "$GAME/scenes/images" \
    --detector "$WEIGHTS/detector.onnx" --recognizer "$WEIGHTS/recognizer.onnx" \
    --accept "$WEIGHTS/accept.json" --bank "$GAME/bank.json" --catalog "$GAME/catalog.json" \
    --annotate "$GAME/out-scenes/annotated" --contact-sheet "$GAME/out-scenes/sheet.png" \
    --art "$GAME/images" > "$GAME/out-scenes/results.jsonl"
```

Each scene comes with exact labels, so it can be scored. Paste this into the terminal, from
the repository's root:

```
cardvision evaluate hover --scenes "$GAME/scenes" \
    --detector "$WEIGHTS/detector.onnx" --recognizer "$WEIGHTS/recognizer.onnx" \
    --accept "$WEIGHTS/accept.json" --bank "$GAME/bank.json" --catalog "$GAME/catalog.json"
```

Among the report's lines, you should see something like:

```
- events: 24 in 1 recording groups
- **named right**: 0 / 22 = 0.00 %; exact one-sided 95 % lower bound 0.00 % (assumes independent events); group bootstrap: no interval (fewer than two recording groups)
```

*Named right* is how often the pointer, resting on the middle of a card, would show its name;
*wrong of shown*, how much of what was shown was wrong. A card mostly hidden or tiny is an
ignore region, left out of every rate and counted. **This is a first look, not a
measurement:** [Measure](measure.md) measures on real recordings.

### 5. Read the result

Open `$GAME/out/annotated/` and `$GAME/out/sheet.png` (past 20 crops, `sheet-1.png`,
`sheet-2.png`, ...); the contact sheet shows only the cards the detector found.

- **Does the detector find your cards?** Compare the boxes in the annotated frames with the
  cards you can see.
- **Does the recognizer name them?** On the contact sheet, is the right card the top match of
  each crop, well clear of the next?

**If there are no boxes at all**, the command says so before its summary line, with the
highest score the detector gave anything in each such frame. It looks like this:

```
cardvision infer: no box in 1 of 1 frame(s); the detector keeps a box at a score of 0.30 or more
cardvision infer: table.png: highest score 0.00, threshold 0.30
```

**The released detector does not see the cards in this video, and this page can go no
further.** Try a clearer, larger, more top-down view of the same cards. If that does not help,
the next tier is [Train](train.md): training the detector for your game takes a GPU (a rented
one will do), some labeling and about a weekend.

### 6. See it in the demo page

The demo page shows your video with the card under the pointer named. It loads a
**release folder**: the two models, the accept rule, your catalog, your bank and a release
document that records a fingerprint of each file, so that a changed or swapped file is
refused. Take three files from `$WEIGHTS`, and none of the released game's bank, catalog or
identity groups. Paste this into the terminal, from the repository's root:

```
mkdir -p "$GAME/release"
cp "$WEIGHTS"/{detector.onnx,recognizer.onnx,accept.json} "$GAME/release/"
cp "$GAME/catalog.json" "$GAME/bank.json" "$GAME/bank.identity-groups.json" "$GAME/release/"
cardvision build-release --detector "$GAME/release/detector.onnx" \
    --recognizer "$GAME/release/recognizer.onnx" --bank "$GAME/release/bank.json" \
    --catalog "$GAME/release/catalog.json" --accept "$GAME/release/accept.json" \
    --out "$GAME/release/release.json"
cardvision verify-release "$GAME/release/release.json"
```

You should see something like:

```
release 3ca33e5e5431b3f9: $GAME/release/release.json
release 3ca33e5e5431b3f9: ok (my-game, 20 cards in the bank, 20 in the catalog; every file present, unchanged and consistent)
bank: 20 of 20 rows record their source image (artV)
```

Your release id will differ. **Running it again after a fix:** add `--overwrite` to
`build-release`; without it, a release that came out different is refused. Then start the demo
page on it, with your images and your video (Node 22 or later; not run by this page's test). Paste
this into the terminal, from the repository's root (the first line moves into `browser/`):

```
cd browser
npm ci
npm run demo -- --release "$GAME/release" --images "$GAME/images" --file "$GAME/video.mp4"
```

After npm's own lines and the build's, you should see something like this. npm's
`npm warn install-scripts ... not yet covered by allowScripts` lines (esbuild, fsevents,
protobufjs) and the build's `OpenCV.js NOT copied ... runs without the geometric stage` line are
expected and harmless:

```
demo: http://127.0.0.1:8765/
...
open the file in the demo: http://127.0.0.1:8765/?file=/file/video.mp4&images=/images/
```

Open the address on the last line in a browser (on a Mac, ⌘-click it in the terminal). When the
line under the picture reads `Ready. Move over a face-up card.`, rest the pointer on a card:
the tooltip shows its image, name and id. If the page says it cannot open the video, convert
it to H.264: `ffmpeg -i in.mp4 -c:v libx264 -pix_fmt yuv420p video.mp4`
(install ffmpeg with `brew install ffmpeg`, `sudo apt install ffmpeg` or `winget install ffmpeg`,
or export an H.264 MP4 from your video editor). Control-C stops the server; `cd ..` returns to
the repository's root.

## Next

- **Names show on your video?** Make it a browser extension your viewers install:
  [Extension](extension.md).
- **They don't, or too few?** [Train](train.md), with a GPU and some labeled frames.
- **Numbers you can publish?** [Measure](measure.md).
- **Something failed?** [If something fails](adapt-your-game.md#if-something-fails).
