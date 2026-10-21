<!-- SPDX-License-Identifier: Apache-2.0 -->

## What this changes

<!-- One or two sentences. -->

## How it was checked

<!-- The commands you ran and what they printed. For code: `python -m pytest`. -->

## Sign-off

- [ ] Every commit in this pull request has a `Signed-off-by` line with my own name or
      persistent handle and a working email (`git commit -s`). By signing off I certify the
      Developer Certificate of Origin 1.1: https://developercertificate.org/

## Changelog

- [ ] `CHANGELOG.md` has a line for this change under Unreleased, or: no user-visible change.

## Provenance

I confirm that this contribution contains:

- [ ] nothing copied or adapted from projects licensed under the GPL or the AGPL, including
      other card-recognition tools;
- [ ] no labels produced by running such a tool;
- [ ] nothing held under a confidentiality or non-disclosure agreement;
- [ ] no card art and no video frames, in any file or attachment.

Being informed by another project's public write-up is fine. Copying or adapting its code,
weights, data or labels is not. CONTRIBUTING.md explains each line.

## For label manifests only

- [ ] Rows are offered as `role: "extra"`, `trained_on: false`, `reachable: null`.
- [ ] Every row names a public video on a platform; none has `platform: "local"`.
- [ ] `cardvision validate-manifest FILE --catalog games/riftbound/catalog.json --sources games/riftbound/sources.json --contribution`
      passes, and its output is pasted above.
- [ ] The manifest's folder holds text only.
- [ ] If the footage is physical play from a shop's or a private individual's stream: I run
      that channel, or the person who does has asked for it to be included.
