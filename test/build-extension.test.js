// scripts/build-extension.mjs + scripts/verify-package.mjs: each browser's
// package is complete (every manifest/page/module path resolves, every build
// bundle present), carries only what the extension loads, keeps the browsers'
// outputs apart, and never touches the repo's manifest.json.
//
// Needs the bundles: `npm run build` first (npm test does).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtension, sharedFileList } from "../scripts/build-extension.mjs";
import { verifyPackageDir } from "../scripts/verify-package.mjs";

const ROOT = join(import.meta.dir, "..");
const out = mkdtempSync(join(tmpdir(), "openjam-build-"));
const rootManifestBefore = readFileSync(join(ROOT, "manifest.json"), "utf8");

const listing = (dir, base = dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listing(p, base) : [p.slice(base.length + 1)];
  });
const zipEntries = (zip) => execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter((l) => l && !l.endsWith("/")).sort();
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

let chrome, firefox;
afterAll(() => rmSync(out, { recursive: true, force: true }));
beforeAll(() => {
  chrome = buildExtension("chrome", { outDir: join(out, "chrome"), zipPath: join(out, "openjam-chrome.zip") });
  firefox = buildExtension("firefox", { outDir: join(out, "firefox"), zipPath: join(out, "openjam-firefox.zip") });
});

test("both packages verify: manifest parses, every referenced path exists, nothing unreachable is shipped", () => {
  expect(verifyPackageDir(chrome.outDir).problems).toEqual([]);
  expect(verifyPackageDir(firefox.outDir).problems).toEqual([]);
});

test("every bundle npm run build produced is in both packages", () => {
  // Disconfirming: add a file to dist/ that no shared-list entry covers, or drop `dist`
  // from the package script — this fails naming the missing bundle.
  const bundles = [...listing(join(ROOT, "dist")).map((f) => "dist/" + f), ...listing(join(ROOT, "src", "generated")).map((f) => "src/generated/" + f)];
  expect(bundles).toContain("dist/rrweb-recorder.js");
  expect(bundles).toContain("dist/rrweb-relay.js");
  expect(bundles).toContain("dist/page-probe.js");
  expect(bundles).toContain("dist/rrweb-replay.js");
  expect(bundles).toContain("src/generated/player-assets.js");
  for (const pkg of [chrome, firefox]) expect(bundles.filter((b) => !pkg.files.includes(b))).toEqual([]);
});

test("the verifier fails on a missing bundle, a dangling reference and a stray file", () => {
  // The guard must be able to fail, or the two tests above prove nothing.
  const broken = join(out, "broken");
  cpSync(firefox.outDir, broken, { recursive: true });
  rmSync(join(broken, "dist", "rrweb-relay.js")); // referenced by the manifest
  rmSync(join(broken, "src", "lanes", "cdp.js")); // imported by background.js
  writeFileSync(join(broken, "stray.js"), "// nothing loads me\n");
  const { problems } = verifyPackageDir(broken);
  expect(problems).toEqual(
    expect.arrayContaining([
      expect.stringContaining("dist/rrweb-relay.js, which is not in the package"),
      expect.stringContaining("src/lanes/cdp.js, which is not in the package"),
      expect.stringContaining("stray.js is shipped but no entry point reaches it"),
    ]),
  );
  rmSync(join(broken, "manifest.json"));
  expect(verifyPackageDir(broken).problems).toEqual(["manifest.json missing at package root"]);
});

test("the Chrome package is the release package: same files as `npm run package`, manifest untouched", () => {
  const listed = sharedFileList(ROOT);
  expect(listed).toContain("manifest.json");
  const expected = listed
    .flatMap((e) => (statSync(join(ROOT, e)).isDirectory() ? listing(join(ROOT, e)).map((f) => e + "/" + f) : [e]))
    .filter((f) => f !== "audio-sync.js") // test-only pure module nothing loads
    .sort();
  expect([...chrome.files].sort()).toEqual(expected);
  expect(readFileSync(join(chrome.outDir, "manifest.json"), "utf8")).toBe(rootManifestBefore);
  // and still the Chrome-only surface
  const m = manifestOf(chrome.outDir);
  expect(m.permissions).toEqual(expect.arrayContaining(["debugger", "offscreen"]));
  expect(m.background.service_worker).toBe("background.js");
  expect(chrome.files.some((f) => f.startsWith("browsers/"))).toBe(false);
});

test("the Firefox manifest asks for nothing Chrome-only and loads its adapter before background.js", () => {
  const m = manifestOf(firefox.outDir);
  expect(m.manifest_version).toBe(3);
  expect(m.permissions).not.toContain("debugger");
  expect(m.permissions).not.toContain("offscreen");
  expect(m.permissions).toEqual(expect.arrayContaining(["storage", "unlimitedStorage", "scripting", "webRequest"]));
  expect(m.background.service_worker).toBeUndefined();
  expect(m.background).toEqual({ scripts: ["browsers/firefox/platform.js", "background.js"], type: "module" });
  expect(m.browser_specific_settings.gecko).toMatchObject({ id: expect.stringMatching(/@/), strict_min_version: "140.0" }); // 128 added content_scripts "world"; 140 added data_collection_permissions
  expect(m.browser_specific_settings.gecko.data_collection_permissions).toEqual({ required: ["none"] });
});

test("the Firefox manifest tracks the root manifest: same version, content scripts, CSP, icons, action, text", () => {
  // Upstream edits manifest.json; this fails until browsers/firefox/manifest.json follows.
  const root = JSON.parse(rootManifestBefore);
  const ff = manifestOf(firefox.outDir);
  expect(ff.version).toBe(root.version);
  for (const key of ["name", "description", "host_permissions", "content_security_policy", "content_scripts", "icons", "action"]) {
    expect(ff[key]).toEqual(root[key]);
  }
  // every root permission is either shared or knowingly Chrome-only
  expect(root.permissions.filter((p) => !ff.permissions.includes(p)).sort()).toEqual(["debugger", "offscreen"]);
});

test("each ZIP holds exactly its directory, with manifest.json at the root", () => {
  for (const [pkg, zip] of [[chrome, "openjam-chrome.zip"], [firefox, "openjam-firefox.zip"]]) {
    const entries = zipEntries(join(out, zip));
    expect(entries).toContain("manifest.json");
    expect(entries).toEqual([...pkg.files].sort());
  }
});

test("the two outputs never mix: Firefox files only in the Firefox package, popup hook only there", () => {
  expect(firefox.files).toEqual(expect.arrayContaining(["browsers/firefox/platform.js", "browsers/firefox/lane.js", "browsers/firefox/popup.js"]));
  expect(firefox.files).not.toContain("browsers/firefox/manifest.json"); // it becomes the package's manifest.json, not a stray copy
  expect(readFileSync(join(firefox.outDir, "popup.html"), "utf8")).toContain('<script type="module" src="browsers/firefox/popup.js"></script>');
  expect(readFileSync(join(chrome.outDir, "popup.html"), "utf8")).toBe(readFileSync(join(ROOT, "popup.html"), "utf8"));
  expect(existsSync(join(chrome.outDir, "browsers"))).toBe(false);
});

test("building leaves the repo's manifest.json alone", () => {
  expect(readFileSync(join(ROOT, "manifest.json"), "utf8")).toBe(rootManifestBefore);
});
