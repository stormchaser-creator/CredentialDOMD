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
    // "" into a date/numeric column rejects the ENTIRE row — a membership
    // with blank dues would silently never reach the cloud. Null is what
    // an empty form field means everywhere.
    out[camelToSnake(k)] = v === "" ? null : v;
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
  travelDocs: "travel_docs",
  travelExpenses: "travel_expenses",
  taxPayments: "tax_payments",
  scheduleDays: "schedule_days",
  taskNotes: "task_notes",
  dutyDays: "duty_days",
  memberships: "professional_memberships",
  invoices: "invoices",
  // Was missing: rows were written (tableName() falls back to the key) but
  // never loaded back, so the deduction ledger only lived in the device
  // cache and vanished on a fresh load.
  deductibles: "deductibles",
  rotations: "rotations",
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
  // apiKey / anthropicApiKey are deliberately NOT here: AI keys live on the
  // device only (see deviceKeys below), never in Postgres.
  taxPrep: "tax_prep",
  // Monthly server-built backup, opt-out. Column is NOT NULL DEFAULT true and
  // the client reads undefined as on, so an untouched account agrees.
  backupMonthly: "backup_monthly",
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
  // Read-only, server-owned: the beta gate. Never written back (not in the map).
  if (row.access_status) settings.accessStatus = row.access_status;
  return settings;
}

// ─── Device-local AI keys ────────────────────────────────────
// Gemini / Anthropic keys are per device and per Clerk user. They ride in
// settings state like before (every reader keeps working) but persist to a
// per-user localStorage slot and are stripped from every cloud write.
const DEVICE_KEY_FIELDS = ["apiKey", "anthropicApiKey"];
const deviceKeySlot = (authUserId) => `credentialdomd-keys:${authUserId}`;

export function loadDeviceKeys(authUserId) {
  if (!authUserId) return {};
  try {
    const raw = localStorage.getItem(deviceKeySlot(authUserId));
    if (raw) return JSON.parse(raw) || {};
  } catch { /* ignore */ }
  // One-time adoption: keys used to live inside the synced settings blob and
  // in Postgres. Pull them out of any local cache copy on this device so the
  // founder's keys survive the switch, then they live only in the slot.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("credentialdomd-data")) continue;
      const cached = JSON.parse(localStorage.getItem(k) || "null");
      const st = cached?.settings || {};
      const found = {};
      for (const f of DEVICE_KEY_FIELDS) if (st[f]) found[f] = st[f];
      if (Object.keys(found).length) {
        localStorage.setItem(deviceKeySlot(authUserId), JSON.stringify(found));
        return found;
      }
    }
  } catch { /* ignore */ }
  return {};
}

// Merge semantics: a field absent from `updates` is untouched; an empty
// string removes it. Partial settings updates must never wipe the other key.
export function saveDeviceKeys(authUserId, updates) {
  if (!authUserId || !updates) return;
  if (!DEVICE_KEY_FIELDS.some(f => f in updates)) return;
  let cur = {};
  try { cur = JSON.parse(localStorage.getItem(deviceKeySlot(authUserId)) || "{}") || {}; } catch { /* ignore */ }
  for (const f of DEVICE_KEY_FIELDS) {
    if (!(f in updates)) continue;
    if (updates[f]) cur[f] = updates[f]; else delete cur[f];
  }
  try {
    if (Object.keys(cur).length) localStorage.setItem(deviceKeySlot(authUserId), JSON.stringify(cur));
    else localStorage.removeItem(deviceKeySlot(authUserId));
  } catch { /* ignore */ }
}

// The Clerk user id of the session that last loaded data on this device;
// lets saveSettings route keys to the right slot without callers changing.
let currentAuthUserId = null;

export function clearDeviceKeys(authUserId) {
  try { if (authUserId) localStorage.removeItem(deviceKeySlot(authUserId)); } catch { /* ignore */ }
}

// ─── Beta access gate ────────────────────────────────────────
// Asks Postgres whether this Clerk user is allowed in. The function trusts
// only the JWT email claim; admins are always active.
export async function claimBetaAccess() {
  if (!supabase) return "active"; // offline/local dev: no gate
  const { data, error } = await supabase.rpc("claim_beta_access");
  if (error) { console.warn("claim_beta_access:", error.message); return "unknown"; }
  return data || "pending";
}

export async function touchLastSeen() {
  if (!supabase) return;
  try { await supabase.rpc("touch_last_seen"); } catch { /* ignore */ }
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
    // Lost the race with the Clerk webhook (unique on auth_user_id): the row
    // exists now, use it.
    const { data: again } = await supabase.from("profiles").select("*").eq("auth_user_id", userId).maybeSingle();
    if (again) return again;
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
  currentAuthUserId = userId;
  const settings = { ...profileRowToSettings(profile), ...loadDeviceKeys(userId) };

  // Fetch all collections in parallel. PostgREST caps any single response at
  // 1,000 rows — a career case log blows straight past that, so every
  // collection pages until a short page says it has everything.
  const fetchAll = async (key) => {
    const PAGE = 1000;
    let rows = [];
    for (let start = 0; ; start += PAGE) {
      const { data, error } = await supabase
        .from(tableName(key))
        .select("*")
        .eq("user_id", profileId)
        .order("created_at", { ascending: false })
        .range(start, start + PAGE - 1);
      if (error) return { data: rows.length ? rows : null, error };
      rows = rows.concat(data || []);
      if (!data || data.length < PAGE) return { data: rows, error: null };
    }
  };
  const collections = Object.keys(TABLE_MAP);
  const results = await Promise.all(
    collections.map((key) =>
      fetchAll(key)
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
export async function saveSettings(userId, settings, authUserId = currentAuthUserId) {
  if (authUserId) saveDeviceKeys(authUserId, settings);
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
  if (error) {
    // One bad row must not strand the rest — retry each row alone so the
    // failure is contained to the row that actually has the problem.
    console.warn(`Bulk sync ${collectionKey} failed (${error.message}) — retrying row-by-row`);
    for (const row of rows) {
      const { error: e2 } = await supabase.from(table).upsert(row, { onConflict: "id" });
      if (e2) console.warn(`Row ${row.id} of ${collectionKey} still failing:`, e2.message);
    }
  }
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
      backup_monthly: true,
      cme_verification_results: "{}", cme_verification_alerted: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);
}
