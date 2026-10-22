<!-- SPDX-License-Identifier: Apache-2.0 -->

# How this was built

I'm a solo software engineer with some machine learning experience. Computer vision isn't my
core competency.

I built this project with heavy use of AI coding tools. Much of the code and the first draft of
the docs were written by an AI coding assistant working to my instructions. The design, the
measurements, and the decisions about what to ship are mine.

You should know that before you rely on any of it. This page says how the work was checked,
so that you can judge it by the checks and not by who or what typed it.

## How it was checked

**Tests.** `python -m pytest` runs the package's tests and the labeling tool's. They run on a
toy card game that is drawn by code, so they need no card art, no footage and no model file.
The contracts that must not drift have tests of their own: how a frame becomes the detector's
input, how a crop becomes the recognizer's input, how a bank is stored and extended, how a
release document is checked, how each evaluation figure is counted.

**Comparisons with the code that trained the released models.** The code here is a rewrite.
The released models were trained and measured with private, messier code. Parts of the
rewrite were compared with the code they replace, on the same inputs. The comparison scripts
are not published, because they run the private code. The results:

- **Scoring and the NumPy version.** The earlier scoring code gives the figures it gave at
  release only under NumPy 1. The published scoring code gives identical results under NumPy
  1.26 and 2.2. Where it matters, the published code states the precision of each step, so
  that a result does not depend on how a NumPy version promotes numbers.
- **The detector's recall measure.** The matching of detections to labels, and the counting
  of one frame, were run beside the earlier code on 18,000 random frames: 6,000 with boxes
  at arbitrary positions, 6,000 on a coarse grid, so that equal overlaps are common, and
  6,000 with cards lying at an angle. The first run found differences. The published code
  measured overlap on a card's outline where the earlier code used the upright box around
  it. It counted a detection matched at an overlap between 0.3 and 0.5 as a false positive.
  It called a detection lying mostly on card backs a false positive on a back. And it broke
  ties between equal overlaps in the other order. The published code was changed to follow
  the earlier code in all four. After the change, every matched pair and every count was
  identical on all 18,000 frames. How false positives are summed over frames, and how the
  score threshold at a cap is found, were not part of that comparison.

- **The rest of the scoring.** The outcome of each hover event, the adjacency rule, the hit
  test, the hover selections, the exact bound, the group bootstrap, the overlap geometry and
  the thresholds at a false-positive cap: 12 checks, no difference. The exact bound differed
  by at most 4.3 × 10⁻¹⁵, inside a tolerance of 10⁻⁹. Two old behaviors were left out on
  purpose: an interval form at the 5th and 95th percentiles (the published code reports the
  2.5th and 97.5th), and an accept-or-reject verdict on a count of regressions.
- **Inference and the shared core.** Contemporaneous project notes report that the shared
  building blocks (the catalog, the preprocessing of a frame and a crop, the bank format), the
  detector's output decode and the accept rule were identical, bit for bit, to the earlier
  code they replace. The check's own output was not kept.
- **The browser code.** Compared with the private browser runtime it was taken from, on
  random and scripted inputs, from the detector's decode through the hover selections, the
  tracker and the frame scheduler: the same output in all 291,304 cases.
- **The trainers.** The detector's trainer passed 19 of 19 checks and the recognizer's 35 of
  35: initial weights, augmentation, losses and every gradient, the optimizer, the learning
  rate at each step, and whole training steps (three for the detector, four for the
  recognizer), all identical bit for bit. The composite scene generator passed 144 of 144.
- **The bank.** The 15 synthesized views of 1,330 card images were byte-identical, 19,950 of
  19,950. Contemporaneous project notes report that of 40 bank rows built again by the
  published code on an Arm machine, 28 were identical to the bank shipped at the time, which
  was built on an x86 machine, and 12 differed by one half-precision step. The check's own
  output was not kept. The two kinds of machine can differ in the last bit of a float, and
  rounding to half precision then sometimes lands on the neighboring value. The bar set before
  the check was exact on x86 and within one step on Arm.

**A retrain through the published code.**
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

**A private held-out test, scored once.** The configuration released as `5cd3a4bf37154976` was
tested on recordings held out whole from all training. The results are historical to that
release: the bank published now is newer. The protocol was fixed before the test, and the test
was scored one time. The [model card](model-card.md) has the figures, with the share of targets
the test could not reach, the one criterion that was amended after scoring, and the one rule I
overrode. [method.md](method.md) says how it was run.

**Outside reviews.** The outside reviewers were not people. Such a review, on this page
and on the others, is one of two things: a review by another AI model than the one that did
the work, or a review by a fresh AI session that was given the material with no prior
context. Either way the reviewer did not take part in the implementation and reviewed the
supplied material in a separate session; this is not independent reproduction. The reviews
were made at points that are hard to undo, and their findings changed what was done.

- The decision to override the adoption rule went to two such reviews
  ([model card](model-card.md)).
- This release was reviewed at four points: the plan for it; the first export tooling; the
  fixes made to that tooling after its review; and the release package before publication.
  The fourth was a documentation review of the release package by another AI model, made
  with the implementation and the release files omitted. It was not a security audit and not
  an independent reproduction. It found one blocker and seven major issues, all addressed
  before publication.

**A cold start.** A fresh AI coding agent was given a copy of this repository and the
release files, no other context, and one hour. It was asked to check that the tools work, to
make the released models recognize a card game it drew itself, and to say what to do next.

- Every toy step of [AGENTS.md](../AGENTS.md) that it ran gave the output the guide shows.
  It did not need to read source code.
- It built a bank for its 20 drawn cards in two seconds. The released recognizer named every
  card that the detector found.
- The released detector found few of those cards: none of 23 drawn in a flat style, and 5 of
  23 drawn with more detail. Drawn stand-ins say little about a real game. They do show which
  part to check first on a new game: the detector.
- It reported six problems. All six are fixed. `cardvision infer` now says why a frame has
  no box. The guides now explain the box format, say what the contact sheet does not show,
  say how to test with card images and no video, and no longer assume a git checkout. A label
  manifest can now name a recording of your own, and not only a video on a platform.

This was one run by one agent. It is a check on the documentation, not on the models.

## What that does and does not tell you

- The tests show that the code does what its documentation says on generated data. They do
  not show that the models are good.
- The private test shows how release `5cd3a4bf37154976` did on one set of recordings, on the
  targets it could reach. Its results are historical: the published bank is newer. It is not
  reproducible by you, because the set is private.
- The public evaluation set is reproducible by you. It is small, and parts of it were looked
  at during development.
- Nobody outside the project has yet reproduced a result from this repository.

If you find something wrong, an issue with the command you ran and its output is the most
useful thing you can send.

## Why say this at all

Because it is true, and because you would want to know. It also explains the shape of the
repository: the [playbooks](../playbooks/), reached from [AGENTS.md](../AGENTS.md), hold the
adapt guide as steps a coding agent can run and check. The guides are written so that someone who is not a developer, working with a coding
agent, can build something like this for their own card game. The hard parts are judgment calls
such as what to label, what to measure, and when a result is real. A guide can only make
recommendations. The guide makes those decisions explicit, but it cannot make them for you.

## It reads cards

In card-game communities "AI" often means generated art. This is not that. These models
recognize cards in video. They cannot draw one.
