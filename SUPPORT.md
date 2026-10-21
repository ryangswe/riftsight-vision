<!-- SPDX-License-Identifier: Apache-2.0 -->

# Support

This repository is maintained by one person, with AI assistance. The promise is small on
purpose, so that it can be kept.

## What this repository is

A maintained snapshot of the card recognition that shipped in RiftSight: the models, the bank
and accept rule, the labels and the tools, as of the release. It is not the trunk that
development happens on. Fixes and contributions land here. Later private work may or may not
be brought across, and nothing here promises that it will.

The bank published with the release is frozen. New cards are not added to it here. Adding
cards to your own copy is one command and needs no retraining:
[docs/measure.md](docs/measure.md), "Refresh the bank when cards are added".

## What you can expect

| | |
| --- | --- |
| Issues | Read once a week, on Tuesday. Best effort after that. |
| Footage removal requests | Acted on within 7 days. |
| Security reports | Answered within 7 days. See [SECURITY.md](SECURITY.md). |
| Label pull requests | Reviewed in a monthly batch. |
| Other pull requests | Best effort. |

## What is not promised

- **Debugging another game's adaptation.** The guide and [AGENTS.md](AGENTS.md) are the
  support for that. If a step in them is wrong or unclear, that is a bug here and an issue is
  welcome. Help beyond the guide happens in Discussions, from whoever has time.
- **A roadmap.** No dates and no features are promised.
- **New banks or retrained weights.** See above.

## Where to go

| For | Go to |
| --- | --- |
| A bug in the code or the docs | The "Bug" issue form |
| A card named wrong | The "Wrong recognition" issue form: video id and timestamp, no images |
| Rows about your channel's videos that you want removed | The "Footage removal request" issue form, or <riftsight.support@gmail.com> |
| A security problem | Not an issue: [SECURITY.md](SECURITY.md) |
| "How do I adapt this to my game?" | Discussions: <https://github.com/ryangswe/riftsight-vision/discussions> |

Please do not attach card art, video frames or screenshots of someone's video to an issue.
A video id and a time are enough to find the frame.
