import { DEFAULT_DATA } from "../constants/defaults";
import { BASE_KEYS, scopedKey, purgeUserStorage } from "./storageScope";

const ENV_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";

function applyDefaults(data) {
  if (!data.settings.apiKey && ENV_API_KEY) {
    data.settings.apiKey = ENV_API_KEY;
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
  if (local) return applyDefaults(local);

  // Fallback to Capacitor storage
  const key = scopedKey(BASE_KEYS.data, userId);
  if (key) {
    try {
      if (window.storage?.get) {
        const r = await window.storage.get(key);
        if (r?.value) {
          const parsed = JSON.parse(r.value);
          try { localStorage.setItem(key, r.value); } catch { /* quota */ }
          return applyDefaults(withDefaults(parsed));
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
  const json = JSON.stringify(data, (k, value) => {
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
