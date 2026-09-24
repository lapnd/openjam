// The Firefox lane (browsers/firefox/lane.js): webRequest events become network
// timeline events with the same detail schema as the other lanes, fetch/XHR are
// left to the page probe, and a webRequest failure never wedges the session.
import { test, expect } from "bun:test";
import { createWebRequestNetwork, createFirefoxLane, headersToObject } from "../browsers/firefox/lane.js";

// A stand-in for chrome.webRequest that records what was registered and lets a
// test fire events. Like Firefox, it rejects an explicit `undefined` extraInfoSpec.
function fakeWebRequest() {
  const registered = {};
  const api = {};
  for (const name of ["onBeforeRequest", "onSendHeaders", "onHeadersReceived", "onBeforeRedirect", "onCompleted", "onErrorOccurred"]) {
    api[name] = {
      addListener(...args) {
        if (args.some((a) => a === undefined)) throw new Error(`Incorrect argument types for webRequest.${name}.`);
        registered[name] = { fn: args[0], filter: args[1], extra: args[2] };
      },
      removeListener(fn) {
        if (registered[name]?.fn === fn) delete registered[name];
      },
    };
  }
  const fire = (name, details) => registered[name].fn(details);
  return { api, registered, fire };
}

function timeline() {
  const events = [];
  const pushEvent = (e) => {
    const full = { id: events.length + 1, rel: 0, ...e };
    events.push(full);
    return full;
  };
  return { events, pushEvent };
}

const H = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));

test("headersToObject lowercases names, joins repeats, skips binary-only headers", () => {
  expect(headersToObject([{ name: "Accept", value: "a" }, { name: "Set-Cookie", value: "x=1" }, { name: "set-cookie", value: "y=2" }, { name: "X-Bin", binaryValue: [1] }])).toEqual({
    accept: "a",
    "set-cookie": "x=1, y=2",
  });
  expect(headersToObject(undefined)).toEqual({});
});

test("registers scoped to the tab, opts into headers only where needed, and passes no undefined arguments", () => {
  // Disconfirming: pass EXTRA[name] unconditionally → the fake (like Firefox) throws
  // "Incorrect argument types" for the events that need no extraInfoSpec.
  const { api, registered } = fakeWebRequest();
  const net = createWebRequestNetwork({ api, pushEvent: timeline().pushEvent });
  net.start(7);
  expect(Object.keys(registered).sort()).toEqual(["onBeforeRedirect", "onBeforeRequest", "onCompleted", "onErrorOccurred", "onHeadersReceived", "onSendHeaders"]);
  for (const r of Object.values(registered)) expect(r.filter).toEqual({ urls: ["<all_urls>"], tabId: 7 });
  expect(registered.onSendHeaders.extra).toEqual(["requestHeaders"]);
  expect(registered.onHeadersReceived.extra).toEqual(["responseHeaders"]);
  expect(registered.onCompleted.extra).toBeUndefined();
  // starting again does not double-register; stopping removes everything
  net.start(7);
  net.stop();
  expect(registered).toEqual({});
});

test("a load becomes one network event with status, headers, mime, timing and size", () => {
  const { api, fire } = fakeWebRequest();
  const { events, pushEvent } = timeline();
  createWebRequestNetwork({ api, pushEvent }).start(1);
  fire("onBeforeRequest", { requestId: "9", url: "https://x.test/logo.png", method: "GET", type: "image", timeStamp: 1000 });
  fire("onSendHeaders", { requestId: "9", requestHeaders: H({ Accept: "image/*", "User-Agent": "Firefox" }) });
  fire("onHeadersReceived", { requestId: "9", statusCode: 200, statusLine: "HTTP/2 200 OK", ip: "1.2.3.4", fromCache: false, responseHeaders: H({ "Content-Type": "image/png; charset=x", "Content-Length": "512" }) });
  fire("onCompleted", { requestId: "9", statusCode: 200, statusLine: "HTTP/2 200 OK", timeStamp: 1042 });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ t: 1000, kind: "network", title: "GET https://x.test/logo.png" });
  expect(events[0].detail).toMatchObject({
    requestId: "wr-9",
    method: "GET",
    resourceType: "image",
    requestHeaders: { accept: "image/*", "user-agent": "Firefox" },
    status: 200,
    statusText: "OK",
    mimeType: "image/png",
    responseHeaders: { "content-type": "image/png; charset=x", "content-length": "512" },
    remoteAddress: "1.2.3.4",
    fromCache: false,
    durationMs: 42,
    encodedBytes: 512,
    failed: false,
    requestBody: null,
  });
  expect("responseBody" in events[0].detail).toBe(false); // no bodies: the documented limit
});

