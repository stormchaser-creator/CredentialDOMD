// 20260825T1753-e313a28 is replaced at build time (see stampBuildId in vite.config.js).
// Because the id changes every deploy, this file's bytes change every deploy,
// which is what makes the browser fire `updatefound` and install the new SW.
const BUILD_ID = "20260825T1753-e313a28";
const CACHE_NAME = `credentialdomd-${BUILD_ID}`;

// All URLs are relative to the SW's own location so the same file works at
// any mount point (/app/ on gh-pages, / in local preview).
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
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
  // ETag revalidation so a new deploy is picked up immediately).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-cache" })
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match("./")))
    );
    return;
  }

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
