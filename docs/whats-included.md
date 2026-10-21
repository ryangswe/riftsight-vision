<!-- SPDX-License-Identifier: Apache-2.0 -->

# What is in this repository, and what is not

## What it does

- **Finds and names cards in a frame of video.** A detector boxes card faces and card backs,
  a recognizer matches each face against a bank built from card images, and an accept rule
  shows nothing when a match is not trusted.
- **Runs in Python and in a web page.** The `cardvision` command line, and a TypeScript runtime
  on ONNX Runtime Web that says which card would be shown under the pointer.
- **Can be pointed at your own game.** A bank built from your card images needs no
  retraining; where that falls short, both models can be fine-tuned with the published trainers
  and a labeling tool that runs on your own machine.
- **Publishes its labels and its method.** Label manifests for frames of public videos, and the
  evaluation tools that score what a viewer would see under the pointer.

## What is in this repository

| | |
| --- | --- |
| `cardvision/` | The Python package and command line: inference, the bank and release tools, both trainers, the generator of training scenes, export, and evaluation. |
| `labeler/` | A labeling tool that runs on your own machine: a small Python server and one web page, no install. A model pre-fills boxes and names, and a person corrects them. |
| `browser/` | The same pipeline for a web page, in TypeScript on ONNX Runtime Web: it loads a release and says which card would be shown under the pointer on a video or image. With a demo page for a local file. See [In a browser](quickstart.md#in-a-browser). |
| `data/` | Label manifests: for single frames of public videos, where the cards are and which cards they are. Text only. The format is in `data/SCHEMA.md`. |
| `games/riftbound/` | Riftbound's catalog (card ids and names), accept rule, and the two training recipes. |
| `games/_template/` | The starting point for another game. |
| `docs/` | Start here, the quickstart, how it works, the commands, the release files, the model card, the data card, the evaluation method, the adapt guide and its pages (your game, train, measure, extension), and what was tried and dropped. Every page is listed in [reference.md](reference.md). |
| `tests/` | The tests. They run on a toy game drawn by code. |
| `examples/` | `toy_quickstart.py`: the [quickstart](quickstart.md) as one script. |

**As release assets, not in git:** the detector and recognizer weights (ONNX), the bank and
its identity groups, the catalog, and the release document that pins them together. See
[Getting the released weights](release-files.md).

## What is not in this repository

- **No card art, no video frames, no images from any game.** The tools take a folder of card
  images that you are entitled to use. The bank is computed from card images and the
  recognizer was trained on them; the docs say so plainly. The images themselves are not here.
- **No videos.** A label manifest names a public video by its id and a time in it. Getting
  the frame is a step you run yourself.
- **The private part of the training data.** The released weights were also trained on images
  from our own private games on a digital client. Those are not published.
- **The private test set.** The headline figures, in the README and the model card, are on the
  public evaluation set. The model card also reports a private held-out test, scored once. Its
  results are historical: they belong to release `5cd3a4bf37154976`, whose bank is older than
  the published one. Keeping the set private reduces direct contamination; once its
  results have guided changes, it serves as a regression benchmark.
- **The browser extension.** `browser/` holds the recognition runtime that runs in a web page
  and a demo page for a file on your own disk, also hosted on GitHub Pages. It is not an
  extension, and it does not attach to any website. An example extension built on it is
  described in [extension.md](extension.md).

**So you cannot rebuild the released weights exactly.** Private images and Riot's card art
were part of the training mix, and neither is published. What the published recipe reaches on
public inputs and card images alone is stated in the
[model card](model-card.md#3-public-only-recipe). On the public evaluation set, a small
one (53 frames, 20 recording groups, 1,053 readable faces), models trained that way named
92.2 % of readable faces right, against 92.5 % for the released weights. The paired difference
is not distinguishable from zero: −0.28 points, with a 95 % interval by recording group of
−4.03 to +3.17. The public-only detector came out weaker: swapped in behind the released
recognizer, it named 1.42 points fewer faces right (paired interval −3.60 to +0.79, which
includes zero). On physical tables more of the shown names were wrong (2.6 % against 1.0 %;
that paired interval includes zero too). This is a small public benchmark used during
development, not an independent test of generalization, and some of its digital identity labels
were assigned with model suggestions ([data card](data-card.md#how-the-labels-were-made)).
