// SPDX-License-Identifier: Apache-2.0
// The Chrome Web Store API (v2) calls a release upload needs: an item's status, a package upload
// and a submission for review. The caller brings an OAuth access token with the
// `https://www.googleapis.com/auth/chromewebstore` scope (a workflow gets one from its Google
// sign-in step); this file never sees a key.

/** Where an item is and how to reach it. `base` is the API's origin (a fake one in tests). */
export interface ChromeItem {
  publisherId: string;
  itemId: string;
  accessToken: string;
  base?: string;
  fetchFn?: typeof fetch;
}

export const CHROME_API = "https://chromewebstore.googleapis.com";

/** The item states the API reports for a submitted or published revision. */
export type ChromeItemState =
  | "ITEM_STATE_UNSPECIFIED"
  | "PENDING_REVIEW"
  | "STAGED"
  | "PUBLISHED"
  | "PUBLISHED_TO_TESTERS"
  | "REJECTED"
  | "CANCELLED";

export interface ChromeRevision {
  state?: ChromeItemState;
  distributionChannels?: Array<{ deployPercentage?: number; crxVersion?: string }>;
}

export interface ChromeStatus {
  itemId?: string;
  publishedItemRevisionStatus?: ChromeRevision;
  /** Unset when nothing was submitted since the last successful publish. */
  submittedItemRevisionStatus?: ChromeRevision;
  lastAsyncUploadState?: string;
  takenDown?: boolean;
  warned?: boolean;
}

export class StoreError extends Error {}

function itemName(item: ChromeItem): string {
  if (!/^[^/]+$/.test(item.publisherId) || !/^[^/]+$/.test(item.itemId)) throw new StoreError("a publisher or item id holds a slash");
  return `publishers/${item.publisherId}/items/${item.itemId}`;
}

async function call(item: ChromeItem, method: string, path: string, body?: BodyInit, contentType?: string): Promise<unknown> {
  const fetchFn = item.fetchFn ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${item.accessToken}` };
  if (contentType) headers["Content-Type"] = contentType;
  const res = await fetchFn(`${item.base ?? CHROME_API}/${path}`, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new StoreError(`Chrome Web Store ${method} ${path}: HTTP ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

/** The item's status (`:fetchStatus`). */
export async function chromeStatus(item: ChromeItem): Promise<ChromeStatus> {
  return (await call(item, "GET", `v2/${itemName(item)}:fetchStatus`)) as ChromeStatus;
}

/** What to do with this release's version. "skip": this version is already submitted or
 *  published (a re-run after the other store failed). "block": uploading now would cancel a
 *  review, overwrite an approved revision waiting for its manual publish, or race an earlier
 *  upload. */
export type Decision = { kind: "go" } | { kind: "skip"; reason: string; versionId?: number } | { kind: "block"; reason: string };

const versions = (r: ChromeRevision | undefined): string[] => (r?.distributionChannels ?? []).map((c) => c.crxVersion ?? "").filter(Boolean);

export function chromeDecision(status: ChromeStatus, version: string): Decision {
  if (status.takenDown) return { kind: "block", reason: "the item is taken down" };
  const submitted = status.submittedItemRevisionStatus;
  if (submitted?.state === "PENDING_REVIEW" || submitted?.state === "STAGED") {
    if (versions(submitted).includes(version)) return { kind: "skip", reason: `version ${version} is already submitted (${submitted.state})` };
    return submitted.state === "PENDING_REVIEW"
      ? { kind: "block", reason: "a submission is pending review (uploading now would cancel it)" }
      : { kind: "block", reason: "an approved revision is staged, waiting for its manual publish" };
  }
  if (versions(status.publishedItemRevisionStatus).includes(version)) return { kind: "skip", reason: `version ${version} is already published` };
  if (status.lastAsyncUploadState === "IN_PROGRESS") return { kind: "block", reason: "an earlier upload is still being processed" };
  return { kind: "go" };
}

export interface ChromeUploadResult {
  uploadState: string;
  crxVersion?: string;
}

/** Upload a package; waits (polling the status) while the store is still processing it. */
export async function chromeUpload(
  item: ChromeItem,
  zip: Uint8Array,
  options: { pollMs?: number; maxPolls?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ChromeUploadResult> {
  const res = (await call(item, "POST", `upload/v2/${itemName(item)}:upload`, zip as BodyInit, "application/zip")) as {
    uploadState?: string;
    crxVersion?: string;
  };
  let state = res.uploadState ?? "UPLOAD_STATE_UNSPECIFIED";
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let k = 0; state === "IN_PROGRESS" && k < (options.maxPolls ?? 60); k++) {
    await sleep(options.pollMs ?? 5000);
    state = (await chromeStatus(item)).lastAsyncUploadState ?? state;
  }
  if (state !== "SUCCEEDED") throw new StoreError(`Chrome Web Store upload ended in ${state}`);
  return { uploadState: state, crxVersion: res.crxVersion };
}

export type ChromePublishType = "DEFAULT_PUBLISH" | "STAGED_PUBLISH";

export interface ChromePublishResult {
  state?: ChromeItemState;
  warnings: string[];
}

/** Submit the uploaded package for review. DEFAULT_PUBLISH goes live once approved;
 *  STAGED_PUBLISH waits for a manual publish after approval. */
export async function chromePublish(item: ChromeItem, publishType: ChromePublishType): Promise<ChromePublishResult> {
  const res = (await call(item, "POST", `v2/${itemName(item)}:publish`, JSON.stringify({ publishType }), "application/json")) as {
    state?: ChromeItemState;
    warningInfo?: { warnings?: Array<{ reason?: string; description?: string }> };
  };
  const warnings = (res.warningInfo?.warnings ?? []).map((w) => [w.reason, w.description].filter(Boolean).join(": "));
  return { state: res.state, warnings };
}
