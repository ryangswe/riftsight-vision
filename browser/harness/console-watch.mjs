// SPDX-License-Identifier: Apache-2.0
// What the browser says about a content-security-policy violation or a refused postMessage, from
// any page, frame or worker of a test browser. Shared by the hover browser test and the rollback
// check. The wording is Chrome's; test/console-watch.test.ts holds its messages as fixtures.

const POLICY = /content security policy|refused to (load|connect|execute|create|frame|apply|run)|violates the following/i;
const ORIGIN = /target origin|does not match the recipient window's origin/i;

/** Which kind of problem a browser log message reports: "policy", "origin" (a postMessage whose
 *  target origin is not the recipient's), or null for any other message. */
export function logProblem(text) {
  const message = String(text ?? "");
  if (POLICY.test(message)) return "policy";
  if (ORIGIN.test(message)) return "origin";
  return null;
}

/** Watch every page, frame and worker of `browser` (puppeteer), now and as they appear. The Log
 *  domain of each target replays what it held before this attached, so a violation at load is not
 *  missed. Problems are pushed to `sinks.policy` and `sinks.origin`. */
export function watchConsole(browser, sinks) {
  const attached = new Set();
  const attach = async (target) => {
    if (attached.has(target) || target.type() === "browser") return;
    attached.add(target);
    const session = await target.createCDPSession();
    session.on("Log.entryAdded", ({ entry }) => {
      const text = String(entry.text ?? "");
      const kind = logProblem(text);
      if (kind === null) return;
      sinks[kind].push({ text: text.slice(0, 300), target: target.type(), url: String(entry.url ?? target.url()).slice(0, 200) });
    });
    await session.send("Log.enable");
  };
  const safely = (target) => void attach(target).catch(() => attached.delete(target));
  browser.on("targetcreated", safely);
  for (const target of browser.targets()) safely(target);
}
