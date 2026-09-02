/**
 * Per-user namespace for everything the app keeps on the device.
 *
 * Every localStorage key that holds one physician's data is suffixed with
 * the signed-in Clerk user id, e.g. `credentialdomd-data:user_2abc`. Two
 * people sharing an iPad, or a session that lapses without the Sign out
 * button, can no longer hand one account's file to the next: the other
 * account reads a different key and finds nothing.
 *
 * AppContext sets the active user id the moment Clerk resolves. Until then,
 * and whenever nobody is signed in, there is no key at all and every helper
 * here reads empty and writes nothing. Nothing is written to an
 * un-namespaced key any more; the pre-namespace keys are migrated once by
 * adoptLegacyStorage() and then removed.
 */
import { STORAGE_KEY } from "../constants/defaults.js";

export const BASE_KEYS = {
  data: STORAGE_KEY,                       // the whole file (mirror of the cloud)
  vault: "credentialdomd-private-vault",   // patient-identifying notes, device-only
  chat: "credentialdomd-assistant-chat",
  archives: "credentialdomd-assistant-archives",
  timer: "credentialdomd-live-timer",
  lastContract: "credentialdomd-last-contract",
  pendingOps: "credentialdomd-pending-ops", // writes that failed to reach the cloud, replayed next load
  // Who last completed a signed-in load on this device (offline fallback
  // identity, src/utils/offlineSession.js). Listed here so purgeUserStorage
  // removes it with everything else: a session that ended in sign-out leaves
  // no identity behind, and the offline fallback can never activate.
  lastIdentity: "credentialdomd-last-identity",
  // CallSync sync bookkeeping (last check, last result); the feed link
  // itself lives in the device-key slot with the AI keys.
  callsync: "credentialdomd-callsync",
};

// The profiles.deleted_at stamp this device last purged its cache for
// (AppContext, after a server-side account deletion). Deliberately NOT in
// BASE_KEYS: purgeUserStorage and the sign-out purge must leave it, or every
// sign-in after a wipe would purge again. It holds a timestamp, nothing else.
export const WIPE_SEEN_KEY = "credentialdomd-wipe-seen";

let activeUserId = null;

export function setActiveUserId(id) { activeUserId = id || null; }
export function getActiveUserId() { return activeUserId; }

/** The namespaced key for `base`, or null when nobody is signed in. */
export function scopedKey(base, userId = activeUserId) {
  return userId ? `${base}:${userId}` : null;
}

