// End-to-end suite for the Firefox build (build/firefox/), in real Firefox:
// install the unpacked extension, record the fixture, stop, open the report in
// the extension's viewer, export it and open the export offline.
//
//   npm run build && make build-firefox && npm run firefox:install && npm run test:firefox
//
// Each test names its disconfirming input (e2e/CLAUDE.md): the change that must
// turn it red. What the Firefox build cannot capture is asserted as absent too,
// so the limits README promises stay true.
import { test, expect } from "@playwright/test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findFirefox, launchFirefox, openPopup, serveFixture, send, stopAndOpenViewer } from "./harness.mjs";

test.describe.configure({ mode: "serial" }); // one browser; recordings are global state in the background page

const firefoxPath = await findFirefox();
// CI sets REQUIRE_FIREFOX so a missing browser fails the job instead of skipping the suite.
if (!firefoxPath && process.env.REQUIRE_FIREFOX) throw new Error("REQUIRE_FIREFOX is set but no Firefox was found (npm run firefox:install)");
test.skip(!firefoxPath, "no Firefox binary (npm run firefox:install, or set FIREFOX_PATH)");

let browser, popup, fixture, downloadDir;

test.beforeAll(async () => {
  downloadDir = mkdtempSync(path.join(tmpdir(), "openjam-fx-dl-"));
  ({ browser } = await launchFirefox({ downloadDir }));
  fixture = await serveFixture();
  popup = await openPopup(browser);
});

