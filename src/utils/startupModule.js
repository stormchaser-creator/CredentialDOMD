// Only the lazy root app loader calls this. A failed preload can poison the
// document's module map on WebKit: importing the same URL again is not a new
// request. One fresh document can recover it, before any workspace is mounted.
const STARTUP_MODULE_RELOAD_KEY = 'credentialdomd-startup-module-reload';

export function recoverStartupModule(error, { storage, reload, online, build } = {}) {
  if (!online || error?.name !== 'TypeError' || !/^(Importing a module script failed\.?|Failed to fetch dynamically imported module(?::.*)?|error loading dynamically imported module(?::.*)?)$/i.test(String(error.message || ''))) return false;
  const key = STARTUP_MODULE_RELOAD_KEY;
  // If the loop guard cannot be persisted, keep the existing manual Reload.
  try {
    if (!build || storage.getItem(key) === build) return false;
    storage.setItem(key, build);
    if (storage.getItem(key) !== build) return false;
  } catch { return false; }
  try { reload(); return true; } catch { return false; }
}

// How long the root loader keeps Suspense after asking for that reload. The
// reload is a network-first navigation (public/sw.js revalidates index.html),
// which on a slow phone connection outlasts a few seconds, and iOS Safari
// fires no beforeunload to say the page is going. Rejecting sooner showed the
// crash screen and reported the failure while the reload was still in flight
// (ticket c39ed1e5). Still bounded: a host that refuses the reload reaches
// the error screen and its Reload button.
export const STARTUP_RELOAD_WAIT_MS = 30000;

export function waitForStartupReload(error, { setTimer = setTimeout } = {}) {
  return new Promise((_, reject) => { setTimer(() => reject(error), STARTUP_RELOAD_WAIT_MS); });
}

// Called once the real App has mounted: reaching this render means the reload
// above worked and this build's chunk is good, so a later, unrelated failure
// in the same tab/build/session must still get its own retry instead of
// being thrown straight to the error screen. The storage wrapper used here
// only implements getItem/setItem, so the guard is lifted by overwriting it
// with a value that can never equal a build id, not by removing the key.
export function clearStartupModuleGuard(storage, build) {
  try {
    if (!build || storage.getItem(STARTUP_MODULE_RELOAD_KEY) !== build) return;
    storage.setItem(STARTUP_MODULE_RELOAD_KEY, '');
  } catch { /* nothing to lift */ }
}
