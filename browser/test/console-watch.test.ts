// SPDX-License-Identifier: Apache-2.0
// The browser-message classifier of the hover browser test and the rollback check, on messages as
// Chrome words them. It runs no browser.
import { describe, expect, it } from "vitest";

import { logProblem } from "../harness/console-watch.mjs";

describe("logProblem", () => {
  it("names a content-security-policy violation, whatever the directive", () => {
    for (const text of [
      "Refused to connect to 'https://other.example/x.json' because it violates the following Content Security Policy directive: \"connect-src 'self' https://settings.toy-fixture.test\".",
      "Refused to load the script 'https://other.example/a.js' because it violates the following Content Security Policy directive: \"script-src 'self' 'wasm-unsafe-eval'\".",
      "Refused to execute inline script because it violates the following Content Security Policy directive: \"script-src 'self'\". Either the 'unsafe-inline' keyword, a hash, or a nonce is required to enable inline execution.",
      "Refused to load the image 'https://other.example/a.png' because it violates the following Content Security Policy directive: \"img-src 'self' blob: data:\".",
      "Refused to create a worker from 'blob:null/1' because it violates the following Content Security Policy directive: \"worker-src 'self'\".",
      "[Report Only] Refused to frame 'https://other.example/' because an ancestor violates the following Content Security Policy directive: \"frame-ancestors 'none'\".",
    ]) {
      expect(logProblem(text)).toBe("policy");
    }
  });

  it("names a postMessage whose target origin is not the recipient's", () => {
    expect(
      logProblem("Failed to execute 'postMessage' on 'DOMWindow': The target origin provided ('chrome-extension://abcdefghijklmnopabcdefghijklmnop') does not match the recipient window's origin ('http://127.0.0.1:41233')."),
    ).toBe("origin");
  });

  it("leaves other messages alone", () => {
    for (const text of [
      "Failed to load resource: net::ERR_NAME_NOT_RESOLVED",
      "Failed to load resource: the server responded with a status of 404 ()",
      "Uncaught (in promise) TypeError: Failed to fetch",
      "Toy fixture: settings {\"kind\":\"updated\",\"problems\":[]}",
      "",
      undefined,
    ]) {
      expect(logProblem(text)).toBeNull();
    }
  });
});