test.afterAll(async () => {
  await browser?.close();
  await fixture?.close();
  if (downloadDir) rmSync(downloadDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readReport = () =>
  popup.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const key = Object.keys(all).find((k) => k.startsWith("report-"));
    return key ? all[key] : null;
  });

// Opens the fixture in a fresh tab and makes it the active one, which is how
// the popup's Start (no tabId) picks what to record.
async function openFixture(url = fixture.url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.bringToFront();
  return page;
}

// Clicks through the fixture the way a bug reproduction would.
async function reproduce(page) {
  await page.click("#injectStyle");
  await page.type("#name", "Ada Lovelace");
  await page.type("#secret", "hunter2");
  for (let i = 0; i < 3; i++) await page.click("#inc");
  await page.click("#netBtn");
  await page.click("#errBtn");
  await page.waitForFunction(() => document.getElementById("counter").textContent === "3");
  await sleep(1500); // rrweb mutation batches and the request tail flush
}

async function record(actions = reproduce, { url } = {}) {
  const page = await openFixture(url);
  const started = await send(popup, { action: "start" }); // no tabId: the active tab, like the toolbar popup
  expect(started.ok, JSON.stringify(started)).toBe(true);
  await actions(page);
  const viewer = await stopAndOpenViewer(browser, popup);
  await page.close();
  return { viewer, started };
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);
const rowsOf = (page) => page.evaluate(() => [...document.querySelectorAll(".row")].map((r) => r.innerText.replace(/\s+/g, " ").trim()));

// The rrweb replay iframe is a sandboxed same-origin srcless iframe inside the
// page, which puppeteer does not list as a frame: reach into it through the DOM.
// (No eval here: the viewer's CSP forbids it.) Waits until the replayed
// document's `selector` element has `prop` equal to `expected`.
const inReplay = (page, selector, prop, expected) =>
  page.waitForFunction(
    (sel, p, want) => document.querySelector(".replayer-wrapper iframe")?.contentDocument?.querySelector(sel)?.[p] === want,
    { timeout: 20000 },
    selector,
    prop,
    expected,
  );

async function playToEnd(page) {
  await page.waitForSelector("#replay .replayer-wrapper, .replayer-wrapper");
  for (const label of ["8x", "Play"]) {
    await page.evaluate((text) => [...document.querySelectorAll(".oj-controls button")].find((b) => b.textContent.includes(text))?.click(), label);
  }
  await inReplay(page, "#counter", "textContent", "3"); // reached the final state
}

test("installs with no Chrome-only surface, and the popup states the Firefox limits", async () => {
  // The background page answering at all proves background.js evaluated without
  // touching chrome.debugger / chrome.offscreen at startup.
  // Disconfirming: drop the `if (chrome.debugger)` guards in background.js — the
  // page throws at load, nothing answers getStatus, and this test times out.
  expect(await send(popup, { action: "getStatus" })).toEqual({ recording: false, eventCount: 0, tabId: null, capture: null });

  const manifest = await popup.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).not.toContain("debugger");
  expect(manifest.permissions).not.toContain("offscreen");
  expect(manifest.background.service_worker).toBeFalsy();
  expect(manifest.background.scripts.map((u) => u.replace(/^moz-extension:\/\/[^/]+\//, ""))).toEqual(["browsers/firefox/platform.js", "background.js"]);

  const shown = await popup.evaluate(() => document.querySelector("openjam-popup").shadowRoot.textContent);
  expect(shown).toContain("Firefox mode (no Chrome debugger)");
  expect(shown).toContain("Not captured: bodies of other loads");
});

test("records console, errors, network and screenshots onto one timeline", async () => {
  const { viewer } = await record();
  const rows = await rowsOf(viewer);
  const has = (re) => rows.some((r) => re.test(r));

  // what the user sees
  expect(has(/CONSOLE counter is now 3/)).toBe(true);
  expect(has(/ERROR .*firefox fixture error/)).toBe(true);
  expect(has(/NETWORK 200 GET .*\/api\/ok/)).toBe(true);
  expect(has(/NETWORK 500 GET .*\/api\/fail/)).toBe(true);
  expect(has(/NETWORK 404 GET .*\/missing\.png/)).toBe(true);
  expect(has(/NETWORK ERR GET .*\/refused\.png/)).toBe(true);
  expect(rows.filter((r) => /SCREENSHOT/.test(r)).length).toBeGreaterThanOrEqual(3); // start, on error, stop
  expect(await bodyText(viewer)).toContain("Firefox (no debugger: page-level capture)");
  // …and the limits are the first thing on the timeline
  expect(rows[0]).toMatch(/LOG .*Firefox mode \(no Chrome debugger\)/);

  const report = await readReport();
  expect(report.meta.capture).toBe("firefox");
  expect(report.device.userAgent).toContain("Firefox");
  const net = report.events.filter((e) => e.kind === "network");
  const byUrl = (part) => net.filter((e) => e.detail.url.includes(part));

  // fetch/XHR come from the page probe, with bodies, and are listed exactly once
  // (webRequest also sees them; the lane must skip them).
  // Disconfirming: drop the `xmlhttprequest` skip in browsers/firefox/lane.js → length 2.
  expect(byUrl("/api/fail")).toHaveLength(1);
  expect(byUrl("/api/fail")[0].detail).toMatchObject({ status: 500, responseBody: expect.stringContaining("boom from /api/fail") });
  expect(byUrl("via=xhr")[0].detail).toMatchObject({ status: 200, responseBody: expect.stringContaining('"via":"xhr"') });

  // plain loads come from webRequest: status, headers, timing — and no body
  const late = byUrl("/late.png")[0].detail;
  expect(late).toMatchObject({ method: "GET", resourceType: "image", status: 200, mimeType: "image/png", failed: false });
  expect(late.requestHeaders["user-agent"]).toContain("Firefox");
  expect(late.responseHeaders["content-type"]).toBe("image/png");
  expect(late.durationMs).toBeGreaterThanOrEqual(0);
  expect(late.responseBody).toBeUndefined(); // the documented limit
  expect(byUrl("/missing.png")[0].detail.status).toBe(404);
  expect(byUrl("/refused.png")[0].detail).toMatchObject({ failed: true, errorText: expect.stringMatching(/NS_ERROR/) });

  // screenshots are real PNGs of the viewport
  const shots = report.events.filter((e) => e.kind === "screenshot");
  expect(shots.every((s) => s.detail.image?.startsWith("data:image/png;base64,"))).toBe(true);
  await viewer.close();
});

test("a navigation mid-recording keeps capturing: document, css, js and image loads, probe and recorder resume", async () => {
  // Loads only webRequest can see, on a page that starts loading after Start.
  // Disconfirming: make onBeforeRequest ignore everything but xhr (no main_frame/
  // stylesheet/script/image rows), or drop pageHello's probe re-injection (then
  // "counter is now 1" is missing after the reload).
  const { viewer } = await record(async (page) => {
    await page.reload({ waitUntil: "load" });
    await page.click("#inc");
    await sleep(1500);
  });
  const report = await readReport();
  const load = (part) => report.events.find((e) => e.kind === "network" && e.detail.url.endsWith(part))?.detail;
  expect(load("/")).toMatchObject({ method: "GET", resourceType: "main_frame", status: 200, mimeType: "text/html" });
  expect(load("/style.css")).toMatchObject({ resourceType: "stylesheet", status: 200, mimeType: "text/css" });
  expect(load("/app.js")).toMatchObject({ resourceType: "script", status: 200 });
  expect(load("/pixel.png")).toMatchObject({ resourceType: "image", status: 200, mimeType: "image/png" });
  const logs = report.events.filter((e) => e.kind === "console").map((e) => e.title);
  // Logged by the reloaded page after the probe was put back: it was re-armed.
  // (Output of scripts that run while the new document loads, like app.js's
  // "app.js loaded", predates the probe and is a documented Firefox limit.)
  expect(logs).toContain("counter is now 1");
  await viewer.close();
});

test("a page with a strict CSP is still recorded (probe and recorder are not blocked by it)", async () => {
  // Many real sites send `script-src 'self'`. Extension-injected MAIN-world scripts
  // must run regardless, or console/replay silently vanish on exactly those sites.
  // Disconfirming: keep the probe from running (drop the injectProbe call in
  // src/lanes/inject.js start) — the console row is missing and this fails.
  const { viewer } = await record(async (page) => {
    await page.click("#b");
    await sleep(1500);
  }, { url: fixture.origin + "/csp" });
  expect((await rowsOf(viewer)).some((r) => /CONSOLE csp click/.test(r))).toBe(true);
  const report = await readReport();
  expect(JSON.parse(report.rrwebEvents).length).toBeGreaterThan(2); // full snapshot + more: the recorder ran
  await viewer.close();
});

test("session replay plays back to the final state in the in-extension viewer, password masked", async () => {
  // Disconfirming: point the rrweb-recorder content script at the isolated world
  // (drop "world": "MAIN") and the replay never reaches counter=3 / the runtime style.
  const { viewer } = await record();
  await playToEnd(viewer);
  await inReplay(viewer, "#name", "value", "Ada Lovelace");
  // A rule the page inserted through the CSSOM replays too. Only the MAIN-world
  // recorder sees insertRule.
  await viewer.waitForFunction(() => {
    const el = document.querySelector(".replayer-wrapper iframe")?.contentDocument?.getElementById("cssinjs");
    return el && el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor === "rgb(42, 161, 152)";
  }, { timeout: 20000 });
  const secret = await viewer.evaluate(() => document.querySelector(".replayer-wrapper iframe").contentDocument.getElementById("secret").value);
  expect(secret).not.toContain("hunter2"); // rrweb masks passwords
  await viewer.close();
});

test("the exported HTML downloads, is self-contained, and replays offline", async () => {
  // The fixture server is closed before the export is opened, so a file that
  // needed the network (a remote script, the recorded page's own assets) would fail.
  // Disconfirming: have report-builder.js reference a remote script/stylesheet —
  // the "no remote code" assertion fails; or drop the inlined replay engine — the
  // replay never reaches counter=3.
  const { viewer } = await record();
  const before = new Set(readdirSync(downloadDir));
  await viewer.evaluate(() => document.getElementById("download").click());
  let file;
  for (let i = 0; i < 50 && !file; i++) {
    await sleep(200);
    file = readdirSync(downloadDir).find((f) => !before.has(f) && f.endsWith(".html"));
  }
  expect(file, "no downloaded export in " + downloadDir).toBeTruthy();
  const html = readFileSync(path.join(downloadDir, file), "utf8");
  expect(html).not.toMatch(/<script[^>]+src=["']https?:/); // no remote code
  await viewer.close();

  await fixture.close(); // fully offline from here
  const offline = await browser.newPage();
  try {
    await offline.goto("file://" + path.join(downloadDir, file), { waitUntil: "domcontentloaded" });
    await offline.waitForSelector(".row");
    const rows = await rowsOf(offline);
    expect(rows.some((r) => /counter is now 3/.test(r))).toBe(true);
    expect(await bodyText(offline)).toContain("Firefox (no debugger: page-level capture)");
    await playToEnd(offline); // waits for counter=3 inside the replayed page
  } finally {
    await offline.close();
    fixture = await serveFixture();
  }
});

test("the popup's own Start and Stop buttons record a session (popup.js unchanged on Firefox)", async () => {
  // The real toggle path: click -> popup.js -> chrome.tabs.query + runtime.sendMessage
  // -> background. The popup tab is in the background, so its tabs.query({active})
  // resolves to the fixture, which is what the toolbar popup does for the page in front.
  // Disconfirming: make popup.js's activeTabId() return undefined — Start then
  // fails on "Couldn't find the tab" (or records the wrong tab) and no recording starts.
  const page = await openFixture();
  const toggle = () => popup.evaluate(() => document.querySelector("openjam-popup").shadowRoot.querySelector("[data-act=toggle]").click());
  const label = () => popup.evaluate(() => document.querySelector("openjam-popup").shadowRoot.querySelector("[data-act=toggle] .t").textContent);
  // The popup refreshes once a second: after the previous test's recording it may still
  // show "Stop", which would satisfy the wait below before this click did anything.
  await popup.waitForFunction(() => document.querySelector("openjam-popup").shadowRoot.querySelector("[data-act=toggle] .t").textContent === "Start recording");
  await toggle();
  await popup.waitForFunction(() => document.querySelector("openjam-popup").shadowRoot.querySelector("[data-act=toggle] .t").textContent === "Stop & open report");
  expect(await send(popup, { action: "getStatus" })).toMatchObject({ recording: true, capture: "firefox" });
  // the start response's notice is what the popup shows while recording
  // (the popup's 1 s poll can flip the button before the start response lands, so wait for it)
  await popup.waitForFunction(() => document.querySelector("openjam-popup").shadowRoot.textContent.includes("Firefox mode (no Chrome debugger)"));
  await page.click("#inc");
  await sleep(800);
  const opened = new Promise((resolve) => {
    const onTarget = async (target) => {
      const p = await target.page();
      if (p) {
        browser.off("targetcreated", onTarget);
        resolve(p);
      }
    };
    browser.on("targetcreated", onTarget);
  });
  await toggle(); // Stop & open report
  const viewer = await opened;
  await viewer.waitForFunction(() => location.pathname.endsWith("/viewer.html") && document.querySelector("#app header"), { timeout: 20000 });
  expect((await rowsOf(viewer)).some((r) => /counter is now 1/.test(r))).toBe(true);
  // a successful Stop closes the popup (popup.js: window.close()); reopen it for a fresh look
  popup = await openPopup(browser);
  expect(await send(popup, { action: "getStatus" })).toMatchObject({ recording: false });
  expect(await label()).toBe("Start recording");
  await viewer.close();
  await page.close();
});

test("narration: the mic is recorded through the background page and lands in the report", async () => {
  // Firefox has no chrome.offscreen; browsers/firefox/offscreen-shim.js hosts
  // offscreen.html in an iframe of the background page. Runs on Firefox's fake
  // microphone (media.navigator.streams.fake).
  // Disconfirming: delete installOffscreenShim() from platform.js — start logs
  // "Audio narration unavailable" and report.audio stays null.
  await popup.evaluate(() => chrome.storage.local.set({ audioSettings: { enabled: true, deviceId: null } }));
  try {
    const { viewer } = await record(async (page) => {
      await page.click("#inc");
      await sleep(2500); // give the recorder something to hold
    });
    const report = await readReport();
    expect(report.events.filter((e) => /Audio narration unavailable/.test(e.title)), "audio start failed").toEqual([]);
    expect(report.audio).toMatchObject({ dataUrl: expect.stringMatching(/^data:audio\//), durationMs: expect.any(Number) });
    expect(report.audio.durationMs).toBeGreaterThan(1500);
    expect(report.audio.dataUrl.length).toBeGreaterThan(1000); // real encoded audio, not an empty blob
    await viewer.waitForSelector("#replay .oj-waveform oj-waveform canvas");
    await viewer.close();
  } finally {
    await popup.evaluate(() => chrome.storage.local.remove("audioSettings"));
  }
});

test("a recording survives the event page's idle timeout (keep-alive)", async () => {
  // Firefox suspends an idle event page after 30 s, and the session lives in its
  // memory. On an idle page nothing else talks to the background, so only the
  // 20 s keep-alive tick holds it up.
  // Disconfirming: set KEEP_ALIVE_MS in background.js to 120_000 — after the wait
  // getStatus reports recording:false (a fresh page) and the events are gone.
  // The popup polls the background every second while it is open (popup.js), which
  // would itself keep the page awake — so it is closed for the idle stretch, as it is
  // for a user who clicked away.
  test.setTimeout(120_000);
  const page = await openFixture();
  expect((await send(popup, { action: "start" })).ok).toBe(true);
  await page.click("#inc"); // one event before the idle stretch
  await popup.close();
  await sleep(40_000); // longer than the 30 s default, on a page that emits nothing
  popup = await openPopup(browser);
  const status = await send(popup, { action: "getStatus" });
  expect(status).toMatchObject({ recording: true, capture: "firefox" });
  expect(status.eventCount).toBeGreaterThan(1);
  await page.click("#inc");
  await sleep(1000);
  const viewer = await stopAndOpenViewer(browser, popup);
  const rows = await rowsOf(viewer);
  expect(rows.some((r) => /counter is now 1/.test(r))).toBe(true);
  expect(rows.some((r) => /counter is now 2/.test(r))).toBe(true);
  await viewer.close();
  await page.close();
});

test("browser pages are refused with advice, and a failed start leaves nothing recording", async () => {
  // Disconfirming: drop the recordableTabError guard — the start would try to
  // inject into about:blank and report an opaque error (or wedge the session).
  const page = await browser.newPage(); // about:blank
  await page.bringToFront();
  const res = await send(popup, { action: "start" });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/only record normal web pages/);
  expect((await send(popup, { action: "getStatus" })).recording).toBe(false);
  await page.close();
});

test("without website access the popup says so and offers to grant it", async () => {
  // Firefox lets the user switch an MV3 extension's host permissions off. Then
  // every tab URL is hidden and OpenJam cannot record; the popup must say why.
  // Disconfirming: make showNotice() ignore chrome.permissions.contains().
  // Last in the file: re-granting needs a user gesture, so the browser is not reused after.
  await popup.evaluate(() => chrome.permissions.remove({ origins: ["<all_urls>"] }));
  await popup.reload({ waitUntil: "domcontentloaded", timeout: 3000 }).catch(() => {});
  await popup.waitForFunction(() => document.querySelector("openjam-popup")?.shadowRoot?.textContent.includes("does not have access to websites"));
  const buttons = await popup.evaluate(() => [...document.querySelector("openjam-popup").shadowRoot.querySelectorAll("button")].map((b) => b.textContent.trim()));
  expect(buttons).toContain("Allow access to all sites");
});
