import { accessAuthority, allowsSettingsChange, membershipWriteError } from "../utils/limitedLaunchAccess.js";
import { createClient } from "@supabase/supabase-js";
import { STORAGE_KEY } from "../constants/defaults";
import { BASE_KEYS, DEVICE_KEYS_BASE, getActiveUserId } from "../utils/storageScope";
import { foundingFromProfile } from "../utils/founding";

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

function accountChangedError() {
  const error = new Error("The signed-in account changed. Reopen this record in its original account.");
  error.code = "membership_account_changed";
  return error;
}

// Each write keeps its initiating identity through token minting, fetch, and
// follow-up requests. A shared client would obtain the *new* session's token.
function writeContext(authUserId = getActiveUserId() || clerkSub()) {
  const accountId = authUserId;
  const activeId = getActiveUserId();
  const clerkId = clerkSub();
  const session = globalThis.window?.Clerk?.session || null;
  const guard = () => {
    const active = getActiveUserId(), current = clerkSub();
    if (!accountId || (active && active !== accountId) || (activeId && active !== activeId)
      || (current && current !== accountId) || (clerkId && current !== clerkId)
      || ((session?.user?.id || session?.userId) && (session.user?.id || session.userId) !== accountId)
      || (globalThis.window?.Clerk?.session || null) !== session) throw accountChangedError();
  };
  guard();
  const owner = { accountId, guard, check: guard, db: null };
  if (supabase) owner.db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: async () => {
      owner.check();
      if (!session) throw new Error("The signed-in session is unavailable.");
      let token;
      try { token = await session.getToken({ template: "supabase" }); }
      catch (error) { owner.check(); throw error; }
      owner.check();
      if (!token) throw new Error("The signed-in session is unavailable.");
      return token;
    },
    global: { fetch: (...args) => { owner.check(); return globalThis.fetch(...args); } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return owner;
}

function guardRecord(owner, key, item, previous, existing = false) {
  owner.guard();
  const before = previous;
  // An update with unknown provenance cannot relabel a Practice attachment as
  // Credential to get around expiry. New inserts retain their declared scope.
  if (existing && key === "documents" && !before && accessAuthority.enabled
    && !["credential", "practice"].every(scope => accessAuthority.allows(scope, "write", owner.accountId))) throw membershipWriteError();
  if (!accessAuthority.allowsMutation(key, item, before, owner.accountId)) throw membershipWriteError();
}

function recordContext(key, item, previous, existing = false, authUserId) {
  const owner = writeContext(authUserId);
  const before = previous || accessAuthority.previousRecord(key, item?.id, owner.accountId);
  owner.check = () => guardRecord(owner, key, item, before, existing);
  owner.check();
  return owner;
}

function guardSettings(owner, settings) {
  owner.guard();
  if (!allowsSettingsChange(settings)) throw membershipWriteError();
}

// Network failures may be queued for this owner. Account/permission changes
// must propagate and must never be converted into another account's retry.
async function writeRequest(owner, request) {
  owner.check();
  try { return await request(); }
  catch (error) {
    owner.check();
    return { error };
  }
}

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
  // The setup board: skips, declared negatives, the snooze and the two
  // completion stamps. Task completion itself is derived, never stored.
  setupState: "setup_state",
  // Monthly server-built backup, opt-out. Column is NOT NULL DEFAULT true and
  // the client reads undefined as on, so an untouched account agrees.
  backupMonthly: "backup_monthly",
  // Auto-acknowledge a forwarded document request to its requester from
  // docs@, opt-out. The client reads undefined as on, same as backupMonthly.
  ackRequests: "ack_requests",
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
  // Unread badges: when this account last opened the panel, so "unread"
  // survives a reload instead of resetting every session. adminInboxSeenAt
  // and adminErrorsSeenAt are Eric's own admin-dashboard tabs; adminMessagesSeenAt
  // is any physician's "seen Eric's message" stamp on their home card.
  adminInboxSeenAt: "admin_inbox_seen_at",
  adminMessagesSeenAt: "admin_messages_seen_at",
  adminErrorsSeenAt: "admin_errors_seen_at",
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
  // Read-only, server-owned: founding member number and flag, assigned by
  // Postgres when the physician signs up and is activated (migration
  // 20260902g_founding_members.sql). Never written back (not in the map).
  Object.assign(settings, foundingFromProfile(row));
  return settings;
}

