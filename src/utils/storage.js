import { STORAGE_KEY, DEFAULT_DATA } from "../constants/defaults";

const ENV_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";

function applyDefaults(data) {
  // Fill in env-var API key when stored key is empty
  if (!data.settings.apiKey && ENV_API_KEY) {
    data.settings.apiKey = ENV_API_KEY;
  }
  return data;
}

export async function loadData() {
  // Try localStorage first (browser), then window.storage (Capacitor/native)
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return applyDefaults({
        ...DEFAULT_DATA,
        ...parsed,
        settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
      });
    }
  } catch { /* localStorage unavailable or corrupt */ }

  try {
    if (window.storage?.get) {
      const r = await window.storage.get(STORAGE_KEY);
      if (r?.value) {
        const parsed = JSON.parse(r.value);
        // Migrate to localStorage for future loads
        try { localStorage.setItem(STORAGE_KEY, r.value); } catch {}
        return applyDefaults({
          ...DEFAULT_DATA,
          ...parsed,
          settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
        });
      }
    }
  } catch { /* window.storage unavailable */ }

  return { ...DEFAULT_DATA };
}

export async function saveData(data) {
  const json = JSON.stringify(data);
  let saved = false;
  try {
    localStorage.setItem(STORAGE_KEY, json);
    saved = true;
  } catch (err) {
    if (err?.name === "QuotaExceededError" || err?.code === 22) {
      console.warn("CredentialDOMD: localStorage quota exceeded. Data was not saved.");
    }
  }
  try {
    if (window.storage?.set) {
      await window.storage.set(STORAGE_KEY, json);
      saved = true;
    }
  } catch { /* window.storage unavailable */ }
  return saved;
}
