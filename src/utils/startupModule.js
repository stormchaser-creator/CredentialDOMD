// Only the lazy root app loader calls this. A failed preload can poison the
// document's module map on WebKit: importing the same URL again is not a new
// request. One fresh document can recover it, before any workspace is mounted.
export function recoverStartupModule(error, { storage, reload, online, build } = {}) {
  if (!online || error?.name !== 'TypeError' || !/^(Importing a module script failed\.?|Failed to fetch dynamically imported module(?::.*)?|error loading dynamically imported module(?::.*)?)$/i.test(String(error.message || ''))) return false;
  const key = 'credentialdomd-startup-module-reload';
  // If the loop guard cannot be persisted, keep the existing manual Reload.
  try {
    if (!build || storage.getItem(key) === build) return false;
    storage.setItem(key, build);
    if (storage.getItem(key) !== build) return false;
  } catch { return false; }
  try { reload(); return true; } catch { return false; }
}
