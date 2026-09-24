# Firefox support

Part of the [OpenJam feature set](README.md).

## What it does

OpenJam runs in Firefox 140+ (developed and tested on 156.0.1) from its own build,
`build/firefox/` (`make build-firefox`), which shares every file with the Chrome build
except a manifest and a small adapter under `browsers/firefox/`.

Firefox has no Chrome DevTools Protocol: no `chrome.debugger`, so no `Network.*`,
`Runtime.*` or `Log.*` streams, and no `chrome.offscreen`. Setting a different manifest is not
enough, so the Firefox build records with what Firefox actually provides:

| Signal | Source in Firefox | Chrome (for comparison) |
|---|---|---|
| Console, uncaught errors, unhandled rejections | A page probe injected into the recorded tab only (the same probe [reduced mode](data-capture.md#when-chromes-debugger-is-unavailable-reduced-mode) uses), with two Firefox fixes: error messages keep their `Error: message` header, and Firefox's `fn@url:line:col` stacks are read | CDP `Runtime.*` |
| fetch / XHR | The probe: method, URL, status, response headers, text bodies < 100 KB | CDP `Network.*` |
| Every other load (documents, scripts, CSS, images, fonts, frames) | `webRequest` (non-blocking): status, request/response headers, timing, failures, redirects — **no bodies** | CDP `Network.*` with text bodies |
| Screenshots | `tabs.captureVisibleTab`: the visible tab's viewport | CDP `Page.captureScreenshot`, any tab |
| Session replay | rrweb, unchanged (MAIN-world content script) | same |
| Mic narration | `offscreen.html` hosted in a hidden iframe of the event page (`browsers/firefox/offscreen-shim.js`); Firefox's background page has a DOM, so no offscreen API is needed | offscreen document |
| Environment | the shared collector | same (no JS-heap `memory` in Firefox) |
| Browser-level log entries | not available | CDP `Log.entryAdded` |

Where Firefox differs, the build says so instead of implying parity: the popup lists what is and
is not captured before **Start**, the same text is the first row of every report's timeline,
and the viewer header reads `Capture: Firefox (no debugger: page-level capture)`
(`meta.capture` is `"firefox"`; see [AI manifest](ai-manifest.md)).

## What to expect / limitations

- **No response bodies for non-fetch/XHR loads.** Reading them needs a blocking
  `webRequest.filterResponseData` listener, a permission OpenJam does not ask for.
- **Top frame only** for `console`, `fetch` and XHR; workers are not seen either.
- **Forward-only, and a gap after navigation.** Nothing logged before Start is captured. After a
  navigation during a recording the probe is put into the new document a few milliseconds late,
  so output of scripts that run while the page loads is missed (its later `console` calls and
  requests are captured).
- **Website access can be switched off.** Firefox lets users turn an MV3 extension's host
  permissions off; without them no page is recordable. The popup shows a notice and an *Allow
  access to all sites* button.
- **Screenshots** are the visible tab's viewport, never full-page or another tab.
- **Suspension.** Firefox suspends an idle event page after 30 s; while recording, the background
  ticks an extension API every 20 s (shared with Chrome) so the session in its memory survives.
- **Unsigned.** Load it as a temporary add-on (`about:debugging`) or on Developer Edition /
  Nightly / ESR with `xpinstall.signatures.required` off. No signed build is published.
- **Not verified on Firefox:** the real (non-fake) microphone prompt and whether Firefox
  remembers the choice, versions other than 156.0.1, Firefox for Android, Linux/Windows Firefox,
  the toolbar-anchored popup panel (tested as a tab), the permission prompt behind *Allow
  access*, and signing / AMO distribution.

## Test data

- End to end, in real Firefox 156: `e2e-firefox/firefox.spec.mjs` (fixture `e2e-firefox/fixture.html`,
  harness `e2e-firefox/harness.mjs`) — install, start/stop (message and the popup's own buttons),
  console/errors/fetch/XHR/webRequest rows, screenshots, replay to the final state, download and offline
  replay of the export, narration on Firefox's fake microphone, a 40 s idle recording, restricted pages,
  the no-website-access notice. Run: `make firefox-install && make test-firefox`.
- The lane: `test/firefox-lane.test.js` (webRequest → events, redirects, failures, Firefox's
  "no `undefined` arguments" rule); the offscreen shim: `test/offscreen-shim.test.js`;
  `background.js` with no debugger and an adapter: `test/background-firefox.test.js`;
  Firefox stack/error formats: `test/page-probe-serialize.test.js`.
- The packages: `test/build-extension.test.js` (both manifests, every referenced path, no missing
  bundle, no mixing) and `make verify`; `make lint-firefox` for Mozilla's `web-ext lint`.

## Related

- [Data capture](data-capture.md) — the Chrome/CDP sources and reduced mode
- [Session replay](session-replay.md) · [Screenshots](screenshots.md) · [Audio narration](audio-narration.md)
- [Privacy & data control](privacy.md) — Firefox adds `webRequest`, drops `debugger`/`offscreen`; nothing leaves the machine
