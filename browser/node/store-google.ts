// SPDX-License-Identifier: Apache-2.0
//
// Credentials for running the upload on the account holder's own machine: a Chrome Web Store
// access token minted from a Google service account's JSON key, and an env file of store
// credentials. Both files must be mode 600 or stricter. Nothing here prints a key, a
// signed request or a token, and error messages never quote a file's content.

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parseEnv } from "node:util";

import { StoreError } from "./store-chrome.js";

/** Google's token address. Fixed: a key file's own `token_uri` is not followed. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CWS_SCOPE = "https://www.googleapis.com/auth/chromewebstore";

/** The names an env file may set. */
export const ENV_FILE_NAMES = ["AMO_JWT_ISSUER", "AMO_JWT_SECRET", "CWS_SERVICE_ACCOUNT_KEY_FILE", "CWS_ACCESS_TOKEN"] as const;

/** A file's text, after checking that no group or other user can read or write it (mode 0600 or 0400). */
export function readPrivateFile(path: string, what: string): string {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    throw new StoreError(`the ${what} ${path} cannot be read`);
  }
  if ((mode & 0o077) !== 0) {
    throw new StoreError(`the ${what} ${path} can be read by other users (mode ${mode.toString(8).padStart(4, "0")}): run chmod 600 ${path}`);
  }
  try {
    return readFileSync(path, "utf-8");
  } catch {
    throw new StoreError(`the ${what} ${path} cannot be read`);
  }
}

/**
 * The store credentials in an env file of KEY=VALUE lines. Only ENV_FILE_NAMES are accepted; any
 * other name is refused (by name, never by value).
 */
export function readEnvFile(path: string): Record<string, string> {
  const values = parseEnv(readPrivateFile(path, "env file")) as Record<string, string>;
  const unknown = Object.keys(values).filter((name) => !(ENV_FILE_NAMES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new StoreError(`the env file ${path} sets names that are not store credentials: ${unknown.sort().join(", ")} (allowed: ${ENV_FILE_NAMES.join(", ")})`);
  }
  return values;
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

export interface TokenOptions {
  fetchFn: typeof fetch;
  /** Tests only. */
  tokenUrl?: string;
  /** Seconds since the epoch (tests). */
  now?: number;
}

/**
 * A Chrome Web Store access token for the service account whose JSON key is at `keyPath`: an
 * RS256-signed JWT exchanged at Google's token address (the JWT bearer grant).
 */
export async function serviceAccountToken(keyPath: string, o: TokenOptions): Promise<string> {
  const text = readPrivateFile(keyPath, "service-account key file");
  let key: { client_email?: unknown; private_key?: unknown };
  try {
    key = JSON.parse(text) as typeof key;
  } catch {
    // JSON.parse's message can quote the file.
    throw new StoreError(`the service-account key file ${keyPath} is not JSON`);
  }
  if (typeof key?.client_email !== "string" || typeof key.private_key !== "string") {
    throw new StoreError(`the service-account key file ${keyPath} has no client_email and private_key: download a JSON key for the service account`);
  }
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(key.private_key);
  } catch {
    throw new StoreError(`the private_key in ${keyPath} is not a usable key`);
  }

  const tokenUrl = o.tokenUrl ?? GOOGLE_TOKEN_URL;
  const iat = Math.floor(o.now ?? Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: CWS_SCOPE, aud: tokenUrl, iat, exp: iat + 3600 }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url");
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` });

  let res: Response;
  try {
    res = await o.fetchFn(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  } catch {
    throw new StoreError(`Google's token address ${tokenUrl} could not be reached`);
  }
  let reply: { access_token?: unknown; error?: unknown } = {};
  try {
    reply = (await res.json()) as typeof reply;
  } catch {
    // Not JSON: say only the status.
  }
  if (!res.ok) {
    // Only Google's short error code is shown, never the body.
    const code = typeof reply.error === "string" && /^[a-z_]{1,40}$/.test(reply.error) ? ` (${reply.error})` : "";
    throw new StoreError(`Google refused a token for the service account in ${keyPath}: HTTP ${res.status}${code}`);
  }
  if (typeof reply.access_token !== "string" || reply.access_token === "") {
    throw new StoreError(`Google's token reply for the service account in ${keyPath} has no access token`);
  }
  return reply.access_token;
}
