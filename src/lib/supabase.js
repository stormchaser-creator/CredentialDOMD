import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ─── Device ID ───────────────────────────────────────────────
const DEVICE_KEY = "credentialdomd-device-id";

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

// Pass device_id as a custom header so Supabase RLS policies can scope
// access to this device's data. See supabase-rls-fix.sql for details.
// TODO: Replace with Supabase Auth (email/magic-link or OAuth) for real security.
export const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          "x-device-id": getDeviceId(),
        },
      },
    })
  : null;

// ─── Case conversion ─────────────────────────────────────────
function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function toSnakeObj(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[camelToSnake(k)] = v;
  }
  return out;
}

function toCamelObj(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[snakeToCamel(k)] = v;
  }
  return out;
}

// ─── Table name mapping (JS key → Supabase table) ───────────
const TABLE_MAP = {
  licenses: "licenses",
  cme: "cme",
  privileges: "privileges",
  insurance: "insurance",
  healthRecords: "health_records",
  education: "education",
  caseLogs: "case_logs",
  workHistory: "work_history",
  peerReferences: "peer_references",
  malpracticeHistory: "malpractice_history",
  documents: "documents",
  shareLog: "share_log",
  notificationLog: "notification_log",
};

function tableName(key) {
  return TABLE_MAP[key] || key;
}

// Fields to skip when writing to Supabase (not in DB schema)
const SKIP_FIELDS = new Set(["data"]); // document base64 data stays local

// ─── Profile / Settings ──────────────────────────────────────
// Maps settings keys → profiles columns
const SETTINGS_TO_PROFILE = {
  name: "name",
  npi: "npi",
  degreeType: "degree_type",
  primaryState: "primary_state",
  phone: "phone",
  email: "email",
  specialties: "specialties",
  theme: "theme",
  fontSize: "font_size",
  apiKey: "api_key",
  reminderLeadDays: "reminder_lead_days",
  notifyEmail: "notify_email",
  notifyText: "notify_text",
  notifyFreqDays: "notify_freq_days",
  lastNotified: "last_notified",
  snoozedUntil: "snoozed_until",
  alertsFingerprint: "alerts_fingerprint",
  additionalStates: "additional_states",
  cmeVerificationResults: "cme_verification_results",
  cmeVerificationAlerted: "cme_verification_alerted",
  lastCmeVerification: "last_cme_verification",
};

const PROFILE_TO_SETTINGS = Object.fromEntries(
  Object.entries(SETTINGS_TO_PROFILE).map(([k, v]) => [v, k])
);

function settingsToProfileRow(settings) {
  const row = {};
  for (const [settingsKey, col] of Object.entries(SETTINGS_TO_PROFILE)) {
    if (settings[settingsKey] !== undefined) {
      row[col] = settings[settingsKey];
    }
  }
  return row;
}

function profileRowToSettings(row) {
  const settings = {};
  for (const [col, settingsKey] of Object.entries(PROFILE_TO_SETTINGS)) {
    if (row[col] !== undefined && row[col] !== null) {
      settings[settingsKey] = row[col];
    }
  }
  return settings;
}

// ─── Ensure profile exists ───────────────────────────────────
export async function ensureProfile(deviceId) {
  if (!supabase) return null;

  // Check if profile exists
  const { data: existing } = await supabase
    .from("profiles")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();

  if (existing) return existing;

  // Create new profile
  const newId = crypto.randomUUID();
  const { data: created, error } = await supabase
    .from("profiles")
    .insert({ id: newId, device_id: deviceId })
    .select()
    .single();

  if (error) {
    console.warn("Failed to create profile:", error.message);
    return null;
  }
  return created;
}

