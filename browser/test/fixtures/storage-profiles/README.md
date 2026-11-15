<!-- SPDX-License-Identifier: Apache-2.0 -->

# Stored profiles

Each `*.json` file here is the whole local extension storage (`chrome.storage`) of one real, older build of a product
that uses the hover host, exported from a throwaway browser profile with the switches flipped from
their defaults. `test/host-storage-profiles.test.ts` reads every file through the settings core and
the switches. The files hold no personal data.

Neither export holds `update.dismissed`, `releaseSkip` or a separate release cache: no update
notice showed, and no remote release failed, while they were made. Hosts, release ids and
hashes in the stored settings copy are replaced with neutral stand-ins of the same shape; the keys
and value shapes are as exported.
