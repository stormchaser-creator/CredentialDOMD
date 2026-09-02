import { createClient } from "@supabase/supabase-js";
import { STORAGE_KEY } from "../constants/defaults";
import { BASE_KEYS, getActiveUserId } from "../utils/storageScope";

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
  followUps: "follow_ups",
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

// Single source of truth for the syncable collection keys. Every consumer
// (load, self-heal, backup restore) derives its list from here, so a
// collection added to TABLE_MAP can never silently fall out of one of them.
export const COLLECTION_KEYS = Object.keys(TABLE_MAP);

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
  showDashboardCredentials: "show_dashboard_credentials",
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
// The CallSync calendar link (a per-user token) and the agreement it syncs
// onto ride the same slot: secrets stay on the device.
export const DEVICE_KEY_FIELDS = ["apiKey", "anthropicApiKey", "callsyncFeedUrl", "callsyncContractId"];
const deviceKeySlot = (authUserId) => `credentialdomd-keys:${authUserId}`;

export function loadDeviceKeys(authUserId) {
  if (!authUserId) return {};
  try {
    const raw = localStorage.getItem(deviceKeySlot(authUserId));
    if (raw) return JSON.parse(raw) || {};
  } catch { /* ignore */ }
  // One-time adoption: keys used to live inside the synced settings blob.
  // Only ever read THIS device's own copies — the un-namespaced legacy blob
  // and this account's own namespaced blob. Scanning every "credentialdomd-data*"
  // key would inherit another account's API keys off a shared device.
  try {
    const candidates = [STORAGE_KEY, `${STORAGE_KEY}:${authUserId}`];
    for (const k of candidates) {
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

// ─── Durable outbound-op queue ───────────────────────────────
// A write that never reaches the cloud (offline, a transient 401, a stale
// schema cache) used to be lost the moment the tab closed — only *additions*
// self-healed on the next load, so edits and deletes silently reverted. Every
// failed write is now appended here, in the same per-account namespace as the
// cached file, and replayed in order before the next merge.
const pendingOpsSlot = (authUserId) =>
  authUserId ? `${BASE_KEYS.pendingOps}:${authUserId}` : null;
const PENDING_OPS_CAP = 500;

function queuePendingOp(op, collectionKey, payload) {
  // currentAuthUserId is only set once loadFromSupabase has run — which it
  // never has on a fully offline load. Fall back to the active user id the
  // AppProvider sets synchronously during render: it names exactly the
  // account whose UI produced this write (real or offline session), so the
  // op lands in that account's own namespace instead of being dropped.
  const key = pendingOpsSlot(currentAuthUserId || getActiveUserId());
  if (!key) return; // no account context yet — nothing safe to namespace under
  try {
    const cur = JSON.parse(localStorage.getItem(key) || "[]");
    const arr = Array.isArray(cur) ? cur : [];
    arr.push({ op, collectionKey, payload, ts: Date.now() });
    // Bound the queue so one permanently-failing op can't grow without limit.
    localStorage.setItem(key, JSON.stringify(arr.slice(-PENDING_OPS_CAP)));
  } catch { /* storage unavailable — best effort */ }
}

// Low-level, non-queuing writes used by the replay pass. They return a bool so
// replay can drop only the ops that actually landed and keep the rest.
async function sbUpsertRow(userId, collectionKey, item) {
  if (!item?.id) return true; // nothing addressable — drop it
  const table = tableName(collectionKey);
  const row = toSnakeObj(item);
  for (const f of SKIP_FIELDS) delete row[f];
  row.user_id = userId;
  row.created_at = row.created_at || new Date().toISOString();
  row.updated_at = row.updated_at || new Date().toISOString();
  const { error } = await supabase.from(table).upsert(row, { onConflict: "id" });
  return !error;
}
async function sbDeleteRow(userId, collectionKey, itemId) {
  if (!itemId) return true;
  const table = tableName(collectionKey);
  const { error } = await supabase.from(table).delete().eq("id", itemId).eq("user_id", userId);
  return !error;
}
async function sbTombstoneRow(userId, collectionKey, itemId) {
  if (!itemId) return true;
  const { error } = await supabase.from("deleted_items").upsert(
    { item_id: itemId, user_id: userId, collection: collectionKey },
    { onConflict: "item_id" }
  );
  return !error;
}

// Replay the queued writes for this account, in order, dropping each only on
// success. Call after the profile is known and BEFORE loadFromSupabase, so the
// replayed rows are part of the cloud snapshot the merge then reads back.
export async function replayPendingOps(profileId, authUserId) {
  if (!supabase || !profileId) return;
  const key = pendingOpsSlot(authUserId || currentAuthUserId);
  if (!key) return;
  let ops;
  try { ops = JSON.parse(localStorage.getItem(key) || "[]"); } catch { ops = null; }
  if (!Array.isArray(ops) || ops.length === 0) return;
  const remaining = [];
  for (const op of ops) {
    let ok = false;
    try {
      if (op.op === "upsert") {
        ok = await sbUpsertRow(profileId, op.collectionKey, op.payload);
      } else if (op.op === "delete") {
        ok = await sbDeleteRow(profileId, op.collectionKey, op.payload);
        if (ok) await sbTombstoneRow(profileId, op.collectionKey, op.payload);
      } else if (op.op === "settings") {
        // Reapply the queued settings patch to the profile row. Later queued
        // patches overwrite earlier ones in replay order, which is the same
        // last-wins the live path has.
        try {
          const row = settingsToProfileRow(op.payload || {});
          row.updated_at = new Date().toISOString();
          const { error } = await supabase.from("profiles").update(row).eq("id", profileId);
          ok = !error;
        } catch { ok = false; }
      } else if (op.op === "tombstone") {
        ok = await sbTombstoneRow(profileId, op.collectionKey, op.payload);
      } else {
        ok = true; // unknown op shape — discard rather than retry forever
      }
    } catch { ok = false; }
    if (!ok) remaining.push(op);
  }
  try {
    if (remaining.length) localStorage.setItem(key, JSON.stringify(remaining));
    else localStorage.removeItem(key);
  } catch { /* ignore */ }
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
  const collections = COLLECTION_KEYS;
  const errored = new Set();
  const results = await Promise.all(
    collections.map((key) =>
      fetchAll(key)
        .then(({ data, error }) => {
          if (error) {
            console.warn(`Failed to load ${key}:`, error.message);
            // A read that FAILED is not the same as an empty collection.
            // Returning [] here would let the self-heal push stale local rows
            // over newer cloud data. Flag it so the caller leaves it untouched.
            errored.add(key);
            return { key, rows: null };
          }
          return { key, rows: data || [] };
        })
    )
  );

  const out = { settings, _userId: profileId, _errored: errored };
  for (const { key, rows } of results) {
    if (rows === null) continue; // errored — leave the key absent
    out[key] = rows.map((row) => {
      const camel = toCamelObj(row);
      // Remove DB-specific fields, keep id — and keep createdAt (drives
      // "most recently entered first" ordering) and updatedAt (lets the
      // self-heal push a newer local edit over an older cloud row).
      delete camel.userId;
      return camel;
    });
  }

  return out;
}

// ─── Save settings to Supabase ───────────────────────────────
export async function saveSettings(userId, settings, authUserId = currentAuthUserId) {
  if (authUserId) saveDeviceKeys(authUserId, settings);
  if (!supabase || !userId) {
    // Offline (or before the profile loads) a settings edit has nowhere to
    // go and used to vanish on the next cloud merge. Queue it like any other
    // write; replay applies it once the session is back. Device-local keys
    // are stripped the same way every cloud write strips them.
    const clean = { ...settings };
    for (const f of DEVICE_KEY_FIELDS) delete clean[f];
    queuePendingOp("settings", "settings", clean);
    return null;
  }
  const row = settingsToProfileRow(settings);
  row.updated_at = new Date().toISOString();
  // Read the row back so a server-enforced value (e.g. the identity lock on
  // email) is surfaced instead of being silently cached as whatever we sent.
  const { data, error } = await supabase
    .from("profiles")
    .update(row)
    .eq("id", userId)
    .select()
    .maybeSingle();
  if (error) {
    console.warn("Failed to save settings:", error.message);
    const clean = { ...settings };
    for (const f of DEVICE_KEY_FIELDS) delete clean[f];
    queuePendingOp("settings", "settings", clean);
    return null;
  }
  if (data && "email" in row && data.email !== row.email) {
    console.warn("Settings email was not accepted by the server (identity lock?):", { sent: row.email, stored: data.email });
  }
  return data ? profileRowToSettings(data) : null;
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
  // No cloud target yet (offline / local dev): queue so it isn't lost.
  if (!supabase || !userId) { queuePendingOp("upsert", collectionKey, item); return; }
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
  if (error) {
    console.warn(`Failed to insert ${collectionKey}:`, error.message);
    queuePendingOp("upsert", collectionKey, item);
  }
}

export async function updateItem(userId, collectionKey, item) {
  if (!supabase || !userId) { queuePendingOp("upsert", collectionKey, item); return; }
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
  if (error) {
    console.warn(`Failed to update ${collectionKey}:`, error.message);
    // Replay as an upsert: if the row was never inserted (a failed add), the
    // update would no-op, so upsert recovers both cases.
    queuePendingOp("upsert", collectionKey, item);
  }
}

export async function deleteItem(userId, collectionKey, itemId) {
  if (!supabase || !userId) { queuePendingOp("delete", collectionKey, itemId); return; }
  if (collectionKey === "documents") {
    const path = documentStoragePath(itemId);
    // Await the removal so a failure is visible (and can be swept) instead of
    // silently orphaning the stored object.
    if (path) {
      const { error: rmErr } = await supabase.storage.from("documents").remove([path]);
      if (rmErr) console.warn("Document file delete failed (object may orphan):", rmErr.message);
    }
  }
  const table = tableName(collectionKey);
  const { error } = await supabase
    .from(table)
    .delete()
    .eq("id", itemId)
    .eq("user_id", userId);
  if (error) {
    console.warn(`Failed to delete ${collectionKey}:`, error.message);
    queuePendingOp("delete", collectionKey, itemId);
  }
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
  if (!itemId) return;
  if (!supabase || !userId) { queuePendingOp("tombstone", collectionKey, itemId); return; }
  const { error } = await supabase.from("deleted_items").upsert(
    { item_id: itemId, user_id: userId, collection: collectionKey },
    { onConflict: "item_id" }
  );
  if (error) {
    console.warn("Failed to record deletion:", error.message);
    queuePendingOp("tombstone", collectionKey, itemId);
  }
}

export async function listTombstones(userId) {
  if (!supabase || !userId) return new Set();
  // PostgREST caps a single response at 1,000 rows; a long-lived account can
  // hold more tombstones than that, so page until a short page ends it.
  const PAGE = 1000;
  const ids = new Set();
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await supabase
      .from("deleted_items")
      .select("item_id")
      .eq("user_id", userId)
      .range(start, start + PAGE - 1);
    if (error || !data) break;
    for (const r of data) ids.add(r.item_id);
    if (data.length < PAGE) break;
  }
  return ids;
}

// ─── Delete all user data ────────────────────────────────────
export async function deleteAllData(userId) {
  if (!supabase || !userId) return;
  // Tombstone every id BEFORE deleting: deleted_items is not in TABLE_MAP, so
  // it survives the wipe. Without this, another device holding a stale cache
  // re-uploads everything on its next self-heal and the wipe undoes itself.
  const PAGE = 1000;
  for (const [key, table] of Object.entries(TABLE_MAP)) {
    for (let start = 0; ; start += PAGE) {
      const { data: rows, error } = await supabase
        .from(table)
        .select("id")
        .eq("user_id", userId)
        .range(start, start + PAGE - 1);
      if (error || !rows || rows.length === 0) break;
      await supabase.from("deleted_items").upsert(
        rows.map((r) => ({ item_id: r.id, user_id: userId, collection: key })),
        { onConflict: "item_id" }
      );
      if (rows.length < PAGE) break;
    }
  }
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
      theme: "dark", font_size: "M", reminder_lead_days: 90,
      notify_email: true, notify_text: true, notify_freq_days: 7,
      backup_monthly: true,
      cme_verification_results: "{}", cme_verification_alerted: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);
}

// ─── Server-side account deletion ────────────────────────────
// deleteAllData above reaches what RLS lets the browser see: the synced
// tables, the documents folder, the profile fields. The delete-account edge
// function, running as the service role, finishes the job: support tickets
// and their screenshots, the assistant log, feedback, backup ZIPs and their
// rows, usage and error rows, the tombstone ledger, and the profile row
// itself reduced to an id. The client purge runs first so the account is
// emptied even when this call cannot get through.
export async function requestAccountDeletion() {
  if (!supabase) throw new Error("No cloud connection");
  // dry_run false is explicit on purpose: the function treats a missing flag
  // as a dry run and deletes nothing.
  const res = await supabase.functions.invoke("delete-account", { body: { dry_run: false } });
  if (res.error) {
    // invoke() reports every non-2xx as the same generic sentence; the
    // useful text is in the response body.
    let msg = "";
    try { msg = (await res.error.context?.json())?.error || ""; } catch { /* not JSON */ }
    throw new Error(msg || res.error.message || "The server-side deletion did not finish.");
  }
  return res.data;
}

// A tombstoned profile (deleted_at set by delete-account) tells the next
// sign-in to drop this device's cache first (AppContext). Once that is done
// the account is in use again and the flag comes off, so offline edits made
// from here on self-heal normally.
export async function clearProfileDeletedAt(profileId) {
  if (!supabase || !profileId) return;
  const { error } = await supabase.from("profiles").update({ deleted_at: null }).eq("id", profileId);
  if (error) console.warn("Could not clear the deletion flag:", error.message);
}