// ─── Load all data from Supabase ─────────────────────────────
export async function loadFromSupabase(deviceId) {
  if (!supabase) return null;

  // Get profile
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();

  if (!profile) return null;

  const userId = profile.id;
  const settings = profileRowToSettings(profile);

  // Fetch all collections in parallel
  const collections = Object.keys(TABLE_MAP);
  const results = await Promise.all(
    collections.map((key) =>
      supabase
        .from(tableName(key))
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .then(({ data, error }) => {
          if (error) {
            console.warn(`Failed to load ${key}:`, error.message);
            return { key, rows: [] };
          }
          return { key, rows: data || [] };
        })
    )
  );

  const out = { settings, _userId: userId };
  for (const { key, rows } of results) {
    out[key] = rows.map((row) => {
      const camel = toCamelObj(row);
      // Remove DB-specific fields, keep id
      delete camel.userId;
      delete camel.createdAt;
      delete camel.updatedAt;
      return camel;
    });
  }

  return out;
}

// ─── Save settings to Supabase ───────────────────────────────
export async function saveSettings(userId, settings) {
  if (!supabase || !userId) return;
  const row = settingsToProfileRow(settings);
  row.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from("profiles")
    .update(row)
    .eq("id", userId);
  if (error) console.warn("Failed to save settings:", error.message);
}

// ─── Collection CRUD ─────────────────────────────────────────
export async function insertItem(userId, collectionKey, item) {
  if (!supabase || !userId) return;
  const table = tableName(collectionKey);
  const row = toSnakeObj(item);
  // Remove fields not in DB
  for (const f of SKIP_FIELDS) delete row[f];
  row.user_id = userId;
  row.created_at = new Date().toISOString();
  row.updated_at = row.created_at;
  const { error } = await supabase.from(table).insert(row);
  if (error) console.warn(`Failed to insert ${collectionKey}:`, error.message);
}

export async function updateItem(userId, collectionKey, item) {
  if (!supabase || !userId) return;
  const table = tableName(collectionKey);
  const row = toSnakeObj(item);
  for (const f of SKIP_FIELDS) delete row[f];
  delete row.user_id;
  delete row.created_at;
  row.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from(table)
    .update(row)
    .eq("id", item.id)
    .eq("user_id", userId);
  if (error) console.warn(`Failed to update ${collectionKey}:`, error.message);
}

export async function deleteItem(userId, collectionKey, itemId) {
  if (!supabase || !userId) return;
  const table = tableName(collectionKey);
  const { error } = await supabase
    .from(table)
    .delete()
    .eq("id", itemId)
    .eq("user_id", userId);
  if (error) console.warn(`Failed to delete ${collectionKey}:`, error.message);
}

// ─── Bulk sync (for initial migration from localStorage) ─────
export async function bulkSync(userId, collectionKey, items) {
  if (!supabase || !userId || !items.length) return;
  const table = tableName(collectionKey);
  const now = new Date().toISOString();
  const rows = items.map((item) => {
    const row = toSnakeObj(item);
    for (const f of SKIP_FIELDS) delete row[f];
    row.user_id = userId;
    if (!row.created_at) row.created_at = now;
    if (!row.updated_at) row.updated_at = now;
    return row;
  });
  const { error } = await supabase.from(table).upsert(rows, { onConflict: "id" });
  if (error) console.warn(`Failed to bulk sync ${collectionKey}:`, error.message);
}

// ─── Delete all user data ────────────────────────────────────
export async function deleteAllData(userId) {
  if (!supabase || !userId) return;
  // Delete from all collection tables
  const deletes = Object.values(TABLE_MAP).map((table) =>
    supabase.from(table).delete().eq("user_id", userId)
  );
  await Promise.all(deletes);
  // Reset profile (keep the row but clear fields)
  await supabase
    .from("profiles")
    .update({
      name: null, npi: null, email: null, phone: null,
      primary_state: null, specialties: "[]",
      additional_states: "[]", theme: "light", font_size: "M",
      api_key: null, reminder_lead_days: 90,
      notify_email: true, notify_text: true, notify_freq_days: 7,
      last_notified: null, snoozed_until: null, alerts_fingerprint: null,
      cme_verification_results: "{}", cme_verification_alerted: false,
      last_cme_verification: null, updated_at: new Date().toISOString(),
    })
    .eq("id", userId);
}
