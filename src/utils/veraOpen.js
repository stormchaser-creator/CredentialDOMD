/**
 * Vera opens on a new chat (owner, 2026-11-17). The conversation that was on
 * screen is not lost: it is filed under Archived, where "Continue this chat" brings it
 * back. One exception: Vera's own "open record" card takes the physician to a
 * record and back, and that return keeps the conversation it came from, for
 * RETURN_WINDOW_MS.
 *
 * A second exception: iOS reloads a PWA that was in the background (back from
 * Mail, Photos or the share sheet), and the app reopens on the screen it was
 * on (App.jsx lastScreen). That is not the physician opening Vera: when the
 * page reopened straight into Vera and she was in use within ACTIVE_WINDOW_MS,
 * the conversation stays, so a packet still downloading or a question waiting
 * on the profession choice is not filed away mid-task.
 *
 * Both marks live in sessionStorage for this tab only. They are read when
 * Vera opens, never inside a render.
 */

export const VERA_RETURN_KEY = "credentialdomd-vera-return";
export const RETURN_WINDOW_MS = 15 * 60 * 1000;
export const VERA_ACTIVE_KEY = "credentialdomd-vera-active";
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

const session = () => { try { return globalThis.sessionStorage || null; } catch { return null; } };

/** Called just before Vera navigates to a record she opened. */
export function markVeraReturn(now = Date.now(), store = session()) {
  try { store?.setItem(VERA_RETURN_KEY, String(now + RETURN_WINDOW_MS)); } catch { /* unavailable */ }
}

/** Stamped whenever Vera's conversation is saved. */
export function markVeraActive(now = Date.now(), store = session()) {
  try { store?.setItem(VERA_ACTIVE_KEY, String(now)); } catch { /* unavailable */ }
}

/** True when this open should start a new chat. Reads only; see clearVeraReturn. */
export function opensFresh(now = Date.now(), store = session(), reopenedOnLoad = false) {
  try {
    const until = Number(store?.getItem(VERA_RETURN_KEY));
    if (Number.isFinite(until) && until > now) return false;
    const active = Number(store?.getItem(VERA_ACTIVE_KEY));
    if (reopenedOnLoad && Number.isFinite(active) && active > 0 && now - active < ACTIVE_WINDOW_MS) return false;
    return true;
  } catch { return true; }
}

export function clearVeraReturn(store = session()) {
  try { store?.removeItem(VERA_RETURN_KEY); } catch { /* unavailable */ }
}

/** The title an archived conversation is listed under: its first question. */
export function archiveTitle(list) {
  const first = (list || []).find(m => m?.role === "user" && String(m.text || "").trim());
  return String(first?.text || "Conversation").replace(/\s+/g, " ").slice(0, 60);
}

/**
 * The messages of `stored` not yet filed, so a copy of the old conversation
 * read later (another tab, a slow store) is archived too, never put back on
 * screen and never archived twice. `filed` is a Set of message ids; it is
 * updated with what is returned.
 */
export function unfiled(stored, filed) {
  const out = (Array.isArray(stored) ? stored : []).filter(m => m && m.id && !filed.has(m.id));
  for (const m of out) filed.add(m.id);
  return out;
}
