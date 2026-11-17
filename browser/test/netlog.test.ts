// SPDX-License-Identifier: Apache-2.0
// The hover browser test's network scope (harness/netlog.mjs), on small NetLog fixtures.
import { describe, expect, it } from "vitest";

import { classify, netlogRequests } from "../harness/netlog.mjs";

const START = 1;
const ALIVE = 2;
const OTHER = 3;
const constants = { logEventTypes: { URL_REQUEST_START_JOB: START, REQUEST_ALIVE: ALIVE, SOCKET_ALIVE: OTHER } };
type Event = { type: number; source: { id: number }; params?: Record<string, unknown> };
const netlog = (events: Event[]) => JSON.stringify({ constants, events });
const start = (id: number, url: string, initiator?: string): Event => ({ type: START, source: { id }, params: { url, ...(initiator ? { initiator } : {}) } });
const alive = (id: number, url: string): Event => ({ type: ALIVE, source: { id }, params: { url } });
const scope = (text: string) => classify(netlogRequests(text), { standInHost: "cdn.example.com" });

describe("the NetLog network scope", () => {
  it("lets requests to 127.0.0.1, the stand-in host and extension or data URLs through", () => {
    const r = scope(netlog([start(1, "http://127.0.0.1:4000/video", "http://127.0.0.1:4000"), start(2, "https://cdn.example.com/config.json", "chrome-extension://abc"), start(3, "chrome-extension://abc/x.js"), start(4, "data:,x")]));
    expect(r.violations).toEqual([]);
    expect(r.hosts).toEqual({ "127.0.0.1:4000": 1, "cdn.example.com": 1 });
  });

  it("flags a request from the extension or the page to any other host", () => {
    const r = scope(netlog([start(1, "https://other.example/x", "chrome-extension://abc"), start(2, "https://www.google.com/x", "http://127.0.0.1:4000")]));
    expect(r.violations.map((v) => v.url)).toEqual(["https://other.example/x", "https://www.google.com/x"]);
  });

  it("exempts only the browser's own requests (no origin) to Google's hosts", () => {
    const r = scope(netlog([start(1, "https://update.googleapis.com/x", "not an origin"), start(2, "https://other.example/x", "not an origin")]));
    expect(r.exempt.map((e) => e.url)).toEqual(["https://update.googleapis.com/x"]);
    expect(r.violations.map((v) => v.url)).toEqual(["https://other.example/x"]);
  });

  it("takes a request's initiator from any of its events (REQUEST_ALIVE carries none)", () => {
    const r = scope(netlog([alive(7, "https://www.google.com/x"), start(7, "https://www.google.com/x", "chrome-extension://abc")]));
    expect(r.exempt).toEqual([]);
    expect(r.violations).toEqual([{ url: "https://www.google.com/x", initiator: "chrome-extension://abc" }]);
  });

  it("checks every URL of a redirected request", () => {
    const r = scope(netlog([start(9, "https://cdn.example.com/a", "chrome-extension://abc"), start(9, "https://other.example/b", "chrome-extension://abc")]));
    expect(r.violations.map((v) => v.url)).toEqual(["https://other.example/b"]);
  });

  it("reads a NetLog cut short, up to its last whole event", () => {
    const whole = netlog([start(1, "https://cdn.example.com/y", "chrome-extension://abc"), start(2, "https://other.example/x", "chrome-extension://abc")]);
    const cut = whole.slice(0, whole.length - 2) + ',{"type":1,"source":{"id":3},"par';
    expect(scope(cut).violations.map((v) => v.url)).toEqual(["https://other.example/x"]);
    expect(scope(cut).hosts).toEqual({ "cdn.example.com": 1, "other.example": 1 });
  });

  it("fails on a cut-short NetLog with no whole event", () => {
    const cut = JSON.stringify({ constants }).slice(0, -1) + ',"events":[{"type":1,"source":{"id":1},"params":{"list":[' + "{},".repeat(60);
    expect(() => netlogRequests(cut)).toThrow();
  });

  // The last event cut short holds many "}," of its own, each a point the parser tries and fails.
  const cutAfter = (inner: number) =>
    netlog([start(1, "https://other.example/x", "chrome-extension://abc")]).slice(0, -2) + ',{"type":1,"source":{"id":2},"params":{"list":[' + "{},".repeat(inner);

  it("recovers the last whole event on the 50th try", () => {
    expect(scope(cutAfter(48)).violations.map((v) => v.url)).toEqual(["https://other.example/x"]);
  });

  it("gives up when the last whole event needs a 51st try", () => {
    expect(() => netlogRequests(cutAfter(49))).toThrow();
  });

  it("fails on a file that is not a NetLog", () => {
    expect(() => netlogRequests("not json")).toThrow();
  });
});
