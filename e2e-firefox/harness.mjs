// Firefox extension-driving helpers for e2e-firefox/. Playwright's Firefox build
// cannot load extensions, so this drives stock Firefox over WebDriver BiDi with
// puppeteer-core: `browser.installExtension()` installs the unpacked build
// (build/firefox/, unmodified) as a temporary add-on, exactly like about:debugging.
//
// Two Firefox facts shape it:
//  - BiDi refuses to navigate to, or script, moz-extension:// pages unless Firefox
//    starts with --remote-allow-system-access. With it, the popup and viewer are
//    driven as real top-level extension pages with the full chrome.* API.
//  - A fixed extension UUID (extensions.webextensions.uuids) makes the
//    moz-extension:// origin known up front, so pages can be opened by URL.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { Browser, getInstalledBrowsers } from "@puppeteer/browsers";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FIREFOX_BUILD = path.join(ROOT, "build", "firefox");
const UUID = "5c2f1c5e-0a11-4d3b-8f00-0a0a0a0a0a0a";
const CACHE = path.join(ROOT, "node_modules", ".cache", "firefox");

// FIREFOX_PATH, else the copy `npm run firefox:install` downloaded, else null.
// The user's own Firefox is deliberately not a fallback: launching a system
// install can trigger its updater.
export async function findFirefox() {
  if (process.env.FIREFOX_PATH) return process.env.FIREFOX_PATH;
  const installed = (await getInstalledBrowsers({ cacheDir: CACHE })).filter((b) => b.browser === Browser.FIREFOX);
  return installed.length ? installed[installed.length - 1].executablePath : null;
}

export async function launchFirefox({ downloadDir, prefs = {} } = {}) {
  const executablePath = await findFirefox();
  if (!executablePath) throw new Error("no Firefox binary: run `npm run firefox:install` or set FIREFOX_PATH");
  const gecko = JSON.parse(readFileSync(path.join(FIREFOX_BUILD, "manifest.json"), "utf8")).browser_specific_settings.gecko.id;
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath,
    headless: !process.env.HEADFUL,
    args: ["--remote-allow-system-access"],
    defaultViewport: { width: 1280, height: 800 },
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({ [gecko]: UUID }),
      // Synthetic microphone, no permission prompt (the Firefox counterpart of
      // Chromium's --use-fake-device-for-media-stream / --use-fake-ui).
      "media.navigator.streams.fake": true,
      "media.navigator.permission.disabled": true,
      // Save downloads straight to downloadDir, no dialog.
      ...(downloadDir
        ? {
            "browser.download.folderList": 2,
            "browser.download.dir": downloadDir,
            "browser.download.useDownloadDir": true,
            "browser.helperApps.neverAsk.saveToDisk": "text/html",
          }
        : {}),
      ...prefs,
    },
  });
  const extensionId = await browser.installExtension(FIREFOX_BUILD);
  return { browser, extensionId, executablePath, version: await browser.version() };
}

// A privileged page never fires the load event puppeteer waits for, so goto
// "times out" even though the page is up: swallow that and wait on real content.
async function gotoExtensionPage(page, file) {
  await page.goto(`moz-extension://${UUID}/${file}`, { waitUntil: "domcontentloaded", timeout: 3000 }).catch(() => {});
}

// popup.html as a top-level tab: the control surface. It messages the background
// like the toolbar popup does, and its own buttons work (its tab is in the
// background, so `tabs.query({active})` resolves to the page under test).
export async function openPopup(browser) {
  const popup = await browser.newPage();
  await gotoExtensionPage(popup, "popup.html");
  await popup.waitForFunction(() => !!document.querySelector("openjam-popup")?.shadowRoot?.querySelector("button"));
  return popup;
}

// A background that never answers is a failure to name, not a hang to sit out.
export async function send(popup, msg, timeoutMs = 30000) {
  let timer;
  const silent = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`background did not answer ${JSON.stringify(msg)} within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([popup.evaluate((m) => chrome.runtime.sendMessage(m), msg), silent]);
  } finally {
    clearTimeout(timer);
  }
}

const bytes = (b64) => Buffer.from(b64, "base64");
const PIXEL = bytes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

// Fixture server: the page, its subresources, and a JSON API (one route fails).
export async function serveFixture() {
  // A port nothing listens on: Firefox blocks low "bad ports" before webRequest
  // sees them, so take a real free one and let it go.
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const closedPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const html = readFileSync(path.join(ROOT, "e2e-firefox", "fixture.html"), "utf8").replace("__REFUSED_URL__", `http://127.0.0.1:${closedPort}/refused.png`);
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    seen.push(url.pathname);
    const reply = (status, type, body, headers = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    switch (url.pathname) {
      case "/":
        return reply(200, "text/html", html);
      // A page whose CSP allows only same-origin external scripts: what a strict production site sends.
      case "/csp":
        return reply(200, "text/html", `<!doctype html><title>csp</title><button id="b">go</button><script src="/csp.js"></script>`, { "content-security-policy": "default-src 'self'; script-src 'self'" });
      case "/csp.js":
        return reply(200, "text/javascript", "document.getElementById('b').onclick = () => console.log('csp click');");
      case "/style.css":
        return reply(200, "text/css", "body{background:#fdf6e3}#counter{color:#dc322f}");
      case "/app.js":
        return reply(200, "text/javascript", "console.log('app.js loaded');");
      case "/pixel.png":
      case "/late.png":
        return reply(200, "image/png", PIXEL);
      case "/api/ok":
        return reply(200, "application/json", JSON.stringify({ ok: true, via: url.searchParams.get("via") }));
      case "/api/fail":
        return reply(500, "application/json", JSON.stringify({ error: "boom from /api/fail" }));
      default:
        return reply(404, "text/plain", "not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: origin + "/",
    seen,
    refusedUrl: `http://127.0.0.1:${closedPort}/refused.png`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// Stops the recording and resolves with the viewer page the background opens.
// (puppeteer keeps reporting about:blank as the URL of an extension tab, so the
// new tab is recognised by its real location.)
export async function stopAndOpenViewer(browser, popup) {
  const opened = new Promise((resolve) => {
    const onTarget = async (target) => {
      const page = await target.page();
      if (!page) return;
      browser.off("targetcreated", onTarget);
      resolve(page);
    };
    browser.on("targetcreated", onTarget);
  });
  const res = await send(popup, { action: "stop" });
  if (!res.ok) throw new Error("stop failed: " + JSON.stringify(res));
  const viewer = await opened;
  await viewer.waitForFunction(() => location.pathname.endsWith("/viewer.html") && document.querySelector("#app header"), { timeout: 20000 });
  return viewer;
}
