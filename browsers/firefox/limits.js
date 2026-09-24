// What the Firefox build can and cannot capture, in one place: the popup shows
// it before Start, the background pushes it onto the timeline at the top of
// every report, and README's table says the same thing. Firefox has no
// chrome.debugger (no CDP), so everything below is what its page-level and
// webRequest APIs actually give.
export const FIREFOX_LIMITS =
  "Recording in Firefox mode (no Chrome debugger). Captured: session replay, console, errors, fetch/XHR with bodies, " +
  "other loads (status, headers, timing), viewport screenshots. Not captured: bodies of other loads, browser-internal " +
  "logs, iframe consoles, full-page or background-tab screenshots, anything before Start.";

// Firefox treats an MV3 extension's host permissions as something the user can
// switch off (about:addons → OpenJam → Permissions). Without them Firefox hides
// tab URLs from the extension, so every page looks unrecordable.
export const FIREFOX_ACCESS_NOTICE =
  "OpenJam does not have access to websites yet, so it cannot record any page. Allow access to all sites " +
  "(or turn it on under Permissions for OpenJam in about:addons). Nothing leaves your machine either way.";
