<!-- SPDX-License-Identifier: Apache-2.0 -->

# Adapt it to your game

This guide takes you from your game's card list and card images to card names on your game's
video, and on to a browser extension. It comes in tiers, one page each. Do them in order and
stop when you have what you need. New here? [Start here](start-here.md) shows the whole
process as one diagram and picks the page for you.

<a id="tier-0-try-it"></a><a id="tier-1-make-it-yours"></a><a id="tier-2-ship-it"></a><a id="9-put-it-in-a-browser-extension-optional"></a>

| Tier | You need | You do | Time and hardware | You get |
| --- | --- | --- | --- | --- |
| [0. Try](your-game.md) | Your card list (a spreadsheet will do), your card images, a video | Import the list. Build a bank with the released recognizer. Run it on the video and open it in the demo page. | An afternoon, on a laptop. No GPU | Names on clear, front-facing cards, **if** the released models carry over to your game |
| [1. Train](train.md) | Some of your game's footage | Generate training scenes from your card images. Label some real frames. Fine-tune both models. | A weekend, with a GPU (a rented one will do) | Models for your game's cards, clients and tables |
| [2. Measure](measure.md) | Recordings held out from training | Calibrate the accept rule on development recordings. Freeze the release, then score the final test once. Extend the bank when a set comes out. | Ongoing; a laptop | Numbers you can state, and a routine for new cards |
| [Extension](extension.md) | Names showing on your video, after Try or Train | Copy the example extension and make a handful of edits: its config file, the legal files with your release id, the picture settings, a key of your own. Add your release and build ([Extension](extension.md)). | Node 22 or later. No GPU | A browser extension that viewers install to hover cards on YouTube and Twitch |

**Read this first.**

- **On one other game, the released models as they stand named 31.4 % of readable card faces
  right, and models trained with this guide 74.4 %.** That game is the One Piece Card Game,
  on a small held-out set with wide intervals: see
  [Measured on another game](#measured-on-another-game-the-one-piece-card-game).
  [Try](your-game.md) is how you find out for yours.
- **Every command of these pages was run on a toy game** that the repository draws from plain
  shapes, or, on [Your game](your-game.md), on toy files standing in for yours. The output
  shown is real. It proves that the commands work. It says nothing about accuracy on a real
  game. Where a command could not be run, it says so and why.
- You need images of your game's cards that you are entitled to use. This repository
  contains no card art for any game, and before you publish a bank or weights for a game you
  do not own, check what its publisher allows.
- The [playbooks](../playbooks/) have the same steps in a form a coding agent can run and
  check; [AGENTS.md](../AGENTS.md) is where it starts.

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
| macOS | The commands of these pages, run by hand (Apple M3 Max laptop) |
| Linux, and Ubuntu under WSL 2 on Windows | The quickstart's toy workflow, run in CI (`.github/workflows/quickstart.yml`) |
| GPU training | Exercised on a rented Linux machine with an NVIDIA RTX 4090 (tier 1). CUDA under WSL is not covered by this guide |
| Windows, natively (PowerShell or Command Prompt) | Not supported |

**How to read the steps.** A block after "Paste this into the terminal" holds commands: copy
the whole block, paste it into the terminal and press Return. A block after "You should see
something like" is what the commands print: you do not type it. Your timings, ids and folder
names will differ.

**Install** (Python 3.11 or later). Paste this into the terminal, from the repository's root:

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
cardvision 0.2.0
```

Then follow [Your game](your-game.md) with your own files. [Train](train.md) and
[Measure](measure.md) run on a toy game first, in a work folder their pages set up.

---

## If something fails

| What you see | Likely cause |
| --- | --- |
| `cardvision: command not found` | The virtual environment is not active: `. .venv/bin/activate` |
| `needs the onnx package`, or `ModuleNotFoundError: No module named 'onnx'`, in a stand-in step | Install from `requirements-lock.txt`, which brings the test tools |
| `... lies inside the repository` from the toy script | `$WORK` is not set in this shell, or points into the checkout |
| `error: ... no such ... file` | A path is wrong. Every path starts from `$WORK` (the toy game) or from `$GAME` and `$WEIGHTS` ([Your game](your-game.md)); check that the variable is set in this shell |
| `training needs torch ...` or a message about YOLOX | [Train](train.md), step 1 was skipped or is incomplete |
| `... already holds a run`, `... already holds generated scenes`, `... already exists with different content` or `... exists; pass --overwrite` | You are running a step again. Add `--overwrite`, or delete that step's output folder (or the whole `$WORK`, as in [Train](train.md#the-toy-game-these-steps-run-on)) and run it again |
| `import-catalog` says `no column for the card's id: name it with --map id=HEADER` | Your list's id column has a header it does not know. Add `--map id="HEADER"` with that header ([Your game](your-game.md), step 1) |
| `import-catalog` says `NAME is a spreadsheet file: export it as CSV (UTF-8) first` | Export the sheet from Excel, Numbers or Google Sheets as CSV (UTF-8), and import the `.csv` |
| `import-catalog` says `the header looks semicolon-separated` | The CSV uses `;` between columns, as some spreadsheet programs write it: add `--delimiter ';'` |
| `fetch` ends with exit code 1 | A row was left without a frame. The last lines say which and why |
| `fetch` ends with exit code 3 | The run stopped early: the platform refused a download (a rate limit or a bot check), or several downloads in a row failed. Check the connection and wait before you run it again |
| `CERTIFICATE_VERIFY_FAILED` from a command that downloads | Your Python has no CA certificates. Install the `download` extra, which brings `certifi` ([data/README.md](../data/README.md)) |
| `fetch` says `no video file given; pass --video-file NAME=PATH` | The row is of a recording of your own (`platform` is `local`). Give its file under the name the manifest uses |
| `validate-manifest: failed` | Each line names the file, the row and the rule broken. `data/SCHEMA.md` lists the rules |
| The contact sheet shows the wrong card first on clear crops | The recognizer does not separate your cards. Go to [Train](train.md) |
| Names on things that are not cards | `tau` is too low for your models. [Measure](measure.md), step 4 |

"How do I adapt this to my game?" questions go to Discussions, not to issues
([SUPPORT.md](../SUPPORT.md)).
