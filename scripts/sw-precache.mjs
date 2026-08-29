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

/** Entry-closure walk: entry chunks + static imports + their CSS. */
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
  return [...SHELL_URLS, ...[...files].sort().map((f) => `./${f}`)];
}

const PRECACHE_BLOCK_RE = /\/\* __PRECACHE_BEGIN__ \*\/[\s\S]*?\/\* __PRECACHE_END__ \*\//;

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
  return { count: stamped.size, entryAssets: expected.size };
}
