// Build-time service-worker precache stamping + verification.
//
// computePrecacheUrls: walks the Vite build manifest and returns the app
// shell as SW-relative URLs ("./assets/index-<hash>.js", ...). Only the
// static entry closure is included: entry chunks, their statically
// imported chunks, and their CSS. Lazy chunks (xlsx, docx, mammoth, the
// Anthropic SDK) are excluded on purpose: they are not needed to boot the
// app and are runtime-cached on first online use.
//
// verifyPrecache: independently re-reads dist/sw.js and the build manifest
// and THROWS (failing the build) if the stamped list has drifted from the
// emitted assets. It deliberately re-walks the manifest with its own logic
// instead of trusting computePrecacheUrls, so a wiring bug (marker not
// replaced, manifest disabled, stale sw.js) can never ship silently.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Static shell precached alongside the hashed assets. Relative to the SW's
// own location, so the same list works at /app/ (gh-pages) and / (preview).
export const SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
];

// The app itself (src/AuthGate.jsx loads it with a dynamic import, so the
// sign-in screen does not wait for it). It is the app shell all the same: an
// installed app opened offline needs it, so it is precached with the entry,
// with its static imports. Its own lazy chunks stay out, as above.
export const APP_SOURCE = "src/App.jsx";
// The manifest names the app's chunk by its source, or (when Rollup gives the
// chunk no single facade, as it does for this one) "_App-<hash>.js" with the
// name "App": it is the entry's dynamic import of that name.
export function appChunkKey(manifest) {
  if (manifest[APP_SOURCE]) return APP_SOURCE;
  const bySource = Object.keys(manifest).find((k) => manifest[k]?.src === APP_SOURCE);
  if (bySource) return bySource;
  const lazy = new Set(Object.values(manifest).filter((c) => c?.isEntry).flatMap((c) => c.dynamicImports ?? []));
  return [...lazy].find((k) => manifest[k]?.name === "App" && manifest[k]?.isDynamicEntry) ?? null;
}

/** Entry-closure walk: entry chunks + static imports + their CSS, and the app chunk's. */
export function computePrecacheUrls(manifest) {
  const files = new Set();
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) return;
    if (chunk.file && !chunk.file.endsWith(".map")) files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const imp of chunk.imports ?? []) visit(imp); // static imports only
  };
  for (const key of Object.keys(manifest)) {
    if (manifest[key].isEntry) visit(key);
  }
  const app = appChunkKey(manifest);
  if (app) visit(app);
  return [...SHELL_URLS, ...[...files].sort().map((f) => `./${f}`)];
}

// The PA and NP rule data's chunk (src/utils/appRules.js loads it with a
// dynamic import). Not in the entry closure, so never in PRECACHE_URLS: the
// service worker precaches it only on a device whose app has needed it
// (public/sw.js APP_RULES_URLS).
export const APP_RULES_SOURCE = "src/utils/appRulesData.js";

/** The rule chunk and its static imports, minus what the entry already precaches. */
export function computeAppRulesUrls(manifest) {
  const entry = new Set(computePrecacheUrls(manifest));
  const files = new Set();
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) return;
    if (chunk.file && !chunk.file.endsWith(".map")) files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const imp of chunk.imports ?? []) visit(imp);
  };
  if (manifest[APP_RULES_SOURCE]) visit(APP_RULES_SOURCE);
  return [...files].sort().map((f) => `./${f}`).filter((u) => !entry.has(u));
}

const PRECACHE_BLOCK_RE = /\/\* __PRECACHE_BEGIN__ \*\/[\s\S]*?\/\* __PRECACHE_END__ \*\//;
const APP_RULES_BLOCK_RE = /\/\* __APP_RULES_BEGIN__ \*\/[\s\S]*?\/\* __APP_RULES_END__ \*\//;

/** Replace the marker-delimited APP_RULES_URLS block in sw.js source. */
export function stampAppRules(swSource, urls) {
  if (!APP_RULES_BLOCK_RE.test(swSource)) {
    throw new Error("sw.js: __APP_RULES_BEGIN__/__APP_RULES_END__ markers not found, cannot stamp the rule chunk list");
  }
  return swSource.replace(APP_RULES_BLOCK_RE, `const APP_RULES_URLS = ${JSON.stringify(urls, null, 2)};`);
}

/** Replace the marker-delimited PRECACHE_URLS block in sw.js source. */
export function stampPrecache(swSource, urls) {
  if (!PRECACHE_BLOCK_RE.test(swSource)) {
    throw new Error("sw.js: __PRECACHE_BEGIN__/__PRECACHE_END__ markers not found, cannot stamp precache list");
  }
  const stamped = `const PRECACHE_URLS = ${JSON.stringify(urls, null, 2)};`;
  return swSource.replace(PRECACHE_BLOCK_RE, stamped);
}

