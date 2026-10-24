<!-- SPDX-License-Identifier: Apache-2.0 -->

# What we tried, and what we dropped

The released pipeline is the short version of a longer path. This page is the rest of it:
what was tried, what was dropped and why. It is here so that someone building the same thing
for another game can skip the parts that did not work.

Each item is described by what it is. None of the dropped code or weights is in this
repository.

## What we would do differently

**Start with a pretrained detector and real labels.**

The work began the other way round: a detector of our own design, trained only on images
from one digital client, with a small classifier in front of it to say whether a frame showed
that client's board at all. Both were built for that client. The detector did not carry over
to anything else: a second digital client, tournament cameras, webcams and phones. The cause
was the training data, not a threshold that could be tuned.

What fixed it was plain. Take a small detector pretrained on a general dataset. Label about
50 real frames across the kinds of footage that matter, letting the model pre-fill and a
person correct. Add generated scenes. Fine-tune. That is how the last training stage of the
released detector was done; the [model card](model-card.md) lists everything that went into
it.

**What the detour cost.**

- **Time.** Under a week of exploratory work in early September. Then, after a pause for
  other work, from about September 26 until the switch to a pretrained detector on
  October 4.
- **Two components built and then set aside.** The detector of our own design, and the board
  classifier. Neither is on the path that names a card.
- **A wrong belief held along the way.** That a second digital client was "close enough" to
  the first for the same detector. It was not, and the claim was withdrawn.
- **Labels came late.** The few dozen real labeled frames that made the difference were made
  after the detour, not before it.

If you are starting on another game: label a little real footage before you build anything,
hold whole recordings out, and fine-tune pretrained models. The
[adapt guide](adapt-your-game.md) is written in that order.

## Recognition without learning

**What it was.** Naming a card by comparing a crop with every card image using fixed,
hand-designed image measures, with no trained model.

**What happened.** It failed on real footage.

**The likely reason.** A card in video is small, blurred, compressed, tilted, sleeved and
unevenly lit. Measures that match two clean copies of an image do not survive that.

**What replaced it.** A learned embedding: an encoder trained so that a crop and its card
land close together.

## Banks built from clean art alone

**What it was.** Building the bank of reference vectors from clean card images, or from
synthetic variations of them, and matching real crops against it.

**What happened.** With the encoder of that time it failed on real footage.

**What changed.** The released bank **is** built from card images. It works because the
encoder is now trained for exactly that: its loss pulls each crop towards its own card's
clean image, and each bank row is the mean over 16 degraded views of the image. The order
matters. A bank from art works when the encoder was trained to bridge the gap. It did not
work as a shortcut around training one.

**Also dropped:** a bank styled to look like physical cards. It cost accuracy on the first
digital client's footage.

## A detector of our own, against a fine-tuned pretrained one

**What it was.** A detector of our own design, trained on images from one digital client.

**What happened.** It did not carry over to a second digital client, to tournament cameras,
to webcams or to phone footage. Moving the score threshold did not fix it. The cause was what
it had been trained on.

**What replaced it.** YOLOX-Nano, pretrained on COCO, fine-tuned on labeled real frames,
generated scenes and card-free frames. Measured side by side on the first client's footage,
it gave fewer wrong names and cost no more to run in a browser.

**What the comparison also showed.** Given exact card corners in place of upright boxes,
recognition gained 4 to 6 points. Getting that needs a model that outputs four corners,
which the released detector does not. Two attempts at one failed; see
[Four corners from a model](#four-corners-from-a-model).

## A larger pretrained encoder

**What it was.** A small vision transformer, pretrained without labels on a large general
image set, used as the recognizer in two ways: frozen, and fine-tuned.

**What happened.** Frozen, it lost to the small recognizer trained for the task; so did a
second, differently pretrained encoder. Fine-tuned, it beat the recognizer of the time on
development data.

**Why it was not adopted.** 43.5 MB of weights and about 123 ms per hover in a browser. The
released recognizer is 4.0 MB. For a tool that runs in a viewer's browser tab while a video
plays, that price was too high for the gain.

## A board classifier

**What it was.** A tiny four-layer convolutional network that answered one question: does
this frame show the first digital client's board? Results were shown only when it said yes.

**What happened.** On physical play it hid every correct result, and on the second digital
client most of them.

**Why it was dropped.** It needs retraining for every game and client. Away from the first
client, the accept rule, calibrated on real negatives, replaced it: a crop that resembles no
card is shown as nothing, whatever the scene. In the released configuration the classifier
decides nothing about tooltips. The browser extension still uses it for one thing, when to
draw ambient outlines; it is not part of this repository.

## An angle head

**What it was.** A model output predicting each card's angle, so that a crop could be turned
upright before recognition.

**What happened.** It learned quarter turns and nothing finer.

**Why it was dropped.** Quarter turns are already handled without it: when the upright look
is not accepted, the recognizer tries the three other orientations. A head that adds only
what the retry already does is not worth its weights.

## Four corners from a model

**What it was.** Two ways to get each card's four corners, so that a card seen at an angle
could be cropped flat: a corner branch added to the detector, reading the same features as its
boxes, and a separate small network that takes one detected card's crop and places its
corners. Both were trained on generated scenes alone, with tilted cards whose corners are
exact, and both were judged on held-out tilted scenes by a pass rule written down before any
result, over two training seeds.

**What happened.** Neither passed.

- **The corner branch.** Its corner error was 11.4 to 11.7 px, against 10.6 px for the corners
  of the plain upright box: no better than the box. The slope of its predicted tilt against
  the true tilt was about 0, against a bar of 0.7: it drew upright rectangles. Several
  variants of the branch stopped at the same place.
- **The per-crop network.** It placed corners well: 2.6 px, against 16.7 px for the box's
  corners on the same cards. It did not follow tilt toward or away from the camera closely
  enough: a slope of 0.43 to 0.45 and a correlation of 0.51 to 0.54 between predicted and true
  tilt, and a median tilt error of 13 to 14 degrees, against bars of 0.7, 0.7 and 6 degrees.

**Why it was dropped.** A corner branch on the detection features learns upright rectangles.
A small per-crop network places corners well but does not recover a card's tilt reliably
enough to pass. The labeling tool keeps its four-cornered boxes, so real angled frames can be
labeled as they come; a later attempt can start from those instead of generated scenes alone.

## Batch hard negatives

**What it was.** In the recognizer's loss, picking the hardest wrong cards within each batch
and pushing the crop away from them by a margin relative to the right card.

**What happened.** With a relative margin it learned nothing.

**Left to try.** An absolute margin, and mining hard negatives from the whole bank instead of
the batch.

## Smaller things that made no difference

- **Recognizing upright only.** Dropped: cards lie sideways and upside down in real play, and
  the rotation retry recovers them.
- **Normalizing every card to one scale before recognition.** No gain.
- **Matching the video codec in training (H.264 against JPEG).** No gain.
- **A separate verifier model after the recognizer.** Not needed: the margin in the accept
  rule already says nothing when two cards are close.
- **Different accept thresholds per kind of footage.** Three studies; one pair of thresholds
  was kept for all sources.

## What held up

- **Label a little real footage and retrain.** A model pre-fills, a person corrects.
- **Generated scenes fitted to real crops.** Useful once the strength of their photometric
  effects was fitted so that a recognizer did about as well on generated crops as on real
  ones.
- **An accept rule calibrated on real negatives.**
- **Whole recordings held out,** and a test set that is scored once.
- **The hover event as the unit of measurement:** what a viewer is shown at a position, with
  wrong names counted against everything shown.
