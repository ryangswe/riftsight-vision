<!-- SPDX-License-Identifier: Apache-2.0 -->

# Data card

The labels this project made on public Riftbound gameplay videos, published as text.

- **Format:** label manifests, one JSON line per labeled frame. [data/SCHEMA.md](../data/SCHEMA.md)
  describes every field.
- **License:** CC BY 4.0, for the annotations only ([LICENSE-DATA](../LICENSE-DATA)).
- **Size:** small. See the counts below.

## What a manifest contains

For single frames of public videos:

- which video (the platform and the video's id) and at what time;
- the size of the frame the labels were made on;
- a box around every card, or labeled points, as fractions of the frame;
- for each card face: the card's catalog id, whether a person could name it, and whether it
  can be read from that frame alone;
- the kind of footage (physical play or a digital client);
- a pseudonymous id for the recording group, the row's role, and whether that very frame
  trained the released models;
- who is credited for the labels;
- whether the video could still be found when last checked.

## What a manifest does not contain

- **No frame, no image, no video.** A row points at a frame; it does not hold one. The
  validator refuses a manifest folder with any file that is not plain text.
- **No channel names, no titles, no notes.** There is no free-text field in the format.
- **No download.** Nothing here gives access to a video.

A row may carry a 64-bit fingerprint of its frame (`frame_dhash`), which lets a tool confirm
it has found the labeled frame. It records only which of 72 coarse regions are brighter than
their neighbor. The picture cannot be rebuilt from it.

## What a video id reveals

**A video id identifies its channel.** Anyone can look a video up by its id. Leaving channel
names out of the manifests is a courtesy. It is not privacy, and the manifests should not be
treated as anonymous.

The CC BY 4.0 license covers only the rights held in the annotations. It grants nothing in
the videos, gives no access to them, and settles nothing about anyone's privacy.

## The sets, in numbers

| Set | Role in the manifest | Videos | Rows (frames) | Labels | Was it trained on? |
| --- | --- | ---: | ---: | ---: | --- |
| Training | `train` | 24 | 49 | 1,780 boxes | 48 of the 50 real frames that trained the released models are here. `trained_on` marks them row by row. |
| Evaluation | `evaluation` | 21 | 53 | 699 boxes and 1,494 points | Never. |
| Extra | `extra` | 6 | 283 | 4,658 boxes | Never. See below. |

File names: `data/riftbound-train.manifest.jsonl` is the training manifest the recipes read.
The evaluation set is `data/riftbound-evaluation.manifest.jsonl` and the extra set is
`data/riftbound-extra.manifest.jsonl`.

Their SHA-256 at release:

| File | SHA-256 |
| --- | --- |
| `data/riftbound-train.manifest.jsonl` | `85b724f71de22d50a4e5bc685ce3f65a2ed6b79fac482d6792811a1da9f813ee` |
| `data/riftbound-evaluation.manifest.jsonl` | `6abaa3c6b59680dd7cffa61becbd597f1a25fe1f9fef966344927d5682a9f823` |
| `data/riftbound-extra.manifest.jsonl` | `60b6f241088832e4d57371212b633dd5db75b4a8fad00fb58970eff33e876cfa` |

By source type. A boxed row has a box around every card. A point row has labeled points and
no claim about the rest of the frame.

| Set | Source type | Videos | Rows | Boxes | Points |
| --- | --- | ---: | ---: | ---: | ---: |
| Training | Physical play, tournament | 13 | 27 | 812 | |
| Training | Physical play, webcam | 3 | 5 | 153 | |
| Training | Physical play, phone | 3 | 4 | 122 | |
| Training | TCG Arena | 5 | 13 | 693 | |
| Evaluation | Physical play, tournament | 5 | 14 | 317 | 161 |
| Evaluation | Physical play, webcam | 1 | 2 | | 73 |
| Evaluation | Physical play, phone | 1 | 2 | | 85 |
| Evaluation | Physical play, camera not recorded | 1 | 6 | 191 | |
| Evaluation | TCG Arena | 5 | 10 | 191 | 253 |
| Evaluation | Rift Atlas | 8 | 19 | | 922 |
| Extra | Rift Atlas | 6 | 283 | 4,658 | |

In the evaluation set, 21 rows are boxed and 32 are point rows. All of it is YouTube video:
rows from another platform whose recordings expire were left out, so that the set stays
obtainable.

### Training

Frames of physical play and of the digital client TCG Arena, with a box around every card
and a name on each face a person could name. These are the real frames behind both released
models. They are a small part of what trained them; the [model card](model-card.md) lists
the rest.

Two of the 50 real training frames are not in the public manifest.

### Evaluation

The public evaluation set. Anyone can obtain its frames and run `cardvision evaluate`
([method](method.md)). It has three parts:

- **Exhaustively boxed frames** of physical play and TCG Arena. Every card has a box, so
  these serve all three measures: hover events, recognizer crops and the detector.
- **Point-labeled frames** of physical play, Rift Atlas and TCG Arena. Only the listed
  points are labeled, so these serve the hover measure only.
- **Point-labeled frames** of Rift Atlas and TCG Arena chosen for cards of the Radiance set.

**It is not an unseen test, and it says so.** None of it was trained on. But:

- the boxed frames were used to score candidate recognizers while the recognizer was
  developed;
- each point-labeled part was looked at once: the first as a screen of the recognizer before
  the private test, the second as one read of how Radiance cards are recognized;
- the first point-labeled part was sized as a screen: in places one frame per video.

So the set flatters the released models somewhat, its physical-play part is thin, and it is a
modest yardstick. Present it as one.

### Extra

Frames of the digital client Rift Atlas, boxed exhaustively. They were an early held-out
test and were then used to score successive versions of the detector during development. They
were never trained on. Because development decisions were made on them, they are published
as data and kept out of the evaluation set.

### What stays private

- **A private held-out test set.** Keeping it private reduces direct contamination; it does
  not stop repeated adoption decisions from overfitting it. Each use is recorded, and once its
  feedback guides changes it serves as a regression benchmark. The
  [model card](model-card.md) reports the figures measured on it, which are historical to
  release `5cd3a4bf37154976`.
- **Two private development sets.** Decisions to adopt a new model are made on them.
  Publishing them would mean drawing new ones before the next decision.
- **Images from our own private games on a digital client**, used in training.

## How the footage was found and grouped

**Training set.** Most training groups were found by YouTube search and got their role from
a seeded shuffle (see "How roles were assigned" below). The rest were found by later searches
made for one source each, Rift Atlas and cards of the Radiance set, and were assigned by rule
rather than by shuffle, or by dated amendments made by the author. All of these are recorded
in the private history of the roles. One early Twitch group predates these searches: it was
found by hand for the earliest draw of roles.

**Evaluation set.** A selection by rule, not a seeded draw. It is YouTube videos only: 21
videos and 53 labeled frames, 8 of Rift Atlas, 5 of TCG Arena and 8 of physical play. They
were drawn from videos used during development (the screen of the recognizer, the read of
Radiance cards, and the development videos), so all 21 were used during development. Left
out: every video of the private held-out test, every video of the private development set
on which adoption decisions for physical play and TCG Arena are read, and the recordings of
a platform where they expire.

**Extra set.** An early manual selection of Rift Atlas gameplay videos from YouTube
(September 2026): 6 videos. The search method was not recorded.

Videos that share an origin, such as one channel or one event, form a **recording group**.
The same table, camera and sleeves recur throughout a group. A model trained on one video of
a group has in effect seen the others, so a group is the unit for everything that follows.
An official event is one origin however many channels carry it, and the cuts of its rounds
share it. A streamer's cross-posts and alternate channels are tied into one group.
Group ids in the manifest are pseudonyms: they say which rows belong together and nothing
else.

### Which footage is in

Digital-client footage and physical-play footage from public videos.

For physical play, a conservative filter was applied before publishing:

- **In:** channels of creators, and channels of event organizers. A shop's channel
  broadcasting an organized, named tournament counts as an organizer.
- **Out:** other streams by shops, and footage by private individuals. They are added later
  only if the person who runs the channel asks.
- **Out by default:** any channel that could not be identified.

**This filter is not a permission.** It is a choice about which rows to point a public file
at. It gives nobody a right in any video.

### How frames were chosen

One frame per second was sampled, from the whole video when it ran 45 minutes or less and
otherwise from three ten-minute stretches. The frames to label were chosen from those.
[data/SCHEMA.md](../data/SCHEMA.md), "How the frames were first sampled", has the exact rule.

## How roles were assigned

Most recording groups got their role from a seeded shuffle of whole groups: no model
output, no look at the frames, no choice by the person labeling. The exceptions are stated
below and in "How the footage was found and grouped": the evaluation set, groups added by
later searches, and dated amendments.

- A group has exactly one role. **A group is never split across roles.**
- Groups dealt to training are published as `train`. Held-out groups that are published are
  `evaluation` or `extra`; which held-out sets are published, and as which, is described set
  by set above.
- For new groups the rule is `cardvision assign-roles` (`cardvision/data/roles.py`): each
  source type ends up with a set share of its groups in evaluation.

The published roles were not all dealt by one shuffle. The evaluation set is the selection
by rule described above. The extra set is the early held-out test described above. The
shuffle behind most groups dealt 118 recording groups, within each source type and origin,
with a fixed quota per key (`random.Random(20261002)`): 73 groups to training, 19 to
development and 26 to the private held-out test. Groups added later were assigned by rule
or by dated amendment, as described above.

`role` and `trained_on` answer different questions. `role` is where the row is published.
`trained_on` is a fact about the released models, taken from the lists they were actually
trained on, not from the role. A `train` row can be `false`; no other role can be `true`.

## How the labels were made

- **Who.** One person, the author. Contributed rows name their contributor in `credit`.
- **Tool.** The labeling tool in [labeler/](../labeler/README.md).
- **Rules.** [How to label](labeling.md). In short: a
  box around every card in the frame; the whole card for a card worth learning from, the
  visible part only for an ignore region; the card's own top marked; a name where one can be
  given, with a separate answer to "can it be read from this frame alone".
- **Model pre-fill.** For training labels, a model's boxes and names were shown and the
  person accepted, corrected or rejected each. A row's `prefill_offered` field says whether a
  model's boxes were shown on that frame, and a box's `origin` says whether it began as a
  model's proposal.
- **Points.** A point says what is under one position of the frame: a card (and which), a
  card back, or not a card. Points that fall off every card are real negatives: showing a
  card there is wrong.

**How the evaluation set was labeled.** In its 21 boxed rows, every box's `origin` is
`manual`. Its 32 point rows hold two kinds of point:

- **Seeded points**, `origin` `seeded`: 16 per frame, 512 in all, placed by the labeling tool
  from a fixed low-discrepancy sequence. Their positions depend on the frame and a seed,
  never on the picture. Each was answered with what lies under it.
- **Centers**, `origin` `center`: one on each card face and card back a person clicked in a
  census of the frame, 982 in all (764 faces, 218 backs). No model output was shown while
  clicking.

Each face center was then named from a crop around it. Whether the name was legible in the
crop was answered before any model's name was shown, and each named face carries
`readable_from` `crop`. Two attributes record the rest:

- `blind` true: the face was named with no model's name shown at all. 306 faces, among them
  every face of physical play. On the other faces it is false.
- `verified_by`: how the name was given. On the other 458 faces, the names two models gave
  were shown after the legibility answer, and the person accepted both when they agreed
  (`accept-both`, 418), accepted one of them (`accept-one`, 25), picked another card
  (`picked`, 14) or answered Unknown (`unknown`, 1). On the blind faces it is `picked` (304)
  or `unknown` (2).

So models' names were shown, after the legibility answer, on 458 of the 764 faces. In the
training set, all 49 rows have `prefill_offered` true. The rows of the evaluation set and of
the extra set do not record it.

## Which cards have real labeled crops

A card is known to the recognizer from its image, and some cards also from real labeled
crops in the training manifest.

299 card ids, 246 card names, have at least one face that becomes a recognizer training
crop in a row the released models were trained on (`trained_on` true): a named face that is
not an ignore region, is not labeled unreadable, and passes the shape check
(`cardvision/data/targets.py`, `crop_exclusion`, with the rules of
`games/riftbound/sources.json`). Printings that share a name are one card to the accept
rule. The ids by set, each written as the set code, a hyphen and the number (OGN-004):

- **OGN** (97): 004, 007, 007A, 012, 013, 016, 024, 027, 028, 029, 039, 039A, 042, 042A,
  043, 045, 046, 056, 058, 060, 077, 079, 087, 089, 089A, 092, 094, 095, 096, 099, 103, 105,
  110, 114, 116, 120, 121, 121A, 122, 124, 126, 126A, 132, 136, 156, 160, 166, 166A, 169,
  181, 184, 186, 192, 194, 195, 199, 204, 205A, 209, 210, 211, 212, 214, 214A, 220, 222,
  232, 238, 240, 246, 246A, 247, 259, 261, 265, 273, 274, 277, 280, 284, 285, 287, 288, 289,
  290, 291, 292, 294, 295, 296, 297, 298, 299, 305, 306, 307, 310.
- **OGS** (2): 019, 021.
- **SFD** (90): 001, 003, 007, 021, 023, 025, 026, 029, 036, 042, 045, 046, 048, 051, 057,
  057A, 062, 065, 066, 069, 071, 076, 077, 085, 089A, 097, 098, 099, 105, 106, 110, 113,
  120, 128, 130, 133, 136, 138, 139, 140, 145, 146, 149A, 150, 155, 161, 175, 177, 177A,
  180, 181, 183, 184, 185, 186, 187, 189, 195, 197, 203, 205, 207, 209, 210, 212, 213, 215,
  216, 217, 218, 219, 220, 221, 225, 234, 242, 243, 246, 247, 251, R01B, R02B, R03B, R04A,
  R04B, R05B, R06B, T01, T02, T03.
- **UNL** (55): 002, 028A, 042, 051, 053, 061, 069, 079A, 080, 089, 089A, 090A, 094, 097,
  111, 112, 113, 113A, 114, 118, 120, 120A, 128, 141, 143A, 150, 150A, 152, 153, 176, 181,
  183, 185, 189, 193, 195, 197, 199, 202, 207, 215, 226, 227, 229, 231, 232, 236, 237, R01A,
  R02A, R04A, R05A, T02, T03, T08.
- **VEN** (55): 012, 019A, 020, 028, 031, 038, 038A, 044, 045, 046, 055, 058, 068, 068A,
  069, 072, 073, 075, 076, 083, 084A, 095, 099, 100, 102, 104, 105, 112A, 113, 114, 135,
  139, 143, 144, 145, 149, 151, 155, 164, 174, 189, 190, 191, 197, R01A, R01B, R02A, R02B,
  R03B, R04A, R05A, R06A, SP6, T05, T06.

## Whether the videos can still be found

Each row records `reachable` and the date it was checked. A video can be deleted, made
private or, on some platforms, expire.

The check is a `cardvision fetch --download` run, and `cardvision record-reachable` copies
its outcome into the rows ([data/SCHEMA.md](../data/SCHEMA.md), "How reachability is
recorded"). The rows of the evaluation set record the check of 2026-10-10. The training set
was checked on 2026-10-17, but that outcome is not recorded in its rows yet: their `reachable`
is still `null`. The extra set was checked differently, and not recorded in its rows either:
only its videos' metadata was read, with no frame downloaded.

Rows reachable at publication, from the latest check of each set:

| Set | Rows reachable | Checked on |
| --- | --- | --- |
| Training | 48 of 49, each frame downloaded. The video of one row is no longer available. | 2026-10-17 |
| Evaluation | 53 of 53, each frame downloaded | 2026-10-10 |
| Extra | 283 of 283 by video metadata: all 6 videos public, every row's time within its video's length. No frame downloaded. | 2026-10-18 |

A row that becomes unreachable stays in the manifest and is reported as unreachable. It is
never dropped from a denominator silently. `cardvision evaluate` lists every row it could not
score, with what it would have contributed.

## Getting the frames

A frame is obtained from its video under the extraction contract in
[data/SCHEMA.md](../data/SCHEMA.md). `cardvision fetch` follows it, from video files you
already have (`--video-file`) or, if you ask, by downloading (`--download`).

- **Downloading is your own act.** The platforms' terms of service apply to you. They may
  restrict downloading and automated access, and handing the step to a tool does not change
  that.
- **A fetched frame is not the labeled frame byte for byte.** Platforms re-encode, decoders
  round differently, and the labeled frames were themselves JPEG. The labels land in the
  same places; pixel values differ slightly. Figures on re-fetched frames can differ a little
  from published ones.

## Removal

If you run a channel and want the rows that point at your videos taken out, open a "Footage
removal request" issue or write to the contact in [SUPPORT.md](../SUPPORT.md). The rows are
removed within 7 days. No reason is needed.

**A CC BY 4.0 license cannot be withdrawn from copies already taken.** A removal takes the
rows out of this repository and of any mirror this project runs. It cannot take them out of
copies that others made before.

## Contributed labels

Labels are accepted as manifest pull requests ([CONTRIBUTING.md](../CONTRIBUTING.md)).

- Contributed labels are public under CC BY 4.0.
- Each row carries the credit its contributor chose, so the attribution travels with the
  data.
- A new recording group gets its role from the same seeded rule. Contributors cannot choose.
- Whether contributed labels are used to train the RiftSight product's models is the
  maintainer's choice.

## License

CC BY 4.0 for the annotations: the boxes, points, card ids and flags. To give credit, name
this repository; each row's `credit` names who made its labels.

The videos stay with whoever holds their rights. Card names, card ids and card art belong to
Riot Games. This is a fan project, not endorsed by Riot Games.
