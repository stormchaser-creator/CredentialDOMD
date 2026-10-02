/**
 * What must be done synchronously before this page goes away, for a reload
 * the app itself asks for. The browser's own reload, a closed tab and iOS
 * discarding the app are met by pagehide and visibilitychange listeners
 * (AppContext); this is the same flush, run before location.reload() so it
 * never depends on those events firing. Nothing here waits: a flush puts
 * what it must keep in localStorage, which survives the page, and starts
 * whatever else in the background.
 */
const flushes = new Set();

/** Run `fn` before the app reloads the page. Returns the unregister. */
export function onPageLeave(fn) {
  if (typeof fn !== "function") return () => {};
  flushes.add(fn);
  return () => { flushes.delete(fn); };
}

/** Every registered flush, now. A flush that throws never stops the others. */
export function flushBeforeLeaving() {
  for (const fn of [...flushes]) {
    try { fn(); } catch { /* the next flush, and the reload, go on */ }
  }
}

/** Reload the page, after the flushes. */
export function reloadPage() {
  flushBeforeLeaving();
  try { (globalThis.window?.location || globalThis.location)?.reload(); } catch { /* the next launch */ }
}
