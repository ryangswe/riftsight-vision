<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing

Thank you for wanting to help. This page says what is welcome, what is not taken into this
repository, and the two statements every contribution carries: the sign-off and the
provenance clause.

One person maintains this repository. [SUPPORT.md](SUPPORT.md) says what to expect.

## What is welcome

- Fixes to the code, with a test that fails without the fix.
- Tests.
- Corrections and improvements to the documentation, the adapt guide
  ([docs/adapt-your-game.md](docs/adapt-your-game.md)) and [AGENTS.md](AGENTS.md) most of all.
  If a step did not work for you, that is a bug in the guide.
- Reports of a wrong card (use the "Wrong recognition" issue form).
- Label manifests for Riftbound footage (see "Label contributions" below).

## What is not taken into this repository

- **Other games' catalogs, banks, weights or labels.** They live in their authors' own
  repositories. Tell us about yours and it is linked from the "Built with this" list in the
  README. A game's card names and art belong to its publisher, and what may be published for
  that game is a question for whoever publishes it.
- **Features outside the scope.** The scope is the detector, the recognizer, the bank and the
  accept rule, the label manifests, and the tools that train, label and evaluate. Features of
  the RiftSight product that are not card recognition (deck tracking, match history, stream
  overlays) are outside it.
- **Images of any kind.** No card art, no video frames, no crops, no screenshots that show a
  card or a frame of someone's video. This holds for issues and pull requests too. A check
  refuses image, video and weights files. The one exception is the project banner,
  `.github/banner.svg`, which is drawn as plain vector shapes.
- **Weights.** Released weights are release assets. They are not committed.

"How do I adapt this to my game?" is a question for Discussions, not for an issue.

## Before you open a pull request

```
python -m pip install -r requirements-lock.txt
python -m pip install --no-deps -e .
python -m pytest
```

With this environment the tests that need PyTorch are skipped. The check that the Python
package and the browser runtime agree is skipped too, unless `npm ci` has been run in
`browser/`; `.github/workflows/browser.yml` runs that check and requires it. Some tests need
the `ffmpeg` program and are skipped without it: one of `tests/test_data_extract.py`, and
those of `tests/test_data_frame_times.py` that read a recording of variable frame rate. If
you changed a trainer or an exporter, run the tests in the training environment as well
(`requirements-lock-train.txt` says how to build it).

If you touched a manifest:

```
cardvision validate-manifest data --sources games/riftbound/sources.json
```

`--sources` names the file that lists the Riftbound manifests' source types. Without it the
command knows only the built-in ones and reports the others as problems.

Every file in `cardvision/`, `tests/`, `labeler/`, `examples/`, `games/`, `data/`, `browser/`,
`docs/` and `.github/`, and every Markdown or text file at the top of the repository, starts
with the license line (`SPDX-License-Identifier: Apache-2.0`, written as a comment of that kind
of file). JSON and CSV files are the exception, since they have no comments. A test checks it.

## Sign-off (DCO)

Every commit carries a `Signed-off-by` line. A check blocks a pull request that has a commit
without one.

By signing off you certify the Developer Certificate of Origin, version 1.1. Its text is at
<https://developercertificate.org/> and is used as it stands. In short, you certify that you
wrote the contribution or otherwise have the right to submit it under the repository's
license. Read the text itself before you sign.

```
git commit -s -m "your message"
```

adds the line from your git name and email:

```
Signed-off-by: Your Name <you@example.com>
```

- **A persistent handle is accepted in place of a legal name**, as long as the email address
  works. This holds for every contributor alike.
- **Each person signs their own commits.** Nobody signs off for someone else.
- **You may use AI coding tools.** A tool cannot sign. The sign-off is a person's statement,
  and by signing you take responsibility for everything in the commit.
- There is no contributor license agreement. Contributions come in under the license they go
  out under: Apache-2.0 for code and documentation, CC BY 4.0 for label manifests.

## Provenance clause

This is a separate statement beside the sign-off. The pull-request form asks you to tick each
line. By opening a pull request you confirm that your contribution contains:

1. nothing copied or adapted from projects licensed under the GPL or the AGPL, including
   other card-recognition tools;
2. no labels produced by running such a tool;
3. nothing held under a confidentiality or non-disclosure agreement;
4. no card art and no video frames.

Two notes on what the clause means.

- **Being informed by another project's public write-up is fine. Copying or adapting its
  code, weights, data or labels is not.** This repository holds itself to the same line; see
  [PROVENANCE.md](PROVENANCE.md).
- **Line 2 is a stated position, not a legal claim.** Whether a program's output is a
  derivative of the program is not clear in law. We keep such labels out so that the question
  never has to be answered for this data.

## Label contributions

Labels are accepted as manifest pull requests only: text files in the format of
[data/SCHEMA.md](data/SCHEMA.md). [data/README.md](data/README.md) has the steps, and the
labeling tool in [labeler/](labeler/README.md) writes such a file.

1. **Write the rows as an offer.** `role` is `extra`, `trained_on` is `false`, `reachable` and
   `reachable_checked` are `null`. Put the credit you want in `credit`; it travels with every
   row.
2. **Run the validator** and include its output in the pull request:

   ```
   cardvision validate-manifest YOUR.manifest.jsonl --catalog games/riftbound/catalog.json \
       --sources games/riftbound/sources.json --contribution
   ```

3. **No images.** No frames, crops or screenshots, in the pull request or in the folder of the
   manifest. The validator refuses a manifest folder that holds anything but text.
4. **You do not choose a role.** A new recording group is given `train` or `evaluation` by the
   same seeded rule used for the published data (`cardvision assign-roles`).
5. **Which footage.** Public videos of Riftbound play. A row must name a video on a platform:
   a row of a recording of your own (`platform` set to `local`) is refused, because nobody
   else can obtain the video. Physical-play footage is taken from channels of creators and of
   event organizers. Streams by shops and by private individuals are left out unless the
   person who runs the channel asks for them to be included. If you run the channel, say so
   in the pull request.

What happens then:

- **Automatic checks** validate the format and refuse any image. They never contact a video
  platform. The maintainer checks that each video can still be found, by hand, one video at a
  time, and records the outcome in the rows (`cardvision record-reachable`;
  [data/SCHEMA.md](data/SCHEMA.md), "How reachability is recorded").
- **Audit.** The maintainer reviews a random 10 % of the boxes, and at least 20, in the
  labeling tool's review walk. A contributor's first pull request gets a sample of 50 boxes.
  If more than 5 % of the sampled boxes are wrong, the pull request is returned with the list.
- **Label pull requests are reviewed in a monthly batch.**
- Accepted labels are public under CC BY 4.0. Whether they are used to train the RiftSight
  product's models is the maintainer's choice.

You do not need the fetch command's download option to label. The tools read video files you
already have. The video platforms' terms restrict downloading and automated access, and
handing the download to a tool does not change that for you.

## Removal requests

If you run a channel and want rows that point at your videos taken out, use the "Footage
removal request" issue form or the contact in [SUPPORT.md](SUPPORT.md). The rows are removed.
You do not need to give a reason.

## Security

Do not open an issue for a security problem. See [SECURITY.md](SECURITY.md).
