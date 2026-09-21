// First-party visit counter for the signed-out screen. Same contract as the website's
// beacon: a fixed path and the referrer, no cookies, no identifiers, no query string.
// track_pv already whitelists /app/*; the app simply never sent anything, so nobody could
// tell how many people who pressed "Create your account" actually arrived.
export function sendAuthVisit({ location = globalThis.location, referrer = globalThis.document?.referrer,
  beacon = globalThis.navigator?.sendBeacon?.bind(globalThis.navigator) } = {}) {
  try {
    if (!beacon || !location?.pathname?.startsWith("/app")) return false; // production path only, never dev
    return beacon("/api/pv", JSON.stringify({ p: "/app/auth", r: referrer || "" })) === true;
  } catch {
    return false;
  }
}
