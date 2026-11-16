<!-- SPDX-License-Identifier: Apache-2.0 -->

# Toy fixture extension

A stand-in extension for testing the shared hover host. It is not a product, and it does not
recognize real cards: the toy release's detector returns fixed boxes whatever the picture, and its
recognizer only tells the toy game's cards apart. The card art is the toy game's colored shapes,
shipped inside the extension, so nothing is fetched.

It uses only the host's three public files (`dist/host-content.js`, `host-compute.js` and
`host-settings.js`) and the interfaces in `src/host/`. Its manifest carries the strict
extension-page policy, with the toy settings host as the one address beyond the extension itself.

Build and run it from `browser/`, after `npm run build` and with the toy release written by
`python tests/test_browser_fixtures.py --demo "$WORK/toy"` (see `browser/README.md`):

```
node scripts/build-fixture.mjs --release-dir "$WORK/toy/release" --art-dir "$WORK/toy/art"
node scripts/build-fixture.mjs --release-dir "$WORK/toy/release" --art-dir "$WORK/toy/art" --idle-unload-ms 6000
node harness/hover-browser.mjs --product fixture-extension/product.mjs --chrome <Chrome for Testing> \
  --release "$WORK/toy/release" --art "$WORK/toy/art" --dist-idle fixture-extension/build/idle
```

`product.mjs` is the harness's product module: the clip puts the toy cards on the detector's boxes,
with card D exactly over card A. `.github/workflows/browser.yml` runs it as "Host browser test".
