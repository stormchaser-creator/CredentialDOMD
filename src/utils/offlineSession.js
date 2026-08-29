/**
 * Offline session fallback — open the app with the last signed-in identity
 * on THIS device when the network is genuinely down.
 *
 * Clerk gates the whole render; offline it never reaches loaded state and
 * the user gets a spinner forever. This module records who last completed a
 * signed-in load on this device and decides, conservatively, when it is
 * safe to render the app from that identity's own local cache.
 *
 * Security model (the primary threat is showing one user another user's
 * cached data, ahead of making offline work at all):
 *  - The identity slot is namespaced per Clerk user id like every other
 *    on-device key (BASE_KEYS.lastIdentity), so purgeUserStorage removes it
 *    on sign-out. A session that ended in sign-out leaves no slot and the
 *    fallback can never activate.
 *  - readLastIdentity only trusts a slot whose stored authUserId matches
 *    the user id in its own key suffix; a tampered or misfiled slot is
 *    ignored.
 *  - The cache key is derived from the recorded authUserId through the SAME
 *    scopedKey namespacing the real session uses — never from any other
 *    account's namespace.
 *  - Activation requires ALL of: real network failure (not merely slow
 *    Clerk), a recorded identity, and a parseable cache for that identity.
 */
import { BASE_KEYS, scopedKey, lsSetJSON } from "./storageScope.js";

/** How long Clerk gets to reach loaded state before the probe decides. */
export const CLERK_LOAD_TIMEOUT_MS = 6000;

// How long an offline identity stays usable without a real sign-in. This is
// the ceiling on the lost-device scenario: a session revoked while the app
// was closed leaves no purge to run, so the slot itself has to age out. Two
// weeks covers any realistic stretch of shifts or travel without leaving a
// stolen, unlocked device readable forever.
export const OFFLINE_IDENTITY_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const SLOT_PREFIX = `${BASE_KEYS.lastIdentity}:`;

/**
 * Record the identity of a successfully signed-in load. Called from
 * AppContext on every authenticated (non-offline) session, so the slot
 * always names the last real sign-in on this device.
 */
export function recordLastIdentity(user) {
  if (!user?.id) return;
  lsSetJSON(
    BASE_KEYS.lastIdentity,
    {
      authUserId: user.id,
      name: user.fullName || user.email || "",
      recordedAt: new Date().toISOString(),
    },
    user.id
  );
}

/**
 * The recorded last identity on this device, or null. Reads ONLY this
 * device's own lastIdentity slots; a slot whose contents disagree with its
 * own key suffix is rejected outright. With more than one surviving slot
 * (shouldn't happen — sign-out purges), the most recently recorded wins.
 */
export function readLastIdentity() {
  let best = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(SLOT_PREFIX)) continue;
      let slot = null;
      try { slot = JSON.parse(localStorage.getItem(key)); } catch { continue; }
      if (!slot || typeof slot !== "object") continue;
      // The slot must name the same user its key is namespaced under.
      if (slot.authUserId !== key.slice(SLOT_PREFIX.length)) continue;
      if (!slot.authUserId) continue;
      // Expired slots are dead: past the TTL the fallback must refuse and the
      // device must see a real sign-in screen, revoked session or not.
      const age = Date.now() - Date.parse(slot.recordedAt || "");
      if (!Number.isFinite(age) || age < 0 || age > OFFLINE_IDENTITY_TTL_MS) continue;
      if (!best || String(slot.recordedAt || "") > String(best.recordedAt || "")) best = slot;
    }
  } catch { return null; }
  return best;
}

/**
 * The localStorage key the offline session reads its data from: the SAME
 * per-user namespacing as the real session (scopedKey over BASE_KEYS.data).
 */
export function offlineCacheKey(authUserId) {
  return scopedKey(BASE_KEYS.data, authUserId);
}

/** True when the namespaced cache for this identity exists and parses. */
export function cachedDataParses(authUserId) {
  if (!authUserId) return false;
  try {
    const raw = localStorage.getItem(offlineCacheKey(authUserId));
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return !!parsed && typeof parsed === "object";
  } catch {
    return false;
  }
}

/**
 * The activation predicate. ALL of these must hold, none alone sufficient:
 *  (a) the network is actually down: navigator.onLine === false, OR Clerk
 *      failed to load within CLERK_LOAD_TIMEOUT_MS AND the same-origin
 *      probe also failed. A slow Clerk on a working network never activates.
 *  (b) a recorded last identity exists for this device.
 *  (c) the namespaced local cache for that identity exists and parses.
 * A loaded Clerk always wins: the fallback never overrides a real answer
 * from auth, including "signed out".
 */
export function shouldActivateOfflineFallback({ onLine, clerkLoaded, clerkTimedOut, probeFailed, identity, cacheOk }) {
  if (clerkLoaded) return false;
  const networkDown = onLine === false || (clerkTimedOut === true && probeFailed === true);
  if (!networkDown) return false;
  if (!identity?.authUserId) return false;
  if (!cacheOk) return false;
  return true;
}

/**
 * Can the network actually be reached? Fetches a small same-origin resource
 * with cache: "no-store"; the cache-busting query keeps the service worker's
 * exact-URL cache match from answering for the network. ANY HTTP response
 * counts as reachable — only a failed fetch is a down network.
 */
export async function probeNetwork() {
  // A blackholing network (SYN drop with navigator.onLine still true) must
  // not hold the decision hostage for the OS TCP timeout: 5 seconds of
  // silence counts as down. Any HTTP response at all counts as reachable.
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 5000) : null;
  try {
    const base = (typeof import.meta.env !== "undefined" && import.meta.env.BASE_URL) || "/";
    await fetch(`${base}manifest.json?offline-probe=${Date.now()}`, { cache: "no-store", signal: ctl?.signal });
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Gather the inputs and run the predicate. Returns { authUserId, name } to
 * activate the offline session, or null. The probe only runs when the
 * decision actually needs it (browser claims online + Clerk timed out).
 */
export async function evaluateOfflineFallback({ clerkLoaded, clerkTimedOut }) {
  if (clerkLoaded) return null;
  const identity = readLastIdentity();
  if (!identity?.authUserId) return null;
  const cacheOk = cachedDataParses(identity.authUserId);
  if (!cacheOk) return null;

  const onLine = typeof navigator !== "undefined" ? navigator.onLine : true;
  let probeFailed = false;
  if (onLine !== false) {
    if (!clerkTimedOut) return null;
    probeFailed = !(await probeNetwork());
  }

  const activate = shouldActivateOfflineFallback({ onLine, clerkLoaded, clerkTimedOut, probeFailed, identity, cacheOk });
  return activate ? { authUserId: identity.authUserId, name: identity.name || "" } : null;
}
