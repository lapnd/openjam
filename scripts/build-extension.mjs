// Assembles one browser's installable extension: a directory to load unpacked
// plus the ZIP of exactly that directory.
//
//   node scripts/build-extension.mjs chrome|firefox   (run `npm run build` first)
//
// Output goes to build/<browser>/ and build/openjam-<browser>.zip; each target
// owns its own directory, so the two never mix, and the repo's manifest.json is
// only ever read. The shared file list is the one the `package` npm script
// already zips for the Chrome release, so a file added upstream ships in both
// browsers without touching this script. Firefox overlays browsers/firefox/
// on top: its own manifest.json (version taken from the root manifest), the
// adapter code the manifest loads, and a popup.html with the adapter's notice
// script added.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackageDir } from "./verify-package.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["chrome", "firefox"];
// In the `package` list but referenced by no shipped file: a pure module that
// only test/audio-sync.test.js imports. Left out so the packages carry only what
// the extension loads; verify-package fails on any other unreachable file.
const NOT_SHIPPED = ["audio-sync.js"];

// The zip arguments of `npm run package`: files and directories at the repo root.
export function sharedFileList(root = ROOT) {
  const script = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.package;
  const marker = "openjam.zip";
  return script.slice(script.indexOf(marker) + marker.length).trim().split(/\s+/).filter(Boolean);
}

function copyEntry(root, outDir, entry) {
  const from = join(root, entry);
  if (!existsSync(from)) throw new Error(`${entry} is missing — run \`npm run build\` first (bundles in dist/ and src/generated/ are build output)`);
  mkdirSync(dirname(join(outDir, entry)), { recursive: true });
  cpSync(from, join(outDir, entry), { recursive: true });
}

// Directory overlay: everything under browsers/<target>/ except its manifest and
// test-only material ships at the same relative path.
function overlayFiles(root, target) {
  const base = join(root, "browsers", target);
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name !== "manifest.json") out.push(p.slice(root.length + 1));
    }
  };
  if (existsSync(base)) walk(base);
  return out;
}

const POPUP_HOOK = '  <script type="module" src="browsers/firefox/popup.js"></script>\n';

export function buildExtension(target, { root = ROOT, outDir = join(root, "build", target), zipPath = join(root, "build", `openjam-${target}.zip`) } = {}) {
  if (!TARGETS.includes(target)) throw new Error(`unknown target "${target}" (expected ${TARGETS.join(" | ")})`);
  rmSync(outDir, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  mkdirSync(outDir, { recursive: true });

  const rootManifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const shared = sharedFileList(root).filter((e) => e !== "manifest.json" && !NOT_SHIPPED.includes(e));
  for (const entry of shared) copyEntry(root, outDir, entry);

  if (target === "chrome") {
    copyEntry(root, outDir, "manifest.json");
  } else {
    for (const f of overlayFiles(root, target)) copyEntry(root, outDir, f);
    const manifest = JSON.parse(readFileSync(join(root, "browsers", target, "manifest.json"), "utf8"));
    manifest.version = rootManifest.version; // one version, owned by the root manifest
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const popupPath = join(outDir, "popup.html");
    const popup = readFileSync(popupPath, "utf8");
    if (!popup.includes('src="popup.js"')) throw new Error("popup.html no longer loads popup.js; update POPUP_HOOK placement in scripts/build-extension.mjs");
    writeFileSync(popupPath, popup.replace(/(\s*<script type="module" src="popup\.js"><\/script>\n)/, "$1" + POPUP_HOOK));
  }

  const { problems, files } = verifyPackageDir(outDir);
  if (problems.length) throw new Error(`${target} package failed verification:\n  ` + problems.join("\n  "));

  mkdirSync(dirname(zipPath), { recursive: true });
  // -X: no extra file attributes; -r: recurse. manifest.json lands at the zip root.
  execFileSync("zip", ["-X", "-q", "-r", zipPath, "."], { cwd: outDir });
  return { outDir, zipPath, files };
}

if (import.meta.url === new URL(process.argv[1] || "", "file://").href) {
  const target = process.argv[2];
  try {
    const { outDir, zipPath, files } = buildExtension(target);
    console.log(`${target}: ${files.length} files -> ${outDir.replace(ROOT + "/", "")}/ and ${zipPath.replace(ROOT + "/", "")}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
