// 20260905T1906-7f54a8c is replaced at build time (see stampBuildId in vite.config.js).
// Because the id changes every deploy, this file's bytes change every deploy,
// which is what makes the browser fire `updatefound` and install the new SW.
const BUILD_ID = "20260905T1906-7f54a8c";
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
  "./assets/index-BS0u-agg.js",
  "./assets/index-vByWTNVZ.css"
];

// Install: precache shell (bypass the HTTP cache so we never precache staleness).
// skipWaiting → the new worker activates immediately (CallSync-style silent
// updates); the page reload is handled by UpdatePrompt.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: "no-cache" })))
    )
  );
  self.skipWaiting();
});

// Activate: clean caches from previous builds
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// The UpdatePrompt UI posts this when the user accepts an update.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
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
