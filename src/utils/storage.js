import { DEFAULT_DATA } from "../constants/defaults";
import { BASE_KEYS, scopedKey, purgeUserStorage } from "./storageScope";
import { loadDeviceKeys, DEVICE_KEY_FIELDS } from "../lib/supabase";

const ENV_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";

function applyDefaults(data) {
  if (!data.settings.apiKey && ENV_API_KEY) {
    data.settings.apiKey = ENV_API_KEY;
  }
  return data;
}

// AI keys are stripped from the cached blob (see saveData), so the offline
// load path re-hydrates them from the per-device key slot. Without this, a
// user offline after the strip would lose their own key from settings state.
function applyDeviceKeys(data, userId) {
  const keys = loadDeviceKeys(userId);
  if (keys && Object.keys(keys).length) {
    data.settings = { ...data.settings, ...keys };
  }
  return data;
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
 * in or nothing is cached). Merged with defaults.
 */
export function readCachedData(userId) {
  const key = scopedKey(BASE_KEYS.data, userId);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) return withDefaults(JSON.parse(raw));
  } catch { /* corrupt or unavailable */ }
  return null;
}

// loadData only loads from localStorage/Capacitor (offline fallback), always
// under the signed-in user's own key. Supabase loading is handled in
// AppContext after auth resolves.
export async function loadData(userId) {
  const local = readCachedData(userId);
  if (local) return applyDefaults(applyDeviceKeys(local, userId));

  // Fallback to Capacitor storage
  const key = scopedKey(BASE_KEYS.data, userId);
  if (key) {
    try {
      if (window.storage?.get) {
        const r = await window.storage.get(key);
        if (r?.value) {
          const parsed = JSON.parse(r.value);
          try { localStorage.setItem(key, r.value); } catch { /* quota */ }
          return applyDefaults(applyDeviceKeys(withDefaults(parsed), userId));
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
  //  - AI keys live in the device-key slot, never in this blob (a stray copy
  //    here could be adopted cross-account off a shared device).
  const slimSettings = { ...(data.settings || {}) };
  for (const f of DEVICE_KEY_FIELDS) delete slimSettings[f];
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
 * private vault, the Assistant transcript and archives, the live timer)
 * goes, so the next person to sign in on a shared device inherits nothing.
 */
export async function clearLocalData(userId) {
  await purgeUserStorage(userId, { keepVault: false });
}
