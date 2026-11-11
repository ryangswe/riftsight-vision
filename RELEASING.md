<!-- SPDX-License-Identifier: Apache-2.0 -->

# Releasing

One maintainer cuts releases. A pull request is not a release: `main` can take a change and wait
for the soak below before a version goes out. `docs/stability.md` says what a version promises.

## When to release

A release is for the people who install the toolkit from the Python package index, so each one
should be worth their reading the changelog.

- **Changes collect on `main`** under the changelog's Unreleased heading. A release goes out when
  they add up to something a user can use, such as a finished feature or a set of related ones,
  usually no more often than every few weeks. Work that is closely related, or done one piece
  after another over a few days, goes out together.
- **Products built on the toolkit do not wait for a release.** They copy what they need from a
  merged commit on `main` and pin it by the full commit and each file's SHA-256, as they would a
  tag.
- **A fix for a bug that affects people installing from the index** goes out as a patch release
  when it is ready.
- **The next release has a milestone** on GitHub, named for its version. A pull request meant for
  it goes in the milestone when it is opened or merged, so the milestone shows what the release
  will hold. The release goes out once nothing in it is open.

## Minor releases (0.X.0)

1. Move the Unreleased entries of `CHANGELOG.md` under the new version and its date, grouped by
   what a user can now do. Name each break and its migration. Bump `version` in
   `pyproject.toml`.
2. **Only for a release that breaks the public surface or changes behavior people rely on:** tag
   `vX.Y.0rc1`, publish it as a GitHub pre-release and upload it to the index; at least one
   product builds and runs on it; wait for no regression for 7 days or one product release,
   whichever comes first. A fix gets the next `rcN`. Any other release goes straight to step 3.
3. Tag `vX.Y.0` and publish the GitHub release with the changelog section as its notes.
4. Upload it to the Python package index: Actions, Publish, Run workflow from the tag `vX.Y.0`
   with the target `pypi`, then approve the upload. The workflow checks that the tag matches the
   version in `pyproject.toml`. A version uploaded there can never be replaced.

Steps 3 and 4 happen on their own when the pull request of step 1 is merged: the Release
workflow (`.github/workflows/release.yml`) tags the merge commit, publishes the release (a
version with `rcN` is a pre-release) and starts Publish with the target `pypi`. What is left is
to approve the upload. It refuses, and creates nothing, when the changelog has no dated section
for the version, the version is already on the index or the index cannot be asked, or the
version is lower than the newest version tag. A re-run does only what is still missing. The
commands above stay as the fallback when it did not run or was refused.

## Patch and docs-only releases

Steps 1, 3 and 4. A patch never breaks the public surface.

## A release with new weights

Publish its measured numbers beside the previous release's, and make sure
`cardvision verify-release` passes on the release document before the final tag.

## Checks before any tag

- Nothing in the release's milestone is open; close the milestone once the release is out, and
  open one for the next.
- CI is green on `main`, and `python -m pytest -n auto --dist loadfile` passes.
- `CHANGELOG.md` has a section for the version in `pyproject.toml`
  (`tests/test_release_process.py` checks this).
- Never land a change to the release automation in the same pull request as a version bump.
- Only the maintainer merges a pull request that raises the version, since the merge is what
  tags and releases.
