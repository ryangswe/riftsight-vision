// SPDX-License-Identifier: Apache-2.0
// Remote releases for a browser extension (experimental): which release a page loads when a
// settings file may name one published on the settings host, the fetch and check of that release,
// the geometric stage under it, and the card table built from its catalog. The contract is
// docs/remote-releases.md. Built on its own to dist/remote-release.js; not part of the runtime's
// API (src/index.ts). Storage, fetch, SHA-256 and the extension's URLs are passed in; no extension
// globals are used here. Skip-list times come from Date.now().

export { buildCardTable, type CardTable } from "./card-table.js";
export { chooseRelease, type ChooseDeps, decisionLine, type LoadRequest, recordSkip, type ReleaseDecision, type RemoteReleaseChoice } from "./choose.js";
export {
  checkRemoteGeometric,
  chosenBeforeFetch,
  fallbackRequest,
  GEO_MANIFEST_PATH,
  type GeometricCheck,
  type GeometricDeps,
  type GeometricField,
  geometricLine,
  type GeometricPointer,
  GEOMETRIC_MAX_BYTES,
  GEOMETRIC_TIMEOUT_MS,
  parseGeometricPointer,
} from "./geometric.js";
export {
  clearStaleSkip,
  compareVersions,
  decide,
  type Decision,
  type DecideInput,
  parsePointer,
  type PointerField,
  readSkip,
  refusalRecorded,
  type ReleasePointer,
  SKIP_KEY,
  SKIP_TTL_MS,
  type SkipEntry,
  type SkipStorage,
  writeSkip,
} from "./pointer.js";
export { DOCUMENT_MAX_BYTES, DOCUMENT_TIMEOUT_MS, FLAT_NAME, loadRemoteRelease, pinnedFiles, type PinnedFile, type RemoteLoad, type RemoteLoadDeps, STALL_MS } from "./remote-load.js";
