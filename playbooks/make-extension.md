<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tier 0 → an extension

This playbook covers building a browser extension for the person's game on top of a release folder. It assumes tier 0 done: [try-my-game.md](try-my-game.md). The rules in [AGENTS.md](../AGENTS.md) apply to every step here.

Goal: a browser extension for the person's game that shows the card under the pointer on
YouTube or Twitch videos, built on the release folder of step 0.0 in [try-my-game.md](try-my-game.md) (`$GAME/cardvision-try/release`)
or of step 0.6 in [try-my-game.md](try-my-game.md) (`$GAME/release`), or, after tier 1, on the release of step 1.6 in [train.md](train.md). Go here when the
names on the person's video are good enough for them (the report of step 0.0, or step 0.4 in [try-my-game.md](try-my-game.md), and
the demo page). The human guide is
[docs/extension.md](../docs/extension.md).

- **Tell the person how it reaches viewers.** Each viewer installs the extension from a
  browser's store (or loads it unpacked, for testing). It is not a stream-side overlay: a
  streamer cannot turn it on for their viewers.
- **Card pictures: names only, unless the person states their rights.** Never put another
  publisher's card art in a public repository, the person's copy of the extension included.
  Build names only (step E6) unless the person tells you they have the right to serve or bundle
  the pictures; then follow `cdn/SETTINGS.md` in the copy, with a host they run. Do not fetch
  card art (see "Stop and ask the person" in [AGENTS.md](../AGENTS.md#stop-and-ask-the-person)).
- **The base is Kenbunshoku** (<https://github.com/ryangswe/kenbunshoku>), an Apache-2.0
  Chrome extension for One Piece Card Game videos built on this repository's browser runtime.
  Its README says it is looking for a maintainer: the person's copy is theirs to maintain.
  Say so. Its guide, `docs/make-it-yours.md`, is the source of these steps; read it in the
  copy, and follow it where it differs from this list.
- **Status of these steps:** checked by Kenbunshoku's own guide on this repository's toy
  release (names only, the geometric stage off, no host, Twitch only); not run by this
  repository's tests. Report them as not run here.

Run the steps in the copy's folder, not in this repository. Its own rules apply there.

**E1. Copy the repository,** outside this checkout (tell the person: it downloads the
Kenbunshoku repository):

```
git clone https://github.com/ryangswe/kenbunshoku.git "$HOME/Downloads/my-game-extension"
cd "$HOME/Downloads/my-game-extension"
```

- **Expect:** git's lines and a folder with `kenbunshoku.config.json` in it.

**E2. Install and test,** with Node 22 or later:

```
npm ci
npm test
```

- **Expect:** the summary passes except one test, which fails by design until both the
  `packageName` (E3) and the extension's key (E8) are changed: a copy must not keep one of
  Kenbunshoku's and not the other. Tests of Kenbunshoku's own values are skipped once
  `packageName` is not `kenbunshoku`. `DOMException` lines and stack traces ("Failed to load
  iframe page ... Iframe page loading is disabled.") before the summary are harmless.

**E3. Edit `kenbunshoku.config.json`.** The keys are explained at the top of
`scripts/fork-config.mjs`. Ask the person for the names and the sites.

- `name`, `shortName`, `description`: the extension's names; `packageName`: the release zip's
  name.
- `icons`: a folder with `icon-16.png`, `icon-32.png`, `icon-48.png` and `icon-128.png`,
  square PNGs of those sizes in pixels. Make them from art of the person's own (ask them for
  it); never from the publisher's logo or card art (E12).
- `videoSites`: `{ "youtube": true|false, "twitch": true|false }`.
- `imageHosts`: `[]` for names only.
- `settingsUrl`: `null` (no fetch; the copy built into the extension is used).
- `printedNumber`: `"none"`, unless the person wants the number printed on a card in image
  addresses.
- `geometric`: `null` (E7).
- `projectUrl`, `modelUrl`, `maintainerContactUrl`, `updateUrlPrefix`: the person's, or
  `null`. Keep `runtimeUrl`: it credits the runtime.
- **Expect:** the build (E10) accepts the file; it refuses a file with a problem and says which.

**E4. The release's legal files.** Rewrite `release-legal/`: `LICENSE` (the models' license:
Apache-2.0 for the released weights), `NOTICE`, whose first line must contain
`(id <release id>)`, and `PROVENANCE.md` (what the models were trained and built from). The
release id is the 16 hexadecimal digits that `cardvision verify-release` prints for the
release folder.

- **Expect:** the build accepts this release, and refuses any other.

**E5. No picture source of Kenbunshoku's.** Replace `data/source-files.json` with `{}`, and
build without `--images-index`.

- **Expect:** the build prints a line such as `{sourceFile} map from data/source-files.json:
  optcgapi 0 of 20 cards`: expected in a copy that does not use that host.

**E6. Names only.** In `cdn/config.json` set `"namesOnly": true`, `"primary": null`,
`"fallbacks": []`, `"geometric": false` and `"cardLink": null`.

- **Expect:** the tooltip shows each card's name, from the release's catalog, and the
  extension requests no picture.

**E7. The geometric stage off.** `"geometric": null` in `kenbunshoku.config.json` (E3), and
delete `data/geometric.json`.

- **Expect:** the build needs no `data/geometric.json`, asks for no unlimited storage and
  ships no OpenCV.

**E8. The extension's own key pair,** with the private key in a private folder of the home
directory: outside Downloads, and outside the copy and any other repository:

```
mkdir -p "$HOME/.extension-keys" && chmod 700 "$HOME/.extension-keys"
openssl genrsa -out "$HOME/.extension-keys/private-key.pem" 2048
openssl rsa -in "$HOME/.extension-keys/private-key.pem" -pubout -out keys/unpacked-public.pem
```

- **Expect:** `keys/unpacked-public.pem` changed, and the private key in
  `$HOME/.extension-keys/`. Never commit the private key, and tell the person where it is:
  anyone who has it can publish an extension under their ID.

**E9. Delete the One Piece text** that no longer applies: the README and the pages in `docs/`
(their figures are for the One Piece models only), `PRIVACY.md` (rewrite it for the person's
hosts, none for names only) and `cdn/README.md`. Keep `LICENSE` and the attributions in
`NOTICE`, and add the person's own.

**E10. Test and build** on the person's release folder. `$GAME` is the game's folder of
step 0.1 in [try-my-game.md](try-my-game.md) (`export GAME="$HOME/Downloads/my-game"`); a new shell has lost it, so set it again,
and the release folder is the one `try` made in step 0.0 in [try-my-game.md](try-my-game.md) (`$GAME/release` if the person used
the step-by-step 0.6 instead; after tier 1, the release of step 1.6 in [train.md](train.md)):

```
npm test
npm run build -- --dev --release "$GAME/cardvision-try/release"
```

- **Expect:** every test passes now (E3 and E8 done), and the build writes `dist/`.

**E11. Load it and check on a local video** (the person's, in `$GAME` as in E10). Loading is
the person's act, or yours in a browser you drive: in Chrome, `chrome://extensions`, **Developer mode** on, **Load unpacked**,
choose `dist/`. Then:

```
npm run manual -- --video "$GAME/video.mp4"
```

- **Expect:** a server on `http://127.0.0.1:8770/`. Open it, turn card hovers on with the
  button in the player, and rest the pointer on a card: its name shows. Stop the server
  afterwards. Then the person tries a video on the sites they turned on.

**E12. Before a store listing** (the person's act, not yours): a `--store` build, packaged with
`npm run package`; every permission and every requested host explained in the listing; the
extension said plainly to be unofficial and not affiliated with the game's publisher; the
publisher's logos kept out of the extension's name and icon; only pictures the person has the
right to serve. The store's own review and policies apply.
