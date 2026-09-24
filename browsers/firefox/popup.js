// Firefox-only popup additions, loaded after popup.js (scripts/build-extension.mjs
// adds the <script> tag to the Firefox copy of popup.html; Chrome's is untouched).
// Says up front what Firefox can and cannot capture, and offers the one
// permission step Firefox needs that Chrome does not: host access.
import { FIREFOX_LIMITS, FIREFOX_ACCESS_NOTICE } from "./limits.js";

const oj = document.getElementById("oj");
const ALL_SITES = { origins: ["<all_urls>"] };
const GRANT = "oj-grant-sites";

async function showNotice() {
  let granted = true;
  try {
    granted = await chrome.permissions.contains(ALL_SITES);
  } catch {
    // no permissions API: assume access, show the limits
  }
  if (granted) oj.showWarning(FIREFOX_LIMITS);
  else oj.showWarning(FIREFOX_ACCESS_NOTICE, { actions: [{ label: "Allow access to all sites", id: GRANT }] });
}

// popup.js turns every oj-action into "open chrome://extensions" (the
// blocked-by-another-extension button), which means nothing here. Capture phase
// + stopImmediatePropagation keeps this click ours; chrome.permissions.request
// needs the user gesture, so it runs synchronously inside the click.
oj.addEventListener(
  "oj-action",
  (e) => {
    if (e.detail.id !== GRANT) return;
    e.stopImmediatePropagation();
    chrome.permissions.request(ALL_SITES).then(showNotice, showNotice);
  },
  { capture: true },
);

showNotice();
