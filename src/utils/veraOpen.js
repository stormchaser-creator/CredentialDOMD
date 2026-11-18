/**
 * Vera opens on a new chat (owner, 2026-11-17). The conversation that was on
 * screen is not lost: it is filed under Archived, where "Continue this chat"
 * brings it back.
 *
 * The decision is made once per VISIT, by App.jsx as the screen changes to
 * Vera (veraArrival below), never once per mount: anything that re-mounts
 * Vera mid-visit (a reload of the data, the access check, the offline screen)
 * keeps the conversation in use.
 *
 * A visit keeps the conversation in one case only, "reload": the page
 * reopened straight onto Vera (iOS reloading the app after Mail, Photos or
 * the share sheet; App.jsx lastScreen) and she was in use within
 * ACTIVE_WINDOW_MS. A packet still downloading or a question waiting on the
 * profession choice is then not filed away mid-task. Coming back to Vera
 * from anywhere else, her own record card included, is a new chat.
 * A question handed to Vera on arrival (Home search, Requests) always starts
 * a new chat, so it never goes out with an older conversation as history.
 *
 * The mark lives in sessionStorage for this tab only.
 */

export const VERA_ACTIVE_KEY = "credentialdomd-vera-active";
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

const session = () => { try { return globalThis.sessionStorage || null; } catch { return null; } };
const read = (store, key) => { try { return store?.getItem(key) ?? null; } catch { return null; } };
const write = (store, key, value) => { try { store?.setItem(key, value); } catch { /* unavailable */ } };

/** Stamped whenever Vera's conversation is saved. */
export function markVeraActive(now = Date.now(), store = session()) {
  write(store, VERA_ACTIVE_KEY, String(now));
}

/**
 * App.jsx calls this on every screen change. Returns the kind of a new Vera
 * visit ("open" | "reload"), or null when the screen is not a new arrival at
 * Vera. `first` is true for the screen the page opened on.
 */
export function veraArrival({ toVera, fromVera, first }, now = Date.now(), store = session()) {
  if (!toVera || fromVera) return null;
  if (!first) return "open";
  const active = Number(read(store, VERA_ACTIVE_KEY));
  return Number.isFinite(active) && active > 0 && now - active < ACTIVE_WINDOW_MS ? "reload" : "open";
}

/** The title an archived conversation is listed under: its first question. */
export function archiveTitle(list) {
  const first = (list || []).find(m => m?.role === "user" && String(m.text || "").trim());
  return String(first?.text || "Conversation").replace(/\s+/g, " ").slice(0, 60);
}

/**
 * The messages of `stored` not yet filed and not on screen, so a copy of the
 * old conversation read later (another tab, a slow store) is archived too,
 * never put back on screen and never archived twice. `filed` is a Set of
 * message ids; it is updated with what is returned. `onScreen` lists the ids
 * of the conversation in use, which is never filed from here.
 */
export function unfiled(stored, filed, onScreen = []) {
  const live = new Set(onScreen);
  const out = (Array.isArray(stored) ? stored : []).filter(m => m && m.id && !filed.has(m.id) && !live.has(m.id));
  for (const m of out) filed.add(m.id);
  return out;
}

/** Every message id already in an archive, so none is filed a second time. */
export function archivedIds(archives) {
  const ids = new Set();
  for (const a of Array.isArray(archives) ? archives : []) for (const m of a?.msgs || []) if (m?.id) ids.add(m.id);
  return ids;
}

/**
 * Whether this mount starts a new chat. A visit is decided once on this page:
 * a re-mount within the same visit keeps what is on screen.
 */
const decided = new Set();
export function decideVisit(visitId, kind, { seeded = false } = {}) {
  if (visitId != null && decided.has(visitId)) return false;
  if (visitId != null) decided.add(visitId);
  return seeded || kind !== "reload";
}
export function _resetVisits() { decided.clear(); }
