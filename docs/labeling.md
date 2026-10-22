<!-- SPDX-License-Identifier: Apache-2.0 -->

# How to label

What gets a box, which kind of box, and how to treat the cases that make people hesitate. The
[labeling tool](../labeler/README.md) explains the keys and passes; [FORMAT.md](../labeler/FORMAT.md)
describes the files. Most sections below link to
[pictures of real frames labeled by their rule](https://github.com/ryangswe/riftsight-vision-label-examples):
Riftbound cards, kept in a repository of their own because the art is Riot Games'.

These rules are written for card games played on a table or in a digital client and filmed or
streamed. Adapt them to your footage, write down what you change, and date it: labels made
under an old rule can then be read under that rule.

## The one rule

Examples: [overlapping cards](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/03-overlapping-cards/README.md), [a covered card whose name still shows](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/04-name-still-shows/README.md).

Judge each card by what is visible:

- **Less than about half of the card is hidden:** a **card** box around the **whole** card,
  including the part you can't see.
- **About half or more is hidden,** whatever hides it (another card, the game's interface, an
  overlay, a hand, glare, the frame's edge): an **ignore** box around the **visible part** only.

Being able to work out which card it is does not change this. Judge by what is visible.

## What gets a box

Examples: [what is not a card](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/17-not-a-card/README.md).

Every card of the game in the frame: face up or face down, physical or digital, on the table,
in a hand, being picked up, or shown enlarged in a panel of the broadcast. A card left without
a box teaches a detector that it is background, so when in doubt, box it and mark what it is.

Art that is not a whole card face (a portrait cropped into a layout, a banner, a name plate,
splash art in the background) is not a card and gets no box. Neither do dice, counters, tokens
that are not cards of the game, the playmat, the interface or a webcam.

## Three kinds of box

| Kind | Key | When | What the box covers |
| --- | --- | --- | --- |
| Card | | A face you could place all four edges of with confidence, and that is worth learning from | The **whole card**, including any part hidden under a small thing: a die, a counter, a fingertip, the edge of the card on top |
| Card back | `b` | Face down: a deck, a face-down card, the back of a card in someone's hand | The whole card |
| Ignore | `h` | A face that is there but not worth learning from: about half or more hidden, its picture and name hidden, heavy motion blur, too small to see | **Only the visible part**: the smallest box around what you can see |

Why the difference: a card box is what a detector should predict, and a card with a small
thing on it is still a card to find, so it gets its full outline. An ignore box only marks a
region where a detection is neither rewarded nor penalized, so the visible part is enough and
is quick to draw.

## Small things on a card

Examples: [dice on cards](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/01-small-things-on-a-card/README.md).

A die, a counter, a damage marker, a fingertip, the corner of another card: the card is still a
card. Box its whole outline, under the small thing.

## Which way up

Examples: [tilted, sideways and upside down](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/02-which-way-up/README.md).

A box records the card's orientation. The side with the white tick is the card's own top: turn
the box with the card (`w` a quarter turn, the knob or `r` / `R` for a tilt), or Option/Alt+click
the edge that is the card's top.

- **Tilted or turned sideways** (tapped, exhausted): the box turns with it, and its top is on
  the side where the card's top now is.
- **Upside down** (the opponent's side of a table, for one): the top is at the bottom of the
  screen.
- **Cards of a landscape kind** (battlefields, locations, fields): the top is the edge the
  text reads along.
- **Card backs and ignore boxes:** orientation does not matter; do not spend time on it.

A card seen at an angle is a trapezoid on screen. In box mode, draw the rotated rectangle that
covers it best. Where no rectangle fits (a steep camera), mark it ignore and leave such footage
to corner mode, which records the four corners exactly.

## Stacks, fans and rows

Examples: [overlapping cards](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/03-overlapping-cards/README.md), [landscape cards and units on them](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/10-landscape-cards/README.md), [small cards in a tight run](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/11-small-cards-in-a-row/README.md).

Judge each card on its own, by the one rule. The top card of a stack is usually a card box; the
cards under it that show only a strip are ignored. In a row of overlapping cards the same holds:
the fully or mostly visible card gets a box, the overlapped strips are ignored.

Ignored strips that lie together may share **one** ignore box drawn around them: one region per
messy area, not one per card. Where it overlaps a card box, the card box still counts in full.
Every visible strip must be inside some box, because a strip left out counts as background. An
ignore box should not cover most of a card that has a box of its own.

A card whose outline would mostly show **another** card (the card on top hides its picture) is
ignored around its visible strip, even when its name can still be read. A recognizer matches
pictures; a full box there would teach it the top card's picture under the bottom card's name.

**A card on a landscape card** (a unit standing on a battlefield, for one): each is judged on
its own. The card on top usually gets a card box; the landscape card gets a card box when less
than about half of it is covered, else an ignore box on what shows.

**Small cards in a tight run** (Riftbound's runes, for one): a card that shows more than half of
itself gets a card box; the strips of the rest share one ignore box. Small cards side by side,
not overlapping, are ordinary cards: one box each.

## Card backs

Examples: [decks, piles and single backs](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/08-card-backs/README.md), [a fan of backs](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/09-fan-of-backs/README.md).

Every back gets a box.

- **A neat deck:** one box, the top card's whole outline.
- **A pile, or any group of touching backs:** **one** box around the pile. Backs are never
  named, so a box per card adds nothing.
- **A back standing alone:** its own box.
- **A fan of backs** (an opponent's hand, for one): the back in front, if less than about half
  of it is hidden, gets a back box; the strips of the others share one ignore box.
- **A back mostly hidden under another card:** ignored, boxed to its strip.
- **A back printed with art** (an art sleeve): still a back.

## The frame's edge

Examples: [cards cut by the frame's edge](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/05-frame-edge/README.md).

About half or less of the card in frame: ignore, boxed to the visible part. Most of it in frame
(picture and name visible, a sliver cut off): a card box around the whole card. A rotated box
may run past the frame's edge, which keeps the card's true size and angle.

## The interface, overlays and webcams

Examples: [a webcam and a game's interface over cards](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/06-interface-overlays-webcams/README.md).

A card partly covered by the game's interface, a broadcast overlay or a webcam: the one rule
applies, as for a card covered by another card. The interface, the overlay and the webcam get no
box of their own.

## Cards shown enlarged

Examples: [a hover preview and a broadcast panel card](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/07-cards-shown-enlarged/README.md).

A whole card face shown enlarged (a client's hover preview, a card shown in a panel of the
broadcast) gets a card box like any other card. Cropped art in the layout (a portrait, a banner,
a name plate) gets none.

## Cards in a digital client's hand

Examples: [a client's hand](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/13-digital-hand/README.md).

Some clients draw the cards in hand cropped, showing the picture and not the text. That is how
the card always looks there, so it is the exception to the one rule: box the visible part as a
card, top edge up, and tag it `visibleShare: half` so that it can be told apart later.

## Tokens

Examples: [tokens on a table](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/12-tokens/README.md).

A token that is a card of the game (it is in your catalog, marked as a token) is boxed like any
card. A marker that is not a card (a die, a bead, a counter) gets no box.

## Physical play

Examples: [sleeves, glare and an angled table](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/14-physical-play/README.md).

- **Sleeves, cases, holders:** box the card, not its sleeve, case or holder: always the card's
  outer border, never the picture frame inside it.
- **Glare and foil:** glare on part of a card is a small thing on it. Glare that hides about
  half or more of the card, or its whole picture, makes it an ignore box.
- **Moving cards:** a card being played or picked up is a card box when its face is sharp and
  mostly visible, else an ignore box.
- **Blur:** heavy motion blur makes an ignore box.

## Very small cards

Examples: [cards too small to make out](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/15-very-small-cards/README.md).

A card too small for its picture to be made out is an ignore box. Frames where most cards are
that small are better removed from the set (the frame menu's **Remove this frame from the
project…**) than labeled.

## How exact

Within a few pixels of the card's outer edge (2 to 3 percent of its width) is fine; do not
nudge for perfection. Be consistent instead: always the outer border, never the picture frame
inside it.

## No card at all

A frame with no card in it is finished with no boxes: the primary button then reads "Finish
frame with no cards". It teaches the detector what is not a card.

## Two passes

Draw every box first (box mode, with "Hide names" on), then name them (identify mode). Boxing and
naming are different kinds of attention, and each is faster alone.

## Naming

Examples: [a card nobody can name](https://github.com/ryangswe/riftsight-vision-label-examples/blob/main/cases/16-card-nobody-can-name/README.md).

Name what you can. `y` / `n` / `m` record whether the card is readable **from this frame
alone**. A card you recognize from a corner of its picture, from the deck list or from knowing
the game gets its name and `n`. **Unknown card** is always allowed and always better than a
guess: a card nobody can name keeps its box and gets that answer.

While naming, check the yellow TOP marker and fix it if it is on the wrong edge.

A card with several printings: pick the printing on screen when you can tell, else the base
card.

The filters above the list of cards narrow it: Type always, then whatever the catalog declares
as facets (Riftbound's catalog has Domain, Energy and Set). A catalog without facets shows only
Type; [the labeling tool's catalog section](../labeler/README.md#the-catalog) says how to add
them, such as a color, a cost or a set.

## Points

In point mode each point is answered with what lies under its center: a card (and which), a
card back, not a card (the table, an overlay, the interface) or a card that cannot be read. A
point on a card's edge counts as that card.

## A census of centers

In center mode, click the center of every card face and Shift+click the center of every card
back, by the same rules as boxes: a card mostly covered by another card is not clicked, and
neither are the overlapped strips of a row. A pile of backs gets one click, at the center of its
top card.

## Naming a census

In verify mode, answer "readable from this crop alone" before anything else, from the crop and
nothing but the crop. Then judge the proposals against the picture, not against each other: two
models agreeing is not evidence that they are right. If neither is right, pick the card
yourself or answer Unknown.

## Which footage to label for training

Pick tables seen from above or at a slight angle (within about 30 degrees), where a rotated
rectangle still fits a card. Skip frames of steeply angled tables in box mode.

## Labels for measuring a model

Label them without any model's help: no pre-fill, and no carry-over in a test set. Decide the
frames and the seed before you look at any result, and do not go back to change a label
because a model disagreed with it.

The question a measuring set answers can differ from the one training labels answer. To
measure hovers, for one, a partly hidden card that a viewer could still point at may count as a
card to find, where a training label would ignore it. Write the set's rule down before you
label, as [Measure](measure.md) describes.
