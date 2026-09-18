// Published ONLY at /sw.js to retire an earlier root-scoped PWA worker.
// The current app keeps its separate /app/sw.js registration and offline cache.
// No fetch handler, cache deletion, client claiming or page reload is needed:
// after this replacement activates, requests use the browser's normal network.
const isLegacyRootRegistration =
  self.location.pathname === "/sw.js" &&
  self.registration.scope === new URL("/", self.location.href).href;

if (isLegacyRootRegistration) {
  self.addEventListener("install", (event) => {
    event.waitUntil(self.skipWaiting());
  });
  self.addEventListener("activate", (event) => {
    // Unregister this registration only; never enumerate or remove /app/.
    event.waitUntil(self.registration.unregister());
  });
}
