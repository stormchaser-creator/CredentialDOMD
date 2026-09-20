const FRAGMENT_KEY = "launch_invite";
const STORAGE_KEY = "credentialdomd.launch_invitation";
export const isLaunchInvitationToken = token => typeof token === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(token);

function sessionStorage() {
  try { return globalThis.window?.sessionStorage; }
  catch { return null; }
}

/** Pending redemption survives Clerk sign-in in this tab; it grants no access. */
export function readLaunchInvitation({ storage = sessionStorage() } = {}) {
  try {
    const token = storage?.getItem(STORAGE_KEY);
    if (isLaunchInvitationToken(token)) return token;
    storage?.removeItem(STORAGE_KEY);
  } catch { /* Storage may be unavailable in private or restricted browsers. */ }
  return null;
}

/** Clear after redemption, cancellation, or an explicit account change. */
export function clearLaunchInvitation({ storage = sessionStorage() } = {}) {
  try { storage?.removeItem(STORAGE_KEY); }
  catch { /* Do not log invitation material. */ }
}

/**
 * Call synchronously before mounting sign-in or starting app requests.
 * Remove the invitation from browser history before validating or saving it.
 * This only captures opaque material; the server decides identity and access.
 */
export function captureLaunchInvitation({
  location = globalThis.window?.location,
  history = globalThis.window?.history,
  storage = sessionStorage(),
} = {}) {
  if (!location) return null;
  const fragment = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  if (!fragment.has(FRAGMENT_KEY)) return readLaunchInvitation({ storage });
  const tokens = fragment.getAll(FRAGMENT_KEY);
  fragment.delete(FRAGMENT_KEY);
  const remainder = fragment.toString();
  try {
    if (!history?.replaceState) throw new Error("History unavailable");
    history.replaceState(history.state, "", `${location.pathname}${location.search || ""}${remainder ? `#${remainder}` : ""}`);
  } catch {
    clearLaunchInvitation({ storage });
    return null;
  }
  clearLaunchInvitation({ storage });
  if (!/^\/app\/?$/.test(location.pathname) || tokens.length !== 1 || !isLaunchInvitationToken(tokens[0])) return null;
  try {
    if (!storage) return null;
    storage.setItem(STORAGE_KEY, tokens[0]);
    return tokens[0];
  } catch { return null; }
}
