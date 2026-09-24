import { defineConfig } from "@playwright/test";

// Firefox suite (e2e-firefox/). Playwright is only the runner here: the browser
// is stock Firefox driven by puppeteer-core over WebDriver BiDi, because
// Playwright's own Firefox build cannot load extensions. See e2e-firefox/harness.mjs.
export default defineConfig({
  testDir: "e2e-firefox",
  workers: 1,
  timeout: 90_000,
  reporter: [["list"]],
});
