<!-- SPDX-License-Identifier: Apache-2.0 -->

# Questions and answers

## Was this built with AI?

Yes. I'm a solo software engineer with some machine learning experience; computer vision
isn't my core competency. Much of the code was written by an AI coding assistant working to my
instructions. [how-this-was-built.md](how-this-was-built.md) says how
it was checked: tests, comparisons with the code that trained the released models, a private
held-out test scored once, and outside reviews. Those reviews were made by other AI models and
by fresh AI sessions, not by people.

The models themselves recognize cards. They do not generate images.

## Were the models trained on ImageNet or COCO?

Not by us. The recognizer starts from torchvision's MobileNetV3-Small weights, which
torchvision's authors trained on ImageNet-1k. The detector starts from Megvii's YOLOX-Nano
weights, which were trained on COCO.

torchvision's code is BSD-3-Clause, and its documentation says pretrained weights may carry
terms from the dataset they were trained on. ImageNet's images are offered for non-commercial
research. Whether that reaches a model fine-tuned from those weights is not settled, and we
are not lawyers.

What we can say: our own work is Apache-2.0, the starting points are named in
[NOTICE](../NOTICE) and [PROVENANCE.md](../PROVENANCE.md), and the training script can start
from random weights instead (`cardvision train-recognizer --init random`,
`cardvision train-detector --init random`).

For the recognizer, that costs a lot. We trained it from random weights with the public-only
recipe and data, and scored it on the public evaluation set (53 frames, 20 recording groups,
1,053 readable faces; a small set, used during development, so not an independent test of
generalization), beside the public-only detector. One run, with the recipe
unchanged (it was set for an ImageNet start; a recipe tuned for random weights was not tried).
It named 75.6 % of readable faces right (796 of 1,053; 95 % interval by recording group 65.7
to 83.7 %), against 92.2 % from ImageNet weights. About one name in six that it showed was
wrong: 17.4 % (168 of 964; 12.4 to 23.7 %), against 1.2 %. The paired intervals of both gaps
are far from zero. That model is not usable as a product model; the ImageNet start matters. A
detector from random weights was not measured.

## Can I use this commercially?

The licenses on our own work allow it.

- **Code and weights: Apache-2.0, for the rights we hold.** The grant covers this project's
  own work: the code, the documentation, what our training added to the weights, and our own
  work in the bank and identity groups, and the catalog's selection and arrangement
  ([NOTICE](../NOTICE)). It cannot cover the starting checkpoints' terms or the card images
  (below). Within that, you may use, change and sell them. Keep the license and the
  [NOTICE](../NOTICE) with any copy you pass on, and say what you changed. That is a summary;
  the [license](../LICENSE) is the text that counts.
