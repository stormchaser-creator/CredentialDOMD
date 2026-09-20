import { DEFAULT_DATA } from "../constants/defaults";
import { BASE_KEYS, scopedKey, purgeForSignOut } from "./storageScope";
import { loadDeviceKeys, EXPORT_REDACT_FIELDS, sanitizeCachedBlob, stripDeviceFields } from "../lib/supabase";

const ENV_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";

function applyDefaults(data) {
  if (!data.settings.apiKey && ENV_API_KEY) {
    data.settings.apiKey = ENV_API_KEY;
  }
  return data;
}

/**
 * Re-hydrate the per-device keys into settings, and ONLY those.
 *
 * AI keys are stripped from the cached blob (see saveData), so the offline load
 * path puts them back from the per-device slot; without this a user offline
 * after the strip would lose their own key from settings state.
 *
 * It used to spread the slot over whatever settings already held, which is a
 * merge, and a merge keeps what it does not overwrite. A blob written by an
 * older build still carries the lock code and the CallSync feed link inside
 * settings, and the slot has no value for the lock code at all (nothing
 * hydrates it any more, by design), so the merge left it standing in the
 * object the app then renders, saves and exports from. Settings are therefore
 * CLEANED of every device-only field first, and then the allowlisted slot
 * values are put on top. loadDeviceKeys already returns nothing but
 * DEVICE_KEY_FIELDS, so this cannot be the path a lock code returns by.
 */
function applyDeviceKeys(data, userId) {
  const keys = loadDeviceKeys(userId);
  const settings = stripDeviceFields(data.settings);
  return { ...data, settings: { ...settings, ...(keys || {}) } };
}

function withDefaults(parsed) {
  return {
    ...DEFAULT_DATA,
    ...parsed,
    settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
  };
}

/**
 * The on-device copy of the file for one user (null when nobody is signed
 * in or nothing is cached). Merged with defaults, and sanitised.
 *
 * Sanitised BEFORE it is returned, not only on disk. A blob written by an
 * older build can still hold the lock code and the AI keys inside settings,
 * and this function has callers besides loadData; handing them the raw blob
 * put the secret straight back into the object the app renders, saves and
 * exports from, whatever the disk copy had been rewritten to say. The disk
 * copy is rewritten here too, so the next read has nothing to strip.
 */
export function readCachedData(userId) {
  const key = scopedKey(BASE_KEYS.data, userId);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    // Trusted: this is the key scoped to THIS user, so a lock code in it is
    // this account's own and may be recovered into the device slot before it
    // is deleted. That recovery is what keeps the encrypted portal passwords
    // readable.
    const { blob, changed } = sanitizeCachedBlob(JSON.parse(raw), userId, { trusted: true });
    if (changed) {
      try { localStorage.setItem(key, JSON.stringify(blob)); } catch { /* quota, or unavailable */ }
    }
    return withDefaults(blob);
  } catch { /* corrupt or unavailable */ }
  return null;
}

/**
 * Sweep BOTH on-device stores: migrate this account's own device fields into
 * the device slot, then scrub them out of the stored copies.
 *
 * Two things were wrong before this existed, and each loses something real.
 *
 * ORDER. readCachedData scrubbed, and loadDeviceKeys' one-time adoption then
 * found an already-cleaned blob, so an account whose keys lived only in a
 * pre-slot cache lost all four device fields. sanitizeCachedBlob now migrates
 * a TRUSTED blob before it strips it, which is why the sweep can run first.
 *
 * REACH. The scrub only ever rewrote localStorage. On a native build the
 * Capacitor copy is the one that survives a browser-storage clear, and a
 * localStorage-first load returned early and never looked at it, so the old
 * lock code and keys sat there until some later save happened to overwrite
 * them. Both stores are swept here, on every load, whichever one answers
 * first.
 */
