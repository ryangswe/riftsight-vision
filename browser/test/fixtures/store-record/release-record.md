<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release record 1.0.0

Machine facts only. Tag `v1.0.0`, commit `0123456789abcdef0123456789abcdef01234567`, run 123456789.

## Packages

| Package | File | Bytes | SHA-256 | Files | Contents SHA-256 |
| --- | --- | ---: | --- | ---: | --- |
| Chrome Web Store package | `chrome.zip` | 20 | `01c6aa298a00e682bc52e05d030b355a87f54e638fbdcccd02a59a301784a055` | 2 | `5edfc3bd4feca8ad4ea101fd301f1d77b515a908e542dd745b274f372b0956c7` |
| Firefox package | `firefox.zip` | 21 | `b290ab678dc43f822f8693737b2a100a44f4bc3f8f509e19e9f470c085551e3e` | 2 | `7271b3e6914aa0fa258beb84ac329952ab8091e05a3ba2ac74fe08d426a44882` |
| Firefox source archive (not attached to the release) | `firefox-source.zip` | 20 | `23a09542290174dd8f8bbc6deca7963098df5d8fef09a1e7a7eea88448fd8ce4` |  |  |
| Load-unpacked package | `load-unpacked.zip` | 27 | `4b0eb2ecc30fecd375360e7f6f012f28bb7c6b5c963ce5b669d2d0bb3e15b6a8` | 2 | `8491477ece301fb17c8f4abd26ca70c16818cd6a71d6bf8a6919d699233d99c9` |

## Build

- Vendored toolkit: version 0.14.1, commit `89abcdef0123456789abcdef0123456789abcdef`
- ONNX Runtime: 1.29.0
- OpenCV: 4.12.0, commit `fedcba9876543210fedcba9876543210fedcba98`
- Bundled model release: example-1
- Firefox lint: 0 errors, 0 warnings (0 in the baseline)
- Addresses checked before upload: 1
- Chrome: submit auto, publish default
- ortVersion: 1.29.0

## Checks on the commit

- external: neutral
- lint: failure (run 555)
- tests: success (run 555)

## Permissions

No permission change is recorded for this release.

### chrome

- permissions: `storage`
- optional_permissions: none
- host_permissions: none
- optional_host_permissions: `https://www.example.org/*`
- content_script_matches: none
- web_accessible_matches: none
- externally_connectable: none
- data_collection: none

### firefox

- permissions: `storage`
- optional_permissions: none
- host_permissions: none
- optional_host_permissions: `https://www.example.org/*`
- content_script_matches: none
- web_accessible_matches: none
- externally_connectable: none
- data_collection: `required:none`
