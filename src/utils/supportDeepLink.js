// Where a support reply email lands in the app. send-ticket-reply links every
// reply to /app/#support/<ticket id> (ticketAppLink in
// supabase/functions/_shared/ticketReplyEmail.ts); emails sent before
// 2026-09-29 link to /app/#support. Both open the Support sheet on "Your
// tickets"; the first also opens that ticket when it is one of the member's.
const TICKET_LINK = /^#support\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// { ticketId } for a support link (ticketId null: the list only); null for
// any other hash.
export function supportDeepLink(hash) {
  if (hash === "#support") return { ticketId: null };
  const match = TICKET_LINK.exec(String(hash || ""));
  return match ? { ticketId: match[1].toLowerCase() } : null;
}

// Every hash an email links into the app: #support, #support/<ticket id>,
// #backups, #requests. App.jsx (AppInner) opens the place each one names.
export function isAppDeepLink(hash) {
  return !!supportDeepLink(hash) || hash === "#backups" || hash === "#requests";
}

// A member who opens an email link while signed out (on an iPhone, Mail opens
// Safari, which does not share the installed app's sign-in) meets Clerk's
// <SignIn routing="hash">. Clerk rewrites the hash (#/factor-one) and, once
// signed in, goes to /app/ with no hash, so the link would be lost before
// AppInner mounts. main.jsx therefore keeps the link in this tab's
// sessionStorage and gives Clerk a clean address; App takes it back, and
// keeps it there until its screen is on view (App.jsx).
const STASH_KEY = "credentialdomd.app_deep_link";
const STASH_MAX_AGE_MS = 60 * 60 * 1000;

function tabStorage() {
  try { return globalThis.window?.sessionStorage; }
  catch { return null; }
}

/** Call synchronously in main.jsx, before Clerk or the app mounts. */
export function captureAppDeepLink({
  location = globalThis.window?.location,
  history = globalThis.window?.history,
  storage = tabStorage(),
  now = Date.now(),
} = {}) {
  const hash = location?.hash || "";
  if (!isAppDeepLink(hash)) return null;
  try {
    if (!storage || !history?.replaceState) return null;
    storage.setItem(STASH_KEY, JSON.stringify({ hash, at: now }));
    history.replaceState(history.state, "", `${location.pathname}${location.search || ""}`);
    return hash;
  } catch {
    // Without storage the hash stays in the address, as it did before: a
    // signed-in visitor still lands on the place it names.
    try { storage?.removeItem(STASH_KEY); } catch { /* storage unavailable */ }
    return null;
  }
}

/**
 * Keep `hash` for this tab again, before a reload the app asks for (Reload on
 * a records load that failed, or on the identity screen). The link was taken
 * at mount (takeAppDeepLink), so without this a reload opened Home and the
 * ticket, request or backup the email named never opened (link audit,
 * 2026-10-01: a flaky network at launch on an iPhone). True when kept.
 */
export function stashAppDeepLink(hash, { storage = tabStorage(), now = Date.now() } = {}) {
  if (!isAppDeepLink(hash)) return false;
  try { storage.setItem(STASH_KEY, JSON.stringify({ hash, at: now })); return true; }
  catch { return false; }
}

/** Drop the link kept for this tab: its screen is on view. */
export function forgetAppDeepLink({ storage = tabStorage() } = {}) {
  try { storage?.removeItem(STASH_KEY); } catch { /* storage unavailable */ }
}

/** The link this tab was opened on, once; "" when there is none. */
export function takeAppDeepLink({
  location = globalThis.window?.location,
  history = globalThis.window?.history,
  storage = tabStorage(),
  now = Date.now(),
} = {}) {
  let stashed = "";
  try {
    const raw = storage?.getItem(STASH_KEY);
    storage?.removeItem(STASH_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && isAppDeepLink(saved.hash) && Number.isFinite(saved.at)
      && now - saved.at >= 0 && now - saved.at <= STASH_MAX_AGE_MS) stashed = saved.hash;
  } catch { /* storage unavailable or a damaged entry: no stashed link */ }
  const hash = location?.hash || "";
  if (isAppDeepLink(hash)) {
    try { history?.replaceState(history.state, "", `${location.pathname}${location.search || ""}`); }
    catch { /* the address keeps its hash; the link still opens */ }
    return hash;
  }
  return stashed;
}
