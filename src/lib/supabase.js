import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Pulls a fresh Supabase-flavored JWT from Clerk on every request.
 *
 * Clerk attaches itself to `window.Clerk` once <ClerkProvider> mounts. The
 * "supabase" template (configured in the Clerk dashboard — see
 * CLERK-SUPABASE-SETUP.md) signs the JWT with the Supabase JWT secret so
 * Postgres / RLS accept it. RLS policies that read `auth.uid()` see the
 * `sub` claim — which the template populates with the Clerk user id.
 */
async function getClerkSupabaseToken() {
  if (typeof window === "undefined") return null;
  const session = window.Clerk?.session;
  if (!session) return null;
  try {
    return await session.getToken({ template: "supabase" });
  } catch (err) {
    console.warn("Failed to mint Supabase token from Clerk:", err.message);
    return null;
  }
}

// ─── Supabase Client ────────────────────────────────────────
// `accessToken` callback is invoked on every request — supabase-js v2 calls
// it before each fetch to attach the Authorization header. This is what
// keeps RLS authenticated as the Clerk user.
export const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      accessToken: getClerkSupabaseToken,
      auth: {
        // Clerk owns sessions now — disable supabase-js's own session mgmt.
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
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
  locumContracts: "locum_contracts",
  workLog: "work_log",
  encounters: "encounters",
  screenings: "screenings",
  alertAcks: "alert_acks",
  professionalPhotos: "professional_photos",
  publications: "publications",
  memberships: "professional_memberships",
  invoices: "invoices",
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
  address: "address",
  website: "website",
  languages: "languages",
  professionalSummary: "professional_summary",
  cvHighlights: "cv_highlights",
  profilePhoto: "profile_photo",
  theme: "theme",
  fontSize: "font_size",
  apiKey: "api_key",
  reminderLeadDays: "reminder_lead_days",
  notifyEmail: "notify_email",
  notifyBrowser: "notify_browser",
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

// ─── Ensure profile exists (now uses auth user id) ──────────
export async function ensureProfile(userId) {
  if (!supabase || !userId) return null;

  // Check if profile exists for this auth user
  const { data: existing } = await supabase
    .from("profiles")
    .select("*")
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (existing) return existing;

  // Create new profile linked to auth user
  const newId = crypto.randomUUID();
  const { data: created, error } = await supabase
    .from("profiles")
    .insert({ id: newId, auth_user_id: userId })
    .select()
    .single();

  if (error) {
    console.warn("Failed to create profile:", error.message);
    return null;
  }
  return created;
}

// ─── Load all data from Supabase ─────────────────────────────
export async function loadFromSupabase(userId) {
  if (!supabase || !userId) return null;

  // Get profile by auth user id
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (!profile) return null;

  const profileId = profile.id;
  const settings = profileRowToSettings(profile);

  // Fetch all collections in parallel
  const collections = Object.keys(TABLE_MAP);
  const results = await Promise.all(
    collections.map((key) =>
      supabase
        .from(tableName(key))
        .select("*")
        .eq("user_id", profileId)
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

  const out = { settings, _userId: profileId };
  for (const { key, rows } of results) {
    out[key] = rows.map((row) => {
      const camel = toCamelObj(row);
      // Remove DB-specific fields, keep id — and keep createdAt, it drives
      // "most recently entered first" ordering in the work log
      delete camel.userId;
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

// ─── Document file storage (bucket: documents, path: <clerkSub>/<docId>) ──
// The documents table syncs metadata; the file bytes go to Storage so a
// lost phone doesn't mean lost scans. Path is deterministic from the doc id.

function dataUrlToBlob(dataUrl) {
  try {
    const [head, b64] = dataUrl.split(",");
    if (!b64) return null;
    const mime = head.match(/data:(.*?)[;,]/)?.[1] || "application/octet-stream";
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch { return null; }
}

function clerkSub() {
  return (typeof window !== "undefined" && window.Clerk?.user?.id) || null;
}

export function documentStoragePath(docId) {
  const sub = clerkSub();
  return sub ? `${sub}/${docId}` : null;
}

export async function uploadDocumentFile(item) {
  if (!supabase || !item?.data) return null;
  const path = documentStoragePath(item.id);
  if (!path) return null;
  const blob = dataUrlToBlob(item.data);
  if (!blob) return null;
  const { error } = await supabase.storage.from("documents")
    .upload(path, blob, { contentType: item.type || blob.type, upsert: true });
  if (error) { console.warn("Document file upload failed:", error.message); return null; }
  return path;
}

export async function downloadDocumentFile(storagePath) {
  if (!supabase || !storagePath) return null;
  const { data, error } = await supabase.storage.from("documents").download(storagePath);
  if (error || !data) return null;
  return await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = (e) => resolve(e.target.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(data);
  });
}

// ─── Collection CRUD ─────────────────────────────────────────
export async function insertItem(userId, collectionKey, item) {
  if (!supabase || !userId) return;
  const table = tableName(collectionKey);
  const row = toSnakeObj(item);
  // Remove fields not in DB
  for (const f of SKIP_FIELDS) delete row[f];
  row.user_id = userId;
  row.created_at = row.created_at || new Date().toISOString();
  row.updated_at = new Date().toISOString();
  // Documents: push the file bytes to Storage and record where they live.
  if (collectionKey === "documents" && item.data) {
    const path = await uploadDocumentFile(item);
    if (path) row.storage_path = path;
    row.mime_type = item.type || null;
    row.size_bytes = item.size || null;
  }
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
  if (collectionKey === "documents") {
    const path = documentStoragePath(itemId);
    if (path) supabase.storage.from("documents").remove([path]).catch(() => {});
  }
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

// ─── Deletion ledger ─────────────────────────────────────────
// A delete recorded here is final across all devices: loads prune these ids
// and the self-healing push skips them, so stale devices can't resurrect.
export async function recordTombstone(userId, collectionKey, itemId) {
  if (!supabase || !userId || !itemId) return;
  const { error } = await supabase.from("deleted_items").upsert(
    { item_id: itemId, user_id: userId, collection: collectionKey },
    { onConflict: "item_id" }
  );
  if (error) console.warn("Failed to record deletion:", error.message);
}

export async function listTombstones(userId) {
  if (!supabase || !userId) return new Set();
  const { data, error } = await supabase
    .from("deleted_items")
    .select("item_id")
    .eq("user_id", userId);
  if (error || !data) return new Set();
  return new Set(data.map((r) => r.item_id));
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
      // Derived from the sync map, so a column added to SETTINGS_TO_PROFILE
      // is always cleared here too — a hand-kept list silently drifted before.
      ...Object.fromEntries(Object.values(SETTINGS_TO_PROFILE).map(col => [col, null])),
      specialties: "[]", additional_states: "[]",
      theme: "light", font_size: "M", reminder_lead_days: 90,
      notify_email: true, notify_text: true, notify_freq_days: 7,
      cme_verification_results: "{}", cme_verification_alerted: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);
}
