// browsers/firefox/offscreen-shim.js: chrome.offscreen for a browser whose
// background page has a DOM — the offscreen document is a hidden iframe of it.
import { test, expect } from "bun:test";
import { installOffscreenShim } from "../browsers/firefox/offscreen-shim.js";

function fakeDocument({ failLoad = false } = {}) {
  const frames = [];
  return {
    frames,
    body: { appendChild: (f) => { frames.push(f); queueMicrotask(() => f.fire(failLoad ? "error" : "load")); } },
    createElement: () => {
      const handlers = {};
      return {
        hidden: false,
        src: "",
        removed: false,
        addEventListener: (name, fn) => { handlers[name] = fn; },
        fire: (name) => handlers[name]?.(),
        remove() { this.removed = true; },
      };
    },
  };
}
const apiWith = (extra = {}) => ({ runtime: { getURL: (p) => "moz-extension://abc/" + p }, ...extra });

test("createDocument hosts the page in a hidden iframe and resolves once it has loaded", async () => {
  const api = apiWith();
  const doc = fakeDocument();
  installOffscreenShim(api, doc);
  expect(await api.offscreen.hasDocument()).toBe(false);
  await api.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "x" });
  expect(doc.frames).toHaveLength(1);
  expect(doc.frames[0]).toMatchObject({ src: "moz-extension://abc/offscreen.html", hidden: true });
  expect(await api.offscreen.hasDocument()).toBe(true);
});

test("one document at a time, like Chrome; closeDocument removes it, and closing none rejects", async () => {
  // background.js relies on both errors: a second create is guarded by hasDocument,
  // a close with nothing open is swallowed in a try/catch.
  const api = apiWith();
  const doc = fakeDocument();
  installOffscreenShim(api, doc);
  await expect(api.offscreen.closeDocument()).rejects.toThrow(/No current offscreen document/);
  await api.offscreen.createDocument({ url: "offscreen.html" });
  await expect(api.offscreen.createDocument({ url: "offscreen.html" })).rejects.toThrow(/single offscreen document/);
  await api.offscreen.closeDocument();
  expect(doc.frames[0].removed).toBe(true);
  expect(await api.offscreen.hasDocument()).toBe(false);
  await api.offscreen.createDocument({ url: "offscreen.html" }); // and it can be created again
  expect(doc.frames).toHaveLength(2);
});

test("a page that fails to load rejects createDocument instead of hanging", async () => {
  const api = apiWith();
  installOffscreenShim(api, fakeDocument({ failLoad: true }));
  await expect(api.offscreen.createDocument({ url: "offscreen.html" })).rejects.toThrow(/failed to load/);
  expect(await api.offscreen.hasDocument()).toBe(false); // and the dead frame does not block a retry
});

test("a browser that has chrome.offscreen keeps its own", () => {
  const own = { hasDocument() {} };
  const api = apiWith({ offscreen: own });
  installOffscreenShim(api, fakeDocument());
  expect(api.offscreen).toBe(own);
});
