<!-- SPDX-License-Identifier: Apache-2.0 -->

# Train: models for your game

This is tier 1, **Train**, of the [adapt guide](adapt-your-game.md). [Your game](your-game.md)
(tier 0, **Try**) ran the released models on your cards. When they miss your cards, or name
too few of them, this page fine-tunes both models for your game: generate training scenes from
your card images, label some real frames, train, and pin a release. When names show on your
video, [Extension](extension.md) puts them in a browser extension, and [Measure](measure.md)
(tier 2) gives you numbers you can state.

**Every command on this page was run on a toy game** that the repository draws from plain
shapes, on an Apple M3 Max laptop (48 GB, macOS, Python 3.12, torch 2.14.1). The output shown is real. It
proves that the commands work. It says nothing about accuracy on a real game. Where a command
could not be run here, it says **not run here** and why. Install first: "Before you start" in
the [adapt guide](adapt-your-game.md#before-you-start) has the platforms and the install block.

## The toy game these steps run on

The steps below, and those of [Measure](measure.md), run on the toy game's files in `$WORK`.
Make them once.

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
fails" in the [adapt guide](adapt-your-game.md#if-something-fails)). To start over from
nothing, delete the whole folder with `rm -rf "$HOME/Downloads/cardvision-toy"`. That deletes
everything in it at once and does not ask, so keep nothing in it that you have not saved elsewhere, such as your own catalog.

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
and two cards share a row, which is why three faces are named nothing. The toy bank below
is a bank of all 20 cards.

**Know what the stand-ins are.** They have no skill.

- The stand-in recognizer is an average pool and a fixed random projection. It can tell the
  toy cards apart and nothing else.
- The stand-in detector **does not look at the image**. It returns the same boxes for any
  frame: the boxes of the cards in `table.png`.
- `accept.json` is strict (`tau` 0.99) because the stand-in recognizer's scores are all high.

Wherever a command below takes `--detector` and `--recognizer`, use the released files for
real work.

**Build the toy bank.**
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

Each row records the image it was computed from, as `artV`: the first 16 hexadecimal digits of
the SHA-256 of the image file's bytes. A later refresh uses it to tell when a card's image has
changed (tier 2, step 5).

**Make the toy video.**
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

---

## Tier 1: Train

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
([Measured on another game](adapt-your-game.md#measured-on-another-game-the-one-piece-card-game)). A game with
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
([Measured on another game](adapt-your-game.md#measured-on-another-game-the-one-piece-card-game)). The toy runs
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
- The scenes assume cards of 63 x 88 mm. If your cards are another size, give it in
  millimeters, width first: for example `--card-size 59x86` for 59 x 86 mm cards.
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

Besides its usual output ([Your game](your-game.md), step 4), it writes the frames it analyzed into
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
before training: top1-seen 0.000 top1-unseen 0.000 criterion 0.000
epoch 1/2 loss 15.1235 ... top1-seen 0.000 top1-unseen 0.000 criterion 0.000 wall 0.1min
epoch 2/2 loss 14.4008 ... top1-seen 0.000 top1-unseen 0.000 criterion 0.000 wall 0.2min
done: best criterion 0.000 at epoch 2; $WORK/runs/recognizer/best.pt
```

Paths in this config are relative to the config file's folder. The first line names the
device (`device=mps` here, on the Apple GPU; see "Which device trains" above). The numbers may
differ slightly by device; on the CPU (`CARDVISION_DEVICE=cpu`) this run printed the same and
took 159 s. The scores staying at zero is not a fault: two short epochs from random weights,
with no real frames, learn next to nothing, so a toy run's numbers, zero or not, mean nothing;
only the commands are being shown. (The second run below, which starts from this one's
checkpoint, can reach a score above zero; that means nothing either.)

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
step 2/10  lr 0.000067  loss 13.8288
step 10/10  lr 0.000333  loss 13.8236
wrote $WORK/runs/detector/last.pth: loss 13.0262 at step 1, 13.8236 at step 10
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
release d48b5310961f232d: $WORK/release/release.json
release d48b5310961f232d: ok (toy, 20 cards in the bank, 20 in the catalog; every file present, unchanged and consistent)
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
the threshold ([Your game](your-game.md), step 5 says how to read the two extra lines). With real
training, look at the annotated frames and the contact sheet again (Your game, steps 4 and 5)
before you measure
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
in the tooltip) and open the last address the server prints. [Your game](your-game.md), step 6
shows that, and step 2 of "The demo page" in
[browser/README.md](../browser/README.md) shows it on the toy game.

**Not run here** on the release of step 6. It was run on a toy release with stand-in models,
which `python tests/test_browser_fixtures.py --demo "$WORK/demo"` writes;
[browser/README.md](../browser/README.md) shows that run, and lists where the browser runtime
and `cardvision infer` are known to differ.
