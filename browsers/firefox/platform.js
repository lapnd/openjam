// Firefox platform adapter. The Firefox manifest loads this ahead of
// background.js (background.scripts: [platform.js, background.js]); it sets
// globalThis.openjamPlatform, which background.js consults where Chrome uses
// chrome.debugger, and fills in the chrome.offscreen calls background.js makes.
// Chrome never loads this file.
import { FIREFOX_LIMITS } from "./limits.js";
import { createFirefoxLane } from "./lane.js";
import { installOffscreenShim } from "./offscreen-shim.js";

installOffscreenShim();

globalThis.openjamPlatform = {
  name: "firefox",
  captureNotice: FIREFOX_LIMITS,
  createLane: createFirefoxLane,
};