// ─── Device-local AI keys ────────────────────────────────────
// Gemini / Anthropic keys are per device and per Clerk user. They ride in
// settings state like before (every reader keeps working) but persist to a
// per-user localStorage slot and are stripped from every cloud write.
// The CallSync calendar link (a per-user token) and the agreement it syncs
// onto ride the same slot: secrets stay on the device.
export const DEVICE_KEY_FIELDS = ["apiKey", "anthropicApiKey", "callsyncFeedUrl", "callsyncContractId"];
const deviceKeySlot = (authUserId) => `${DEVICE_KEYS_BASE}:${authUserId}`;

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

function queuePendingOp(op, collectionKey, payload, owner) {
  owner.check();
  const key = pendingOpsSlot(owner.accountId);
  if (!key) return; // no account context yet — nothing safe to namespace under
  try {
    const cur = JSON.parse(localStorage.getItem(key) || "[]");
    const arr = Array.isArray(cur) ? cur : [];
    arr.push({ op, collectionKey, payload, ts: Date.now(), queueId: crypto.randomUUID() });
    // Bound the queue so one permanently-failing op can't grow without limit.
    localStorage.setItem(key, JSON.stringify(arr.slice(-PENDING_OPS_CAP)));
  } catch { /* storage unavailable — best effort */ }
}

// Low-level, non-queuing writes used by the replay pass. They return a bool so
// replay can drop only the ops that actually landed and keep the rest.
async function sbUpsertRow(userId, collectionKey, item, owner) {
  if (!item?.id) return true; // nothing addressable — drop it
  const table = tableName(collectionKey);
  const row = toSnakeObj(item);
  for (const f of SKIP_FIELDS) delete row[f];
  row.user_id = userId;
  row.created_at = row.created_at || new Date().toISOString();
  row.updated_at = row.updated_at || new Date().toISOString();
  if (collectionKey === "documents" && item.data) {
    const path = await uploadForOwner(item, owner);
    if (!path) return false;
    row.storage_path = path;
    row.mime_type = item.type || null;
    row.size_bytes = item.size || null;
  }
  const { error } = await writeRequest(owner, () => owner.db.from(table).upsert(row, { onConflict: "id" }));
  return !error;
}
async function sbDeleteRow(userId, collectionKey, itemId, owner) {
  if (!itemId) return true;
  const table = tableName(collectionKey);
  const { error } = await writeRequest(owner, () => owner.db.from(table).delete().eq("id", itemId).eq("user_id", userId));
  return !error;
}
async function sbTombstoneRow(userId, collectionKey, itemId, owner) {
  if (!itemId) return true;
  const { error } = await writeRequest(owner, () => owner.db.from("deleted_items").upsert(
    { item_id: itemId, user_id: userId, collection: collectionKey },
    { onConflict: "item_id" }
  ));
  return !error;
}

// Replay the queued writes for this account, in order, dropping each only on
// success. Call after the profile is known and BEFORE loadFromSupabase, so the
// replayed rows are part of the cloud snapshot the merge then reads back.
const replayInFlight = new Map();
export function replayPendingOps(profileId, authUserId = getActiveUserId() || clerkSub()) {
  const key = pendingOpsSlot(authUserId);
  if (replayInFlight.has(key)) return replayInFlight.get(key);
  const task = replayForOwner(profileId, authUserId).finally(() => replayInFlight.delete(key));
  replayInFlight.set(key, task);
  return task;
}