async function sweepStores(userId, key) {
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const { blob, changed } = sanitizeCachedBlob(JSON.parse(raw), userId, { trusted: true });
      if (changed) localStorage.setItem(key, JSON.stringify(blob));
    }
  } catch { /* corrupt, or storage unavailable */ }

  try {
    if (window.storage?.get) {
      const r = await window.storage.get(key);
      if (r?.value) {
        const { blob, changed } = sanitizeCachedBlob(JSON.parse(r.value), userId, { trusted: true });
        if (changed) await window.storage.set(key, JSON.stringify(blob));
      }
    }
  } catch { /* unavailable */ }

  // The un-namespaced pre-namespace blob, stripped and NEVER trusted. On a
  // shared device it can belong to whoever used the machine before, so nothing
  // in it is adopted; it is cleaned so the material stops sitting on the disk.
  // This used to happen only as a side effect of loadDeviceKeys, which
  // loadData does not reach when this account has no cache of its own, so a
  // colleague's old keys could sit there untouched through every load.
  try {
    const raw = localStorage.getItem(BASE_KEYS.data);
    if (raw) {
      const { blob, changed } = sanitizeCachedBlob(JSON.parse(raw), userId, { trusted: false });
      if (changed) localStorage.setItem(BASE_KEYS.data, JSON.stringify(blob));
    }
  } catch { /* corrupt, or storage unavailable */ }
}

// loadData only loads from localStorage/Capacitor (offline fallback), always
// under the signed-in user's own key. Supabase loading is handled in
// AppContext after auth resolves.
export async function loadData(userId) {
  // First, and on every load: the sweep is what migrates a legacy cache into
  // the device slot, and it has to happen before anything reads either store.
  await sweepStores(userId, scopedKey(BASE_KEYS.data, userId));

  const local = readCachedData(userId);
  if (local) return applyDefaults(applyDeviceKeys(local, userId));

  // Fallback to Capacitor storage. sweepStores above has already migrated and
  // scrubbed this copy, so what comes back here is clean; it is sanitised
  // again on the way through because this function must not depend on the
  // sweep having succeeded to be safe.
  const key = scopedKey(BASE_KEYS.data, userId);
  if (key) {
    try {
      if (window.storage?.get) {
        const r = await window.storage.get(key);
        if (r?.value) {
          const { blob, changed } = sanitizeCachedBlob(JSON.parse(r.value), userId, { trusted: true });
          const text = changed ? JSON.stringify(blob) : r.value;
          try { localStorage.setItem(key, text); } catch { /* quota */ }
          if (changed) {
            try { await window.storage.set(key, text); } catch { /* unavailable */ }
          }
          return applyDefaults(applyDeviceKeys(withDefaults(blob), userId));
        }
      }
    } catch { /* unavailable */ }
  }

  return { ...DEFAULT_DATA };
}

// Save to localStorage as backup cache (Supabase writes happen per-operation
// in AppContext). `userId` is the Clerk id the data belongs to; with none
// there is nowhere safe to put it, so nothing is written.
export async function saveData(data, userId) {
  const key = scopedKey(BASE_KEYS.data, userId);
  if (!key) return false;
  // Keep the cached blob small and secret-free:
  //  - document bytes are re-fetched from Storage on demand, so drop them once
  //    a doc is safely uploaded (a doc with no storagePath still holds its only
  //    copy in `data`, so that one is kept — never evict the last copy);
  //  - device-only material never goes in this blob at all: the AI keys and the
  //    CallSync feed token, because a stray copy here could be adopted
  //    cross-account off a shared device, AND the lock code that opens the
  //    encrypted portal passwords, which used to be cached beside the very
  //    ciphertext it decrypts. One list (EXPORT_REDACT_FIELDS in
  //    src/lib/supabase.js) decides all of it, for the cache and the export
  //    alike; this used to strip DEVICE_KEY_FIELDS only, which is that list
  //    minus the lock code.
  const slimSettings = { ...(data.settings || {}) };
  for (const f of EXPORT_REDACT_FIELDS) delete slimSettings[f];
  const slim = {
    ...data,
    settings: slimSettings,
    documents: (data.documents || []).map((d) =>
      d && d.data && d.storagePath ? { ...d, data: undefined } : d
    ),
  };
  const json = JSON.stringify(slim, (k, value) => {
    // Don't cache internal userId
    if (k === "_userId") return undefined;
    return value;
  });
  let saved = false;
  try {
    localStorage.setItem(key, json);
    saved = true;
  } catch (err) {
    if (err?.name === "QuotaExceededError" || err?.code === 22) {
      console.warn("CredentialDOMD: localStorage quota exceeded.");
    }
  }
  try {
    if (window.storage?.set) {
      await window.storage.set(key, json);
      saved = true;
    }
  } catch { /* unavailable */ }
  return saved;
}

/**
 * Sign-out purge. Everything this user kept on the device (the file, the
 * private vault, the Assistant transcript and archives, the live timer, the
 * offline identity slot, the AI keys and lock code) goes, so the next person
 * to sign in on a shared device inherits nothing.
 */
export async function clearLocalData(userId) {
  await purgeForSignOut(userId);
}
