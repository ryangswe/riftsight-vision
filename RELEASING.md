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

To prepare the version commit of step 1, run `python tests/release_prepare.py --version X.Y.Z
--check` to see the plan, then the same without `--check` on a clean tree. It moves the Unreleased
entries under the new heading and date, rewrites the compare links (a final and a first candidate
compare with the previous final, a later candidate with the candidate before it) and sets the six
places that name the version, `CITATION.cff` among them (with its release date). It refuses a version that is not greater than the current one, an
empty Unreleased section and a tree with uncommitted changes. The one exception is a final whose
candidates are already in the changelog: with nothing under Unreleased, its section says it is the
version only, unchanged from the last candidate. The introduction of the release and
its "Changes that may need action" lines stay yours to write. After the upload, the Publish
workflow installs the new version from the index in a fresh environment and prints it.

## Patch and docs-only releases

Steps 1, 3 and 4. A patch never breaks the public surface.

## A release with new weights

Publish its measured numbers beside the previous release's, and make sure
`cardvision verify-release` passes on the release document before the final tag.

## Checks before merging a version bump

- Nothing in the release's milestone is open; close the milestone once the release is out, and
  open one for the next.
- The pull request's checks are green, and `python -m pytest -n auto --dist loadfile` passes.
- `CHANGELOG.md` has a section for the version in `pyproject.toml`
  (`tests/test_release_process.py` checks this).
- Never land a change to the release automation in the same pull request as a version bump.
- Only the maintainer merges a pull request that raises the version, since the merge is what
  tags and releases.

## What a red check means

Red means do not merge. There is no check that is expected to fail for a while and is fine to
merge past.

- A check on a pull request fails only on what that pull request can fix.
- Something that can only happen after the merge, such as a page going live, is a warning on the
  pull request. The tag's build or the upload enforces it.
- A toolkit change that would break a product goes in two steps: the product first merges a change
  that works with both the current toolkit and the new one, and then the toolkit change merges.

## The downstream canary

`.github/workflows/canary.yml` ("Downstream canary") checks a change against the products that
vendor the browser runtime. It runs on every pull request and every push to `main`. For each
product it names, it checks out the current commit of the product's branch, vendors this
checkout's build into it with the options the product's own vendor manifest records, and runs the
product's own checks. It is not a required check, but a red run still means do not merge (see
"What a red check means").

The products come from the repository variable `CANARY_TARGETS`, a JSON list with one entry per
product:

```json
[{"repo": "account/product", "branch": "main", "vendorDir": "vendor/cardvision-browser", "steps": ["npm run vendor-check", "npm test"]}]
```

- `repo`: the product's repository. `branch`: the branch to follow; each run looks up its current
  commit and the job summary names it. To try one fixed commit instead, give `sha`, the full
  40-character commit, in place of `branch`. `vendorDir`: the folder, inside the product, it
  vendors the runtime into. `steps`: shell commands run in the product after
  vendoring, in order, each reported in the job summary. An optional `"chrome": true` installs a
  headless Chrome for Testing first and names it in `$CHROME`.
- A product can be listed more than once, for example its `main` branch and the commit it last
  released. The summary tells the jobs apart by commit.
- An empty variable, or `[]`, makes the job a neutral skip.
- Each step runs with `CARDVISION_CANARY=1` set. A product can use it to skip a check that cannot
  pass on a build it did not vendor itself, such as a test that its docs link the vendored commit.

To change it, write the list to a file, check it, then set it from a checkout of this
repository:

```bash
CANARY_TARGETS="$(cat targets.json)" node browser/scripts/canary.mjs plan .
```

```bash
gh variable set CANARY_TARGETS < targets.json
```

`plan` prints the matrix it would run, or names each problem and exits 1. In the browser, the
variable is under the repository's Settings → Secrets and variables → Actions → Variables. It
takes effect on the next pull request or push to `main`; the workflow has no manual run.

An entry that follows a branch needs no update when the product changes. A fixed `sha` must be a
commit on the product's main branch, or on a branch that will stay: the job checks the commit out
by its hash, and a squash merge leaves a pull request's own commits only on its branch, which may
be deleted.
