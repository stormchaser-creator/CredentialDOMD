// 20261002T2248-1afa4e5 is replaced at build time (see stampBuildId in vite.config.js).
// Because the id changes every deploy, this file's bytes change every deploy,
// which is what makes the browser fire `updatefound` and install the new SW.
const BUILD_ID = "20261002T2248-1afa4e5";
const CACHE_NAME = `credentialdomd-${BUILD_ID}`;

// All URLs are relative to the SW's own location so the same file works at
// any mount point (/app/ on gh-pages, / in local preview).
// At build time the block between the markers is REPLACED with the real
// emitted asset list (entry js chunks + css from the Vite build manifest,
// plus the shell below); see stampBuildId in vite.config.js and
// scripts/sw-precache.mjs. The list here is only the unstamped dev fallback.
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
  "./assets/index-CP-qQkFx.js",
  "./assets/index-Dy61Q32e.css"
];

// The PA and NP rule data's own chunk (src/utils/appRules.js), stamped at
// build time like the list above. Precached only on a device whose app has
// needed it: the page leaves APP_RULES_FLAG in Cache Storage the first time it
// loads the data, so a PA or NP opens offline after an update while an MD or
// DO device never downloads it.
const APP_RULES_URLS = [
  "./assets/appRulesData-CCPwlP85.js"
];
const FLAG_CACHE = "credentialdomd-flags";
const APP_RULES_FLAG = "./__app-rules-wanted";
async function wantsAppRules() {
  try { return !!(await (await caches.open(FLAG_CACHE)).match(APP_RULES_FLAG)); } catch { return false; }
}
// Puts this build's rule chunk in this build's cache, if it is not there.
// Best effort: a failure here never stops the update (the page loads the
// chunk itself when it needs it, online).
async function cacheAppRules() {
  if (!APP_RULES_URLS.length) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const missing = [];
    for (const u of APP_RULES_URLS) if (!(await cache.match(u))) missing.push(u);
    if (missing.length) await cache.addAll(missing.map((u) => new Request(u, { cache: "no-cache" })));
  } catch { /* fetched when needed */ }
}

// Install: precache shell (bypass the HTTP cache so we never precache staleness).
// skipWaiting → the new worker activates immediately (CallSync-style silent
// updates); the page reload is handled by UpdatePrompt.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: "no-cache" })));
      if (await wantsAppRules()) await cacheAppRules();
    })
  );
  self.skipWaiting();
});

// Activate: clean caches from previous builds. The invoice hand-off copy
// (credentialdomd-handoff-*, src/utils/invoiceHandoffStore.js) is the app's
// data, not a build's files: it stays, as does the device's flags cache
// (APP_RULES_FLAG above).
const KEEP_CACHE = /^credentialdomd-(handoff-|flags$)/;
self.addEventListener("activate", (event) => {
  const cleaned = caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE_NAME && !KEEP_CACHE.test(k)).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim());
  event.waitUntil(cleaned);
  // The flag can land between the install's look and now (the first launch
  // of this build loads the chunk through the old worker, into the old
  // build's cache this activation just deleted): looked at again once the
  // worker is active, never inside waitUntil. Until activation ends, every
  // request of the page waits for it, cross-origin ones included, and on a
  // weak network this fetch can take tens of seconds on an iPhone: the
  // account read and every save waited behind a best-effort cache warm-up
  // (review of f06d9276). Should the worker stop first, the page's
  // APP_RULES_WANTED (src/utils/appRules.js) and the fetch handler cache it.
  cleaned.then(async () => { if (await wantsAppRules()) await cacheAppRules(); }).catch(() => {});
});

// The UpdatePrompt UI posts this when the user accepts an update.
// APP_RULES_WANTED: a page of this build whose account needs the PA and NP
// rule data has it (src/utils/appRules.js rememberAppRulesOnDevice): this
// build's chunk goes in this build's cache now, whenever the flag was
// written, so the next launch opens offline. A page of another build is
// ignored (its chunk is not this worker's).
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data && event.data.type === "APP_RULES_WANTED" && event.data.build === BUILD_ID) {
    const done = cacheAppRules();
    if (typeof event.waitUntil === "function") event.waitUntil(done);
  }
});

// Only same-origin URLs inside the SW's own scope, matching known static
// shell paths, are ever cached. The cache never holds an API response, so
// it can never replay one user's data to another account on this device;
// user data lives solely in the per-Clerk-id localStorage namespace.
const SCOPE_PATH = new URL("./", self.location).pathname;
function isStaticAsset(rawUrl) {
  const url = new URL(rawUrl);
  if (url.origin !== self.location.origin) return false;
  if (!url.pathname.startsWith(SCOPE_PATH)) return false;
  const rel = url.pathname.slice(SCOPE_PATH.length);
  return (
    rel === "" ||
    rel === "index.html" ||
    rel === "manifest.json" ||
    rel.startsWith("assets/") ||
    rel.startsWith("icons/") ||
    rel.startsWith("fonts/")
  );
}

// Offline navigation fallback: the precached SPA shell from THIS build, so
// the HTML always matches the hashed assets in the same cache.
async function offlineShell() {
  const shell = (await caches.match("./index.html")) || (await caches.match("./"));
  return shell || new Response("Offline", { status: 503, statusText: "Offline" });
}

// Fetch: network-first for navigations, cache-first for hashed assets
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Skip non-GET and cross-origin API calls (don't cache these)
  if (request.method !== "GET") return;
  // A legacy root-scoped worker must not replace private access with the app
  // shell offline or cache recipient-facing resources.
  const requestUrl = new URL(request.url);
  if (requestUrl.origin === self.location.origin && /^\/credential-access(?:\/|\.html$|$)/.test(requestUrl.pathname)) {
    event.respondWith(fetch(request, { cache: "no-store" }).catch(() => new Response("Private credential access requires an internet connection.", {
      status: 503, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain", "Referrer-Policy": "no-referrer" },
    })));
    return;
  }
  if (request.url.includes("generativelanguage.googleapis.com")) return;
  if (request.url.includes("npiregistry.cms.hhs.gov")) return;
  if (request.url.includes("supabase.co")) return;
  if (request.url.includes("clerk")) return;

  // Update-detection endpoints must never be served from any cache.
  if (request.url.includes("version.json") || request.url.endsWith("/sw.js")) {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  // Navigation requests: network-first, revalidating past the HTTP cache
  // (GitHub Pages serves HTML with max-age=600 — "no-cache" forces an
  // ETag revalidation so a new deploy is picked up immediately). Offline,
  // fall back to the precached shell. Navigations are NOT written to the
  // cache: the shell comes exclusively from the install-time precache, so
  // URL variants (e.g. auth redirects with query tokens) never become
  // cache keys.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-cache" }).catch(offlineShell)
    );
    return;
  }

  // Everything that is not a known static shell asset goes straight to the
  // network, untouched and uncached.
  if (!isStaticAsset(request.url)) return;

  // Static assets (content-hashed filenames): cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