/** Fail the build if dist/sw.js's stamped list drifted from the emitted build. */
export function verifyPrecache(distDir) {
  const swPath = resolve(distDir, "sw.js");
  const manifestPath = resolve(distDir, ".vite", "manifest.json");
  if (!existsSync(swPath)) throw new Error(`precache verify: ${swPath} missing`);
  if (!existsSync(manifestPath)) throw new Error("precache verify: build manifest missing. Is build.manifest enabled?");

  const sw = readFileSync(swPath, "utf8");
  if (sw.includes("__BUILD_ID__")) throw new Error("precache verify: dist/sw.js still contains __BUILD_ID__ (unstamped)");
  if (sw.includes("__PRECACHE_BEGIN__")) throw new Error("precache verify: dist/sw.js still contains precache markers (unstamped)");
  if (sw.includes("__APP_RULES_BEGIN__")) throw new Error("precache verify: dist/sw.js still contains the rule chunk markers (unstamped)");

  const m = sw.match(/const PRECACHE_URLS = (\[[\s\S]*?\]);/);
  if (!m) throw new Error("precache verify: could not locate PRECACHE_URLS in dist/sw.js");
  const stamped = new Set(JSON.parse(m[1]));

  // Independent re-walk of the manifest (do not reuse computePrecacheUrls).
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expected = new Set();
  const seen = new Set();
  const walk = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) return;
    if (chunk.file && !chunk.file.endsWith(".map")) expected.add(chunk.file);
    (chunk.css ?? []).forEach((c) => expected.add(c));
    (chunk.imports ?? []).forEach(walk);
  };
  Object.keys(manifest).forEach((k) => { if (manifest[k].isEntry) walk(k); });
  // The app chunk, loaded lazily by the entry, is shell too (APP_SOURCE).
  // Found independently of appChunkKey: by source, else the entry's dynamic
  // import named "App".
  const entryLazy = Object.values(manifest).filter((c) => c?.isEntry).flatMap((c) => c.dynamicImports ?? []);
  const appKey = manifest[APP_SOURCE] ? APP_SOURCE
    : Object.keys(manifest).find((k) => manifest[k]?.src === APP_SOURCE) ?? entryLazy.find((k) => manifest[k]?.name === "App");
  if (appKey) walk(appKey);

  const missing = [...expected].filter((f) => !stamped.has(`./${f}`));
  if (missing.length) {
    throw new Error(`precache verify: emitted entry assets missing from dist/sw.js precache list:\n  ${missing.join("\n  ")}`);
  }

  // Every stamped hashed asset must actually exist on disk (no stale entries).
  const stale = [...stamped]
    .filter((u) => u.startsWith("./assets/"))
    .filter((u) => !existsSync(resolve(distDir, u.slice(2))));
  if (stale.length) {
    throw new Error(`precache verify: precache list references files not present in dist:\n  ${stale.join("\n  ")}`);
  }

  for (const shell of ["./", "./index.html"]) {
    if (!stamped.has(shell)) throw new Error(`precache verify: shell URL ${shell} missing from precache list`);
  }

  // The PA and NP rule chunk: out of the entry closure (no MD or DO device
  // precaches it), and listed for the devices that need it.
  const rulesMatch = sw.match(/const APP_RULES_URLS = (\[[\s\S]*?\]);/);
  if (!rulesMatch) throw new Error("precache verify: could not locate APP_RULES_URLS in dist/sw.js");
  const rules = JSON.parse(rulesMatch[1]);
  const rulesChunk = manifest[APP_RULES_SOURCE];
  if (!rulesChunk || !rulesChunk.isDynamicEntry) throw new Error(`precache verify: ${APP_RULES_SOURCE} is not a chunk of its own (a static import put the PA and NP rule data back in the entry bundle)`);
  if (expected.has(rulesChunk.file)) throw new Error(`precache verify: the PA and NP rule chunk ${rulesChunk.file} is in the entry closure`);
  if (!rules.includes(`./${rulesChunk.file}`)) throw new Error(`precache verify: APP_RULES_URLS lacks the rule chunk ${rulesChunk.file}`);
  const missingRules = rules.filter((u) => !existsSync(resolve(distDir, u.slice(2))));
  if (missingRules.length) throw new Error(`precache verify: APP_RULES_URLS references files not present in dist:\n  ${missingRules.join("\n  ")}`);
  return { count: stamped.size, entryAssets: expected.size, appRules: rules.length };
}

/**
 * Fail the build if the app is back in the entry bundle (a static import of
 * App.jsx from main.jsx or AuthGate.jsx), so the sign-in screen would wait
 * for all of it again, or if its chunk is not precached with the entry.
 */
export function verifyAppSplit(distDir) {
  const manifest = JSON.parse(readFileSync(resolve(distDir, ".vite", "manifest.json"), "utf8"));
  const key = appChunkKey(manifest);
  if (!key || !manifest[key]?.isDynamicEntry) throw new Error("app split verify: the app is not a chunk of its own; the sign-in screen would wait for the whole app (src/AuthGate.jsx)");
  const sw = readFileSync(resolve(distDir, "sw.js"), "utf8");
  const m = sw.match(/const PRECACHE_URLS = (\[[\s\S]*?\]);/);
  if (!m || !JSON.parse(m[1]).includes(`./${manifest[key].file}`)) throw new Error(`app split verify: the app chunk ${manifest[key].file} is not precached; an installed app opened offline could not start`);
  return { app: manifest[key].file };
}
