<!-- SPDX-License-Identifier: Apache-2.0 -->

# Stored profiles

Each `*.json` file here is the whole `chrome.storage.local` of one real, older build of a product
that uses the hover host, exported from a throwaway browser profile with the switches flipped from
their defaults. `test/host-storage-profiles.test.ts` reads every file through the settings core and
the switches. The files hold no personal data.