// ─── Small typed accessors (null key = no-op) ─────────────────
export function lsGet(base, userId) {
  const k = scopedKey(base, userId);
  if (!k) return null;
  try { return localStorage.getItem(k); } catch { return null; }
}
export function lsGetJSON(base, userId) {
  const raw = lsGet(base, userId);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export function lsSet(base, value, userId) {
  const k = scopedKey(base, userId);
  if (!k) return false;
  try { localStorage.setItem(k, value); return true; } catch { return false; }
}
export function lsSetJSON(base, value, userId) {
  return lsSet(base, JSON.stringify(value), userId);
}
export function lsRemove(base, userId) {
  const k = scopedKey(base, userId);
  if (!k) return;
  try { localStorage.removeItem(k); } catch { /* unavailable */ }
}

/**
 * Remove every namespaced key belonging to `userId`.
 *
 * `keepVault` is for involuntary sign-outs (session expiry, revocation from
 * the Clerk dashboard): the vault holds patient notes that exist nowhere
 * else, and a token timing out must not destroy them. The key is still
 * unreadable to any other account. The explicit Sign out button and Delete
 * All My Data pass keepVault=false.
 */
export async function purgeUserStorage(userId, { keepVault = false } = {}) {
  if (!userId) return;
  for (const [name, base] of Object.entries(BASE_KEYS)) {
    if (name === "vault" && keepVault) continue;
    lsRemove(base, userId);
  }
  try { await window.storage?.remove?.(scopedKey(BASE_KEYS.data, userId)); } catch { /* unavailable */ }
}

// ─── One-time migration of the pre-namespace keys ─────────────
const COLLECTION_ID_SKIP = new Set(["settings"]);

function collectIds(blob) {
  const ids = new Set();
  if (!blob || typeof blob !== "object") return ids;
  for (const [key, val] of Object.entries(blob)) {
    if (COLLECTION_ID_SKIP.has(key) || !Array.isArray(val)) continue;
    for (const x of val) if (x?.id) ids.add(x.id);
  }
  return ids;
}

function readLegacy(base) {
  try { return localStorage.getItem(base); } catch { return null; }
}
function removeLegacy(base) {
  try { localStorage.removeItem(base); } catch { /* unavailable */ }
}
/** Move a legacy value under the user's key, never overwriting a namespaced one. */
function moveLegacy(base, userId) {
  const raw = readLegacy(base);
  // An empty placeholder ("[]", "{}", "null") written by a component that
  // mounted before adoption ran does not count as a namespaced value; the
  // legacy content wins over it.
  const cur = lsGet(base, userId);
  const curEmpty = cur == null || /^\s*(\[\s*\]|\{\s*\}|null|"")\s*$/.test(cur);
  if (raw != null && curEmpty) lsSet(base, raw, userId);
  removeLegacy(base);
}

/** True while any pre-namespace key is still on the device. */
export function hasLegacyStorage() {
  return [BASE_KEYS.data, BASE_KEYS.vault, BASE_KEYS.chat, BASE_KEYS.archives, BASE_KEYS.timer, BASE_KEYS.lastContract]
    .some(base => readLegacy(base) != null);
}

/**
 * Decide what happens to the un-namespaced keys left by builds before this
 * one, the first time a signed-in user loads with the cloud reachable.
 *
 * Rule: the legacy file is adopted by this user only if their cloud profile
 * already holds data AND at least one record id in the legacy file exists
 * in that cloud data (the local file is a mirror of the cloud, so the true
 * owner always overlaps; a different account never does, ids are UUIDs).
 * Adopted: the file, chat, archives, timer and last-contract move under
 * the user's key and the self-heal sync then runs on it as before.
 * Not adopted: those keys are removed. The file is a cloud mirror and the
 * rest is the previous account's transcript and timer state; a new account
 * must never see it, let alone push it up.
 *
 * The vault is decided on its own evidence: it is adopted when the file
 * was, or when any note is attached to a record that exists in this user's
 * cloud (vault keys are `section:recordId`). Otherwise it is left in place
 * untouched, unreadable to anyone but the account whose records it names,
 * because those notes exist nowhere else and no automatic step deletes them.
 *
 * Returns the adopted legacy file, or null.
 */
export function adoptLegacyStorage(userId, { cloudIds, cloudHasData }) {
  if (!userId) return null;
  const legacyRaw = readLegacy(BASE_KEYS.data);
  let legacy = null;
  if (legacyRaw) { try { legacy = JSON.parse(legacyRaw); } catch { legacy = null; } }

  let adopted = false;
  if (legacy && cloudHasData && cloudIds?.size) {
    for (const id of collectIds(legacy)) {
      if (cloudIds.has(id)) { adopted = true; break; }
    }
  }

  const movable = [BASE_KEYS.data, BASE_KEYS.chat, BASE_KEYS.archives, BASE_KEYS.timer, BASE_KEYS.lastContract];
  if (adopted) {
    for (const base of movable) moveLegacy(base, userId);
    // Capacitor copy of the file, when present.
    (async () => {
      try {
        const legacyCap = await window.storage?.get?.(BASE_KEYS.data);
        if (legacyCap?.value) await window.storage.set(scopedKey(BASE_KEYS.data, userId), legacyCap.value);
        await window.storage?.remove?.(BASE_KEYS.data);
      } catch { /* unavailable */ }
    })();
    console.log("CredentialDOMD: adopted the pre-namespace local file for this account");
  } else {
    for (const base of movable) if (readLegacy(base) != null) removeLegacy(base);
    try { window.storage?.remove?.(BASE_KEYS.data); } catch { /* unavailable */ }
    if (legacy) console.log("CredentialDOMD: discarded a local file that belongs to another account");
  }

  // Vault: independent evidence, never auto-deleted while it holds notes.
  const vaultRaw = readLegacy(BASE_KEYS.vault);
  if (vaultRaw != null) {
    let vault = null;
    try { vault = JSON.parse(vaultRaw); } catch { vault = null; }
    const entries = vault && typeof vault === "object" ? Object.entries(vault) : [];
    if (entries.length === 0) {
      removeLegacy(BASE_KEYS.vault);
    } else {
      const owns = adopted || entries.some(([k]) => cloudIds?.has(k.slice(k.indexOf(":") + 1)));
      if (owns) {
        // Merge, existing namespaced notes win.
        const current = lsGetJSON(BASE_KEYS.vault, userId) || {};
        lsSetJSON(BASE_KEYS.vault, { ...Object.fromEntries(entries), ...current }, userId);
        removeLegacy(BASE_KEYS.vault);
      }
    }
  }

  return adopted ? legacy : null;
}
