import { STORAGE_KEY, DEFAULT_DATA } from "../constants/defaults";
import { getDeviceId, ensureProfile, loadFromSupabase, bulkSync, saveSettings as sbSaveSettings } from "../lib/supabase";

const ENV_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";

const COLLECTION_KEYS = [
  "licenses", "cme", "privileges", "insurance", "healthRecords",
  "education", "caseLogs", "workHistory", "peerReferences",
  "malpracticeHistory", "documents", "shareLog", "notificationLog",
];

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

export async function loadData() {
  const deviceId = getDeviceId();

  // Try Supabase first
  try {
    const profile = await ensureProfile(deviceId);
    if (profile) {
      const sbData = await loadFromSupabase(deviceId);
      if (sbData) {
        const userId = sbData._userId;
        delete sbData._userId;

        // Merge with defaults
        const merged = {
          ...DEFAULT_DATA,
          ...sbData,
          settings: { ...DEFAULT_DATA.settings, ...(sbData.settings || {}) },
        };

        // Check if localStorage has data not yet in Supabase (first-time migration)
        const local = loadFromLocalStorage();
        if (local) {
          let migrated = false;
          for (const key of COLLECTION_KEYS) {
            if (local[key]?.length > 0 && (!merged[key] || merged[key].length === 0)) {
              merged[key] = local[key];
              // Sync local data to Supabase
              bulkSync(userId, key, local[key]).catch(() => {});
              migrated = true;
            }
          }
          // Migrate settings if Supabase profile is empty
          if (!merged.settings.name && local.settings?.name) {
            merged.settings = { ...merged.settings, ...local.settings };
            sbSaveSettings(userId, merged.settings).catch(() => {});
            migrated = true;
          }
          if (migrated) {
            console.log("CredentialDOMD: Migrated localStorage data to Supabase");
          }
        }

        // Store userId for future operations
        merged._userId = userId;

        // Keep localStorage as cache
        try {
          const cacheData = { ...merged };
          delete cacheData._userId;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(cacheData));
        } catch { /* quota */ }

        return applyDefaults(merged);
      }
    }
  } catch (err) {
    console.warn("CredentialDOMD: Supabase load failed, falling back to localStorage:", err.message);
  }

  // Fallback to localStorage
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
