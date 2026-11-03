<!-- SPDX-License-Identifier: Apache-2.0 -->

# Store uploads from a workflow

An extension built on this toolkit can upload each release to the Chrome Web Store and to
addons.mozilla.org (AMO) from a GitHub workflow. The person who owns the store accounts keeps
the decision: the upload runs only after they approve it on the run's page. The tool is
`browser/dist/node/store-upload.mjs`, vendored with the other Node tools ([extension.md](extension.md)),
and the workflow to copy is [`browser/templates/store-release.yml`](../browser/templates/store-release.yml).
It is [experimental](stability.md#experimental).

## How a release goes up

1. **The tag.** Pushing a release tag (`v1.2.3`) starts the workflow. A product whose tags look
   different (`extension-v1.2.3`) sets the template's `TAG_PREFIX` and its `tags:` pattern.
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
     longer occur, so they can be removed).

   It writes each package's sha256 and a summary (versions, hashes, notes, any permission change,
   what goes where) to the run page.
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

## Running it by hand, and after a failure

"Run workflow" on the Actions page, with the release tag as "Use workflow from", runs the build
job alone, or both jobs with `upload` ticked. A run from a branch is refused, so the workflow
that runs is always the tag's.

If one store fails after the other succeeded, the run page lists what was done before the
failure. Re-run the failed job: a store that already has this version submitted or published is
skipped, and the other one is finished. The upload jobs of two runs never overlap.

## The files a product keeps

```
store/store.config.json        the store items, and words the workflow must never contain
store/permissions.json         the permission surface of this release, per browser
store/lint-baseline.json       the Firefox lint warnings the product knows and accepts
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
| `chrome.publish` | `default`: live once approved. `staged`: published by hand after approval |
| `firefox.releaseNotes` | locale → a notes file, beside the release file (a leading `<!-- SPDX-License-Identifier: … -->` line is left out) |
| `firefox.approvalNotes` | a file with the notes to Mozilla's reviewers |
| `permissionsChanged` | true when the permission surface changed since the previous release |
| `before` | `[{url, sha256?, why?}]`: what must be live before upload |

`lint-baseline.json` is `{"warnings": [{"code", "file", "why"}]}`, one entry per accepted
warning of `web-ext lint --output json` (`why` is for the reader). Start it from the last release
that went up by hand, after reading each warning. The template pins the linter's version, since a
new version can add warnings; update the version and the baseline together.

The template's `store/` folder ([`browser/templates/store/`](../browser/templates/store/)) has
one of each, with made-up ids.

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

Set the environment's required reviewer to the store account's holder and its deployment policy
to the release tags (`v*`, or the product's `TAG_PREFIX` followed by `*`).

## What it never does

It uploads packages and submits them for review. It never changes a store listing, a screenshot
or a justification field, never publishes to a CDN or moves a release pointer or flag (the
workflow names no such credential, and `check` refuses one that does), never commits, and
writes nothing outside the run.
