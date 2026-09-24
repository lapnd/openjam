// Verifies an unpacked extension directory: the manifest parses, every path it
// names exists, every local file an HTML page / JS module references exists,
// and nothing is shipped that no entry point reaches. Used by
// scripts/build-extension.mjs after each build and by test/build-extension.test.js.
//
// The walk is the same reference graph test/packaging.test.js follows for the
// Chrome release list (manifest -> HTML script/link -> JS import / getURL),
// plus the two runtime-load forms that test does not need: scripting
// `files: [...]` and `url: "x.html"` (chrome.offscreen).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, posix, relative, sep } from "node:path";

// Shipped for legal reasons, never referenced by code.
const ALWAYS_OK = new Set(["LICENSE", "manifest.json"]);

const stripQuery = (s) => s.replace(/[?#].*$/, "");
const matchAll = (src, re) => [...src.matchAll(re)].map((m) => m[1]);
const isLocal = (p) => !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(p);

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

export function manifestEntryPoints(manifest) {
  const entries = [];
  const bg = manifest.background || {};
  if (bg.service_worker) entries.push(bg.service_worker);
  entries.push(...(bg.scripts || []));
  if (bg.page) entries.push(bg.page);
  for (const cs of manifest.content_scripts || []) entries.push(...(cs.js || []), ...(cs.css || []));
  const action = manifest.action || manifest.browser_action || {};
  if (action.default_popup) entries.push(action.default_popup);
  for (const icons of [manifest.icons, action.default_icon]) {
    if (icons && typeof icons === "object") entries.push(...Object.values(icons));
    else if (typeof icons === "string") entries.push(icons);
  }
  if (manifest.options_ui && manifest.options_ui.page) entries.push(manifest.options_ui.page);
  for (const war of manifest.web_accessible_resources || []) {
    entries.push(...(Array.isArray(war) ? [war] : war.resources || []).filter((r) => !r.includes("*")));
  }
  return entries;
}

// Returns { problems: string[], files: string[], reachable: string[] }.
export function verifyPackageDir(dir) {
  const problems = [];
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return { problems: ["manifest.json missing at package root"], files: [], reachable: [] };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { problems: ["manifest.json is not valid JSON: " + err.message], files: [], reachable: [] };
  }
  for (const key of ["manifest_version", "name", "version"]) {
    if (manifest[key] == null) problems.push(`manifest.json lacks "${key}"`);
  }

  const files = listFiles(dir);
  const reachable = new Set(["manifest.json"]);
  const queue = [];
  const want = (path, from) => {
    const p = posix.normalize(stripQuery(path).replace(/^\//, ""));
    if (!existsSync(join(dir, normalize(p)))) {
      problems.push(`${from} references ${p}, which is not in the package`);
      return;
    }
    if (!reachable.has(p)) {
      reachable.add(p);
      queue.push(p);
    }
  };

  for (const e of manifestEntryPoints(manifest)) want(e, "manifest.json");

  while (queue.length) {
    const file = queue.shift();
    // Bundles are self-contained; their minified bodies hold phantom specifiers.
    if (file.startsWith("dist/") || file.startsWith("src/generated/")) continue;
    if (!/\.(html|m?js)$/.test(file)) continue;
    const body = readFileSync(join(dir, normalize(file)), "utf8");
    const at = (ref) => posix.join(posix.dirname(file), ref);

    if (file.endsWith(".html")) {
      const refs = [...matchAll(body, /<script[^>]+src=["']([^"']+)["']/g), ...matchAll(body, /<link[^>]+href=["']([^"']+)["']/g)];
      for (const r of refs) if (isLocal(r)) want(at(r), file);
      continue;
    }
    // Relative imports resolve against the importing file; extension-root
    // strings (getURL, scripting files, offscreen url) against the package root.
    const imports = [...matchAll(body, /import\s+[^"']*from\s*["']([^"']+)["']/g), ...matchAll(body, /import\(\s*["']([^"']+)["']\s*\)/g), ...matchAll(body, /^\s*import\s*["']([^"']+)["']/gm)];
    for (const spec of imports) if (spec.startsWith("./") || spec.startsWith("../")) want(at(spec), file);
    const rootStrings = [
      ...matchAll(body, /getURL\(\s*["']([^"']+)["']/g),
      ...matchAll(body, /\burl:\s*["']([^"']+\.html)["']/g),
      ...[...body.matchAll(/\bfiles:\s*\[([^\]]*)\]/g)].flatMap((m) => matchAll(m[1], /["']([^"']+)["']/g)),
    ];
    for (const s of rootStrings) if (isLocal(s)) want(s, file);
  }

  for (const f of files) if (!reachable.has(f) && !ALWAYS_OK.has(f)) problems.push(`${f} is shipped but no entry point reaches it`);
  return { problems, files, reachable: [...reachable] };
}

// CLI: node scripts/verify-package.mjs <dir>...
if (import.meta.url === new URL(process.argv[1] || "", "file://").href) {
  let failed = false;
  for (const dir of process.argv.slice(2)) {
    const { problems, files } = verifyPackageDir(dir);
    if (problems.length) {
      failed = true;
      console.error(`FAIL ${dir}:\n  ` + problems.join("\n  "));
    } else console.log(`ok   ${dir} (${files.length} files, all manifest/page/module references resolve, nothing unreachable)`);
  }
  process.exit(failed ? 1 : 0);
}
