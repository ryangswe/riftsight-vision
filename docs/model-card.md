<!-- SPDX-License-Identifier: Apache-2.0 -->

# Model card

Two small models that find trading cards in a frame of gameplay video and name them. They
are the models the RiftSight product ships for Riftbound.

| | Detector | Recognizer |
| --- | --- | --- |
| What it does | Finds cards: a box, a score and a class (card face or card back) | Turns a crop of a card face into a 128-value vector |
| Network | YOLOX-Nano, two classes | MobileNetV3-Small features, projected to 128 values |
| Input | One frame, letterboxed to 640 × 384 | One crop, pooled to 128 × 128 |
| Size as ONNX (32-bit weights) | 3.7 MB | 4.0 MB |
| Starts from | YOLOX-Nano pretrained on COCO by Megvii | MobileNetV3-Small pretrained on ImageNet-1k by torchvision's authors |
| Training seed | 1337 | 1337 |
| Released files | [`detector.onnx`](https://github.com/ryangswe/riftsight-vision/releases/download/v0.1.0/detector.onnx) of release v0.1.0, SHA-256 `dd9dc32b74756d83316bf8347784f09fad69d6f54c55384c1d093cb312727185` | [`recognizer.onnx`](https://github.com/ryangswe/riftsight-vision/releases/download/v0.1.0/recognizer.onnx) of release v0.1.0, SHA-256 `a65ee03103893c39f8a0bbde9b3d18b8540130205df7883c4467b2673c47fd3b` |

They run together with a **bank** (one vector per card, computed from card images) and an
**accept rule** (when a match is trusted). [how-it-works.md](how-it-works.md) describes the
pipeline. A figure on this page belongs to one exact combination of detector, recognizer,
bank, catalog and settings, and says which.

This is recognition. The models read cards. They do not generate images.

## Intended use

- Naming Riftbound cards in gameplay video: two digital clients (Rift Atlas, TCG Arena) and
  physical play filmed from near overhead.
- A starting point for another card game: build a bank from that game's card images, or
  fine-tune both models. [adapt-your-game.md](adapt-your-game.md) is the guide. On one other game,
  the One Piece Card Game, the released weights with a bank of its cards named 31.4 % of
  readable faces right on a small held-out set, and weights fine-tuned for it 74.4 %; see
  [adapt-your-game.md](adapt-your-game.md#measured-on-another-game-the-one-piece-card-game).
- Pre-filling labels for a person to correct, in the labeling tool.

## Out of scope

- **Anything where a wrong name does harm.** The accept rule keeps wrong names rare; it does
  not make them impossible. Do not use the output to rule on a game, to judge a player, or as
  evidence of what happened in a match.
- **Identifying people.** The models look at cards. They were not built to recognize faces,
  hands, players or channels and are not suited to it.
- **Counting or tracking cards over time.** Each frame is analyzed on its own.
- **Telling a real card from a counterfeit, or grading condition.**
- **Games other than Riftbound, without the steps in the adapt guide.** The released bank
  holds Riftbound cards only. Any other card is, at best, named nothing.

## Lineage

### Detector

1. YOLOX-Nano, pretrained on COCO by Megvii: `yolox_nano.pth` from the YOLOX release
   `0.1.1rc0`.
2. Two intermediate fine-tunes on private data. Those checkpoints are not published.
3. The released fine-tune on labeled public footage, generated scenes, card-free frames and a
   private stream.

The class-prediction layers of the COCO checkpoint (80 classes) were replaced by two: card
face and card back.

### Recognizer

1. MobileNetV3-Small, pretrained on ImageNet-1k by torchvision's authors:
   `MobileNet_V3_Small_Weights.IMAGENET1K_V1`.
2. The classifier was removed and a projection to 128 values added. The network was then
   trained for 34 epochs; the released weights are those of epoch 10.

[PROVENANCE.md](../PROVENANCE.md) gives each starting file's version and hash, and what its
publisher says about its terms.

## Training data

By kind. None of it is in this repository as images.

| Kind | What it is | Public? |
| --- | --- | --- |
| Labeled public footage | Frames of public videos of physical play and of a digital client, with a box around every card and the card's name | The labels are published as a manifest ([data card](data-card.md)). The frames are not; anyone can obtain them from the videos. |
| Generated scenes | Card images pasted onto generated tables, with exact labels | The generator is published (`cardvision make-composites`). The scenes are not. |
| Card images | The clean image of each card | Not published. They belong to Riot Games. |
| Private images | Images from our own private games on a digital client | Not published. |
| Card-free frames (detector only) | Frames of video that show no cards | Not published; see below. |

Real labeled footage is a small part of the whole: **50 frames, about 1,900 boxes, from 25
videos**. 48 of those 50 frames are in the public training manifest. The rest of the training
came from generated scenes, card images and the private images.

### Detector: the released fine-tune

`games/riftbound/train-detector.toml` is the recipe.

- **Length.** 500 steps, 16 training images per step.
- **Optimizer.** SGD with Nesterov momentum 0.9 and weight decay 0.0005.
- **Learning rate.** A warm-up over 30 steps to a peak of 0.001. Then a cosine down to 0.05 of
  the peak, reached at the start of the closing phase, and held there.
- **Closing phase.** The last 10 % of the steps, 50 steps: no mosaic images, and an L1 term
  added to the box loss.
- **Weight averaging.** An exponential moving average of the weights is kept throughout, with
  decay 0.9998.
- **What was exported.** The averaged weights at the last step. **No checkpoint was
  selected:** no step was picked as the best one.

Each training image starts from one tile, and about half the images are four-tile mosaics.
The streams the tiles came from:

| Stream | First tiles per batch of 16 | Share of a mosaic's further tiles |
| --- | ---: | ---: |
| Labeled public footage (50 frames) | 5 | 0.30 |
| Card-free frames | 2 | 0.125 |
| Generated scenes | 4 | 0.25 |
| Private images | 5 | 0.325 |

**The card-free frames** came from video searches that were not logged, so they cannot be
published as a manifest. The public trainer takes a folder of your own card-free images
instead.

**What the public recipe changes.** `cardvision/train_detector/default.toml` is the same
recipe with the private stream's tiles shared among the three public streams, and it starts
from the COCO weights, not from the intermediate checkpoint. It does not give the released
detector. What it gives was measured in Python (`cardvision evaluate detector`) on the 21
fully boxed frames of the public evaluation set: 415 face targets in 6 recording groups, a
very small set. Intervals are 95 % by recording group.

- **At the released score threshold, 0.3:** the public recipe (seed 1337) found 370/415 =
  89.16 % (85.56–93.29) of the faces, with 1.57 false positives per frame. The released
  detector found 387/415 = 93.25 % (85.96–97.18), with 1.76.
- **Two more seeds,** reported and not picked: 87.47 % and 88.67 % at the same threshold.
- **At a cap of 0.5 false positives per frame:** 83.37 % for seed 1337 against 83.61 % for the
  released detector; the other two seeds trail by 5 to 6 points.
- **Behind the released recognizer,** the seed-1337 detector named 91.07 % of readable faces
  right, against 92.50 % for the released pair (paired difference −1.42 points, −3.60 to
  +0.79).

Of the two public-only models, what gap there is to the released ones sits in the detector.
"3. Public-only recipe" under Evaluation has the whole pair.

### Recognizer: the released training

`games/riftbound/train-recognizer.toml` is the recipe: the loss, the augmentations, the
hyper-parameters and the epoch grid are those of the released run.

- 34 epochs of 800 steps at batch 256: 27,200 steps.
- 204,913 rows per epoch. The table under this list says what they were.
- 37 cards were kept out of training altogether, to check that a card known only from its
  image can still be found. The recipe names them.
- **Checkpoint choice.** Scored every 5 epochs and at the end. The released checkpoint, epoch
  10, was chosen by a score on a private validation set of 12,615 crops. The public trainer
  keeps the same shape of rule on public inputs: half top-1 on real crops of training cards
  from recording groups held out whole, half top-1 on generated crops of cards kept out of
  training.

**What an epoch of the released run held.** A row is one training crop. The first kind sets
the size of the others: 113,704 crops from a private stream, covering 870 training cards.
That count is the recipe's `base`. Every other count below is worked out from it, and the
rows add up to 204,913.

| Kind of row | Rows per epoch | Share of 204,913 |
| --- | ---: | ---: |
| Crops from a private stream, covering 870 training cards; every row once | 113,704 | 55.49 % |
| Crops cut from the generated scenes | 27,126 | 13.24 % |
| Real labeled crops | 15,648 | 7.64 % |
| Real negatives (crops that show no card face) | 6,803 | 3.32 % |
| Negatives from the private stream | 6,804 | 3.32 % |
| 96 rows of every card of a second private stream | 13,728 | 6.70 % |
| Extra rows of alternate printings and of Battlefield cards (the recipe's `[boost]`) | 14,700 | 7.17 % |
| Rows of easily confused pairs of cards, 4 pairs in every batch | 6,400 | 3.12 % |
| Total | 204,913 | 100.00 % |

The arithmetic:

- **Private stream.** 113,704 crops, covering 870 training cards.
- **Generated crops, and their cap.** The recipe asks for round(0.30 × 113,704) = 34,111
  crops. Only 27,126 could be used. The cut pool held 27,943 crops, and 817 of them were of the
  37 cards kept out of training, so 27,943 − 817 = 27,126 were available. The count is the
  smaller of the two: min(34,111, 27,126) = 27,126.
- **Base so far.** 113,704 + 27,126 = 140,830.
- **Real labeled crops.** A tenth of the epoch up to that point, which is one row for every
  nine before them: round(0.1 / 0.9 × 140,830) = 15,648.
- **Positives so far.** 140,830 + 15,648 = 156,478.
- **Negatives.** The rule is F / (1 − F) of the rows so far, with F = 0.08:
  round(0.08 / 0.92 × 156,478) = 13,607. Half are real crops and half come from the private
  stream: 6,803 and 6,804.
- **Subtotal.** 156,478 + 13,607 = 170,085.
- **Then** 13,728 + 14,700 + 2 × 3,200 = 34,828 rows. The 3,200 is 4 pairs in each of the 800
  batches, and a pair is two rows, so the pairs give 6,400.
- **Total.** 170,085 + 34,828 = 204,913 rows per epoch. An epoch ran as 800 steps at batch
  256 (204,913 / 256 = 800.4; a last, partial batch is dropped), for 34 epochs: 27,200 steps.
- **Shares.** Each count over 204,913, rounded to two decimal places. Nothing is adjusted: the
  eight rounded shares add to exactly 100.00 %.

So 62.19 % of an epoch's rows came from those two private streams ((113,704 + 13,728) /
204,913). Half of the negatives also came from a source that is not published; "Negatives"
below says what it was.

**What the public recipe changes.** The private streams are replaced by card images, and the
checkpoint is chosen on the two public validation sets. Expect a different result from the
released weights. Measured in Python on the public evaluation set (53 frames, 20 recording
groups, 1,053 readable faces; intervals 95 % by recording group). It is a small public
benchmark used during development, not an independent test of generalization, and some of its
digital identity labels were assigned with model suggestions ("1. Public evaluation set"
under Evaluation):

- **The run.** One seed (1337), 34 epochs from ImageNet weights. The checkpoint kept was
  epoch 10's, chosen on the public validation sets. Its bank held the 1,472 cards of the
  catalog as the repository published it then; no labeled face in the evaluation set is
  outside it.
- **Behind the released detector,** it named 991/1,053 = 94.11 % (90.88–96.88) of readable
  faces right, against 92.50 % for the released recognizer. Wrong of shown: 1.39 %
  (0.64–2.17) against 1.62 %. The paired difference in named right, +1.61 points (−0.16 to
  +3.90), is not distinguishable from zero.
- **On labeled face crops** (253 crops in 4 recording groups, very few), top-1 right: 235/253
  = 92.89 % (88.38–96.51), against 238/253 = 94.07 % (88.89–97.69). Intervals over 4 groups
  are descriptive: with so few groups they can be unstable or misleadingly narrow.
- **From random weights** instead of ImageNet, the same recipe is far worse; see "3.
  Public-only recipe" under Evaluation.

### The generated scenes of the released runs

One set of scenes fed both models.

| | |
| --- | --- |
| Scenes | 8,000 for training, 500 for validation |
| Layouts | table 5,165; board (a game in progress) 2,040; scatter 795 |
| Background | a CC0 material scan in half the scenes (the 183 training scans of the list's 207; the other 24 are for validation scenes), a generated surface in the rest |
| Broadcast graphics | none 5,600; side panels 1,075; bars 737; picture-in-picture 588 |
| Frame size | 1280 × 720: 3,966; 1920 × 1080: 4,034 |
| Card faces labeled positive | 93,916, of 1,240 card ids |

- **Not from card images alone.** About 45 % of the card faces in those scenes, and the card
  backs, came from private image pools. The published generator runs on card images alone and
  draws its own card backs. That is a different training distribution.
- **The detector** used whole scenes: 4 of the 16 first tiles of each batch, and a 0.25 share
  of the further mosaic tiles.
- **The recognizer** used 27,943 face crops cut from the scenes: positive faces that are
  nearly whole (at least 90 % visible), at least 48 px on the short side, and within 15
  degrees of a quarter turn.
- **Photometric strength.** The generator tints, flattens and blurs cards and adds glossy
  streaks, at strengths drawn per card; one number scales those strengths together. That
  number was fitted to real crops.
  Strengths were tried in a fixed rising order, and the one kept is the lowest at which a
  recognizer of the time (an earlier model) was right about as often on generated face crops
  as on real crops of the same size: 52.7 % top-1 on real crops, 54.1 % on generated crops,
  inside the ±5 points allowed.

### Negatives

The recognizer is also trained on crops that show no card face, so that it scores them low.

The released run's real negatives also included boxes rejected during pre-fill and detector
false positives on the same frames, which a label manifest cannot carry; the public trainer
builds negatives from card-back and not-card boxes only.

## The bank and the accept rule

- **Bank.** One row per card, the mean of 16 views of the card's image. Computed from card
  images. The published bank, `bank.json` of release `201478a00d6ef6ba`, is version 1 and
  holds 1,492 cards; SHA-256 `8dd173a237a19bcd86c52b3cdb88b54f726e690c1d9e19f1bec6d75e63ce969e`.
  A row can record which image it was computed from (`artV`, a hash of the image file). A
  refresh reuses a row unless it can see that the card's image changed, and a bank written
  before the field existed records no image. So a row can lag behind a card's current image.
  `cardvision check-bank-art` reports it.
  In the published bank, no row was embedded from an earlier image than the one its catalog
  pins.
- **Identity.** Printings that share a name are one card. A match shows the printing whose
  row matched best, which is not always the printing on the table.
- **Accept rule.** `tau` 0.62, `delta` 0.05, rotation retry on
  (`games/riftbound/accept.json`). A name is shown only when the best match scores at least
  0.62 and leads the best differently named card by at least 0.05. The values were calibrated
  for the released models on real footage, with real negatives.
- **Hover rule.** The selection called `accepted-nms`; [how-it-works.md](how-it-works.md)
  describes it.

## Evaluation

Four kinds of figure, kept apart. [method.md](method.md) explains the measures and how to
run them.

### 1. Public evaluation set (reproducible; not an unseen test)

Labels on public videos, published as a manifest. Anyone can obtain the frames and run
`cardvision evaluate`.

Release `201478a00d6ef6ba`, scored once in Python on 2026-10-18 (`cardvision evaluate hover`,
`crops` and `detector`, default settings). All 53 rows had their frame; the check of
2026-10-10 found all 53 reachable. Intervals are 95 % by recording group (10,000
replicates); "—" where a slice has a single group.

| Measure | All sources | Digital clients | Physical play |
| --- | --- | --- | --- |
| Hover: named right | 974/1,053 = 92.50 % (88.25–95.76) | 673/695 = 96.83 % (94.47–98.79) | 301/358 = 84.08 % (78.79–89.49) |
| Hover: wrong of shown | 16/990 = 1.62 % (0.71–2.68) | 13/686 = 1.90 % (0.67–3.32) | 3/304 = 0.99 % (0.24–1.98) |
| Crops: top-1 | 238/253 = 94.07 % (88.89–97.69) | 11/12 = 91.67 % (—) | 227/241 = 94.19 % (88.46–98.23) |
| Detector: recall at score 0.3 | 387/415 = 93.25 % (85.96–97.18) | 127/145 = 87.59 % (77.78–95.12) | 260/270 = 96.30 % (92.50–97.89) |
| Detector: recall at 0.5 false positives per frame | 347/415 = 83.61 % (71.63–90.78) | 105/145 = 72.41 % (57.14–84.15) | 242/270 = 89.63 % (85.00–93.02) |
| Detector: AP@0.5, card faces | 0.9491 | 0.9467 | 0.9565 |

Recording groups: hover 20 (12 digital, 8 physical), crops 4 (1 and 3), detector 6 (2 and
4). The crop intervals, and the detector intervals by source, rest on 2 to 4 groups: treat
them as descriptive, since with so few groups an interval can be unstable or misleadingly
narrow. The detector and crop rows have no Rift Atlas frames: the boxed frames are TCG Arena and
physical play. The "released" columns in section 3 split hover by client. The score
threshold at a false-positive cap is found on all sources together, so one source alone can
be above the cap.

None of this set was trained on. It is still not an unseen test: parts of it were looked at
while the recognizer was developed, so it flatters the models somewhat. The
[data card](data-card.md) says which parts. This is a small public benchmark used during
development, not an independent test of generalization.

**Some identity labels were given with model suggestions.** Of the 764 face centers whose
identity a person labeled (one kind of label in this set, not all 1,053 readable faces it is
scored on), 458 were named after two models' names were shown; on 418 of those the person
accepted the name both models gave. All 458 are digital-client faces; every physical-play
face was named blind. Whether a name was legible was answered before any suggestion was shown,
which protects that answer, not the identity given afterwards. Which models supplied the
suggestions is not recorded in the published data, so how they relate to the models scored
here cannot be told from it. (The labeling tool records its arms by file and checksum,
`verify.arms` in [labeler/FORMAT.md](../labeler/FORMAT.md); the published manifest drops them.)
The suggestions could bias the absolute rates and the comparisons below; the size and
direction of any bias are not known. The [data card](data-card.md#how-the-labels-were-made)
has the full accounting.

A frame fetched today is not byte-identical to the frame that was labeled. Figures on
re-fetched frames can differ slightly from published ones. What was seen:

- `cardvision fetch` keeps a frame only when its fingerprint is within 6 bits of the row's;
  a row with no such frame is reported as unusable and not scored. In the fetch of
  2026-10-10, all 53 frames were 0 to 2 bits from their fingerprints (46 at 0).
- With the same detector and recognizer and an earlier bank, extracting the frames again
  from those downloads, three times, gave the same hover figures each time.
- With those same models and bank, decoding the downloads in a web browser instead of Python
  changed 24 of the 1,995 hover events, in both directions. Named right moved by one face
  (975/1,053) and wrong of shown by none (16/991).

**Proposed investigation thresholds, not a reproducibility range.** If a re-fetch of all 53 rows
gives, in the "All sources" column, named right more than 1 point from 92.50 % or wrong of shown
more than 0.5 point from 1.62 %, look for the cause before trusting the figures. The rationale:
the largest change seen above was one face of named right (with that earlier bank, 974 of 1,053
in Python and 975 in the browser, about 0.1 point) and a negligible one in wrong of shown, and
the thresholds add a margin to that. They are a chosen tolerance, not a measured re-fetch
variability. The repeatability checks that ran are the three above: the fingerprints of one
fetch, three extractions from the same downloads, and one decode of them in a web browser. No
second download has been compared with this one, so no check sampled a change in the downloads
or in a platform's encodes, and a platform that re-encodes a video can move a figure further.
The source columns hold fewer events and can move more.

### 2. Private held-out test (reported; not reproducible)

A private held-out test set, scored once. These results are historical: they belong to
release `5cd3a4bf37154976`, not to the bank published here ("The configuration these figures
belong to" below). The test ran in a web browser, on the video
platforms' own watch pages, under a protocol fixed beforehand. One criterion of the check on
the capture tool was amended after scoring; see "The validation accounting" below.
[method.md](method.md) describes the protocol.

All counts are unreduced.

| Source | Groups | Named right (clustered 95 % interval) | Wrong of shown (clustered 95 % interval) | Upper bound: exact / clustered | Not reached |
| --- | ---: | --- | --- | ---: | ---: |
| Rift Atlas | 23 | 345/352 = 98.0 % (96.6–99.4) | 5/350 = 1.43 % (0.29–2.87) | 2.98 % / 2.61 % | 16 % |
| TCG Arena | 15 | 175/181 = 96.7 % (94.8–98.7) | 1/176 = 0.57 % (0.00–1.85) | 2.67 % / 1.60 % | 28 % |
| Physical play, near-overhead cameras | 20 | 322/382 = 84.3 % (76.9–91.2) | 9/331 = 2.72 % (1.03–4.48) | 4.70 % / 4.19 % | 31 % |
| Physical play, steeper cameras (reported apart) | 5 | 44/68 = 64.7 % | — | — | — |
| Radiance cards (a stratum inside the Atlas and Arena rows) | 6 | 93/96 | — | — | — |

**The clustered intervals and the clustered bound were added after scoring. They are for
reference only; no verdict depended on them.** They resample whole recording groups (20,000
replicates) and were computed from the per-group tallies fixed at scoring.

The two rates do not share a denominator. What each column means:

- **Named right** = right / (right + wrong + nothing shown), over readable card faces that the
  test could reach.
- **Wrong of shown** = wrong tooltips / all tooltips counted: the share of counted tooltips
  that are wrong under this test's target-sampling protocol ("From labels to targets" below).
  It is not a measured frequency of wrong tooltips for real viewers, whose pointers need not
  follow that mix. Wrong tooltips are faces named wrong, any tooltip on a card back, and any
  tooltip on an off-card point that names a card not under it. A readable face that showed
  nothing is in the first rate and not in the second. (Rift Atlas: the 5 wrong tooltips were 3
  faces, 1 back and 1 off-card point.)
- **Upper bound** = one-sided 95 %. The exact binomial bound is what the protocol reported.
  It treats events as independent, which events from one recording are not, and the scorer
  labels it a reference only. The clustered bound is beside it.
- **Not reached** = the share of eligible targets the test could not read: under the player's
  controls, behind an advert, lost to video quality, or failing a frame check. The reasons
  were decided before any read. **The rates are on reached targets.** Targets at the bottom
  of the player, under its controls, were left out, and the direction of any bias from that
  cannot be told from the record.
- **From labels to targets.** 1,408 seeded points (16 per frame on 88 frames, from a fixed
  low-discrepancy sequence), each labeled with what lies under it, plus the labeled face
  centers and the card backs found in a census of each frame: 3,013 planned targets (Rift
  Atlas 999, TCG Arena 628, physical 1,386). A seeded point that lands on a face is a face
  target, on a back a back target, elsewhere an off-card target. Then eligibility, then reach.

#### The validation accounting

The automated capture tool was checked against a pass made by hand.

- 198 hand-versus-automated pairs.
- 162 agreed: 127 showed the same name and 35 both showed nothing. There was no disagreement
  of identity or of status.
- 36 could not be compared. That is 18.2 %, against a limit of 5 % fixed beforehand. **The
  check tripped.**
- After scoring, the rule was amended. 20 pairs lay on two whole frames that the automated
  pass never opened because an advert was served; they leave the check. The other 16 pairs,
  where both passes gave the same could-not-reach reason, count as agreeing. In all: 162/162
  comparable outcomes agreed; 16 more pairs agreed on non-reach status; 20 were excluded under
  a post-scoring amendment. Agreeing that a target could not be reached does not verify a
  displayed name.
- The amendment did not change the model-result counts above. It affects how much confidence
  this check gives in the capture tool.
- A rerun of those 20 with the same frozen tool agreed with the hand pass on all 20. It was
  diagnostic: nothing was rescored.
- The per-source results above never depended on this rule.

#### How the recognizer was chosen, and an override

The released recognizer was a candidate judged against the recognizer it replaced, under a
rule fixed beforehand. The rule, as it was written:

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

- It passed the rule's accuracy clauses. For example: +7.0 points on a private development
  set, interval +4.0 to +11.1.
- It failed three clauses. On each of two sets it showed two more tooltips on off-card points
  than the recognizer it replaced. And a card back was named by the second training seed,
  which is not the released candidate.
- Under the rule the answer was: do not adopt.
- **The rule was overridden.** Two outside reviews found those three clauses mis-specified
  for their sample sizes. (The reviews were by other AI models;
  [how-this-was-built.md](how-this-was-built.md) says what kind of review that was.) The
  override was made under stated conditions: the artifacts frozen by hash, and a fresh,
  independently labeled screen before the private test. It accepted a stated cost.

The cost, as it was stated when the rule was overridden:

> The override accepted, on the development read, about two more off-card tooltips per 742
> random points than the incumbent and a wrong-of-shown rate of 10/601 (1.66 %) against the
> incumbent's 9/599 (1.50 %) on the digital set, in exchange for +7 to +9 points of
> correct-over-named on physical and Arena rows; the backs clause had been tripped by the
> pair seed, not the shipped seed.

The override is the author's decision, not the rule's. It is stated here so that a reader can
weigh it.

#### The envelope

The physical-play figures are for cameras near overhead, to about 30°. The steeper-camera
row shows what lies outside that: 44/68.

#### The configuration these figures belong to

The figures belong to release `5cd3a4bf37154976`, whose public document pins every component
by hash. They are historical to it.

**The bank published with this repository is newer.** Adding cards can change a decision on
an old card. These figures are therefore not a test of the published bank.
The release published with this repository is `201478a00d6ef6ba`. Its detector and
recognizer are those of `5cd3a4bf37154976`; the bank, the identity groups and the catalog
changed, in three refreshes since that release:

- one live in the product on or before 2026-10-09;
- one live on 2026-10-10;
- the current one, live since 2026-10-15: 36 rows embedded again from a new image (18
  whose preview image had become the final image, and 18 that had been embedded from an
  earlier image), and 18 cards added, from 1,474 to 1,492; none removed. The recognizer did
  not change. Before it went live, a replay of 140 fixed targets of a private development
  set was accepted: 134 could be compared, and none regressed.

Its bank holds 1,492 cards.

### 3. Public-only recipe

What the published code reaches when it trains on the published training manifest,
generated scenes and card images alone, scored on the public evaluation set beside the
released weights.

- **What ran.** One run of each public recipe: the detector from the COCO weights (seed
  1337), the recognizer from ImageNet weights (seed 1337). The public-only arm is release
  `1df8452de1bead6a`, with a bank of the 1,472 cards of the catalog as the repository
  published it then; no labeled face in the evaluation set is outside it. The released arm is
  release `201478a00d6ef6ba`: the released detector and recognizer with a bank of 1,492 cards.
  Of its 20 extra cards, one was shown on this set, twice, on a card of the same name in that
  1,472-card catalog, and both
  counted right; no other extra card was shown. An extra card can also change a margin without
  being shown, and that effect was not tested: no same-catalog run of the released arm was
  made. Both arms used the same accept rule (`tau` 0.62, `delta`
  0.05, rotation retry). Scored once, in Python (`cardvision evaluate hover`), with no
  threshold tuned.
- **The set is small.** 53 frames, 20 recording groups, 1,995 hover events, 1,053 readable
  faces. Intervals are 95 % by recording group (10,000 replicates). The exact bounds below
  are one-sided 95 % and treat events as independent; they are for reference.
- **It is not an independent test.** This is a small public benchmark used during
  development, not an independent test of generalization. Some digital identity labels were
  assigned with model suggestions: 458 of the 764 face-center identity labels, by models
  that are not recorded in the published data (section 1 above, and the
  [data card](data-card.md#how-the-labels-were-made)).

| Source | Groups | Named right, released | Named right, public-only | Wrong of shown, released | Wrong of shown, public-only |
| --- | ---: | --- | --- | --- | --- |
| All | 20 | 974/1,053 = 92.50 % (88.25–95.76) | 971/1,053 = 92.21 % (88.05–95.51) | 16/990 = 1.62 % (0.71–2.68) | 12/983 = 1.22 % (0.51–2.15) |
| Digital clients | 12 | 673/695 = 96.83 % (94.47–98.79) | 669/695 = 96.26 % (94.49–97.90) | 13/686 = 1.90 % (0.67–3.32) | 4/673 = 0.59 % (0.00–1.26) |
| Rift Atlas | 8 | 526/539 = 97.59 % (94.77–99.62) | 523/539 = 97.03 % (95.48–98.34) | 11/537 = 2.05 % (0.45–3.67) | 4/527 = 0.76 % (0.15–1.56) |
| TCG Arena | 4 | 147/156 = 94.23 % (81.82–95.76) | 146/156 = 93.59 % (81.82–100.00) | 2/149 = 1.34 % (0.00–3.85) | 0/146 = 0.00 % (0.00–0.00: degenerate, see below) |
| Physical play | 8 | 301/358 = 84.08 % (78.79–89.49) | 302/358 = 84.36 % (80.23–89.85) | 3/304 = 0.99 % (0.24–1.98) | 8/310 = 2.58 % (1.03–4.59) |

**TCG Arena, public-only, wrong of shown:** no errors observed, 0/146 across 4 recording
groups. The percentile bootstrap degenerates to 0–0 and does not provide useful uncertainty
here; it does not establish a zero error rate. The row's other intervals rest on the same 4
groups and are descriptive too.

Exact bounds, all sources: named right at least 91.02 % released and 90.72 % public-only;
wrong of shown at most 2.44 % released and 1.97 % public-only.

Paired differences (public-only minus released, same events, 95 % by recording group):

- **All sources:** named right −0.28 points (−4.03 to +3.17), wrong of shown −0.40 points
  (−1.38 to +0.76). **Neither is distinguishable from zero on this set.** That is not a
  claim that the two are equal: the set is too small to tell a difference of a few points.
- **Digital clients:** named right −0.58 (−3.09 to +2.08). Wrong of shown −1.30 (−2.20 to
  −0.45): fewer wrong names for the public-only pair; the interval excludes zero, but it is
  one of several slices on 12 groups, so read it as a hint, not a finding.
- **Physical play:** named right +0.28 (−8.43 to +8.80). Wrong of shown +1.59 (−0.14 to
  +3.52): more wrong names for the public-only pair, 2.58 % against 0.99 %. The interval
  includes zero.

**Where the gap sits.** The public-only detector came out weaker: at the released score
threshold it found 89.16 % of faces against 93.25 % (21 frames, 6 groups; the intervals
overlap; "What the public recipe changes" under the detector). Swapped in behind the
released recognizer, it named 1.42 points fewer faces right (paired interval −3.60 to +0.79,
which includes zero).
The public-only recognizer is not behind the released one on this set; behind the released
detector it named 94.11 % right, a paired +1.61 points (−0.16 to +3.90). Across three
detector seeds, reported and not picked, the pair's named right spread by 0.5 points and its
wrong of shown by 0.2 points.

**From random weights.** The same recognizer recipe started from random weights
(`--init random`), beside the public-only detector, named 796/1,053 = 75.59 % (65.70–83.72) of
readable faces right, and 168/964 = 17.43 % (12.38–23.70) of shown names were wrong: about
one in six. Against the ImageNet start, the paired differences are −16.62 points (−23.39 to
−11.30) and +16.21 points (+11.63 to +21.90). It is not usable as a product model. A detector
from random weights was not measured. One run, with the recipe unchanged (it was set for an
ImageNet start; a recipe tuned for random weights was not tried).

The videos of the evaluation set are on a fixed exclusion list for this run, so published
data can never train on what it is scored on.


### 4. Cost

| | |
| --- | --- |
| Detector | 3.7 MB as ONNX |
| Recognizer | 4.0 MB as ONNX |
| Analysis time in a browser, WebGPU | about 86 ms for a 1080p frame, on an Apple M3 Max |
| Analysis time in a browser, WebAssembly | about 243 ms for a 1080p frame, on an Apple M3 Max |
| Analysis time in Python (`cardvision infer`, CPU) | about 93 ms for a 1080p frame with 16 card faces (median), on an Apple M3 Max |

### Python and browser figures differ slightly

The private test ran in a browser. `cardvision evaluate` runs in Python. The two follow the
same steps, but floating-point results can differ in their last bits between runtimes and
between processor architectures, and a score exactly at a threshold can then fall either
side. Every figure here says which runtime it came from.

The published scoring code gave identical results under NumPy 1.26 and 2.2.

## Limits

- **Steep camera angles.** Outside the near-overhead envelope fewer cards were named: 44/68
  in the private test, against 322/382 inside it.
- **Sleeves and glare.** Glossy sleeves and reflections hide part of the art. Their effect
  was not measured apart.
- **Small cards.** A box under 24 px on a side is dropped before recognition. A small crop
  carries little of the art. The effect of size was not measured apart.
- **Content that is not Riftbound.** The detector looks for cards in general, so it may box
  another game's cards or card-like graphics. The accept rule is what keeps them from being
  named. This was not measured on other games' footage.
- **Cards newer than the bank.** A card the bank lacks cannot be named right. It should be
  named nothing; it can be named as a card that looks like it.
- **Printings.** Printings of one name are one identity. The printing shown is the best
  match, which may not be the printing on the table.
- **Not reached.** The private test could not read 16 % to 31 % of its eligible targets. The
  figures say nothing about those.
- **One frame at a time.** The Python tools do not smooth results over time.

## Can the released weights be rebuilt?

Not exactly. Images from our own private games on a digital client, and card images, were
part of the training. Neither is published. The detector also started from an intermediate
checkpoint that is not published.

What is published: the recipes, the code, the labels on public footage, and the generator of
scenes. Section 3 above says what those reach without the private parts.

**Retrained with the private parts.**
Both released models were trained again through the published trainers, with the private
data passed in through plug-ins, the same recipe and the same seed. The detector started
from the same unpublished intermediate checkpoint, so only its last fine-tune was run again.
The bar was written before the run. Before any output existed, it was widened to the spread
between two seeds of the original runs, never below the original bar, because a run with
the same seed does not repeat bit for bit across PyTorch and CUDA versions. Per measure:
5.5 points for the detector at 0.5 false positives per frame, and 1.0 point at 2.2; for the
recognizer, 1.0 point of named right and two more wrong tooltips per set. Both models
passed. Both also stayed inside the original bar: 1.0 point, and for the recognizer at most
one more wrong tooltip per set.

- **Detector.** On a private set of 23 frames used to compare detectors during development,
  the retrained detector found 83.45 % of physical-play cards at 0.5 false positives per
  frame, against 84.14 % for the released weights (−0.69 points, 2 of 290 cards), and
  95.52 % against 95.86 % at 2.2 (−0.34 points). A second run with the same seed and code
  landed 1.38 points below the released weights at 0.5, which would have missed the original
  1.0-point bar; it was reported only, never a candidate.
- **Recognizer.** The same checkpoint was chosen: epoch 10, at a selection score of 0.9293
  against 0.9303. Each recognizer was scored behind the released detector's boxes, with a
  bank of the same 1,492 card images built by its own weights. On a private development set
  it named 85.77 % of readable faces right against 86.31 % (−0.54 points, 3 of 555 faces),
  with 9 wrong tooltips against 10. On a second private set (digital client) it named
  96.10 % right against 95.94 % (+0.16 points), with 20 wrong tooltips each.

## Reporting a wrong card

Open a "Wrong recognition" issue with the video's id, the time in the video, where on the
frame the card is, what was shown and what the card is. **Do not attach a frame or a
screenshot.** The video id and the time are enough to find it.
