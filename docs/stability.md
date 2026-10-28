<!-- SPDX-License-Identifier: Apache-2.0 -->

# Stability

What you can build on, what may change, and how you'll hear about it.

## What is kept stable

These are the public surface: changed only as [versioning](#versioning) and
[deprecation](#deprecation) below describe.

- **The `cardvision` commands, their flags and their exit codes** (`next`, `try` and
  `fetch-weights` from v0.2.0): `next`, `try`, `fetch-weights`, `import-catalog`,
  `check-catalog`, `check-bank-art`, `build-bank`, `infer`, `build-release`, `verify-release`,
  `convert-release`, `make-composites`, `fetch-textures`, `train-recognizer`, `train-detector`,
  `export`, `evaluate`, `calibrate`, `check-refresh`, `build-features`, `pack-features`,
  `validate-manifest`, `fetch`, `record-reachable` and `assign-roles`. `cdn` and `refresh` are
  [experimental](#experimental) and not part of this promise. Report text meant for
  people may be reworded; the object `next --json` prints keeps its fields and ids, and changes
  its `schemaVersion` when its shape changes.
- **The files a release is made of:**
  - the release document (`release.json`);
  - the bank, as JSON or in its binary form (`bank.bin`, format version 1, in
    [release-files.md](release-files.md#the-binary-bank-bankbin));
  - the identity groups;
  - the geometric index;
  - the catalog.
  Each one that carries a `schemaVersion` changes it when its format changes, and the release
  document's readers (Python and browser) refuse a version they do not know rather than guess.
  `bank.bin` carries its format version in its eighth byte, under the same rule.
- **The label manifest format,** `data/manifest.schema.json`.
- **The browser runtime's exports from `browser/src/index.ts`:** `loadRelease`, `createSession`,
  `analyzeFrame`, `hoverAt` and the types they use.
- **The released models of a given release id.** A model release (for example `201478a00d6ef6ba`)
  never changes once published: new weights get a new release id, checked by `verify-release`.

## Experimental

These are the tools a product uses to keep its own browser extension current: they publish a
release, its settings file and card pictures to a host of its own, and judge a card-data
refresh. They are new, and **may change in a minor release** (0.X.0), not only at 1.0. The
changelog names each change.
- **The remote-release module:** the exports of `browser/src/remote/`, built to
  `dist/remote-release.js` (not part of `browser/src/index.ts`), and the settings contract it
  implements, [remote-releases.md](remote-releases.md).
- **The Node tools** `dist/node/verify-release.mjs` and `dist/node/package-zip.mjs`: their
  arguments, their output and their exit codes.
- **`cardvision cdn`**, its subcommands and flags, and the format of `cdn.config.json`
  ([cdn.md](cdn.md)).
- **`cardvision refresh`**, its steps and flags, and the rule schema `refresh-rule/1`
  ([refresh-rule-template.md](refresh-rule-template.md)).

A product vendors the remote-release module and the Node tools with the runtime
([extension.md](extension.md#the-maintenance-kit)), so a version it has vendored keeps working
until the product updates it. `cardvision cdn` and `cardvision refresh` come with the installed
`cardvision` package: pin its version to keep their behavior.

## What may change

Everything else may change in any release:
- Python module internals;
- names inside a work folder;
- the demo page's layout;
- the training recipes' defaults.

## Versioning

- **Before 1.0, a minor version (0.X.0) may break the public surface.** When it does,
  [CHANGELOG.md](../CHANGELOG.md) names each break and how to migrate.
- **A patch version (0.x.Y) never breaks it.**
- **Each minor version is first tagged as a release candidate** (for example `v0.2.0rc1`).
  [RELEASING.md](../RELEASING.md) has the steps.
- **Pin a version** (`pip install cardvision==X.Y.Z`, `pip install` from a tag, or a release's
  files by its release id) if you build on this, and read the changelog before you move.

## Deprecation

Before anything in the public surface is removed or changed incompatibly:
- it keeps working, with a warning, for at least one minor release;
- the changelog's Deprecated section names it, with what to use instead.

Security fixes are the exception: they ship as soon as they are ready, and the changelog says
what changed.

Support for a Python version ends when that version reaches its end of life upstream, or when a
security fix needs a newer one, whichever comes first. The changelog says so in the release that
ends it.

## Supported versions

- **Python: 3.11 or later; CI tests 3.11 and 3.12.** Newer versions may work but are not tested.
  Python 3.10 is not supported from v0.2.0: it reaches its end of life in October 2026, and the
  image library's security fixes need 3.11.
- **Browsers:** the browser runtime has been run in Chrome and Firefox (see
  [browser/README.md](../browser/README.md)). It uses WebGPU where the browser offers it and
  WebAssembly otherwise. Other browsers may work but are not checked.
- **Operating systems:** CI runs on Linux and on Windows through WSL 2 (Ubuntu); the docs are
  written and checked on macOS.

## Who maintains it

One person maintains this project.
- Security reports: [SECURITY.md](../SECURITY.md) promises an answer within 7 days.
- Other questions: [SUPPORT.md](../SUPPORT.md).

A fix may take longer than the answer.
