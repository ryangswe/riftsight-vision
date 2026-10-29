<!-- SPDX-License-Identifier: Apache-2.0 -->

# Extension: your own browser extension

When the report of `cardvision try` and the demo page name your cards on your video
([Your game](your-game.md), or [Train](train.md), step 8), a browser extension brings the same hover to videos on YouTube and
Twitch. **Each viewer installs your extension from a browser's store; it is not a stream-side
overlay.** A streamer who wants viewers to hover cards asks them to install it.

**Video:** [Make it yours: your own browser extension](https://www.youtube.com/watch?v=tRTTq4P3sRU).

The browser runtime answers one question: with the pointer here, over this picture, which
card would be shown? It loads your release, analyzes frames and applies the accept and hover
rules. An extension adds everything around that: finding the video on a website and the
pointer over it, capturing the frame under the pointer, a tooltip beside the card, a settings
file and its on/off switch, the permissions for the sites it runs on, and a package for a
browser's store. This repository has none of that.

A working example does: the One Piece example extension, Kenbunshoku
(<https://github.com/ryangswe/kenbunshoku>), an Apache-2.0 Chrome extension built on this
runtime for YouTube and Twitch. Its models, bank and card list all come from the release
folder it is built with. What makes it Kenbunshoku (its names, icons, sites, hosts, settings
address and the rule for printed numbers) is one file, `kenbunshoku.config.json`, and the build
refuses a file with a problem, saying which. So you copy the repository, edit that file, add
your release and its legal files, and build. Kenbunshoku's README says it is looking for a
maintainer: a copy is yours to maintain, so plan for that.

Its guide, [Make it yours: an extension for another card game](https://github.com/ryangswe/kenbunshoku/blob/main/docs/make-it-yours.md),
has the detail and the exact files. Its steps are:

1. **Copy the repository, then `npm ci` and `npm test`.**
2. **Edit `kenbunshoku.config.json`:** name, icons, video sites, image hosts, settings
   address, printed-number rule, geometric stage on or off, and links.
3. **Your models:** pass your release folder with `--release` and rewrite `release-legal/`
   (license, notice and provenance of your models). The build refuses a release whose id the
   notice does not name.
4. **Card pictures: choose one.** Names only, or your own image host. Host only pictures you
   have the right to serve; if you do not have that right, use names only.
5. **Extra accuracy (the geometric stage), on or off** ([Measure](measure.md), step 7).
6. **Your own extension ID:** make your own key pair. Do not reuse the example's key.
7. **Delete the One Piece text** that no longer applies.
8. **Build, load and check on a local video** before you try a website.
9. **Before a store listing:** explain every permission and every host the extension
   requests, and say plainly that it is unofficial and not affiliated with your game's
   publisher.

Its guide says its steps were checked on this repository's toy release: with names only, the
extra-accuracy stage off, no host at all and Twitch only, the copy's tests passed, it built,
and in Chrome for Testing on the local test page it named the cards under the pointer.

That check used the demo's toy release, `$WORK/demo/release`, which
`python tests/test_browser_fixtures.py --demo "$WORK/demo"` writes ([browser/README.md](../browser/README.md),
"The demo page", step 1), not the release of Train, step 6. To repeat it, build with
`--release "$WORK/demo/release"`. The release of Train, step 6, `$WORK/release`, builds too,
but its ten-step detector finds nothing (Train, step 7), so an extension built with it names no
card. With the released models and your own bank, use the release folder of
[Your game](your-game.md): `$GAME/cardvision-try/release` from `cardvision try`, or
`$GAME/release` from its step 6; with your own trained models, your own release folder.

## Card pictures

**Names only is the default, and the safe choice.** The tooltip then shows each card's name,
from your release's catalog, and the extension requests no picture from anywhere. Showing card
pictures means serving them from a host of your own (step 4 above) or, with changes of your
own to the copy, bundling them in the extension. Either is your choice and your responsibility under the rules of your game's
publisher: serve or bundle only pictures you have the right to distribute. **Never put another
publisher's card art in a public repository**, your copy of the extension included. This
repository contains no card art for any game.

## The maintenance kit

An extension does not import the runtime from a package registry: it vendors a copy, built
from one tagged commit of this repository, into a folder of its own such as
`vendor/cardvision-browser/`. `npm ci && npm run build` in `browser/` writes `browser/dist/`:
`cardvision.js` and `worker.js` (the runtime), `remote-release.js` (the
[remote releases](remote-releases.md) the settings file can point to), ONNX Runtime's
WebAssembly files (`ort-wasm-*`), OpenCV.js for the geometric stage (`opencv.mjs`,
`opencv_js.wasm`, when `scripts/build-opencv.mjs` has built it), `node/verify-release.mjs` and
`node/package-zip.mjs` (the Node tools its release and package scripts call), the license
notices (`*.LEGAL.txt`, `THIRD-PARTY-NOTICES.txt`), and the demo page (`demo/`), which an
extension does not need. The build
writes no TypeScript declarations. The product's own vendoring script copies the files it uses
and adds a `VENDOR.json` beside `cardvision.js` recording what it vendored: its
`onnxruntimeWeb` key is the ONNX Runtime version, which `verify-release.mjs` checks a release
against. When `VENDOR.json` is there without that key, the script exits 2 unless `--ort-web
VERSION` is given; without `VENDOR.json` it takes `--ort-web`, else the `onnxruntime-web`
package Node finds. Other keys, such as the commit, are the product's own. On the publishing side it uses
[`cardvision cdn`](cdn.md) and, for each card update, [`cardvision refresh`](refresh-rule-template.md)
([playbooks/refresh-set.md](../playbooks/refresh-set.md)). To update, vendor a newer tagged
commit, run the extension's tests and ship it as a store release: code never arrives through
the settings file. The remote-release module, the Node tools and both commands are
[experimental](stability.md#experimental). To show cards in the viewer's language, see
[languages.md](languages.md).

## With a coding agent

[playbooks/make-extension.md](../playbooks/make-extension.md) has the same steps as numbered commands
for a coding agent, each with what to expect, and the rules it follows about pictures.
