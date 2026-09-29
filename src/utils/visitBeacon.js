// First-party visit counter for the signed-out screen. Same contract as the website's
// beacon: a fixed path and the referrer, no cookies, no identifiers, no query string.
// track_pv already whitelists /app/*; the app simply never sent anything, so nobody could
// tell how many people who pressed "Create your account" actually arrived.
//
// Plain http://credentialdomd.com/app/ is switching itself to https (index.html), so it
// sends nothing; the https page counts the visit. That page's referrer is then the site's
// own http address, which says nothing about where the visitor came from, so it is sent
// as no referrer rather than credited to credentialdomd.com. The landing pages do the same.
const OWN_HTTP = /^http:\/\/credentialdomd\.com\//;

export function sendAuthVisit({ location = globalThis.location, referrer = globalThis.document?.referrer,
  beacon = globalThis.navigator?.sendBeacon?.bind(globalThis.navigator) } = {}) {
  try {
    if (!beacon || !location?.pathname?.startsWith("/app")) return false; // production path only, never dev
    if (location.protocol === "http:" && location.hostname === "credentialdomd.com") return false;
    const r = referrer && !OWN_HTTP.test(referrer) ? referrer : "";
    return beacon("/api/pv", JSON.stringify({ p: "/app/auth", r })) === true;
  } catch {
    return false;
  }
}
