// SPDX-License-Identifier: Apache-2.0
// The hover browser test's network scope: what a Chrome NetLog says was requested, and which of
// those requests left the machine. Tested on fixtures in test/netlog.test.ts.

/** Every request in a NetLog's text: all the URLs it went to (a redirect adds one) and the origin
 *  that started it (null for a request the browser started itself), gathered per request across
 *  its events. A NetLog cut short before Chrome closed it is read up to its last whole event. */
export function netlogRequests(text) {
  const doc = parseNetlog(text.trim());
  const types = Object.fromEntries(Object.entries(doc.constants.logEventTypes).map(([k, v]) => [v, k]));
  const bySource = new Map();
  for (const e of doc.events ?? []) {
    const name = types[e.type];
    if (name !== "URL_REQUEST_START_JOB" && name !== "REQUEST_ALIVE") continue;
    const r = bySource.get(e.source.id) ?? { urls: new Set(), initiator: null };
    if (e.params?.url) r.urls.add(e.params.url);
    if (e.params?.initiator && e.params.initiator !== "not an origin") r.initiator = e.params.initiator;
    bySource.set(e.source.id, r);
  }
  return [...bySource.values()].filter((r) => r.urls.size > 0).map((r) => ({ urls: [...r.urls], initiator: r.initiator }));
}

/** A NetLog is whole JSON only once Chrome closed it. A cut-short one is cut back, one "}," at a
 *  time from the end, to the last point where closing the events list makes whole JSON. */
function parseNetlog(body) {
  try {
    return JSON.parse(body);
  } catch (error) {
    const eventsAt = body.indexOf('"events"');
    if (eventsAt < 0) throw error;
    for (let end = body.length, tries = 0; end > eventsAt && tries < 50; tries += 1) {
      const at = body.lastIndexOf("},", end - 1);
      if (at <= eventsAt) break;
      try {
        return JSON.parse(body.slice(0, at + 1) + "]}");
      } catch {
        end = at;
      }
    }
    try {
      return JSON.parse(body.replace(/,?\s*$/, "") + "]}");
    } catch {
      throw error;
    }
  }
}

const LOCAL_SCHEMES = /^(chrome-extension|data|blob):/;
/** Chrome's own background traffic (sign-in, updates) goes to these hosts. */
const CHROME_OWN = /(^|\.)(google\.com|googleapis\.com|gstatic\.com|gvt1\.com)$/;

/** Sort the requests: the ones that stayed (127.0.0.1, the stand-in host, extension and data
 *  URLs), Chrome's own exempt ones (no initiator, to Google's hosts), and violations (any other
 *  host, whoever asked). Also counts the hosts seen. */
export function classify(requests, { standInHost }) {
  const violations = [];
  const exempt = [];
  const hosts = {};
  for (const r of requests) {
    for (const url of r.urls) {
      if (LOCAL_SCHEMES.test(url)) continue;
      let host;
      try {
        host = new URL(url).host;
      } catch {
        violations.push({ url, initiator: r.initiator, why: "not a URL" });
        continue;
      }
      hosts[host] = (hosts[host] ?? 0) + 1;
      if (host.startsWith("127.0.0.1:") || host === "127.0.0.1" || host === standInHost) continue;
      if (r.initiator === null && CHROME_OWN.test(host.replace(/:\d+$/, ""))) exempt.push({ url, initiator: null });
      else violations.push({ url, initiator: r.initiator });
    }
  }
  return { violations, exempt, hosts };
}
