<!-- SPDX-License-Identifier: Apache-2.0 -->

# Releasing

One maintainer cuts releases. A pull request is not a release: `main` can take a change and wait
for the soak below before a version goes out. `docs/stability.md` says what a version promises.

## Minor releases (0.X.0)

1. Move the Unreleased entries of `CHANGELOG.md` under the new version and its date. Name each
   break and its migration. Bump `version` in `pyproject.toml`.
2. Tag `vX.Y.0rcN` and publish it as a GitHub pre-release.
3. At least one product built on the toolkit builds and runs on the release candidate.
4. Wait for no regression for 7 days or one product release, whichever comes first. A fix
   restarts at step 2 with the next `rcN`.
5. Tag `vX.Y.0` and publish the GitHub release with the changelog section as its notes.

## Patch and docs-only releases

They skip the release candidate: steps 1 and 5 only. A patch never breaks the public surface.

## A release with new weights

Publish its measured numbers beside the previous release's, and make sure
`cardvision verify-release` passes on the release document before the final tag.

## Checks before any tag

- CI is green on `main`, and `python -m pytest -n auto --dist loadfile` passes.
- `CHANGELOG.md` has a section for the version in `pyproject.toml`
  (`tests/test_release_process.py` checks this).