test("fetch/XHR are left to the page probe so nothing is listed twice", () => {
  // Disconfirming: delete the HANDLED_BY_PROBE check in onBeforeRequest.
  const { api, fire } = fakeWebRequest();
  const { events, pushEvent } = timeline();
  createWebRequestNetwork({ api, pushEvent }).start(1);
  fire("onBeforeRequest", { requestId: "1", url: "https://x.test/api", method: "POST", type: "xmlhttprequest", timeStamp: 1 });
  fire("onCompleted", { requestId: "1", statusCode: 200, timeStamp: 2 });
  expect(events).toEqual([]);
});

test("a redirect closes the first event; the target reuses the requestId and gets its own", () => {
  const { api, fire } = fakeWebRequest();
  const { events, pushEvent } = timeline();
  createWebRequestNetwork({ api, pushEvent }).start(1);
  fire("onBeforeRequest", { requestId: "3", url: "http://x.test/old", method: "GET", type: "main_frame", timeStamp: 100 });
  fire("onHeadersReceived", { requestId: "3", statusCode: 301, statusLine: "HTTP/1.1 301 Moved", responseHeaders: H({ Location: "https://x.test/new" }) });
  fire("onBeforeRedirect", { requestId: "3", redirectUrl: "https://x.test/new", statusCode: 301, timeStamp: 110 });
  fire("onBeforeRequest", { requestId: "3", url: "https://x.test/new", method: "GET", type: "main_frame", timeStamp: 111 });
  fire("onHeadersReceived", { requestId: "3", statusCode: 200, statusLine: "HTTP/1.1 200 OK", responseHeaders: H({ "Content-Type": "text/html" }) });
  fire("onCompleted", { requestId: "3", statusCode: 200, timeStamp: 150 });
  expect(events.map((e) => [e.detail.url, e.detail.status, e.detail.durationMs])).toEqual([
    ["http://x.test/old", 301, 10],
    ["https://x.test/new", 200, 39],
  ]);
  expect(events[0].detail.redirectUrl).toBe("https://x.test/new");
});

test("a failed load is marked failed with Firefox's error text; an abort is a cancel", () => {
  const { api, fire } = fakeWebRequest();
  const { events, pushEvent } = timeline();
  createWebRequestNetwork({ api, pushEvent }).start(1);
  fire("onBeforeRequest", { requestId: "5", url: "http://x.test/a.png", method: "GET", type: "image", timeStamp: 10 });
  fire("onErrorOccurred", { requestId: "5", error: "NS_ERROR_CONNECTION_REFUSED", timeStamp: 15 });
  fire("onBeforeRequest", { requestId: "6", url: "http://x.test/b.png", method: "GET", type: "image", timeStamp: 20 });
  fire("onErrorOccurred", { requestId: "6", error: "NS_BINDING_ABORTED", timeStamp: 21 });
  expect(events[0]).toMatchObject({ title: "FAILED http://x.test/a.png", detail: { failed: true, errorText: "NS_ERROR_CONNECTION_REFUSED", canceled: false } });
  expect(events[1].detail).toMatchObject({ failed: true, canceled: true });
});

test("events for requests the lane never saw start are ignored", () => {
  const { api, fire } = fakeWebRequest();
  const { events, pushEvent } = timeline();
  createWebRequestNetwork({ api, pushEvent }).start(1);
  fire("onHeadersReceived", { requestId: "404", statusCode: 200, responseHeaders: [] });
  fire("onCompleted", { requestId: "404", statusCode: 200, timeStamp: 1 });
  fire("onErrorOccurred", { requestId: "404", error: "x", timeStamp: 1 });
  expect(events).toEqual([]);
});

test("if webRequest cannot be armed the lane still starts and says what is missing", async () => {
  // Disconfirming: drop the try/catch in createFirefoxLane.start — the throw
  // would leave background.js's session half-started (recording, no lane).
  globalThis.chrome = {
    webRequest: { onBeforeRequest: { addListener() { throw new Error("webRequest permission missing"); }, removeListener() {} } },
    scripting: { executeScript: async () => {} },
    tabs: { sendMessage: async () => ({ ok: true }) },
  };
  const { events, pushEvent } = timeline();
  const lane = createFirefoxLane({ session: {}, pushEvent, maybeErrorScreenshot() {}, tell: async () => ({ ok: true }) });
  expect(lane.name).toBe("firefox");
  await lane.start(1); // must not throw
  expect(events.find((e) => e.kind === "log")).toMatchObject({ level: "warning", title: expect.stringContaining("non-fetch/XHR loads unavailable"), detail: { message: expect.stringContaining("permission missing") } });
  await lane.stop(1);
  delete globalThis.chrome;
});
