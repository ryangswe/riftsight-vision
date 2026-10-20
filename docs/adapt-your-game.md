<!-- SPDX-License-Identifier: Apache-2.0 -->

# Adapt it to your game

This guide takes you from a folder of your game's card images to card names on your game's
video. It comes in three tiers. Do them in order and stop when you have what you need.
[The process at a glance](overview.md) shows the tiers and their loop as one diagram.

| Tier | You need | You do | You get |
| --- | --- | --- | --- |
| [0. Try it](#tier-0-try-it) | A folder of your game's card images, and a laptop | Write a catalog file. Build a bank with the released recognizer. Run it on a video. | Names on clear, front-facing cards, **if** the released models carry over to your game |
| [1. Make it yours](#tier-1-make-it-yours) | A GPU, and some of your game's footage | Generate training scenes from your card images. Label some real frames. Fine-tune both models. | Models for your game's cards, clients and tables, and optionally a browser extension built on them |
| [2. Ship it](#tier-2-ship-it) | Recordings held out from training | Calibrate the accept rule on development recordings. Freeze the release, then score the final test once. Extend the bank when a set comes out. | Numbers you can state, and a routine for new cards |

**Read this first.**

- **On one other game, the released models as they stand named 31.4 % of readable card faces
  right, and models trained with this guide 74.4 %.** That game is the One Piece Card Game,
  on a small held-out set with wide intervals: see
  [Measured on another game](#measured-on-another-game-the-one-piece-card-game). Tier 0 is how
  you find out for yours.
- **Every command on this page was run on a toy game** that the repository draws from plain
  shapes, on an Apple M3 Max laptop (48 GB, macOS, Python 3.10). The output shown is real. It
  proves that the commands work. It says nothing about accuracy on a real game.
- Where a command could not be run here, it says **not run here** and why.
- You need images of your game's cards that you are entitled to use. This repository
  contains no card art for any game, and before you publish a bank or weights for a game you
  do not own, check what its publisher allows.
- [AGENTS.md](../AGENTS.md) has the same steps in a form a coding agent can run and check.

## Measured on another game: the One Piece Card Game

The steps of this guide were followed for a second card game, the One Piece Card Game. Its
catalog, bank, weights and labels live in their own repositories, not here: the [models](https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece) and the [labels](https://huggingface.co/datasets/JuicyKaraageNo1/kenbunshoku-onepiece-labels) on Hugging Face. No card
art is included there either.

**What was done.**

- **The released models as they stand (tier 0).** The released detector and recognizer,
  unchanged, with a bank built from the game's card images.
- **Trained models (tier 1).** Both models fine-tuned with the published trainers on 8,000
  scenes generated from the game's official card images (not included in either repository)
  and a few labeled frames of real video: 13 frames after a first labeling sitting, then 23
  frames from 12 recording groups after a second. The 23-frame models are the example's
  default. Six more frames, from three other recording groups, were kept out of training and
  used only to choose between the two trained sets.
- **The optional geometric stage** (tier 2, step 7) on top of the default, with settings
  chosen on development data and fixed before the test.

**How it was measured.** 25 frames of 13 public videos from 9 recording groups, none of them
in training: 2 digital groups (a digital client) and 7 physical ones (4 webcam or phone, 3
tournament). A person marked the center of every card, and labeled what lies under 100 points
placed at random over the frames, most of them off the cards: 572 hover events, 297 of them on
readable card faces. Wrong of shown below is the share of counted tooltips that are wrong under
this target-sampling protocol, not a measured frequency for real viewers. The models, the
comparisons and what each outcome would decide were written down before any of these frames
was scored, and the frames were scored once, in Python
(`cardvision evaluate hover` and `evaluate compare`). Every arm used the released accept rule
(`tau` 0.62, `delta` 0.05), not tuned for this game. Intervals are 95 % group-bootstrap
intervals over recording groups (10,000 resamples, seed 0). The arms on the older catalog
score 296 readable faces: one face is a printing only the newer catalog has.

| Arm | Named right (95 % interval) | Wrong of shown (95 % interval) |
| --- | --- | --- |
| Released models, bank for this game | 93/296 = 31.4 % (23.7–42.5) | 11/104 = 10.6 % (4.2–28.0) |
| Detector trained, released recognizer | 171/296 = 57.8 % (31.7–68.1) | 16/187 = 8.6 % (3.6–28.1) |
| Both trained, 13 frames | 222/296 = 75.0 % (51.5–84.2) | 8/230 = 3.5 % (0.8–12.9) |
| Both trained, 23 frames (the default) | 221/297 = 74.4 % (50.3–83.8) | 9/230 = 3.9 % (1.6–11.8) |
| The default with the geometric stage | 249/297 = 83.8 % (62.5–91.8) | 7/256 = 2.7 % (0.6–10.3) |

| Arm | Physical, 7 groups: named right | Physical: wrong of shown | Digital, 2 groups: named right | Digital: wrong of shown |
| --- | --- | --- | --- | --- |
| Released models | 35/123 = 28.5 % (17.8–39.8) | 10/45 = 22.2 % (10.9–41.2) | 58/173 = 33.5 % | 1/59 = 1.7 % |
| Detector trained | 45/123 = 36.6 % (21.4–48.2) | 13/58 = 22.4 % (11.5–41.2) | 126/173 = 72.8 % | 3/129 = 2.3 % |
| Both trained, 13 frames | 69/123 = 56.1 % (42.9–68.6) | 6/75 = 8.0 % (0.9–23.1) | 153/173 = 88.4 % | 2/155 = 1.3 % |
| The default | 68/124 = 54.8 % (41.0–67.1) | 7/75 = 9.3 % (3.2–18.8) | 153/173 = 88.4 % | 2/155 = 1.3 % |
| The default with the stage | 84/124 = 67.7 % (51.2–80.4) | 6/90 = 6.7 % (0.8–17.3) | 165/173 = 95.4 % | 1/166 = 0.6 % |

Digital figures rest on 2 recording groups and are given as counts and descriptive percentages,
without intervals.

**The comparisons written down before scoring,** as computed (paired, on the same events;
the interval end that each claim rested on is in brackets):

- **The default against the released models: passed.** Named right +42.91 points (lower end
  +22.42), wrong of shown −6.65 points (upper end −1.15); on physical play alone, +26.02
  (+14.41) and −12.76 (−0.08). Read it with this beside it: the released models named a card
  on only 104 of the 571 events they were scored on, and a gain over models that name little
  is to be read with that in view. In this comparison the default's wrong of shown is 9/229 =
  3.93 %, not the 9/230 of the table: a paired comparison scores the events that both arms
  have, and the released models' older catalog lacks one printing, a face the default named
  right.
- **The geometric stage on the default: passed.** Named right +9.43 points (lower end +6.65),
  wrong of shown −1.18 points (upper end +0.42); on physical play alone, reported but not a
  condition, +12.90 (+6.60) and −2.67 (+0.65). So on this game's real footage the stage
  helps. In the Python package it stays optional and off by default.
- **13 frames against 23 frames: reported only.** Named right +0.34 points (lower end −0.99):
  the two are not separated. The 23-frame models were made the default before the test, on
  the six development frames, by a narrow margin; nothing here shows them better than the
  13-frame models.
- **The accept rule recalibrated on the 23 training frames** (`tau` 0.60, `delta` 0.07),
  reported only: 226/297 = 76.1 % (54.5–84.4) named right, 14/240 = 5.8 % (2.2–17.3) wrong of
  shown. The released rule stays the default.

**What to keep in mind.**

- **The set is small.** 25 frames from 13 videos in 9 recording groups, 2 of them digital. The
  intervals are wide, and with 9 groups a percentile bootstrap tends to run narrow, so they
  are if anything optimistic. One digital recording group holds 135 of the 297 readable faces,
  and the overall figures lean on it.
- **Physical play is well below digital.** The default named 68/124 right on physical play
  against 153/173 on digital; webcam and phone footage was the hardest (39/80, against 29/44
  on tournament footage; counts only).
- **DON!! cards.** The game's DON!! cards come in many art variants that count as one
  identity, and they are 40 of the 283 readable faces whose center a person marked. Without
  them the default names 193/256 = 75.4 % (50.3–84.8) right with 9/202 = 4.5 % (1.9–13.6)
  wrong of shown, and with the stage 221/256 = 86.3 % (64.3–94.3) and 7/228 = 3.1 %
  (0.6–11.7). The released models: 84/255 = 32.9 % (19.7–45.5) named right.
- **SAMPLE-stamped cards.** Most official images of set and starter cards, from which the bank
  was built, carry a large pale "SAMPLE" overprint, and the digital client shows the same
  images; physical cards do not carry it. Of the 168 readable digital faces whose center was
  marked, an automatic check found the overprint on 18: the default named 15/18 of them right
  and 134/150 of the others, and with the stage 18/18 and 143/150. Counts only, with no claim
  of cause: in a spot check of that automatic check, 8 of 10 overprint marks were right (the
  two others belonged to a neighboring card), and 16 of the 18 are in one recording group.
- **Tournament footage from the game's publisher** is in both the training and the held-out
  sources (different recordings). On its held-out faces the default named 22/28 right; on the
  other tournament's, 7/16 (counts only).

Labels for every frame above, training and held-out, are published with the example as
manifests, without frames: `cardvision fetch` obtains the frames from the public videos.

## Before you start

Start by getting the code: step 0 of the
[quickstart](quickstart.md) clones the repository, or
downloads it as a ZIP. Run everything from the repository's root.
The commands are written for a POSIX shell (macOS or Linux). On Windows, run them in Ubuntu
under WSL: see "Which computer?" in the [quickstart](quickstart.md).

**What was checked where.**

| Platform | What was checked |
| --- | --- |
| macOS | The commands on this page, run by hand (Apple M3 Max laptop) |
| Linux, and Ubuntu under WSL 2 on Windows | The quickstart's toy workflow, run in CI (`.github/workflows/quickstart.yml`) |
| GPU training | Exercised on a rented Linux machine with an NVIDIA RTX 4090 (tier 1). CUDA under WSL is not covered by this guide |
| Windows, natively (PowerShell or Command Prompt) | Not supported |

**How to read the steps.** A block after "Paste this into the terminal" holds commands: copy
the whole block, paste it into the terminal and press Return. A block after "You should see
something like" is what the commands print: you do not type it. Your timings, ids and folder
names will differ.

**Install** (Python 3.10 or later). Paste this into the terminal, from the repository's root:

```
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-lock.txt
python -m pip install --no-deps -e .
cardvision --version
```

pip prints many lines while it installs (a notice that a newer pip exists is harmless). You
should see something like this as the last line:

```
cardvision 0.1.0
```

**Pick a work folder outside the repository.** Images, frames and model files must never land
in the repository. This page uses `cardvision-toy` in your Downloads folder, where you can find
it: it is outside the repository on purpose, and you can delete it when you are done. Paste
this into the terminal, from the repository's root:

```
export WORK="$HOME/Downloads/cardvision-toy"
mkdir -p "$WORK"
```

`$WORK` in the commands and the output below stands for that folder; the terminal prints its
full path. On macOS, `open "$WORK"` shows it in the Finder. A new terminal forgets `$WORK` and
the virtual environment: paste `. .venv/bin/activate` and the `export` line again first.
Running a step again replaces what it wrote, except where a step refuses to (see "If something
fails" at the end). To start over from nothing, delete the whole folder with
`rm -rf "$HOME/Downloads/cardvision-toy"`. That deletes everything in it at once and does not
ask, so keep nothing in it that you have not saved elsewhere, such as your own catalog.

**Draw the toy game and build stand-in models.** The released weights are release assets
([Getting the released weights](release-files.md) lists them). To check the commands without them, one script draws a toy game (20 cards made of
colored shapes, with a catalog), builds two tiny stand-in models, and runs them on a test scene.
Paste this into the terminal, from the repository's root:

```
python examples/toy_quickstart.py "$WORK/toy"
```

You should see something like:

```
wrote $WORK/toy/catalog.json and 20 images in $WORK/toy/art
wrote stand-in models, a staged bank and a test scene in $WORK/toy
table.png: 7 boxes
  0  face  named Amber Circle    best match TOY-001 Amber Circle, similarity 1.000, margin 0.139, look 0
  1  face  named Coral Triangle  best match TOY-003 Coral Triangle, similarity 1.000, margin 0.172, look 3
  2  face  named nothing         best match TOY-001 Amber Circle, similarity 0.842, margin 0.108, look 0
  3  face  named nothing         best match TOY-015 Plum Triangle, similarity 1.000, margin 0.000, look 0
  4  face  named Amber Stripes   best match TOY-017 Amber Stripes, similarity 1.000, margin 0.139, look 0
  5  back  never named
  6  face  named nothing         best match TOY-005 Plum Stripes, similarity 0.785, margin 0.040, look 3
1 frame, 6 faces, 3 named
```

This writes `catalog.json`, the card images in `art/`, `recognizer.onnx`, `detector.onnx`,
`accept.json`, `bank.json` and a test scene, `table.png`, into `$WORK/toy`. The toy game and
the stand-ins belong to the test suite; the script imports them from `tests/`. Its bank,
`bank.json`, is staged so that the accept rule has something to refuse: one card is left out
and two cards share a row, which is why three faces are named nothing. Step 2 of tier 0
builds a bank of all 20 cards.

**Know what the stand-ins are.** They have no skill.

- The stand-in recognizer is an average pool and a fixed random projection. It can tell the
  toy cards apart and nothing else.
- The stand-in detector **does not look at the image**. It returns the same boxes for any
  frame: the boxes of the cards in `table.png`.
- `accept.json` is strict (`tau` 0.99) because the stand-in recognizer's scores are all high.

Wherever a command below takes `--detector` and `--recognizer`, use the released files for
real work.

---

## Tier 0: Try it

**You need:** a folder of your game's card images; a laptop. No GPU.

**Time:** one trial run that followed this guide step by step, on another card game with a
catalog of 5,334 cards, took about an hour for all of tier 0; building the bank was 9 min
54 s of it, on a laptop's CPU (Apple M3 Max). Expect a first time through to take longer.
The aim is an afternoon. On the toy game every command below
finishes in about a second.

**What to expect:** on the One Piece Card Game, the released models named 31.4 % of readable
card faces right ([Measured on another game](#measured-on-another-game-the-one-piece-card-game));
your game may do better or worse. If the detector finds your
cards and the recognizer's vectors separate them, you get names on clear, front-facing cards.
If not, you will see it in step 4, and tier 1 is the way forward.

### 1. Write the catalog

The catalog is the one file your game has to supply: every card's id, name, kind and image
file. Start from the template.
Paste this into the terminal, from the repository's root:

```
cp -r games/_template "$WORK/my-game"
```

It prints nothing. Run it once: run again, it copies the template a second time inside the
first, as `$WORK/my-game/_template`, and leaves your own files as they are.

**Decide what counts as the same card, before you write a name.** The tools have to know
which entries are one card. Naming one of them for another is then right, and two of them
scoring alike is not doubt. There are two rules, and the catalog states one in a top-level
`"identity"` field.

- `"name"` is the default: leave the field out. Entries with exactly the same name are one
  card. Use it when a name is one card in your game and its printings differ only in their
  picture. Example: `Amber Circle` in the first set and `Amber Circle` with promotional art
  are two entries with one name, and either answer is right for either.
- `"printing"`: an entry is a card of its own unless its `printingOf` names another entry.
  The same name joins nothing. Use it when different cards share a name in your game.
  Example: two cards are both called `Amber Circle`, with their own numbers and their own
  text, and each has an alternate-art printing. That is four entries: the two cards with
  `"printingOf": null`, and each alternate with the id of its own card in `printingOf`. One
  `Amber Circle` shown for the other is then a wrong answer.

How to choose: two entries that a player would call different cards must be different
identities. If any name in your card list belongs to more than one such card, write
`"identity": "printing"` above `"cards"`. Do not change a name to tell cards apart, by adding
an id to it for instance: the name is what a viewer is shown, and every tool reports the id
beside it.

Then edit `$WORK/my-game/catalog.json`. `games/_template/README.md` explains every field.

**Already have a spreadsheet?** Save it as CSV (or TSV, or have a JSON list of rows) and import
it in place of the template's catalog:

```
cardvision import-catalog cards.csv --out "$WORK/my-game/catalog.json" --game my-game \
    --images /path/to/images
```

It finds the id, name, type, reprint and image columns by their headers, sends the other
columns to each card's `extra` (or to filters, with `--facets`), and reports duplicate ids,
names under several ids, the identity rule it suggests and the cards without art.
`games/_template/cards.example.csv` is a sheet with the columns it expects, and
[docs/commands.md](commands.md#cardvision-import-catalog) has every option. Image URLs stay
URLs in the catalog; `--download` fetches them, slowly. Download only images you are allowed
to, and prefer the source's bulk download or files you already have. Then read on: the rules below hold for an imported catalog
too.
The rules that matter most:

- `id` is unique, 1 to 64 characters, with no space or other whitespace and no control
  character. Use your game's collector numbers.
- `name` is the card's name, as a viewer should read it. Under the default rule it is also the
  card's identity: two entries with exactly the same name are printings of one card.
- `printingOf` is `null`, or for an alternate printing the id of the card it is a printing of.
- `art` is the image's file name inside the folder you will pass as `--art`, or `null` for a
  card without art (below).
- `facets` (optional) gives the labeling tool filters beside the card's `kind`: color, cost,
  set and the like. The template shows three; delete them if you do not need them.
- `extra` (optional) is an object for anything else you want to keep with a card, such as its
  rules text. Nothing reads it.

**Give an entry that has no usable image `"art": null`.** A card whose image you do not have,
or have only as a placeholder or a vector file, cannot be recognized, and a row computed from
the wrong picture takes names away from other cards. Listed as a *card without art*, it keeps
its id and identity, so a label can still name it, and it gets no bank row:

```json
{"id": "SET-P07", "name": "Seventh Promo Card", "kind": "creature", "printingOf": null, "art": null}
```

Give it its `art` when you have the image, and extend the bank. (For a file that is simply not
there, `--skip-missing-art` in step 2 leaves the entry out of the bank instead.)

**Your card images should look like the cards as they appear on screen.** The bank is computed
from these images, and a crop from video is compared with it. An overprint, a watermark or a
border that the real cards do not have is a difference the models have to bridge, and only
real footage will show how well they do.

(Keep your game's folder outside this repository, or in your own fork. Other games'
catalogs are not taken into this repository.)

Check that it loads.
Paste this into the terminal, from the repository's root:

```
python -c "import sys; from cardvision.core.catalog import load_catalog; print(len(list(load_catalog(sys.argv[1]))), 'cards')" "$WORK/toy/catalog.json"
```

You should see something like:

```
20 cards
```

A catalog with a mistake is refused with the card id and the position of the first problem.

Then look at the images, before any bank is built. With no bank, `check-bank-art` reads the
image of every card of the catalog.
Paste this into the terminal, from the repository's root:

```
cardvision check-bank-art --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art"
```

You should see something like:

```
card images: $WORK/toy/art (20 catalog cards; 20 with a usable image)
  0 with no image under --art
  0 with a file that holds no picture
  0 with a picture that looks like a placeholder
```

For your game it names every entry whose image is missing, is not a picture (a vector file, a
web page saved under an image's name, a download that broke off) or looks like a placeholder,
and every image file that different cards share. It only reports, and exits with 0.

### 2. Build a bank

One row per card, computed from the card images by the recognizer.
Paste this into the terminal, from the repository's root:

```
cardvision build-bank --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" \
    --recognizer "$WORK/toy/recognizer.onnx" --out "$WORK/toy/bank-all.json"
```

You should see something like:

```
  20 / 20 cards
bank: $WORK/toy/bank-all.json (20 rows of 128 values; 20 embedded, 0 kept from the base bank)
identity groups: $WORK/toy/bank-all.identity-groups.json
```

For your game, pass your catalog, your image folder and the released recognizer. Add
`--skip-missing-art` to leave out cards whose image you do not have.

If the command ends with lines under `look at these before you rely on the bank:`, read them:
they name pictures that look like placeholders, image files that different cards share, and
cards of different identities whose bank rows are nearly the same (a cosine of 0.99 or more).
The last usually means the same picture filed under two cards, or one card's image filed under
another's id; look at each listed image and fix the file or the catalog, because the accept
rule cannot tell such cards apart and names neither. The toy game lists nothing.

Each row records the image it was computed from, as `artV`: the first 16 hexadecimal digits of
the SHA-256 of the image file's bytes. A later refresh uses it to tell when a card's image has
changed (tier 2, step 5).

**Time:** a bank of 1,472 cards took 157 s on the Apple M3 Max laptop, built with a
recognizer of the released architecture.

### 3. Run it on a video

For the toy check there is no real video, so make one: 15 seconds of the test scene.
Paste this into the terminal, from the repository's root:

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
```

Then paste this into the terminal, from the repository's root:

```
cardvision infer "$WORK/toy/table.mp4" --every 5 \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json" \
    --annotate "$WORK/tier0/annotated" --crops "$WORK/tier0/crops" \
    --contact-sheet "$WORK/tier0/sheet.png" --art "$WORK/toy/art"
```

It prints one JSON line per analyzed frame, and on standard error you should see something like:

```
cardvision infer: the contact sheet is $WORK/tier0/sheet.png
cardvision infer: 3 frame(s), 18 face(s), 3 back(s), 15 named
cardvision infer: boxes per frame, fewest / median / most: faces 6 / 6 / 6, backs 1 / 1 / 1
```

Three frames (`--every 5` takes one every five seconds), six faces and one card back in each,
five faces named. The sixth is a card cut in half by the frame's edge, and the accept rule says
nothing for it. In the JSON, each `box` is `[x, y, width, height]`: the card's top-left corner
and size, in pixels of the original frame ([the fields](how-it-works.md#what-cardvision-infer-prints)).

The last line is there for a video: a card that is missed in every frame does not show in the
totals. Card backs are a separate class and may be missed on a new game; compare the count
with what is on the table.

It also wrote:

- `tier0/annotated/`: each frame with its boxes and names drawn;
- `tier0/crops/`: each face crop as the recognizer saw it;
- `tier0/sheet.png`: the **contact sheet**, each crop beside its three best matches. A sheet
  of more than 20 crops is written as pages, `sheet-1.png`, `sheet-2.png` and so on, and the
  first line above names them. `--contact-sheet-rows` (default 60) limits the crops over all
  pages.

**For your game** (not run here: needs the release assets).
Paste this into the terminal, from the repository's root:

```
cardvision infer YOUR-VIDEO.mp4 \
    --detector DETECTOR.onnx --recognizer RECOGNIZER.onnx \
    --bank "$WORK/my-game/bank.json" --catalog "$WORK/my-game/catalog.json" \
    --contact-sheet "$WORK/my-game/sheet.png" --art /path/to/your/card/images
```

**If you have no video**, a photo or a screenshot works as input: `cardvision infer` takes
images as well as video, and a folder of images too. If you have only card images, with no
picture of a table, draw a few test scenes from them. Each comes with exact labels.
Paste this into the terminal, from the repository's root:

```
cardvision make-composites --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" \
    --out "$WORK/tier0/scenes" --n 3 --seed 1 --split val
```

You should see something like:

```
  3 / 3 scenes
wrote 3 scenes to $WORK/tier0/scenes: 25 positive faces showing 14 different cards, 10 more faces marked as ignore regions (too hidden or too small), 3 backs
```

The scenes are images in `$WORK/tier0/scenes/images/`; run `cardvision infer` on them as above.
`--split val` keeps them apart from the training scenes of tier 1. They are a harder test than
a clean table: the cards are small, turned, overlapped and blurred, and some are shown face
down. A poor result on them does not mean a poor result on a clear photo. (On the toy game the
stand-in detector ignores the image, so this only shows that the command works.)

The generator knows where every card of a scene is and which card it is, so the scenes can be
scored against their exact labels. This is the scorer of tier 2, with its rules and its
intervals; there is no need to match boxes to `labels.jsonl` yourself.
Paste this into the terminal, from the repository's root:

```
cardvision evaluate hover --scenes "$WORK/tier0/scenes" \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json"
```

The report opens by saying what it is about. Among its main parts, you should see something like
this (from this run):

```
**These rows are generated scenes, not footage.** `cardvision make-composites` drew them from card images: 3 scenes, split `val`, seed 1. Generated scenes are a harder and a different test from a real table: the cards are small, turned, overlapped and blurred, and the table is drawn by code. Figures on them say whether the tools run and roughly where the models stand. They do not say how the models do on real video.

- rows: one generated scene each. The generator labels every card it draws, so every scene is an exhaustively boxed frame, and hover events are the centers of its boxes
- cards: faces 35, backs 3. A card that shows less than 50 % of itself, or whose short side is under 20 px, by the generator's own figures, is an ignore region (here: faces 10, backs 1). An ignore region gives no hover event and no crop, and a detection on it is neither a card found nor a false positive
- everything else the generator draws (distractors, dice, hands, broadcast graphics) has no box and is background
- role evaluated: none. Generated scenes have no role, and all of them are one recording group, so no rate below has a group bootstrap interval
- rows read: 3
- rows used: 3
- labels left out of used rows: center-inside-another-box 3, ignore-region 11

### Overall

- events: 24 in 1 recording groups
- readable faces: right 0, wrong 0, nothing 22
- backs: name shown 0, nothing 2
- **named right**: 0 / 22 = 0.00 %; exact one-sided 95 % lower bound 0.00 % (assumes independent events); group bootstrap: no interval (fewer than two recording groups)
- **wrong of shown**: 0 / 0 = undefined; group bootstrap: no interval (fewer than two recording groups)
```

Read it like this: *named right* is how often the pointer, resting on the middle of a card,
would show that card's name, and *wrong of shown* is how much of what was shown was wrong. On
the toy game every face reads "nothing", because the stand-in detector ignores the image.

- The pointer positions are the centers of the cards' own boxes. A center that lies inside
  another card's box gives no event, as in tier 2, and is counted.
- A card that is mostly hidden, or tiny, is left out of every rate and counted. The report
  says how many.
- All the scenes are one recording group, so there is no group bootstrap interval. The exact
  bound assumes independent events, and the cards of one scene are not independent.
- `cardvision evaluate crops --scenes` scores the recognizer alone on the labeled cards, and
  `cardvision evaluate detector --scenes` the detector alone. `--out DIR` writes the report and
  a line per event.

**This is a first look, not a measurement.** It tells you whether the tools run on your cards
and roughly where the models stand. Tier 2 measures on real recordings.

Without `--accept` the rule is the one calibrated for the released Riftbound models
(`tau` 0.62, `delta` 0.05). Those values were not chosen for your game. Treat names as
provisional until tier 2.

### 4. Read the result

Look at the annotated frames and the contact sheet. Together they answer the two questions of
tier 0. Neither answers both alone: the contact sheet shows only the cards the detector
found, so it cannot show a card that was missed.

- **Does the detector find your cards?** Open the annotated frames (`--annotate`) and compare
  the number of boxes with the number of cards you can see on screen. Missing boxes on clear
  cards mean the detector does not carry over.
- **Does the recognizer name the cards it found?** On the contact sheet, for each crop, is
  the right card the first of the three matches, and is its score well clear of the second?

If both look good, go to tier 2 and measure. If either does not, go to tier 1.

**If there are no boxes at all**, standard error says why. Before the summary line it gives the
number of frames with no box, the detector's score threshold, and for each such frame the
highest score the detector gave anything in it, before the threshold. On the trained toy
detector of tier 1 (step 7), you should see something like:

```
cardvision infer: no box in 1 of 1 frame(s); the detector keeps a box at a score of 0.30 or more
cardvision infer: table.png: highest score 0.00, threshold 0.30
```

- **A highest score far below the threshold** means the detector does not see these cards as
  cards. The remedy is tier 1: train the detector on generated scenes of your cards.
- **A highest score just under the threshold** can mean small, blurred or partly hidden
  cards. Try a clearer, larger view of the same cards first (a closer photo, a sharper frame).
  This may not be enough; if it is not, tier 1 is the way forward.

The threshold is fixed by the release. The line tells you how near a frame came; it is not a
setting to change. A frame whose boxes were all too small to read (under 24 pixels on a side)
is reported as that, not as a score.

### 5. Look at it in a browser (optional)

`browser/` has a demo page that shows the card under the pointer on a video or image file from
your disk (tier 1, step 8 says more about it). It loads a **release folder**: one folder with
the two models, the accept rule, the catalog and the bank, and a release document that pins
them by hash. The steps above made no such folder. Make one from the released detector, the
released recognizer and their accept rule, with your own catalog and bank.

The toy check needs one more stand-in. The stand-in detector of the toy game answers with nine
rows, which is not the output of a real detector, and a release refuses it. The test suite
writes a stand-in that a release takes, and a table to look at.
Paste this into the terminal, from the repository's root:

```
python tests/test_browser_fixtures.py --demo "$WORK/demo"
mkdir -p "$WORK/tier0/release"
cp "$WORK/demo/release/detector.onnx" "$WORK/toy/recognizer.onnx" "$WORK/toy/accept.json" \
    "$WORK/toy/catalog.json" "$WORK/toy/bank-all.json" "$WORK/toy/bank-all.identity-groups.json" \
    "$WORK/tier0/release/"
cardvision build-release --detector "$WORK/tier0/release/detector.onnx" \
    --recognizer "$WORK/tier0/release/recognizer.onnx" --bank "$WORK/tier0/release/bank-all.json" \
    --catalog "$WORK/tier0/release/catalog.json" --accept "$WORK/tier0/release/accept.json" \
    --out "$WORK/tier0/release/release.json"
cardvision verify-release "$WORK/tier0/release/release.json"
```

You should see something like:

```
wrote $WORK/demo/release/release.json, $WORK/demo/art and $WORK/demo/table.png
the cards on the table: Amber Circle, Coral Triangle, Azure Circle, Slate Stripes, Amber Stripes, and a card back
OpenCV: FFMPEG: tag 0x30385056/'VP80' is not supported with codec id 139 and format 'webm / WebM'
for the scoring page: $WORK/demo/table.webm and $WORK/demo/labels/table.manifest.jsonl (3 rows)
release d2a28098cf47af82: $WORK/tier0/release/release.json
release d2a28098cf47af82: ok (toy, 20 cards in the bank, 20 in the catalog; every file present, unchanged and consistent)
bank: 20 of 20 rows record their source image (artV)
```

Your release id will differ: it is a hash of the content. The `OpenCV: FFMPEG` line is a
harmless note from the video writer: the toy video is written.

**For your game**, put the released detector, the released recognizer and the accept rule in
one folder with your catalog, the bank of step 2 and the identity groups file that step
wrote beside the bank. Then run the same two `cardvision` commands on that folder. The accept
rule is a JSON file with `tau`, `delta` and `rotationRetry`.

**Take exactly three files from the downloaded release:** the detector, the recognizer and, as
a starting point only, the accept rule (tier 2 calibrates your own). **Leave the rest out:**
the released bank, its catalog, its identity groups and its release document belong to the
released game. They list that game's cards. Your folder holds your catalog, the bank and the
identity groups that `build-bank` made from it, and the release document that `build-release`
writes.

Then serve the demo page on it, with the toy table named so that the page opens it with no
file to find. It needs Node 22 or later. Paste this into the terminal, from the repository's
root (the first line moves into `browser/`):

```
cd browser
npm ci
npm run demo -- --release "$WORK/tier0/release" --images "$WORK/toy/art" --file "$WORK/demo/table.png"
```

After npm's own lines and the build's, you should see something like:

```
demo: http://127.0.0.1:8765/
scoring page: http://127.0.0.1:8765/score.html
release folder: $WORK/tier0/release (served at /release/)
image folder: $WORK/toy/art (served at /images/; the demo page shows card images from it)
file: $WORK/demo/table.png (served at /file/table.png)
open the file in the demo: http://127.0.0.1:8765/?file=/file/table.png&images=/images/
```

npm also prints lines of its own, such as `npm warn install-scripts` notes (esbuild, fsevents,
protobufjs) and an `npm notice` that a new major version of npm is available: both are harmless.

Open the address on the last line in a browser (on a Mac, ⌘-click it in the terminal). The page
opens the file by itself, and says so under the picture:
`table.png opened from this page's address (/file/table.png on the local server)`. When the
line under the picture reads `Ready. Move over a face-up card.`, move the pointer over a card
to see its name. With the pointer on the first card of the toy table, the tooltip shows the
card's image, `Amber Circle` and `TOY-001`. The text panel (`Details`, then `Raw text`) then
ends with `under the pointer: Amber Circle (TOY-001)`. The address can name that one file and
the server's own image folder, and nothing else. A coding agent that drives a browser opens the
demo this way too, because it cannot use a file chooser.

The server keeps running until you press Control-C in the terminal. Without `--file`, the page
at `http://127.0.0.1:8765/` is one drop zone: drop a video or image file of your game on it, or
choose one with its button, and it starts. [browser/README.md](../browser/README.md) describes
the page.

---

## Tier 1: Make it yours

**You need:** a GPU (CUDA, or Apple silicon for small runs); your card images; some footage
of your game.

**Videos:** [Train for your game](https://www.youtube.com/watch?v=pu6TV2CmvwM) runs this tier on the toy game;
[Label frames with the labeling tool](https://www.youtube.com/watch?v=eL0gChfpS_w) covers step 3.

**Time and hardware:** on Riftbound, the public recipes on public inputs trained on a
rented cloud GPU: an NVIDIA RTX 4090, on an AMD Ryzen 9 7950X host limited to 13.6 vCPU. The
recognizer's 34 epochs took 5.0 h. Each 500-step detector run took 45 s. The whole job, from
setup to the recognizer's end, took 5.02 h and cost about $4.47 at the rental rate of about
$0.89 an hour, not counting the upload or storage. Two steps ran on the Apple M3 Max laptop
above: 8,000 generated scenes (step 2, 12 workers) in 11 min, and a bank of 1,472 cards with the
trained recognizer (step 6) in 157 s. The aim is a weekend. On the toy game, on the laptop
above: 60 generated scenes in 35 s, a two-epoch recognizer run in 17 s (Apple GPU), a
ten-step detector run in 61 s (CPU).

**Which device trains.** Both trainers take `--device cpu`, `--device mps` (Apple GPU) or
`--device cuda` (NVIDIA GPU). Without it, the environment variable `CARDVISION_DEVICE`
decides, with the same three values; set it once for the session with, for example,
`export CARDVISION_DEVICE=cpu`. With neither, the recognizer takes CUDA when there is one,
then the Apple GPU, then the CPU, and the detector takes CUDA when there is one and otherwise
the CPU (the detector's recipe has not been validated on the Apple GPU, so it is never picked
for it automatically; `--device mps` or `CARDVISION_DEVICE=mps` still forces it). A device
this machine does not have is an error, not a fallback. `--device` wins over the variable.

**How much to label:** there is no fixed number yet. Label in rounds, and let a small check
tell you when to stop:

1. Label a sitting of about 10 to 15 frames, spread over as many different recordings and
   setups (clients, cameras, tables, lighting) as you can. As a practical rule, take
   typically 1 to 3 frames from a video rather than many frames from one: more videos give
   more variety of lighting, angle and table. This is guidance, not a measured result.
2. Train both models (steps 4 and 5).
3. Check them on a small development set that you keep out of training: a few frames from
   recordings you do not train on.
4. If the development check improved, label another sitting and train again.
5. Stop when a sitting no longer helps.
6. Then label a separate test set, from recordings never used for training or development, and
   score it once (tier 2).

On the One Piece Card Game that path was: a first sitting of 13 frames, then a second that
made 23 training frames from 12 recording groups; 6 development frames from 3 other recording
groups to choose between the two trained sets; and a held-out test set of 25 frames from 9
recording groups, scored once
([Measured on another game](#measured-on-another-game-the-one-piece-card-game)). A game with
busier tables, cards stacked or overlapping, or many cards that look alike will likely need
more. For scale: the released Riftbound models had 50 real labeled frames, about 1,900 boxes,
from 25 videos, beside generated scenes and private images.

**What to expect:** on Riftbound, the public recipes on public inputs and card images alone
named 92.2 % of readable faces right on the public evaluation set, against 92.5 % for the
released weights. That set is small (53 frames, 20 recording groups, 1,053 readable faces),
and the paired difference, −0.28 points (95 % interval by recording group −4.03 to +3.17), is
not distinguishable from zero. It is a small public benchmark used during development, not an
independent test of generalization, and some of its digital identity labels were assigned with
model suggestions ([data card](data-card.md#how-the-labels-were-made)). The public-only
detector came out weaker, and on physical tables 2.6 % of shown names were wrong, against
1.0 % (that paired interval includes zero). The
[model card](model-card.md#3-public-only-recipe) has the figures by source. On another game,
the One Piece Card Game, 23 labeled frames and generated scenes took the share of readable
faces named right from 31.4 % to 74.4 % on a small held-out set
([Measured on another game](#measured-on-another-game-the-one-piece-card-game)). The toy runs
below train for seconds from random weights.
They prove the commands and produce models that find nothing.

### 1. Install the training environment

From the repository's root (if you are in `browser/`, run `cd ..` first), in the same virtual
environment, paste this into the terminal:

```
python -m pip install -r requirements-lock-train.txt
python -m pip install --no-deps -e .
python -m pip install setuptools wheel
python -m pip install --no-deps --no-build-isolation "yolox @ git+https://github.com/Megvii-BaseDetection/YOLOX@6ddff4824372906469a7fae2dc3206c7aa4bbaee"
```

YOLOX builds the detector's network. It is installed on its own because its metadata pins
library versions that conflict with the ones above. `requirements-lock-train.txt` explains.

On a Mac, the YOLOX install prints a git warning that "the following paths have collided"
and names files under `demo/ncnn/android/` (two file names that differ only in capitals, on
a file system that does not tell them apart). It is harmless: those files are an Android demo
that is never used here.

Check it. Paste this into the terminal, from the repository's root:

```
python -c "import torch, torchvision, yolox; print('torch', torch.__version__, 'torchvision', torchvision.__version__)"
```

You should see something like:

```
torch 2.14.1 torchvision 0.29.1
```

(Here these four commands were run in a fresh environment of their own, not on top of the
base one. The training lock contains the base lock, so the result is the same.)

### 2. Generate training scenes

Scenes are your card images pasted onto generated tables, with exact labels for every card.
Paste this into the terminal, from the repository's root:

```
cardvision make-composites --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" \
    --out "$WORK/composites/train" --n 60 --seed 7 --check
```

You should see something like:

```
  50 / 60 scenes
  60 / 60 scenes
wrote 60 scenes to $WORK/composites/train: 860 positive faces showing 20 different cards, 542 more faces marked as ignore regions (too hidden or too small), 142 backs
{
 "scenes": 60,
 "objects": 1837,
 "problemCount": 0,
 ...
}
```

`--check` compares the labels with the images. `problemCount` must be 0.

For your game:

- The released runs used 8,000 scenes. `--workers N` spreads the work over processes; the
  output does not depend on it.
- The catalog's optional `kinds` block tells the generator which kinds are landscape, how
  often a kind is foil, and how a game board is laid out. `games/_template/README.md` and
  `cardvision/core/catalog.py` describe it.
- Half the released scenes lay on scanned table surfaces. To use them, download the CC0
  scans (**not run here**: it downloads 207 files, 183 for training scenes and 24 for
  validation scenes) and add `--textures`.
  Paste this into the terminal, from the repository's root:

  ```
  cardvision fetch-textures --index cardvision/composites/cc0_textures.json --out "$WORK/textures"
  ```

### 3. Label real frames

For Riftbound, a small number of real labeled frames was part of what made the detector
work beyond one digital client ([what-we-tried.md](what-we-tried.md)).

The labeling tool is in [labeler/](../labeler/README.md). It needs no install. The fast
way is to let a model propose boxes and names and to correct them.

**a. Write frames and a pre-fill file** from a video, with whatever models you have. Paste this
into the terminal, from the repository's root:

```
cardvision infer "$WORK/toy/table.mp4" --every 5 \
    --detector "$WORK/toy/detector.onnx" --recognizer "$WORK/toy/recognizer.onnx" \
    --bank "$WORK/toy/bank-all.json" --catalog "$WORK/toy/catalog.json" \
    --accept "$WORK/toy/accept.json" \
    --frames "$WORK/label/frames/table" --prefill-out "$WORK/label/prefill.jsonl"
```

Besides its usual output (tier 0, step 3), it writes the frames it analyzed into
`$WORK/label/frames/table/`, named after the video: `table-f00001.jpg`, `table-f00002.jpg`
and so on.

**b. List the frames to label.** Paste this into the terminal, from the repository's root:

```
python3 labeler/make_sample.py --out "$WORK/label/sample.json" \
    --asset table="$WORK/label/frames/table" --all --times "$WORK/label/prefill.jsonl"
```

You should see something like:

```
wrote .../label/sample.json: 3 frames of 1 assets
```

**c. Start the tool** and open the address it prints. Paste this into the terminal, from the
repository's root:

```
python3 labeler/serve.py --mode box --role training --sample "$WORK/label/sample.json" \
    --catalog "$WORK/toy/catalog.json" --art "$WORK/toy/art" --prefill "$WORK/label/prefill.jsonl"
```

You should see something like:

```
labeling tool: http://127.0.0.1:8090/  mode=box role=training
labels:    $WORK/label/labels
sample:    $WORK/label/sample.json
frames:    $WORK/label/frames
catalog: $WORK/toy/catalog.json (20 cards, 0 tokens)
art:       $WORK/toy/art
prefill: * = $WORK/label/prefill.jsonl
decklists: $WORK/label/decklists (absent)
```

The lines after the first say which folders and files this pass uses. `(absent)` after
`decklists` only means there are no deck lists; none are needed.

Here the server was started and its page loaded (HTTP 200). **The labeling itself was not
done here**: it is a person's work. These flags open straight into the Boxes pass; when it is
finished the page offers the next pass and switches the running tool to it, and **← Project**
leads to the project's screen, which shows how far each pass is and writes the export. `labeler/README.md` has a five-minute start on toy data of its own, which
needs no flag, and `labeler/FORMAT.md` has the rules for what gets a box.

**d. Export a manifest** (**not run here**: it needs labels made in the tool; the test suite
covers it). A manifest names a video and a time, never a file, so the export needs to know
where each video is hosted. `labeler/README.md`, "Offering labels", lists what to add to the
sample file first. For a recording of your own, which is hosted nowhere, `make_sample.py
--local` adds it for you; tier 2 runs that route from start to end.
Paste this into the terminal, from the repository's root:

```
python3 labeler/export.py manifest --labels-dir "$WORK/label/labels" \
    --sample "$WORK/label/sample.json" --credit "Your Name" --source-type physical/phone \
    --out "$WORK/manifests/my-game.manifest.jsonl"
```

`--source-type` says what kind of footage it is: here a phone over a table. Tier 2 lists the
values.

**e. Check the manifest and get its frames.** Tier 2 runs both commands on a toy manifest:
`cardvision validate-manifest` and `cardvision fetch`.

**Hold recordings out now.** Before you train, decide which recordings are for training and
which are for measuring, by recording group and by a seeded shuffle (tier 2, step 6). A
recording you train on can never measure anything again.

### 4. Train the recognizer

The trainer reads one config file. This one is the smallest that runs: card images and
generated scenes, random starting weights, two short epochs.
Paste this into the terminal, from the repository's root:

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
```

You should see something like:

```
card images: 20 of 20 catalog cards
composite_positives: cut 350 crops into $WORK/runs/recognizer/cache/composite_positives (...)
art: 2 rows dropped ({'kept out of training': 2})
note: stream real_positives has no rows; its segment gives none
note: stream real_negatives has no rows; its segment gives none
note: the seen validation set is empty and scores 0; checkpoints are compared on what is left
device=mps classes=18 rows/epoch=260 steps/epoch=8 epochs=2 seed=0 seen=0 unseen=33 ...
epoch 1/2 loss 15.1255 ... top1-seen 0.000 top1-unseen 0.000 criterion 0.000 wall 0.2min
epoch 2/2 loss 14.4012 ... top1-seen 0.000 top1-unseen 0.061 criterion 0.030 wall 0.3min
done: best criterion 0.030 at epoch 2; $WORK/runs/recognizer/best.pt
```

Paths in this config are relative to the config file's folder. The first line names the
device (`device=mps` here, on the Apple GPU; see "Which device trains" above). The numbers
differ between devices: on the CPU (`CARDVISION_DEVICE=cpu`) the same run took 163 s, and
its scores can stay at zero, ending in `top1-unseen 0.000 criterion 0.000` and
`done: best criterion 0.000 at epoch 2`. That is not a fault. A toy run this short learns
nothing, so its numbers, zero or not, mean nothing; only the commands are being shown.

For your game, copy `cardvision/train_recognizer/default.toml` and set the paths.

- Leave `init = "imagenet"` (the default) to start from torchvision's pretrained weights,
  which are downloaded on first use. **Not run here** with that setting.
- Add your label manifests and frames under `[data]` (`manifests`, `frames`). The three notes
  above then go away: real crops join the epoch and the "seen" validation set is filled.
- `games/riftbound/train-recognizer.toml` is the released recipe, with comments on what each
  part does.

**Starting from another model.** `init`, or `--init` on the command line, can also name a
recognizer checkpoint, for example one trained on another game: a `best.pt` or `last.pt` of
this trainer, or the `.safetensors` file of the export below. Here the toy run starts again
from its own checkpoint.
Paste this into the terminal, from the repository's root:

```
cardvision train-recognizer --config "$WORK/toy-recognizer.toml" --out "$WORK/runs/recognizer-2" \
    --init "$WORK/runs/recognizer/best.pt"
```

You should see something like:

```
started from best.pt (SHA-256 <64 hex digits>): the encoder's 247 tensors, and nothing else from the file
```

Only the encoder's weights are read, and they must fit exactly. A file with another embedding
width is refused before any data is prepared, and the message names the first tensor that
does not fit. The log, `run.json` and both checkpoints record the file's name and SHA-256.
`init = "imagenet"` stays the documented start. Whether a start from another game's model
does better on your game has not been measured here: train both, and compare them on
development recordings before you choose (tier 2, "Three kinds of recording group"), never on
your final test.

Export the checkpoint to ONNX.
Paste this into the terminal, from the repository's root:

```
cardvision export recognizer "$WORK/runs/recognizer/best.pt" --out "$WORK/release" --name recognizer
```

It writes `recognizer.onnx` (4.0 MB), a copy with half-precision weights,
`recognizer.safetensors` and a report, and refuses to finish if the ONNX file does not match
PyTorch closely enough.

### 5. Train the detector

Paste this into the terminal, from the repository's root:

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
```

You should see something like:

```
training 10 steps of 16 on cpu; streams: composites (60 frames)
step 1/10  lr 0.000033  loss 13.0262
step 2/10  lr 0.000067  loss 13.8287
step 10/10  lr 0.000333  loss 13.7450
wrote $WORK/runs/detector/last.pth: loss 13.0262 at step 1, 13.7450 at step 10
next: cardvision export detector $WORK/runs/detector/last.pth --out $WORK/runs/detector
```

Right after the `training 10 steps ...` line it may print a two-line `FutureWarning` from
YOLOX's own code (`.../yolox/models/yolo_head.py:...: FutureWarning:
torch.cuda.amp.autocast(args...) is deprecated ...`), here and in the run below. It is
harmless: it is about a PyTorch function YOLOX calls, and it changes nothing in the run.

Paths in the detector's config are relative to the folder you run the command from, which is
why this one writes the full path.

For your game, copy `cardvision/train_detector/default.toml`. It mixes three streams: your
labeled frames, generated scenes, and a folder of your own images that show no cards.

- **Start from the pretrained weights, not from random.** Drop `--init random` and add
  `--download-pretrained`, which fetches the public COCO-pretrained YOLOX-Nano file once and
  checks its SHA-256. **Not run here**: it downloads. The download comes first, before
  PyTorch is needed. So the command also works as a step of its own on a machine without the
  training environment: it fetches and checks the file, prints where it is, and then says
  what training needs.
- Ten steps from random weights, as above, give a detector that finds nothing.
- Use `--device cuda` on a GPU. The default is CUDA when there is one and the CPU otherwise
  ("Which device trains", at the top of tier 1).

**Starting from another model.** `--init`, or `init` in the config, names a detector
checkpoint to start from in place of the public weights, for example one trained on another
game: a `last.pth` of this trainer, or the `.safetensors` file of the export below. Here the
toy run starts again from its own checkpoint.
Paste this into the terminal, from the repository's root:

```
cardvision train-detector --config "$WORK/toy-detector.toml" --out "$WORK/runs/detector-2" \
    --init "$WORK/runs/detector/last.pth"
```

You should see something like:

```
training 10 steps of 16 on cpu; streams: composites (60 frames)
started from last.pth (SHA-256 <64 hex digits>): all 642 tensors copied, and nothing else from the file
```

Only weights are read. The file must hold the network's tensors, each in the network's shape,
or the run stops and names the first that does not fit. One case is handled and reported,
not refused: a checkpoint with another number of classes keeps its other weights, and its
class layers are widened from one class or left as built. The line above then says which.
The log, `run.json` and `last.pth` record the file's name and SHA-256. The public pretrained
weights stay the documented start. Whether a start from another game's detector does better
on your game has not been measured here: train both, and compare them on development recordings
before you choose (tier 2, "Three kinds of recording group"), never on your final test.

Export it. Paste this into the terminal, from the repository's root:

```
cardvision export detector "$WORK/runs/detector/last.pth" --out "$WORK/release" --name detector
```

It writes `detector.onnx` (3.7 MB), a half-precision copy, `detector.safetensors` and a
report, and refuses to finish if the ONNX file does not match PyTorch closely enough. Scores
are compared on every anchor. Boxes are held to 0.01 px on the anchors any threshold of 0.01
or more keeps (the operating threshold is 0.3), and every other box to a bound that grows with
its size: a trained detector proposes boxes far larger than the frame at scores near zero, and
those differ between runtimes in their last bits. The report gives both figures and how many
anchors the 0.01 px bound covered. The evaluation's full sweep of thresholds runs on the ONNX
file itself, so it is not a parity question.

### 6. Build a bank and pin a release

A release is one document that pins the two models, the bank, the catalog and the accept
rule together by hash. Every file must be in the release's folder.
Paste this into the terminal, from the repository's root:

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

You should see something like:

```
  20 / 20 cards
bank: $WORK/release/bank.json (20 rows of 128 values; 20 embedded, 0 kept from the base bank)
identity groups: $WORK/release/bank.identity-groups.json
release aa11d1bfe5cbe378: $WORK/release/release.json
release aa11d1bfe5cbe378: ok (toy, 20 cards in the bank, 20 in the catalog; every file present, unchanged and consistent)
bank: 20 of 20 rows record their source image (artV)
```

Your release id will differ: it is a hash of the content.

On a toy run, `build-bank` may also print, between the `identity groups:` line and the
release lines, a note like this:

```
look at these before you rely on the bank:
  nearly the same bank row under different cards, cosine 0.99 or more (1 group(s)):
    TOY-001, TOY-002, TOY-003, TOY-003A, TOY-004, TOY-005, TOY-006, TOY-007, and 12 more
    This usually means the same picture filed under two cards, ...
```

On the toy game it is harmless and expected: a recognizer that has learned nothing (for
example the CPU run of step 4) gives every card nearly the same row. On your own game, with a
trained recognizer, take it seriously: it names cards the accept rule cannot tell apart.

`build-release --settings FILE` overrides parts of the default settings, the detector's score
threshold among them. Box parity is checked down to a threshold of 0.01 (step 5), so a release
with a lower one is refused.

**A bank belongs to one recognizer.** Whenever you retrain the recognizer, rebuild the bank
with it. A bank built with other weights gives meaningless scores.

### 7. Run your models

Paste this into the terminal, from the repository's root:

```
cardvision infer "$WORK/toy/table.png" --release "$WORK/release/release.json"
```

You should see something like:

```
{"source": "$WORK/toy/table.png", "frame": "table.png", "t": 0.0, "frameW": 1280, "frameH": 768, "analysisW": 1280, "analysisH": 768, "boxes": []}
cardvision infer: no box in 1 of 1 frame(s); the detector keeps a box at a score of 0.30 or more
cardvision infer: table.png: highest score 0.00, threshold 0.30
cardvision infer: 1 frame(s), 0 face(s), 0 back(s), 0 named
```

No boxes, as expected from a detector trained for ten steps: its highest score is far below
the threshold (tier 0, step 4 says how to read the two extra lines). With real training, look at
the annotated frames and the contact sheet again (tier 0, steps 3 and 4) before you measure
anything.

`--release` checks the release and takes every file and setting from it. The separate files
(`--detector`, `--recognizer`, `--bank`, `--catalog`, `--accept`) also work, but not
together with `--release`.

### 8. Look at it in a browser (optional)

`browser/` runs the same pipeline in a web page, from the same release folder, and has a demo
page that shows the card under the pointer on a video or image file from your disk. It needs
Node 22 or later.
Paste this into the terminal, from the repository's root:

```
cd browser
npm ci
npm run demo -- --release "$WORK/release"
```

Open the address it prints, and drop a video or image file on the page, or choose one: that
starts it. The line under the picture says which backend runs (WebGPU, or WebAssembly) and
what a frame costs. It is a way to look at your models on a local file: it is not a browser
extension and does not attach to any website.

To open a file with no file chooser, add `--file PATH` (and `--images FOLDER` for card images
in the tooltip) and open the last address the server prints. Tier 0, step 5 shows that on the
toy game.

**Not run here** on the release of step 6. It was run on a toy release with stand-in models,
which `python tests/test_browser_fixtures.py --demo "$WORK/demo"` writes;
[browser/README.md](../browser/README.md) shows that run, and lists where the browser runtime
and `cardvision infer` are known to differ.

### 9. Put it in a browser extension (optional)

**Video:** [Make it yours: your own browser extension](https://www.youtube.com/watch?v=tRTTq4P3sRU).

The browser runtime answers one question: with the pointer here, over this picture, which
card would be shown? It loads your release, analyzes frames and applies the accept and hover
rules. An extension adds everything around that: finding the video on a website and the
pointer over it, capturing the frame under the pointer, a tooltip beside the card, a settings
file and its on/off switch, the permissions for the sites it runs on, and a package for a
browser's store. This repository has none of that.

A working example does: the One Piece example extension, Kenbunshoku
(<https://github.com/ryangswe/kenbunshoku>), an Apache-2.0 Chrome extension built on this
runtime for YouTube and Twitch. Its models, bank and card list all come from the release
folder it is built with. What makes it Kenbunshoku (its names, icons, sites, hosts, settings
address and the rule for printed numbers) is one file, `kenbunshoku.config.json`, and the build
refuses a file with a problem, saying which. So you copy the repository, edit that file, add
your release and its legal files, and build.

Its guide, [Make it yours: an extension for another card game](https://github.com/ryangswe/kenbunshoku/blob/main/docs/make-it-yours.md),
has the detail and the exact files. Its steps are:

1. **Copy the repository, then `npm ci` and `npm test`.**
2. **Edit `kenbunshoku.config.json`:** name, icons, video sites, image hosts, settings
   address, printed-number rule, geometric stage on or off, and links.
3. **Your models:** pass your release folder with `--release` and rewrite `release-legal/`
   (license, notice and provenance of your models). The build refuses a release whose id the
   notice does not name.
4. **Card pictures: choose one.** Names only, or your own image host. Host only pictures you
   have the right to serve; if you do not have that right, use names only.
5. **Extra accuracy (the geometric stage), on or off** (tier 2, step 7).
6. **Your own extension ID:** make your own key pair. Do not reuse the example's key.
7. **Delete the One Piece text** that no longer applies.
8. **Build, load and check on a local video** before you try a website.
9. **Before a store listing:** explain every permission and every host the extension
   requests, and say plainly that it is unofficial and not affiliated with your game's
   publisher.

Its guide says its steps were checked on this repository's toy release: with names only, the
extra-accuracy stage off, no host at all and Twitch only, the copy's tests passed, it built,
and in Chrome for Testing on the local test page it named the cards under the pointer.

That check used the demo's toy release, `$WORK/demo/release`, which
`python tests/test_browser_fixtures.py --demo "$WORK/demo"` writes (tier 0, step 5), not the
release of step 6. To repeat it, build with `--release "$WORK/demo/release"`. The release of
step 6, `$WORK/release`, builds too, but its ten-step detector finds nothing (step 7), so an
extension built with it names no card. With your own trained models, use your own release
folder.

---

## Tier 2: Ship it

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
from the recording, score. The toy check runs it on the toy video of tier 0,
`$WORK/toy/table.mp4`, under the name `table`.

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
([Measured on another game](#measured-on-another-game-the-one-piece-card-game)). Try it when
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

Four named where tier 0 named three: the staged bank gives two cards the same row, so the
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

---

## If something fails

| What you see | Likely cause |
| --- | --- |
| `cardvision: command not found` | The virtual environment is not active: `. .venv/bin/activate` |
| `needs the onnx package`, or `ModuleNotFoundError: No module named 'onnx'`, in a stand-in step | Install from `requirements-lock.txt`, which brings the test tools |
| `... lies inside the repository` from the toy script | `$WORK` is not set in this shell, or points into the checkout |
| `error: ... no such ... file` | A path is wrong. Every path on this page starts from `$WORK`; check that the variable is set in this shell |
| `training needs torch ...` or a message about YOLOX | Tier 1, step 1 was skipped or is incomplete |
| `... already holds a run`, `... already holds generated scenes`, `... already exists with different content` or `... exists; pass --overwrite` | You are running a step again. Add `--overwrite`, or delete that step's output folder (or the whole `$WORK`, as in "Before you start") and run it again |
| `fetch` ends with exit code 1 | A row was left without a frame. The last lines say which and why |
| `fetch` ends with exit code 3 | The run stopped early: the platform refused a download (a rate limit or a bot check), or several downloads in a row failed. Check the connection and wait before you run it again |
| `CERTIFICATE_VERIFY_FAILED` from a command that downloads | Your Python has no CA certificates. Install the `download` extra, which brings `certifi` ([data/README.md](../data/README.md)) |
| `fetch` says `no video file given; pass --video-file NAME=PATH` | The row is of a recording of your own (`platform` is `local`). Give its file under the name the manifest uses |
| `validate-manifest: failed` | Each line names the file, the row and the rule broken. `data/SCHEMA.md` lists the rules |
| The contact sheet shows the wrong card first on clear crops | The recognizer does not separate your cards. Go to tier 1 |
| Names on things that are not cards | `tau` is too low for your models. Tier 2, step 4 |

"How do I adapt this to my game?" questions go to Discussions, not to issues
([SUPPORT.md](../SUPPORT.md)).
