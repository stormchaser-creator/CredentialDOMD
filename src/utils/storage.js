import { STORAGE_KEY, DEFAULT_DATA } from "../constants/defaults";

const ENV_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";

function applyDefaults(data) {
  if (!data.settings.apiKey && ENV_API_KEY) {
    data.settings.apiKey = ENV_API_KEY;
  }
  return data;
}

function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_DATA,
        ...parsed,
        settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
      };
    }
  } catch { /* corrupt or unavailable */ }
  return null;
}

// loadData now only loads from localStorage/Capacitor (offline fallback).
// Supabase loading is handled in AppContext after auth resolves.
export async function loadData() {
  // Try localStorage first
  const local = loadFromLocalStorage();
  if (local) return applyDefaults(local);

  // Fallback to Capacitor storage
  try {
    if (window.storage?.get) {
      const r = await window.storage.get(STORAGE_KEY);
      if (r?.value) {
        const parsed = JSON.parse(r.value);
        try { localStorage.setItem(STORAGE_KEY, r.value); } catch {}
        return applyDefaults({
          ...DEFAULT_DATA,
          ...parsed,
          settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
        });
      }
    }
  } catch { /* unavailable */ }

  return { ...DEFAULT_DATA };
}

// Save to localStorage as backup cache (Supabase writes happen per-operation in AppContext)
export async function saveData(data) {
  const json = JSON.stringify(data, (key, value) => {
    // Don't cache internal userId
    if (key === "_userId") return undefined;
    return value;
  });
  let saved = false;
  try {
    localStorage.setItem(STORAGE_KEY, json);
    saved = true;
  } catch (err) {
    if (err?.name === "QuotaExceededError" || err?.code === 22) {
      console.warn("CredentialDOMD: localStorage quota exceeded.");
    }
  }
  try {
    if (window.storage?.set) {
      await window.storage.set(STORAGE_KEY, json);
      saved = true;
    }
  } catch { /* unavailable */ }
  return saved;
}