- **Labels: CC BY 4.0.** You may use them for any purpose, with credit.
  [PROVENANCE.md](../PROVENANCE.md#licenses-by-artifact) has a complete attribution example.

[PROVENANCE.md](../PROVENANCE.md#licenses-by-artifact) has one table for every published
artifact: code, weights, bank, identity groups, catalog and labels, each with its grant, its
provenance, the notices to keep and the rights it does not settle.

Three things those licenses do not settle for you:

1. **The starting weights.** See the question above.
2. **The card images.** The bank and the weights derive from card images that belong to the
   game's publisher. This repository does not contain them and cannot license them. What you
   may do with a bank or with weights for a game is between you and its publisher.
3. **The name.** RiftSight and its logo are not licensed. Use your own name
   ([TRADEMARK.md](../TRADEMARK.md)).

We are not lawyers and this is not legal advice.

## Why is the test set private?

Keeping the set private reduces direct contamination: a test set that is published ends up
in training data. Repeated adoption decisions can still overfit it. We record each use; once
its feedback guides changes, it serves as a regression benchmark, and a new independent sample
is needed for a fresh generalization claim.

The cost is that you cannot reproduce those figures. So there is also a public evaluation
set, with labels anyone can score against, and the [model card](model-card.md) keeps the two
kinds of figure apart and says what each is worth.

## Why is there no card art in the repository?

Because it is not ours. The card art belongs to Riot Games.

The tools take a folder of card images that you are entitled to use, and the repository
contains none: no card art, no video frames, no images from any game. The catalog holds
card ids and names, and a file name per card, never a link to an image.

This does not hide how the method works. The bank is computed from card images, and the
recognizer's training pulls crops towards clean card images. The docs say so plainly.

## Can I rebuild your exact weights?

No.

Images from our own private games on a digital client, and card images, were part of the
training, and neither is published. The detector also started from an intermediate
checkpoint that is not published.

What you can do is run the published recipes on public inputs: the label manifests, scenes
from the generator, and your own copies of the card images. That gives different weights.
How they compare with the released ones: we ran the public recipes once, on public inputs
and card images alone, and scored the result on the public evaluation set. That set is small:
53 frames, 20 recording groups, 1,053 readable faces. It is a public benchmark used during
development, not an independent test of generalization, and some of its digital identity
labels were assigned with model suggestions
([data card](data-card.md#how-the-labels-were-made)).

- **Named right:** 92.2 % for the public-only models, 92.5 % for the released ones. The
  paired difference, −0.28 points (95 % interval by recording group −4.03 to +3.17), is not
  distinguishable from zero.
- **Wrong of shown:** 1.2 % against 1.6 %. The paired difference, −0.40 points (−1.38 to
  +0.76), is not distinguishable from zero either.
- **Weak spots.** The public-only detector finds fewer cards: 89.2 % of faces at the released
  score threshold, against 93.3 %, on the 21 fully boxed frames of that set (415 faces, 6
  recording groups; the intervals overlap). On physical tables, 2.6 % of the names the
  public-only models showed were wrong, against 1.0 %; that paired interval includes zero.

The [model card](model-card.md#3-public-only-recipe) has the figures by source.

## Does it work on my game?

Measured on one other game, the One Piece Card Game, on a small held-out set (25 frames from
13 videos in 9 recording groups, so the intervals are wide):

- the released weights as they stand, with a bank built from that game's card images, named
  93/296 = 31.4 % (23.7–42.5) of readable card faces right, with 11/104 = 10.6 % (4.2–28.0)
  of the names shown wrong;
- both models trained with the adapt guide on 23 labeled frames and generated scenes named
  221/297 = 74.4 % (50.3–83.8) right, with 9/230 = 3.9 % (1.6–11.8) of the names shown wrong;
- the optional geometric stage on top of those raised it to 249/297 = 83.8 % (62.5–91.8),
  with 7/256 = 2.7 % (0.6–10.3) wrong.

Physical play was well below digital: on it, the 23-frame trained models named 68/124 =
54.8 % (41.0–67.1) right, with 7/75 = 9.3 % (3.2–18.8) of the names shown wrong. One digital
recording group holds 135 of the 297 readable faces, so the overall figures lean on it. Wrong
of shown is the share of counted tooltips that are wrong under that evaluation's
target-sampling protocol. These figures are for that game and that protocol. The figures, the
caveats and the comparisons written down before scoring are in
[adapt-your-game.md](adapt-your-game.md#measured-on-another-game-the-one-piece-card-game);
the example's models and labels are in their own repositories: the
[models](https://huggingface.co/JuicyKaraageNo1/kenbunshoku-onepiece) and the
[labels](https://huggingface.co/datasets/JuicyKaraageNo1/kenbunshoku-onepiece-labels) on
Hugging Face.

What can be said from how it is built:

- **The detector** has two classes, card face and card back. They are about cards in
  general, not about Riftbound's cards. Whether it finds your game's cards as it stands is
  the open question.
- **The recognizer** needs no retraining to learn a new list of cards. You build a bank from
  your card images. Whether its vectors separate your game's cards well enough is the other
  open question.
- **If either falls short,** both can be fine-tuned with the published trainers on generated
  scenes of your cards and a small number of labeled frames.

[adapt-your-game.md](adapt-your-game.md) has the steps in three tiers, and
[AGENTS.md](../AGENTS.md) has the same steps for a coding agent. Try tier 0
([your-game.md](your-game.md)) before anything else: it takes your card list and images and
tells you quickly whether the released models see your cards at all.

Other games' catalogs, banks and weights are not kept in this repository. They live with
their authors and are linked from the README's "Built with this" list.
