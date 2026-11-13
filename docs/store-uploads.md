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
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v7
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
workflow names no such credential, and `check` refuses one that does), never commits, and
writes nothing outside the run.
