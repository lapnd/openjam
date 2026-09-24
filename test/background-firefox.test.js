// background.js on a browser with no chrome.debugger and a platform adapter
// (Firefox): it must load without touching Chrome-only APIs, record on the
// adapter's lane, say so in the popup response and in the report, and salvage a
// closed tab without the debugger's onDetach.
import { test, expect, afterAll } from "bun:test";
import { FIREFOX_LIMITS } from "../browsers/firefox/limits.js";
import { createFirefoxLane } from "../browsers/firefox/lane.js";

const store = {};
const createdTabs = [];
const tabMessages = [];
const runtimeListeners = [];
const tabRemovedListeners = [];
const webRequest = {};
let captureCalls = 0;

for (const name of ["onBeforeRequest", "onSendHeaders", "onHeadersReceived", "onBeforeRedirect", "onCompleted", "onErrorOccurred"]) {
  webRequest[name] = {
    fn: null,
    addListener(fn) {
      this.fn = fn;
    },
    removeListener() {
      this.fn = null;
    },
  };
}

// bun runs every test file in one process: put the globals back so the Chrome
// suites (background.test.js sorts right after this file) never see the adapter.
const previous = { chrome: globalThis.chrome, platform: globalThis.openjamPlatform };
afterAll(() => {
  globalThis.chrome = previous.chrome;
  if (previous.platform === undefined) delete globalThis.openjamPlatform;
  else globalThis.openjamPlatform = previous.platform;
});

// NB: no `debugger` and no `offscreen` key — that absence is the point.
globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 3 }],
    get: async (id) => ({ id, url: "https://example.test/app", windowId: 1 }),
    sendMessage: async (tabId, msg) => {
      tabMessages.push({ tabId, msg });
      if (msg.action === "oj-device-info") return { userAgent: "Firefox/999", url: "https://example.test/app", title: "T" };
      return { ok: true };
    },
    captureVisibleTab: async () => {
      captureCalls++;
      return "data:image/png;base64,AA==";
    },
    create: async (opts) => void createdTabs.push(opts.url),
    onRemoved: { addListener: (fn) => tabRemovedListeners.push(fn) },
  },
  storage: {
    local: {
      get: async (key) => (key === null ? { ...store } : { [key]: store[key] }),
      set: async (obj) => void Object.assign(store, obj),
      remove: async (keys) => void [].concat(keys).forEach((k) => delete store[k]),
    },
  },
  scripting: { executeScript: async () => {} },
  webRequest,
  runtime: {
    id: "own",
    getPlatformInfo: (cb) => cb({ os: "test" }),
    getManifest: () => ({ version: "9.9.9" }),
    getURL: (p) => "moz-extension://test/" + p,
    onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
  },
};
globalThis.openjamPlatform = { name: "firefox", captureNotice: FIREFOX_LIMITS, createLane: createFirefoxLane };

const dispatch = (msg, sender = {}) =>
  new Promise((resolve) => {
    let done = false;
    for (const fn of runtimeListeners) fn(msg, sender, (r) => !done && ((done = true), resolve(r)));
  });

// Disconfirming: drop the `if (chrome.debugger)` guards in background.js — this
// import throws "undefined is not an object (evaluating 'chrome.debugger.onDetach')".
await import("../background.js?firefox-platform");

const reports = () => Object.keys(store).filter((k) => k.startsWith("report-"));

test("starts on the adapter's lane without attaching a debugger, and returns the limits notice", async () => {
  tabMessages.length = 0;
  const res = await dispatch({ action: "start" });
  expect(res).toEqual({ ok: true, warning: FIREFOX_LIMITS, blockedBy: null });
  expect(await dispatch({ action: "getStatus" })).toMatchObject({ recording: true, tabId: 3, capture: "firefox" });
  // the probe armed, the page asked for device info, replay started, first screenshot taken
  expect(tabMessages.map((m) => m.msg.action)).toEqual(expect.arrayContaining(["oj-probe-start", "oj-device-info", "oj-rrweb-start"]));
  expect(captureCalls).toBe(1);
  // webRequest is armed for exactly this tab
  expect(webRequest.onBeforeRequest.fn).toBeFunction();
  await dispatch({ action: "stop" });
  expect(webRequest.onBeforeRequest.fn).toBeNull(); // and disarmed
});

test("the report says it was recorded in Firefox mode, leads with the limits, and carries webRequest loads", async () => {
  await dispatch({ action: "start" });
  const now = Date.now();
  webRequest.onBeforeRequest.fn({ requestId: "1", url: "https://example.test/a.css", method: "GET", type: "stylesheet", timeStamp: now });
  webRequest.onHeadersReceived.fn({ requestId: "1", statusCode: 200, statusLine: "HTTP/2 200 OK", responseHeaders: [{ name: "Content-Type", value: "text/css" }] });
  webRequest.onCompleted.fn({ requestId: "1", statusCode: 200, timeStamp: now + 5 });
  // page-probe records still flow through the shared inject-lane handler
  const probe = [{ kind: "console", level: "log", t: now + 1, message: "hello", stack: [] }];
  expect(await dispatch({ type: "oj-page-batch", eventsJson: JSON.stringify(probe) }, { tab: { id: 3 } })).toEqual({ ok: true });
  await dispatch({ action: "stop" });

  const report = store[reports().at(-1)];
  expect(report.meta).toMatchObject({ capture: "firefox", version: "9.9.9" });
  expect(report.device.userAgent).toBe("Firefox/999");
  expect(report.events[0]).toMatchObject({ kind: "log", level: "warning", title: FIREFOX_LIMITS });
  expect(report.events.find((e) => e.kind === "network").detail).toMatchObject({ url: "https://example.test/a.css", resourceType: "stylesheet", status: 200, mimeType: "text/css", durationMs: 5 });
  expect(report.events.find((e) => e.kind === "console").title).toBe("hello");
  expect(createdTabs.at(-1)).toMatch(/^moz-extension:\/\/test\/viewer\.html\?key=report-/);
});

test("closing the recorded tab salvages the recording (no debugger onDetach to do it)", async () => {
  await dispatch({ action: "start" });
  createdTabs.length = 0;
  for (const fn of tabRemovedListeners) fn(3);
  await new Promise((r) => setTimeout(r, 600)); // grace window + save
  expect((await dispatch({ action: "getStatus" })).recording).toBe(false);
  expect(createdTabs).toHaveLength(1);
  const report = store[reports().at(-1)];
  expect(report.events.some((e) => /recorded tab was closed/.test(e.title))).toBe(true);
});
