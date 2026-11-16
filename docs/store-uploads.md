<!-- SPDX-License-Identifier: Apache-2.0 -->

# Store uploads from a workflow

An extension built on this toolkit can upload each release to the Chrome Web Store and to
addons.mozilla.org (AMO) from a GitHub workflow. The person who owns the store accounts keeps
the decision: the upload runs only after they approve it on the run's page. That approval needs
a public repository, or GitHub Enterprise ([a private repository](#a-private-repository)). The tool is
`browser/dist/node/store-upload.mjs`, vendored with the other Node tools ([extension.md](extension.md)),
and the workflow to copy is [`browser/templates/store-release.yml`](../browser/templates/store-release.yml).
It is [experimental](stability.md#experimental).

## How a release goes up

1. **The tag.** Pushing a release tag (`v1.2.3`) starts the workflow. A product whose tags look
   different (`extension-v1.2.3`) sets the template's `TAG_PREFIX` and its `tags:` pattern. A
   product that adopts [release on merge](#release-on-merge) does not push the tag: merging the
   version creates it.
2. **The build job** has no store access. It builds the packages from that commit, runs the
   product's own release checks, then `store-upload.mjs check`, which refuses when:
   - the tag, the release file and the packages' manifests name different versions;
   - a package has no `manifest.json` at its root (a Chrome package may instead keep all its
     files in one top-level folder, as the Chrome Web Store dashboard accepts; addons.mozilla.org
     needs the root);
   - a Chrome package carries a `key`, or a Firefox package has no gecko settings;
   - a package's permission surface (permissions, hosts, content-script and web-accessible
     matches, externally connectable, Firefox data collection) is not the one committed in
     `store/permissions.json`, or it changed since the previous release without the release
     file saying so (the store's justification fields are updated by hand first);
   - an address in the release file's `before` list does not answer 200 (or its bytes do not
     match the sha256 given);
   - a workflow file mentions a CDN or object-store credential, the remote flag or the toolkit's
     CDN tool, or a word the product lists in `deny`;
   - `web-ext lint` finds an error in the Firefox package, or a warning not in the product's
     `store/lint-baseline.json` (by rule and file; the run page names baseline entries that no
     longer occur, so they can be removed);
   - a workflow where write permission could reach a job that holds store access: a job that
     names an environment has no `permissions:` of its own, or has a write permission itself
     (block or `{ contents: write }` form, quoted or not, at any indentation), or the workflow
     grants write at its top level while any job names an environment. It also refuses what it
     cannot read: a comment on a job's header line, a job written in flow style, or a `jobs:`
     block with no job it recognizes. This guards the template's layout; it does not read
     reusable workflows or YAML anchors.

   It writes each package's sha256 and a summary (versions, hashes, notes, any permission change,
   what goes where) to the run page, and the [release record](#the-release-record-and-the-release-assets).
3. **The upload job** runs in the `store` environment, whose required reviewer (the store account's holder) approves it on
   the run page. Only then does GitHub hand it the store credentials. `store-upload.mjs upload`
   refuses when its environment holds a denied name or a package's sha256 differs from the build
   job's. It then checks every store before uploading anything:
   - **Chrome:** the item's status (`:fetchStatus`). A submission pending review stops the run,
     because uploading would cancel that review, and so does an approved revision staged for a
     manual publish.
   - **Firefox:** a listed version awaiting review stops the run.
   - **The "before upload" addresses,** again: the approval can come days after the build.

   If all are clear, it uploads the Firefox package and waits for Mozilla's validation (this
   creates nothing on the listing), uploads to Chrome and submits for review unless the release
   file says `upload-only`, then creates the Firefox version with its source archive, release notes
   and notes to reviewers. Each step is written to the run page as it happens.

4. **The release assets job** (`release-assets`) has `contents: write` and nothing else: no
   environment, no identity token, no store or CDN credential, only the run's own `GITHUB_TOKEN`.
   It attaches the packages, `SHA256SUMS` and the release record to the tag's GitHub release
   ([below](#the-release-record-and-the-release-assets)). It does not wait for the approval.

## Release on merge

The template [`browser/templates/extension-release.yml`](../browser/templates/extension-release.yml)
replaces pushing the tag by hand. Merging the version commit to the main branch is the release:
a push to main runs one job that creates the tag and the GitHub release and starts
`store-release.yml` on that tag with `upload` and `attach` set. That run builds and checks as before, then
waits for the `store` environment's reviewer, so the upload is still approved on its page.

It acts only when all three hold:

1. the version in `package.json` has no tag (`TAG_PREFIX` followed by the version);
2. `store/releases/<version>.json` exists;
3. `CHANGELOG.md` has a dated section for the version, with something in it: the heading line
   carries a `YYYY-MM-DD` date (`## [1.2.3] - 2026-11-13` or `## 1.2.3 (2026-11-14)`). A heading
   such as `## [1.2.3] - Unreleased` counts as missing. The section is the GitHub release's notes.

Otherwise nothing happens, and the job's summary says which is missing. A push that leaves the
version alone does nothing. Two things are refused and fail the job: a version with a pre-release
suffix (`1.2.3-rc1`) that has a release file, because store versions are numeric (without one it
does nothing), and a version lower than the newest
final version tag (pre-release tags are not compared, so one does not block a hotfix). If the job
stops half way, re-run it: it does only what is missing, the release or the store run. A tag made
with the workflow's token starts no workflow, so the store run is started by a dispatch, not by
the tag.

The decision is `node/release-decide.mjs`, one of the vendored Node tools (`npm run vendor --
--node-tools`). It reads no network: the workflow gathers the facts it is given (the tags, read
through the API with the workflow's token so a private repository works, whether the release
exists, how many store runs the tag has) and acts only on its outputs. The workflow is given
`contents: write` and `actions: write` and no `store` environment, store credential or identity
token; the upload stays in `store-release.yml`. `store-upload.mjs check` scans the file for denied
names only (a CDN or object-store credential, a pointer or flag command, a word in `deny`). It
does not check the workflow's permissions, so keep them as the template has them.

Two details:

- Merges close together: one run goes at a time, and GitHub keeps only the newest waiting run,
  so a waiting run is replaced by a newer push. The newest commit's version is then the one
  released, and a version merged in between can be left untagged; tag it by hand if it matters.
- An annotated tag the API cannot follow to a commit still counts as a tag: nothing is released
  under its name, and its version is compared.
- "Start the store run only if none has started" reads `gh run list --workflow store-release.yml
  --branch <tag>`. If that misses a run, a second dispatch is a duplicate: it still waits for the
  `store` environment's approval, and can be cancelled there.

To adopt it:

1. Copy the template to `.github/workflows/extension-release.yml`, next to `store-release.yml`,
   and pin its `uses:` to commits. Edit only the lines marked `PRODUCT`: the repository in the
   fork guard (`if: github.repository == 'YOUR-ORG/YOUR-REPO'`; until it is set the job never runs), the
   branch, the file locations and the tag prefix (the same one `store-release.yml` uses).
2. Vendor with `--node-tools` so `vendor/cardvision-browser/node/release-decide.mjs` exists.
3. Make `store-release.yml`'s "Check the release" step scan the new file. A copy of the template
   from before release on merge does not: replace the step with the template's (it sets
   `RELEASE_WORKFLOW` to `--workflow .github/workflows/extension-release.yml` when the file
   exists), or add `--workflow .github/workflows/extension-release.yml` to the `check` command by
   hand. The file must name no CDN or object-store credential, pointer command or flag command.
4. **Adopt it in a pull request that does not change the version**, while the current version is
   already tagged. Otherwise the adoption merge itself releases the version.
5. From then on, release with one pull request that holds the version, the changelog section and
   `store/releases/<version>.json`; merging it starts the release. Do not push the tag. If the
   tag already exists, the version is not released again.

## Running it by hand, and after a failure

"Run workflow" on the Actions page, with the release tag as "Use workflow from", runs the build
job alone, or both jobs with `upload` ticked. A run from a branch is refused, so the workflow
that runs is always the tag's.

### The first run

For a product's first release through the workflow, go in this order:

1. **Push the tag.** The build job builds and checks, and the upload job waits for approval.
2. **Reject that upload job** on the run page. One upload job runs at a time (the jobs share a
   concurrency group), and a job waiting for approval may hold the slot.
3. **Run a precheck.** "Run workflow" on the tag (Use workflow from: the tag) with `upload` and
   `precheck_only` ticked. Approve it. The upload job signs in to both stores, reads their state
   and reports "Prechecks passed". It uploads nothing. A tag push never sets `precheck_only`, and
   a run from a branch is refused.
4. **The real upload.** "Run workflow" on the tag with `upload` only, and approve it.

### Checking a pull request without a tag

`store-upload.mjs check` takes the tag as an argument, so a pull request can run it with the tag
the version would get. The template does not include such a job; add one to a separate workflow
file, `.github/workflows/store-check.yml` (it must not hold store credentials), with the same build, lint and check steps as the
template's build job, and replace the tag lookup:

```yaml
on: pull_request
jobs:
  store-check:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run store:build   # the product's own build into out/
      - run: |
          version=$(node -p "require('./package.json').version")   # or the version the release file names
          node vendor/cardvision-browser/node/store-upload.mjs check --config store/store.config.json \
            --release "store/releases/$version.json" --tag "v$version" --tag-prefix v \
            --permissions store/permissions.json --chrome-zip out/chrome.zip --firefox-zip out/firefox.zip \
            --workflow .github/workflows/store-release.yml \\
            --workflow .github/workflows/store-check.yml --summary "$GITHUB_STEP_SUMMARY"
```

Add the template's `--previous-permissions`, `--firefox-source` and `--lint` options as the
product's release needs them.

If one store fails after the other succeeded, the run page lists what was done before the
failure. Re-run the failed job: a store that already has this version submitted or published is
skipped, and the other one is finished. The upload jobs of two runs never overlap.

## The files a product keeps

```
store/store.config.json        the store items, and words the workflow must never contain
store/permissions.json         the permission surface of this release, per browser
store/lint-baseline.json       the Firefox lint warnings the product knows and accepts
store/record-facts.json        optional: facts the release record carries beyond what the tool reads
store/releases/<version>.json  one per release
store/releases/<version>/      its notes files
```

`store/permissions.json` is this release's surface. When it differs from the previous release's
file (the newest earlier `TAG_PREFIX` tag that is not a pre-release), the release file must say
`permissionsChanged`. With no earlier file, the run page says the surfaces were not compared.

`store.config.json`:

| Key | Meaning |
| --- | --- |
| `chrome.publisherId`, `chrome.itemId` | the Chrome Web Store publisher and item |
| `firefox.addon` | the add-on's id, slug or guid on AMO |
| `deny` | extra words (the product's CDN secret names, its pointer or flag commands) |

A release file:

| Key | Meaning |
| --- | --- |
| `version` | the version; the tag is `TAG_PREFIX` followed by it, `v<version>` by default (`--tag-prefix`) |
| `chrome.submit` | `auto`: submit for review after the upload. `upload-only`: the Chrome listing text changes (the API cannot set "What's new" or the test instructions), so the account holder pastes it in the dashboard and submits |
| `chrome.publish` | `default`: live once review passes; use it unless the account holder said otherwise before that release's process started. `staged`: published by hand after approval |
| `firefox.releaseNotes` | locale → a notes file, beside the release file (a leading `<!-- SPDX-License-Identifier: … -->` line is left out) |
| `firefox.approvalNotes` | a file with the notes to Mozilla's reviewers, at most 3000 characters (code points, counted without the license comment); a longer file is refused by `check` and, when Firefox is a target, by the upload's prechecks, before anything is uploaded |
| `permissionsChanged` | true when the permission surface changed since the previous release |
| `before` | `[{url, sha256?, why?}]`: what must be live before upload |
| `expect` | `[{url, file or sha256, when?, why?}]`: addresses the [daily status check](#the-daily-status-check) expects to answer 200 with the bytes of `file` (a path beside the release file) or with this sha256, such as the live settings file; `when: "published"` waits until the version is public |

`lint-baseline.json` is `{"warnings": [{"code", "file", "why"}]}`, one entry per accepted
warning of `web-ext lint --output json` (`why` is for the reader). Start it from the last release
that went up by hand, after reading each warning. The template pins the linter's version, since a
new version can add warnings; update the version and the baseline together.

The template's `store/` folder ([`browser/templates/store/`](../browser/templates/store/)) has
one of each, with made-up ids.

## The release record and the release assets

`check` can write a record of the release, for a reader who wants to match a downloaded package to
the build that made it. Add to the template's `check` step:

```
--record-out out/record.json --vendor-manifest vendor/cardvision-browser/cardvision-vendor.json \
--facts store/record-facts.json --runtimes cdn/RUNTIMES.json --ci-results out/ci.jsonl \
--commit "$GITHUB_SHA" --run-id "$GITHUB_RUN_ID"
```

`--facts`, `--runtimes` and `--ci-results` are optional. The template passes `--facts` and
`--runtimes` only when `store/record-facts.json` and `cdn/RUNTIMES.json` exist, and `--ci-results`
when its step that reads the commit's check runs succeeded.

The tool is vendored with `--node-tools` ([extension.md](extension.md)): a product must re-vendor
it from a toolkit commit that has these commands (`--record-out`, `assets`, `status`) before it
copies this template; an older vendored copy refuses the options.

It writes `out/record.json` and, beside it, `out/record.md`. Both hold machine facts only:

- the version and tag, the commit and the run id;
- the vendored toolkit's version and commit, and the ONNX Runtime and OpenCV versions, read from
  the vendor manifest (`--vendor-manifest`, required with `--record-out`);
- each package's file name, size and sha256, and its manifest's version (the Chrome, Firefox and
  Firefox source packages, and `--load-unpacked-zip` for a package people load unpacked, which
  is checked for its version and hashed);
- the permission surface of each browser and whether the release file says it changed;
- for each package built from files, the number of files and one digest over them: the SHA-256 of
  the lines `<sha256>  <file name>\n`, one per unpacked file (folders are not files), sorted by
  file name. A name is the path in the zip, so it keeps the package's top folder when it has one.
  The unpacked tree can be matched without the zip's own bytes, which differ between builds. From
  the unpacked folder (names with spaces or newlines need a stricter script; `check` reads the zip
  itself):

  ```
  find . -type f | sed 's|^\./||' | LC_ALL=C sort | while read -r f; do
    printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"
  done | shasum -a 256
  ```

- the commit's check runs (`--ci-results`, the output of
  `gh api repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/check-runs --paginate --jq '.check_runs[]'`;
  `checks: read` is enough): each one's name, status, conclusion and the Actions run behind it,
  without the run being recorded;
- the bundled model release (the facts file's `modelRelease`). With `--runtimes`, `check` fails
  unless it is the `bundledRelease.id` of the version's row in the product's `cdn/RUNTIMES.json`
  ([the runtime table](cdn.md#the-runtime-table)), and unless the row's `ortWeb` is the vendored
  ONNX Runtime;
- the Firefox lint counts, how Chrome submits, and how many "before upload" addresses were checked;
- the product's own facts from `store/record-facts.json`, if it has one:
  `{"facts": {"name": "short text, a number, or true or false"}}`, names of letters and digits.

What a reader cannot match against a build stays out: the live check's notes and anything a
person judged. The record names files, never paths. `check` refuses to write it, and fails, when
its text holds a path on someone's machine (a home, temporary or runner folder, a drive letter or a
network share), a CDN, object-store or store credential name (`AMO_…`, `CWS_…`, a token name) or
one of the product's `deny` words, so a fact must not carry any of them.

The template's `release-assets` job runs after the build on a tag push, or on a dispatch that ticks
`attach`. The merge workflow dispatches with `attach` set: a tag made with a workflow's own token
starts no push run, so that dispatch is how such a release attaches. A dispatch without `attach`
(the steps of [the first run](#the-first-run), a re-run of the upload) never attaches: the zips are
not byte-for-byte reproducible, so a second attach on the same tag would be refused. It runs `store-upload.mjs assets`, which checks each package against the hash in
the record and copies the Chrome, Firefox and load-unpacked packages, `release-record.json`,
`release-record.md` and `SHA256SUMS` into `release-assets/`, and then `gh release upload` attaches
them to the tag's release. It never attaches the Firefox source archive, and the job never runs in
the `store` environment (see the rule `check` applies to the workflow, above). A per-tag
`concurrency` group keeps two attaches of one tag from overlapping. The job needs the release to exist; if the tag's release is created after the
workflow starts, run the job again when it is (Re-run failed jobs). The job lists the
release's assets first, and stops if it cannot. If a `SHA256SUMS` is there, it downloads it (and
stops if it cannot) and refuses to replace the assets when it differs from this run's (another
build); identical bytes are uploaded again (`--clobber`). `SHA256SUMS` goes up first, so a partial
upload leaves the guard in place.

To adopt it, copy the template's `release-assets` job and the extra `check` options and artifact
paths into `.github/workflows/store-release.yml`, and have the product's build write the load-unpacked
package to `out/` (name it with `--load-unpacked-zip`) if it has one. A product's `release-assets`
job keeps `contents: write` at the job, not at the workflow.

## The daily status check

`store-upload.mjs status` and the template [`browser/templates/store-status.yml`](../browser/templates/store-status.yml)
tell the maintainer when what the stores show is not what the repository says. It needs no
credential: the workflow runs daily with `contents: read`, in no environment, and reads the repository, the two public store addresses, the `expect` addresses of the release
file and the Actions cache that holds the previous run's versions. Nothing else.

```
node store-upload.mjs status --config store/store.config.json --releases store/releases \
  [--state-in FILE] [--state-out FILE] [--summary FILE]
```

It takes the newest release file in `--releases` (files are named for their version; the order is
by number, so `1.10.0` follows `1.9.0`) and reads each configured store's public version:

- **Chrome:** the extension update service, `https://clients2.google.com/service/update2/crx`, asked
  for the item without an installed version and with a very high `prodversion`, so that the
  item's minimum browser version cannot hide it. It is what a browser itself asks, and it needs no
  key. A staged rollout can show part of the audience the older version, and an item that is
  restricted to testers or one domain may not be listed at all.
- **Firefox:** `https://addons.mozilla.org/api/v5/addons/addon/<addon>/`, the add-on's
  `current_version`. A 404, 401 or 403 means no public version (a draft is hidden from the
  public API).

| What it finds | Result |
| --- | --- |
| a store shows the newest release file's version | passes |
| a store shows an older version | passes, with a note: the version is in review or has not been submitted. No credential can tell the two apart, so a version that stays in review for days appears in the note every day |
| a store lists no public version, and the product has no earlier release file | passes, with a note (the release is in review) |
| a store lists no public version, earlier release files exist, and the previous run's versions were read with none seen for this store | passes, with a note (a version waiting for its initial review is not red every day) |
| a store lists no public version, earlier release files exist, and there are no previous versions to read (a first run, an unreadable or evicted cache) | fails |
| a store shows a newer version than the newest release file | fails |
| a store's version went back since the previous run | fails (needs `--state-in`). A staged rollout that shows part of the audience the older version can trip this: wait for the rollout, or delete the cache entry |
| a store listed a public version on an earlier run and lists none now, even with one release file | fails (a takedown) |
| an `expect` address does not answer 200, or its bytes differ | fails |
| a store cannot be read (three tries, after 30 seconds and then 2 minutes, each with a 20-second limit; a rate limit is retried too) | fails |

A failed scheduled run emails the repository's maintainers, so each failure is a fault to look at,
not a reminder. The template keeps the previous run's versions in the Actions cache (the highest
version seen per store; a bad reading does not lower it), and saves them even when the run is red,
so a first red run still leaves state for the next day. After a rollback you made on purpose,
delete that cache entry (Actions, Caches), or the check stays red. Without a cache the check still
runs and notes that a version that went back cannot be told.

To adopt it, copy the template to `.github/workflows/store-status.yml`, pin its actions to full
commits as the file does, and add `expect` entries to the release file for the files that must be
live (for example the remote settings file, with `file` pointing at the repository's copy).
Nothing in it is a store credential, and the template names none.

## Credentials

Nothing secret is in a repository or passes through a chat. In the product's repository, the
`store` environment holds:

- **Chrome:** either nothing secret (option A, Workload Identity Federation: the environment
  variables `CWS_WORKLOAD_IDENTITY_PROVIDER` and `CWS_SERVICE_ACCOUNT`, and Google lets only
  this repository's `store` environment act as the service account), or the service account's key
  as `CWS_SERVICE_ACCOUNT_KEY` (option B). Either way, the publisher adds the service account in
  the Chrome Web Store dashboard (Account), and the Chrome Web Store API is enabled in its Google
  Cloud project. Chrome allows one service account per publisher.
- **Firefox:** `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, from the account's API credentials page
  on addons.mozilla.org.

An account that already has AMO API credentials: reuse them. Do not generate a new key, because
regenerating it revokes the old one for everything else that uses it.

The `store` environment's settings (Settings, Environments):

- **Required reviewers:** the store account's holder.
- **Prevent self-review:** unticked when the account holder is the only maintainer, so they can
  approve their own run (a team with a second maintainer may keep it ticked).
- **Allow administrators to bypass:** unticked, so the approval cannot be skipped.
- **Deployment branches and tags:** selected tags only, `v*` (or the product's `TAG_PREFIX` followed
  by `*`).

## A private repository

The approval is the `store` environment's required reviewer. GitHub offers required reviewers on
public repositories under every plan, and on private ones only under GitHub Enterprise; on GitHub
Free, environment secrets too are for public repositories only. On a private repository without
Enterprise the environment would have no reviewer, so the template's upload job does not run
there (`!github.event.repository.private`), and nothing in this page's setup should be done for it.

Such a product keeps the build job: on the release tag it builds the packages, runs every check
and keeps the packages with their `hashes.json` as the run's artifact. The account holder then
uploads that artifact, either by hand in the two dashboards or from their own machine with the
same tool and their own credentials in their shell:

```bash
node store-upload.mjs upload --config store/store.config.json --release store/releases/<version>.json --targets chrome,firefox --hashes hashes.json --chrome-zip chrome.zip --firefox-zip firefox.zip --firefox-source firefox-source.zip
```

`upload` checks the packages against `hashes.json` and both stores before sending anything, as
in the workflow.

On that machine the credentials are files, not a token:

1. **Chrome.** In the Google Cloud project of the publisher's service account, create a JSON key
   for it (IAM, Service accounts, Keys). Chrome allows one service account per publisher, so
   products under different publishers need one service account each, and the publisher adds it
   in the Chrome Web Store dashboard (Account). `upload` mints the access token from the key
   itself (a signed request to `https://oauth2.googleapis.com/token`; the key file's own
   `token_uri` is not followed). With more than one publisher, give each key file its own name
   (`chrome-<publisher>.json`) so that one never replaces another, and point each product's env
   file at its own. Chrome answering `HTTP 403` with `PERMISSION_DENIED` after the token was minted
   means the key's service account is not the one on that publisher's Account page: most often,
   another publisher's key.
2. **The env file.** Keep the credentials in one file of `KEY=VALUE` lines, outside every
   repository:

   ```
   AMO_JWT_ISSUER=user:…
   AMO_JWT_SECRET=…
   CWS_SERVICE_ACCOUNT_KEY_FILE=<the key file's full path>
   ```

   It may set only these three names and `CWS_ACCESS_TOKEN`; any other name is refused. Set
   either `CWS_SERVICE_ACCOUNT_KEY_FILE` or `CWS_ACCESS_TOKEN`, not both.
3. **Only you can read them.** `chmod 600` the key file and the env file: `upload` refuses either
   when another user could read it. On Windows, keep them in the WSL home, not on a Windows
   drive, where every file looks readable to all.
4. **A clean environment.** `upload` refuses to run while its environment holds a CDN or object
   store credential (a Cloudflare or Amazon object store's, `CLOUDFLARE_`, `CF_…_TOKEN` and the
   like, or the product's `deny` words), and a shell often holds one. Start it with nothing but the env file:

   ```bash
   env -i HOME="$HOME" PATH="$PATH" node store-upload.mjs upload --env-file "$HOME/.config/store/store.env" --config store/store.config.json --release store/releases/<version>.json --targets chrome,firefox --hashes hashes.json --chrome-zip chrome.zip --firefox-zip firefox.zip --firefox-source firefox-source.zip --precheck-only
   ```

   A name set in the environment wins over the file. `--precheck-only` checks both stores and
   uploads nothing; run it first, then the same line without it. Nothing it prints holds a key,
   a token or a secret.

## What it never does

It uploads packages and submits them for review. It never changes a store listing, a screenshot
or a justification field, never publishes to a CDN or moves a release pointer or flag (the
workflows name no such credential, and `check` refuses one that does), never commits, and
writes nothing outside the run. The only thing written to the repository is what
[release on merge](#release-on-merge) creates: the tag and the GitHub release.
