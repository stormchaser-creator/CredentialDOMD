// Token acquisition can finish after navigation has begun. WebKit rejects a
// new cross-origin fetch at that point, even with correct CORS. Only explicitly
// identified background reads use this guard; an accepted write keeps its transport.
const LEAVE_WINDOW_MS = 10000;
const ABANDONED = "background_read_page_leaving";
let watchedWindow = null, leavingSince = null, pageHidden = false;

function watch() {
  const target = globalThis.window;
  if (!target?.addEventListener) return false;
  if (target === watchedWindow) return true;
  watchedWindow = target; leavingSince = null; pageHidden = false;
  target.addEventListener("beforeunload", () => { leavingSince = Date.now(); });
  target.addEventListener("pagehide", () => { pageHidden = true; });
  target.addEventListener("pageshow", () => { pageHidden = false; leavingSince = null; });
  return true;
}

export function canStartBackgroundRead(now = Date.now()) {
  if (!watch()) return true;
  return !pageHidden && !(leavingSince !== null && now - leavingSince >= 0 && now - leavingSince < LEAVE_WINDOW_MS);
}

export function backgroundReadAbandoned() {
  return Object.assign(new Error("Background read abandoned as the page leaves."), { name: "AbortError", code: ABANDONED });
}
export function isBackgroundReadAbandoned(error) {
  return error?.name === "AbortError" && error?.code === ABANDONED;
}

/** Supabase awaits its token before this boundary. Decline abandoned database reads and optional last-seen bookkeeping. */
export function guardPageLeaveReads(send) {
  canStartBackgroundRead(); // Watch before the SDK starts awaiting its token.
  return (input, init) => {
    let backgroundRead = false;
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input?.url, globalThis.location?.href);
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      backgroundRead = (["GET", "HEAD"].includes(method) && url.pathname.startsWith("/rest/v1/"))
        || (method === "POST" && url.pathname === "/rest/v1/rpc/touch_last_seen");
    } catch { /* Preserve the original transport's behavior for malformed input. */ }
    if (backgroundRead && !canStartBackgroundRead()) return Promise.reject(backgroundReadAbandoned());
    return send(input, init);
  };
}
