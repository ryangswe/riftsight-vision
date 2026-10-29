<!-- SPDX-License-Identifier: Apache-2.0 -->

# A host of your own: `cardvision cdn`

A browser extension built on this runtime can read a small settings file, card pictures and
newer releases from a host of its own. `cardvision cdn` publishes them there and checks what is
served, driven by one file of the product's, `cdn/cdn.config.json`. The extension's side of the
contract is [remote-releases.md](remote-releases.md).

**Experimental.** The command and its config file may change in a minor release
([stability.md](stability.md#experimental)).

The host is a Cloudflare bucket served from a domain of the product's own, such as
`https://cdn.example.org`. Uploads go through the bucket's S3 API; every check reads the
public address over HTTPS, as an extension would. Host only card pictures you have the right
to serve ([extension.md](extension.md#card-pictures)).

## Install

Publishing needs `boto3`, the `cdn` extra, and cardvision 0.5.0 or later (earlier versions have
no `cdn` command):

```
python -m pip install "cardvision[cdn]>=0.5.0"
```

In a checkout of the toolkit, `python -m pip install -e ".[cdn]"` does the same.

`plan --offline`, `verify`, `verify-geo` and `verify-release-live` need no extra. The checks that
start the runtime need Node and the product's vendored `verify-release.mjs`
([extension.md](extension.md#the-maintenance-kit)).

## Set up a host of your own

Once, about 30 minutes, by the product's maintainer:

1. **An account of the product's own,** under an email you would be willing to hand over, not
   linked to another project's account.
2. **A domain in that account,** with a neutral name. Pictures and the settings file are
   served from `cdn.<domain>`.
3. **A bucket** in the account's object storage. Leave its development public URL disabled, and
   connect `cdn.<domain>` as the bucket's custom domain.
4. **A CORS policy** on the bucket, so that the extension and the video sites' pages can read
   the settings file:

   ```json
   [{"AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600}]
   ```

5. **An API token** with object read and write on that one bucket only. Note its access key
   id, its secret access key and the account id.
6. **An environment file** on your machine, outside every repository or ignored by git (below).
   Never paste its values into a chat or an issue.
7. **Network Error Logging off** for the zone, or its `NEL` and `Report-To` headers removed by a
   response header rule. Otherwise every viewer's browser sends error reports to a third
   party. `verify` fails while the headers are there.

Handing the product over later means making the new maintainer an administrator of the account.
Whoever owns the domain owns the settings file, and so where pictures come from.

## The environment

Every name starts with the product's `envPrefix` (`EXAMPLECDN` below). The tool reads only
these, from the environment or from `--env-file FILE` (other lines of the file are ignored):

| Variable | Holds |
| --- | --- |
| `EXAMPLECDN_R2_ACCOUNT_ID` | the account id, 32 lowercase hex characters |
| `EXAMPLECDN_R2_ACCESS_KEY_ID` | the token's access key id, 32 hex characters |
| `EXAMPLECDN_R2_SECRET_ACCESS_KEY` | the token's secret access key, 64 hex characters |
| `EXAMPLECDN_BUCKET` | the bucket's name only |
| `EXAMPLECDN_PUBLIC_BASE` | the public address, `https://` and the host only, with no path, for example `https://cdn.example.org`. The extension reads its files at the host's root, so a path is refused. |
| `EXAMPLECDN_EXTENSION_IDS` | the extension ids (store and unpacked), comma-separated; `verify-release-live` checks CORS for each |

What each command needs ("the credentials" are the first four rows of the table: the account
id, the two keys and the bucket):

| Command | Needs |
| --- | --- |
| `plan --offline` | nothing; it checks the settings file's `primary` against `_PUBLIC_BASE` when that is set |
| `verify`, `verify-geo` | `_PUBLIC_BASE` |
| `verify-release-live` | `_PUBLIC_BASE` and `_EXTENSION_IDS` |
| `plan`, `publish`, `publish-geo` | the credentials and `_PUBLIC_BASE` |
| `publish --config` with a pointer that is not the live one | the credentials, `_PUBLIC_BASE` and `_EXTENSION_IDS` |
| `publish-release` | the credentials, `_PUBLIC_BASE` and `_EXTENSION_IDS` |

A dry run needs what the run itself needs, so it fails where the run would. A value in the
wrong format is refused with its length, never its value.

## cdn.config.json

The product's file, at `<product repository>/cdn/cdn.config.json`. Paths in it are relative to
the repository's root, the file's grandparent. `--cdn-config FILE` names another one; by default
it is `cdn/cdn.config.json` under the current folder.

```json
{
  "schemaVersion": 1,
  "product": "examplegame",
  "envPrefix": "EXAMPLECDN",
  "forbiddenWords": ["otherproject"],
  "settings": {"obsoleteCardLink": false},
  "dataFiles": {},
  "pages": [],
  "geometric": false
}
```

**Required keys.** Each of these differs between products and turns a check on, so a key left
out would turn a check off silently. The tool refuses a file that lacks one; an explicit `[]`,
`{}` or `false` is fine.

| Key | Meaning |
| --- | --- |
| `schemaVersion` | exactly `1` |
| `product` | lowercase letters, digits and `-`; the log prefix and the default user agent, `<product>-cdn-verify/1` |
| `envPrefix` | capital letters and digits, for example `EXAMPLECDN` ([the environment](#the-environment)) |
| `forbiddenWords` | lowercase names of other projects. A bucket, a public base or a template that holds one is refused. |
| `dataFiles` | the data files the settings file may name ([below](#data-files-and-pages)); `{}` for none |
| `pages` | the HTML pages served at the host's root, by file name; `[]` for none |
| `geometric` | `true` turns on the geometric stage: `publish-geo`, `verify-geo`, `publish-release --geometric` and a pointer's `geometric` block. With `false`, a pointer that carries `geometric` is refused. |
| `settings.obsoleteCardLink` | `true` checks a `cardLink` field that old extension builds required: absent or malformed, a warning; pointing at another project, refused |

**Optional keys,** with their defaults:

| Key | Default |
| --- | --- |
| `userAgent` | `<product>-cdn-verify/1`, sent with every HTTPS check |
| `art.prefix`, `art.indexKey` | `art/`, `art/index.json` |
| `art.cacheControl`, `art.maxImageBytes` | `public, max-age=86400`, `5242880` |
| `settings.placeholders` | `["{art}", "{file}", "{cardId}", "{printedId}"]`; a product that adds `{sourceFile}` may not use it in `primary` |
| `settings.corsOrigin` | `https://www.youtube.com`, the origin `verify` asks CORS for |
| `releases.legalDir` | `release-legal` |
| `releases.runtimes` | `cdn/RUNTIMES.json`, [the runtime table](#the-runtime-table) |
| `releases.bundledDocument` | `dist/release/release.json`, the release the current build bundles |
| `runtime.dir`, `runtime.verifyScript` | `vendor/cardvision-browser`, `node/verify-release.mjs` |
| `runtime.userAgent` | `<product>-cdn-verify/1`, passed to the script as `--user-agent`, whatever the top-level `userAgent`; `false` passes none |

An unknown key is refused: a misspelled switch must not publish with a default. Nothing in the
file can weaken a check. `primary` is always under `<public base>/<art prefix>`, a release
document is read up to 262144 bytes, the extension's limit, and release folders are always under
`vision/releases/`, where the extension looks for them; a `releases.prefix` key is refused.

### Data files and pages

A data file is a JSON file that the settings file names by `{path, sha256}`, under the data
file's own key:

```json
"dataFiles": {"details": {"prefix": "data/", "namePattern": "details-<sha8>.json", "schemaVersion": 1,
                          "requiredObjectKeys": ["cards"], "maxBytes": 33554432}}
```

Its name holds the first 8 hex digits of its own SHA-256 (`<sha8>`), so every change is a new
name and a file is never replaced in place. It must be a JSON object with that `schemaVersion`
and an object under each required key. It is served immutable.

A page is a plain HTML document of at most 1 MB with no script, published at the host's root
with `--page FILE` (one of `pages`).

### The runtime table

`cdn/RUNTIMES.json` lists every extension version that reads a pointer: the ONNX Runtime it
runs and the release it bundles. Add a row with each store release:

```json
{
  "1.2.0": {"ortWeb": "1.29.0",
            "bundledRelease": {"id": "0123456789abcdef", "detectorSha256": "<64 hex>", "recognizerSha256": "<64 hex>"}}
}
```

`publish-release` refuses a release that a version its pointer would reach could not load
(another ONNX Runtime major.minor): raise `--min-version`, or ship the release bundled first.

## The commands

Each takes `--cdn-config FILE` and `--env-file FILE`.

### plan and publish

```
cardvision cdn plan --offline --catalog catalog.json --images IMAGES
cardvision cdn publish --env-file .env --catalog catalog.json --images IMAGES --config config.json --dry-run
cardvision cdn publish --env-file .env --catalog catalog.json --images IMAGES --config config.json
cardvision cdn verify --env-file .env
```

- `plan --offline` needs no credentials and treats the host as empty: every art path is a
  clean relative path to a JPEG, PNG or WebP under `--images`, at most `art.maxImageBytes`,
  whose bytes are an image. The content type comes from the bytes, not the name.
- `plan`, and `publish --dry-run`, compare with the live `art/index.json` and list what is new
  and changed. Nothing is written.
- `publish` writes, in this order: the new and changed images; `art/index.json`, listing only
  what landed; the data files (`--data-file`, once per kind); the page (`--page`); and
  `config.json` (`--config`) last. A failed image keeps its path out of the index and stops
  before `config.json`; a re-run retries it. Nothing is ever deleted.
- `publish --config config.json` alone publishes the settings file, for a switch such as
  `namesOnly: true` or `primary: null`.
- A replaced image reaches viewers within a day (`max-age=86400`), or at once after a cache
  purge.

### verify

`verify` reads what is served: `config.json` against the contract, its content type,
`Cache-Control: public, max-age=300` and CORS for `settings.corsOrigin`; each data file it
names, by SHA-256; each page; `art/index.json`; and `--samples N` images (default 8) by SHA-256,
content type and caching. Any `NEL` or `Report-To` header fails it.

### publish-geo and verify-geo

For a product with `"geometric": true`. The geometric index is the folder that
`cardvision pack-features` writes (`manifest.json` and `shard-N.bin`):

```
cardvision cdn publish-geo --env-file .env --dir PACKED --expect-sha256 MANIFEST_SHA256 --dry-run
cardvision cdn publish-geo --env-file .env --dir PACKED --expect-sha256 MANIFEST_SHA256
cardvision cdn verify-geo --env-file .env --dir PACKED --expect-sha256 MANIFEST_SHA256
```

The folder is `vision/geo/<first 16 hex of the manifest's source.sha256>/`. The shards go
first, each checked by HEAD (size, SHA-256, type, caching); the manifest only once every shard
checks out. An object already there with other bytes refuses the run; one with the right bytes
and wrong metadata refuses it too, unless `--fix-metadata`, which rewrites the metadata in place.
`publish-geo` writes a flat index; a folder that holds a series index is refused
([index folders](remote-releases.md#index-folders)).

### publish-release

```
cardvision cdn publish-release --env-file .env --release RELEASE_DIR --min-version 1.2.0 --config cdn/config.json --set-pointer --dry-run
```

`RELEASE_DIR` is a release folder named after its id (`cardvision build-release`). Every check
runs first, a dry run included:

1. **The seal:** the document is at most 262144 bytes, its id is the folder's name, every
   pinned file is a flat name with its size and SHA-256, and `releases.legalDir` (or `--legal`)
   holds `LICENSE`, `NOTICE` and `PROVENANCE.md`, with the release id on `NOTICE`'s first line.
2. **The runtimes:** every version in [the runtime table](#the-runtime-table) that the pointer
   reaches runs the release's ONNX Runtime major.minor.
3. **The models:** when the detector or the recognizer differs from what installs run now (the
   live pointer's release, else each reached version's bundled one), `--sessions` is required.
4. **The runtime's own check,** in Node: the vendored `verify-release.mjs --dir`, with
   `--sessions` starting both ONNX Runtime sessions.
5. **The geometric stage** (`--geometric FILE --geo-manifest-sha256 SHA`): the index is already
   on the host (`publish-geo` first), in a folder of one layout, with that manifest SHA-256,
   bound to the release's bank, with a row for every bank card. Without `--geometric`, installs
   run the release with the stage off.
6. **The settings file** it would write (`--config`, with `--set-pointer` to write the pointer
   and the data files' entries into it) passes the contract.
7. **The data files** it names are published by this run or already live with those bytes.
8. **The remote state,** through the S3 API only, so that no 404 is cached at the edge: a key
   that holds other bytes refuses the whole run. A folder is never overwritten.

Then, without `--dry-run`: the pinned and legal files, `geometric.json`, `release.json` last in
the folder (each checked by HEAD); `vision/releases/index.json`; a live check of the folder
(`verify-release-live`); the data files; `config.json` last; and `verify`. Without `--config`
the folder is published and the pointer does not move.

### verify-release-live

```
cardvision cdn verify-release-live --env-file .env --expect-id 0123456789abcdef
```

It reads the live pointer (or `--candidate ID`, a folder with no pointer, or the pointer of
`--config-url URL`), fetches the document and checks its SHA-256, runs the vendored script with
`--url` (and `--sessions` when given), then checks every file of the folder: SHA-256, content
type, `Cache-Control`, no `NEL`, CORS for each id in `_EXTENSION_IDS`, and compression for
JSON. With a geometric pointer it also checks `geometric.json` and its index's binding.

## Safety checks

- **Another project's account.** The run is refused when the account id or the access key
  equals the unprefixed variables of another project found in the environment, or when the
  bucket or the public base holds one of `forbiddenWords`.
- **The settings file** is checked against the contract before it goes out, and its `primary`
  must be on `_PUBLIC_BASE`. No template may point at another project.
- **A pointer only moves to a folder that verifies live.** `publish --config` with a `release`
  field checks it live first, unless it is the live pointer already (so an emergency
  `namesOnly` never waits). A rollback is checked the same way.
- **A settings file never names a data file that is not there.** Each one it names is
  published by the same run, before it, or is already live with exactly those bytes. This holds
  for a dry run too.
- **Upload order:** pictures, then their index, then data files and pages, then `config.json`.
  Within a release folder: pinned and legal files, then `geometric.json`, then `release.json`.
  A failure stops the run before anything that depends on it.
- **Release folders and geometric index folders are never overwritten.** A changed release is
  a new id, a changed index a new folder. A publish does replace other files: changed images,
  `art/index.json`, the page, `config.json` and `vision/releases/index.json`; a data file is
  written again under its name, which holds its hash. `--fix-metadata` rewrites the metadata of
  a file already there, never its bytes. Nothing is ever deleted.
- **Caches.** Every check of `verify`, `verify-release-live` and the publish gates adds a query
  that bypasses the cache. `verify-geo` adds none: it reads each file of the index at its own address.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | done, or every check passed |
| 1 | a failure: an upload failed, or a check of what is served failed |
| 2 | a usage error |
| 3 | refused by a check before anything was written (`REFUSED: <why>`) |

## Rolling back

Publish the settings file as it was before, then check it:

```
cardvision cdn publish --env-file .env --config previous-config.json --dry-run
cardvision cdn publish --env-file .env --config previous-config.json
cardvision cdn verify --env-file .env
cardvision cdn verify-release-live --env-file .env --expect-id 0123456789abcdef
```

A settings file with no `release` field returns installs to their bundled release. Folders stay
on the host, unused.