async function replayForOwner(profileId, authUserId) {
  if (!supabase || !profileId) return;
  let owner;
  try { owner = writeContext(authUserId); }
  catch (error) { if (error.code === "membership_account_changed") return; throw error; }
  const key = pendingOpsSlot(owner.accountId);
  if (!key) return;
  let ops;
  try { ops = JSON.parse(localStorage.getItem(key) || "[]"); } catch { ops = null; }
  if (!Array.isArray(ops) || ops.length === 0) return;
  // Give legacy operations identities before awaiting. Remove only completed
  // IDs from a fresh read, preserving appended work (including identical rows).
  ops = ops.map(op => ({ ...op, queueId: op.queueId || crypto.randomUUID() }));
  try { localStorage.setItem(key, JSON.stringify(ops)); } catch { return; }
  const completed = new Set();
  for (const op of ops) {
    try { owner.guard(); } catch { break; }
    // Keep denied operations in their original account queue for a later authorized sync.
    const permitted = op.op === "settings" ? allowsSettingsChange(op.payload)
      : accessAuthority.allowsMutation(op.collectionKey, typeof op.payload === "object" ? op.payload : { id: op.payload }, null, owner.accountId);
    const documentReplayAllowed = op.collectionKey !== "documents" || ["credential", "practice"].every(scope => accessAuthority.allows(scope, "write", owner.accountId));
    if (!permitted || !documentReplayAllowed) continue;
    const item = typeof op.payload === "object" ? op.payload : { id: op.payload };
    const previous = accessAuthority.previousRecord(op.collectionKey, item?.id, owner.accountId);
    owner.check = op.op === "settings" ? () => guardSettings(owner, op.payload)
      : () => {
        guardRecord(owner, op.collectionKey, item, previous, true);
        if (op.collectionKey === "documents" && !["credential", "practice"].every(scope => accessAuthority.allows(scope, "write", owner.accountId))) throw membershipWriteError();
      };
    let ok = false;
    try {
      if (op.op === "upsert") {
        ok = await sbUpsertRow(profileId, op.collectionKey, op.payload, owner);
      } else if (op.op === "delete") {
        ok = await sbDeleteRow(profileId, op.collectionKey, op.payload, owner);
        if (ok) ok = await sbTombstoneRow(profileId, op.collectionKey, op.payload, owner);
      } else if (op.op === "settings") {
        // Reapply the queued settings patch to the profile row. Later queued
        // patches overwrite earlier ones in replay order, which is the same
        // last-wins the live path has.
        try {
          const row = settingsToProfileRow(op.payload || {});
          row.updated_at = new Date().toISOString();
          const { error } = await writeRequest(owner, () => owner.db.from("profiles").update(row).eq("id", profileId));
          // A duplicate email (profiles_email_unique_key, 20260903e) is the one
          // failure retrying cannot fix: another account holds that address and
          // still will next time. Replay everything else rather than dropping
          // the physician's whole queued patch over one refused field.
          if (error && error.code === "23505" && "email" in row) {
            const { email: _refused, ...rest } = row;
            const retry = await writeRequest(owner, () => owner.db.from("profiles").update(rest).eq("id", profileId));
            ok = !retry.error;
          } else {
            ok = !error;
          }
        } catch { ok = false; }
      } else if (op.op === "tombstone") {
        ok = await sbTombstoneRow(profileId, op.collectionKey, op.payload, owner);
      } else {
        ok = true; // unknown op shape — discard rather than retry forever
      }
    } catch { ok = false; }
    if (ok) completed.add(op.queueId);
  }
  try {
    const current = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(current)) return;
    const remaining = current.filter(op => !completed.has(op.queueId));
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
export async function saveSettings(userId, settings, authUserId) {
  const owner = writeContext(authUserId);
  owner.check = () => guardSettings(owner, settings);
  owner.check();
  saveDeviceKeys(owner.accountId, settings);
  if (!supabase || !userId) {
    // Offline (or before the profile loads) a settings edit has nowhere to
    // go and used to vanish on the next cloud merge. Queue it like any other
    // write; replay applies it once the session is back. Device-local keys
    // are stripped the same way every cloud write strips them.
    const clean = { ...settings };
    for (const f of DEVICE_KEY_FIELDS) delete clean[f];
    queuePendingOp("settings", "settings", clean, owner);
    return null;
  }
  const row = settingsToProfileRow(settings);
  row.updated_at = new Date().toISOString();
  // Read the row back so a server-enforced value (e.g. the identity lock on
  // email) is surfaced instead of being silently cached as whatever we sent.
  const { data, error } = await writeRequest(owner, () => owner.db
    .from("profiles")
    .update(row)
    .eq("id", userId)
    .select()
    .maybeSingle());
  owner.check();
  if (error) {
    // A taken email is a decision, not an outage, so it is never queued for
    // retry. But the update carries the whole profile, so dropping it whole
    // would silently lose the name, NPI, phone and everything else the
    // physician just typed. Retry once without the email; only the address is
    // refused, and the caller is told which field did not save.
    if (error.code === "23505" && "email" in row) {
      const { email: refused, ...rest } = row;
      const retry = await writeRequest(owner, () => owner.db.from("profiles").update(rest).eq("id", userId).select().maybeSingle());
      owner.check();
      if (!retry.error) {
        console.warn("That email is on another CredentialDOMD account, so it was not saved. Everything else was.", { refused });
        return { savedExcept: "email" };
      }
      console.warn("Failed to save settings:", retry.error.message);
      const clean = { ...settings }; delete clean.email;
      for (const f of DEVICE_KEY_FIELDS) delete clean[f];
      queuePendingOp("settings", "settings", clean, owner);
      return null;
    }
    console.warn("Failed to save settings:", error.message);
    const clean = { ...settings };
    for (const f of DEVICE_KEY_FIELDS) delete clean[f];
    queuePendingOp("settings", "settings", clean, owner);
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

export async function uploadDocumentFile(item, authUserId) {
  const owner = recordContext("documents", item, undefined, true, authUserId);
  return uploadForOwner(item, owner);
}

async function uploadForOwner(item, owner) {
  owner.check();
  if (!supabase || !item?.data) return null;
  const path = `${owner.accountId}/${item.id}`;
  const blob = dataUrlToBlob(item.data);
  if (!blob) return null;
  const { error } = await writeRequest(owner, () => owner.db.storage.from("documents")
    .upload(path, blob, { contentType: item.type || blob.type, upsert: true }));
  owner.check();
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
  const owner = recordContext(collectionKey, item);
  // No cloud target yet (offline / local dev): queue so it isn't lost.
  if (!supabase || !userId) { queuePendingOp("upsert", collectionKey, item, owner); return; }
  const table = tableName(collectionKey);
  const row = toSnakeObj(item);
  // Remove fields not in DB
  for (const f of SKIP_FIELDS) delete row[f];
  row.user_id = userId;
  row.created_at = row.created_at || new Date().toISOString();
  row.updated_at = new Date().toISOString();
  // Documents: push the file bytes to Storage and record where they live.
  if (collectionKey === "documents" && item.data) {
    const path = await uploadForOwner(item, owner);
    if (!path) { queuePendingOp("upsert", collectionKey, item, owner); return; }
    row.storage_path = path;
    row.mime_type = item.type || null;
    row.size_bytes = item.size || null;
  }
  const { error } = await writeRequest(owner, () => owner.db.from(table).insert(row));
  owner.check();
  if (error) {
    console.warn(`Failed to insert ${collectionKey}:`, error.message);
    queuePendingOp("upsert", collectionKey, item, owner);
  }
}

export async function updateItem(userId, collectionKey, item, previous, authUserId) {
  const owner = recordContext(collectionKey, item, previous, true, authUserId);
  if (!supabase || !userId) { queuePendingOp("upsert", collectionKey, item, owner); return; }
  const table = tableName(collectionKey);
  const row = toSnakeObj(item);
  for (const f of SKIP_FIELDS) delete row[f];
  delete row.user_id;
  delete row.created_at;
  row.updated_at = new Date().toISOString();
  const { error } = await writeRequest(owner, () => owner.db
    .from(table)
    .update(row)
    .eq("id", item.id)
    .eq("user_id", userId));
  owner.check();
  if (error) {
    console.warn(`Failed to update ${collectionKey}:`, error.message);
    // Replay as an upsert: if the row was never inserted (a failed add), the
    // update would no-op, so upsert recovers both cases.
    queuePendingOp("upsert", collectionKey, item, owner);
  }
}

export async function deleteItem(userId, collectionKey, itemId, previous) {
  const owner = recordContext(collectionKey, previous || { id: itemId }, previous, true);
  if (!supabase || !userId) { queuePendingOp("delete", collectionKey, itemId, owner); return; }
  if (collectionKey === "documents") {
    const path = `${owner.accountId}/${itemId}`;
    // Await the removal so a failure is visible (and can be swept) instead of
    // silently orphaning the stored object.
    if (path) {
      const { error: rmErr } = await writeRequest(owner, () => owner.db.storage.from("documents").remove([path]));
      owner.check();
      if (rmErr) console.warn("Document file delete failed (object may orphan):", rmErr.message);
    }
  }
  const table = tableName(collectionKey);
  const { error } = await writeRequest(owner, () => owner.db
    .from(table)
    .delete()
    .eq("id", itemId)
    .eq("user_id", userId));
  owner.check();
  if (error) {
    console.warn(`Failed to delete ${collectionKey}:`, error.message);
    queuePendingOp("delete", collectionKey, itemId, owner);
  }
}

// ─── Bulk sync (for initial migration from localStorage) ─────
export async function bulkSync(userId, collectionKey, items, authUserId) {
  const owner = writeContext(authUserId);
  const previous = items.map(item => accessAuthority.previousRecord(collectionKey, item?.id, owner.accountId));
  owner.check = () => items.forEach((item, index) => guardRecord(owner, collectionKey, item, previous[index], true));
  owner.check();
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
  const { error } = await writeRequest(owner, () => owner.db.from(table).upsert(rows, { onConflict: "id" }));
  owner.check();
  if (error) {
    // One bad row must not strand the rest — retry each row alone so the
    // failure is contained to the row that actually has the problem.
    console.warn(`Bulk sync ${collectionKey} failed (${error.message}) — retrying row-by-row`);
    for (const row of rows) {
      const { error: e2 } = await writeRequest(owner, () => owner.db.from(table).upsert(row, { onConflict: "id" }));
      owner.check();
      if (e2) console.warn(`Row ${row.id} of ${collectionKey} still failing:`, e2.message);
    }
  }
}

// ─── Deletion ledger ─────────────────────────────────────────
// A delete recorded here is final across all devices: loads prune these ids
// and the self-healing push skips them, so stale devices can't resurrect.
export async function recordTombstone(userId, collectionKey, itemId, previous) {
  const owner = recordContext(collectionKey, previous || { id: itemId }, previous, true);
  if (!itemId) return;
  if (!supabase || !userId) { queuePendingOp("tombstone", collectionKey, itemId, owner); return; }
  const { error } = await writeRequest(owner, () => owner.db.from("deleted_items").upsert(
    { item_id: itemId, user_id: userId, collection: collectionKey },
    { onConflict: "item_id" }
  ));
  owner.check();
  if (error) {
    console.warn("Failed to record deletion:", error.message);
    queuePendingOp("tombstone", collectionKey, itemId, owner);
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
  const { error: profileErr } = await supabase
    .from("profiles")
    .update({
      // Derived from the sync map, so a column added to SETTINGS_TO_PROFILE
      // is always cleared here too — a hand-kept list silently drifted before.
      ...Object.fromEntries(Object.values(SETTINGS_TO_PROFILE).map(col => [col, null])),
      specialties: "[]", additional_states: "[]",
      theme: "dark", font_size: "M", reminder_lead_days: 90,
      notify_email: true, notify_text: true, notify_freq_days: 7,
      // The two NOT NULL columns in the sync map. A null here fails the whole
      // UPDATE (23502) and leaves name, email and NPI on the row while the UI
      // reports the account emptied; that happened when ack_requests joined
      // the map without joining this list. Checked by
      // scripts/delete-account.test.mjs.
      backup_monthly: true,
      ack_requests: true,
      cme_verification_results: "{}", cme_verification_alerted: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);
  if (profileErr) console.error("profile reset failed:", profileErr.message);
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
// The profile's deleted_at stamp then tells every device, on its next
// sign-in, to drop the cache it holds from before the wipe (AppContext,
// WIPE_SEEN_KEY). The stamp stays on the row; each device remembers which
// one it has honored.
