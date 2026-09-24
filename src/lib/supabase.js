import { accessAuthority, allowsSettingsChange, membershipWriteError } from "../utils/limitedLaunchAccess.js";
import { createClient } from "@supabase/supabase-js";
// Extensions are explicit on purpose: node resolves these specifiers as
// written, which is what lets scripts/device-secrets.test.mjs import the real
// redaction and the real hydration allowlist instead of a copy of them.
import { STORAGE_KEY } from "../constants/defaults.js";
import { BASE_KEYS, DEVICE_KEYS_BASE, getActiveUserId } from "../utils/storageScope.js";
import { foundingFromProfile } from "../utils/founding.js";
import { createLimitedLaunchClient } from "../utils/limitedLaunchClient.js";
import { createContinuityBinding, recoverContinuity, PRODUCTION_CLERK_ISSUER } from "../utils/continuityRecovery.js";
import { getLockCode, saveLockCode, configureSecretContinuity } from "../utils/secretBox.js";
import { profileInitializationError } from "../utils/profileIssueDiagnostics.js";

// The typeof guard is the same one src/constants/defaults.js carries, and for
// the same reason: this module owns redactForExport, which the export paths and
// the pure-node test scripts (scripts/device-secrets.test.mjs) both import, and
// import.meta.env does not exist outside Vite. Vite still statically replaces
// the member expression at build time.
export const CLERK_CONTINUITY_ENABLED = import.meta.env?.VITE_CLERK_CONTINUITY_ENABLED === "true";
const SUPABASE_URL =
  (typeof import.meta.env !== "undefined" && import.meta.env.VITE_SUPABASE_URL) || undefined;
const SUPABASE_ANON_KEY =
  (typeof import.meta.env !== "undefined" && import.meta.env.VITE_SUPABASE_ANON_KEY) || undefined;

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

// Invalidate requests already in flight before an explicit local purge. Clerk
// signout is asynchronous, so session identity alone cannot mark that boundary.
const writeGenerations = new Map();
export function invalidateAccountWrites(accountId) {
  if (accountId) writeGenerations.set(accountId, (writeGenerations.get(accountId) || 0) + 1);
}

// Each write keeps its initiating identity through token minting, fetch, and
// follow-up requests. A shared client would obtain the *new* session's token.
function writeContext(authUserId = getActiveUserId() || clerkSub(), { cloud = true } = {}) {
  const accountId = authUserId;
  const writeGeneration = writeGenerations.get(accountId) || 0;
  const activeId = getActiveUserId();
  const clerkId = clerkSub();
  const session = globalThis.window?.Clerk?.session || null;
  const guard = () => {
    const active = getActiveUserId(), current = clerkSub();
    if (!accountId || (writeGenerations.get(accountId) || 0) !== writeGeneration || (active && active !== accountId) || (activeId && active !== activeId)
      || (current && current !== accountId) || (clerkId && current !== clerkId)
      || ((session?.user?.id || session?.userId) && (session.user?.id || session.userId) !== accountId)
      || (globalThis.window?.Clerk?.session || null) !== session) throw accountChangedError();
  };
  guard();
  const owner = { accountId, guard, check: guard, db: null };
  if (supabase && cloud) owner.db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
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
  // Categories a physician, Vera or the uploader created, and the records in
  // them. Credential scope. Migration 20260925010000_custom_categories.sql;
  // scripts/check-tables-exist.mjs refuses a deploy if either table is missing.
  customCategories: "custom_categories",
  customRecords: "custom_records",
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

// settingsToProfileRow / profileRowToSettings are exported for
// scripts/settings-persistence.test.mjs: which settings survive a round trip
// through the cloud is exactly the kind of thing that looks right in review
// and is silently lossy in production (see LOCAL_ONLY_SETTINGS below).
export function settingsToProfileRow(settings) {
  const row = {};
  for (const [settingsKey, col] of Object.entries(SETTINGS_TO_PROFILE)) {
    if (settings[settingsKey] !== undefined) {
      row[col] = settings[settingsKey];
    }
  }
  return row;
}

export function profileRowToSettings(row) {
  const settings = {};
  for (const [col, settingsKey] of Object.entries(PROFILE_TO_SETTINGS)) {
    if (row[col] !== undefined && row[col] !== null) {
      settings[settingsKey] = row[col];
    }
  }
  // Read-only, server-owned: the beta gate. Never written back (not in the map).
  if (row.access_status) settings.accessStatus = row.access_status;
  // Read-only, server-owned: the mailbox the sign-in provider reported as
  // verified. clerk-webhook stamps it with the service role and
  // profiles_lock_verified_email freezes it against user tokens (migration
  // 20260915d). email-inbound routes forwarded mail on it, so the browser has
  // to be able to see it: without it, routableSenders always assumed the
  // account address was unconfirmed and Settings and Requests both told a
  // physician whose mail was routing fine that nothing reached them. Never
  // written back: it is not in SETTINGS_TO_PROFILE, and the trigger on the
  // table would drop it even if it were.
  if (row.verified_email) settings.verifiedEmail = row.verified_email;
  // Read-only, server-owned: founding member number and flag, assigned by
  // Postgres when the physician signs up and is activated (migration
  // 20260902g_founding_members.sql). Never written back (not in the map).
  Object.assign(settings, foundingFromProfile(row));
  return settings;
}

/**
 * Settings the cloud has no column for, so a cloud read cannot carry them.
 *
 * settingsToProfileRow writes only what SETTINGS_TO_PROFILE names; anything
 * else is dropped without a word. That is fine for a value the device also
 * keeps, and it was silently destructive for these two, which only the device
 * keeps: loadFromSupabase rebuilds settings from the profile row, AppContext
 * merges DEFAULT_SETTINGS with that row, and then caches the result over the
 * on-device copy. A physician who set "Vera answers with: Claude Opus" got it
 * for exactly as long as they stayed offline; the next online load put Vera
 * back on Gemini and the dropdown back to "Gemini (cheaper, the default)",
 * with nothing said. coderModel rides the same path and is listed for the
 * same reason, not because it has failed yet.
 *
 * Deliberately NOT in DEFAULT_SETTINGS: a default would make the merged value
 * defined, the carry-forward below would find nothing missing, and the
 * physician's choice would still be lost. The readers already treat absent as
 * their own default (SettingsSection reads `s.coderModel || "opus"` and
 * `s.assistantModel || "gemini"`).
 *
 * Device keys are not here. They are local-only too, but loadFromSupabase
 * hydrates them from the per-user device slot (loadDeviceKeys), which is a
 * stronger place than the cached settings blob.
 */
export const LOCAL_ONLY_SETTINGS = ["assistantModel", "coderModel"];

/**
 * Cloud settings, plus the local-only keys the cloud never stored.
 *
 * Only the named keys, and only where the cloud has nothing to say: merging
 * all of the cached settings would resurrect values the physician deleted on
 * another device, which is the bug the namespaced cache exists to avoid.
 */
export function withLocalOnlySettings(cloudSettings, localSettings) {
  const out = { ...(cloudSettings || {}) };
  if (!localSettings || typeof localSettings !== "object") return out;
  for (const k of LOCAL_ONLY_SETTINGS) {
    if (out[k] === undefined && localSettings[k] !== undefined) out[k] = localSettings[k];
  }
  return out;
}

// ─── Device-local AI keys ────────────────────────────────────
// Gemini / Anthropic keys are per device and per Clerk user. They ride in
// settings state like before (every reader keeps working) but persist to a
// per-user localStorage slot and are stripped from every cloud write.
// The CallSync calendar link (a per-user token) and the agreement it syncs
// onto ride the same slot: secrets stay on the device.
export const DEVICE_KEY_FIELDS = ["apiKey", "anthropicApiKey", "callsyncFeedUrl", "callsyncContractId"];
const deviceKeySlot = (authUserId) => `${DEVICE_KEYS_BASE}:${authUserId}`;

// The unlock material that shares the device slot. secretBox.js keeps the
// portal-password lock code there (same DEVICE_KEYS_BASE slot as the AI keys)
// and it is deliberately NOT in DEVICE_KEY_FIELDS: nothing hydrates it into
// settings any more, and nothing reads it from there. It is named here because
// an export, or a cache written by an older build, can still hold a copy.
export const UNLOCK_FIELDS = ["lockCode"];

// The ONE list an export is redacted against. DataExport.jsx and
// credentialExport.js each carried their own hand-written
// `const { apiKey, anthropicApiKey, ...safe }` strip, and two hand-maintained
// lists is exactly how the lock code and the CallSync feed link ended up in a
// downloaded backup: neither list was updated when the slot grew.
export const EXPORT_REDACT_FIELDS = [...DEVICE_KEY_FIELDS, ...UNLOCK_FIELDS];

/**
 * Settings with every device-only field removed: the two AI keys, the CallSync
 * feed link and contract id, and the lock code that opens the encrypted portal
 * passwords. The only redaction any export path may use.
 */
export function redactForExport(settings) {
  const safe = { ...(settings || {}) };
  for (const f of EXPORT_REDACT_FIELDS) delete safe[f];
  return safe;
}

/**
 * The allowlist that decides what may be hydrated back into settings.
 *
 * The slot holds more than the AI keys, and loadDeviceKeys used to spread all
 * of it into settings: the lock code rode along, was cached to disk by
 * saveData, and was written into the downloaded JSON export beside the very
 * ciphertext it opens. The code keeps working because secretBox.getLockCode
 * reads the slot directly (src/utils/secretBox.js line 22), never settings.
 */
function pickDeviceFields(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const f of DEVICE_KEY_FIELDS) if (obj[f]) out[f] = obj[f];
  return out;
}

/**
 * Strip every device-only field out of ONE parsed cache blob.
 *
 * The one place the rule is written, so the three callers cannot drift: the
 * localStorage scrub below, and readCachedData / loadData in
 * src/utils/storage.js, which have to apply it to what they RETURN as well as
 * to what is on disk. Returning a blob unsanitised and rewriting the disk copy
 * afterwards leaves the secret in the object the app then renders, saves and
 * exports from, which is most of the way back to the original defect.
 *
 * `trusted` says whether this blob is known to belong to authUserId. Only a
 * trusted blob may hand its lock code back to the device slot: on a shared
 * device an un-namespaced file can belong to whoever used the machine before,
 * and adopting their unlock material is worse than dropping our own. The lock
 * code is the only way to read this account's encrypted portal passwords, so
 * recovering it from a trusted copy before deleting it is what keeps the vault
 * readable.
 *
 * Returns { blob, changed }. `changed` is false when there was nothing to
 * strip, which is the common case and means no rewrite is needed.
 */
export function sanitizeCachedBlob(blob, authUserId, { trusted = false } = {}) {
  const settings = blob?.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { blob, changed: false };
  if (!EXPORT_REDACT_FIELDS.some((f) => f in settings)) return { blob, changed: false };

  // MIGRATE BEFORE SCRUBBING. This order is the whole correctness of the
  // function and it was wrong for a day: the scrub ran first, and
  // loadDeviceKeys' one-time adoption then found an already-cleaned blob, so a
  // physician whose keys lived only in a pre-slot cache lost all four device
  // fields on the next load. They are not recoverable from anywhere else: the
  // AI keys are the user's own, and callsyncFeedUrl is a per-user calendar
  // feed token. Reproduced for a localStorage-only cache and for a
  // Capacitor-only one before this was written.
  //
  // Only a TRUSTED blob may donate. Trusted means this file is namespaced to
  // authUserId, so its contents are that account's own. The un-namespaced
  // pre-namespace blob is never trusted: on a shared device it can belong to
  // whoever used the machine before, and adopting their key bills one
  // physician's Anthropic account to another and pulls the wrong call
  // schedule. That refusal is unchanged; this only adds the case where the
  // file demonstrably IS ours.
  if (trusted && authUserId) {
    // Field by field, and only where the slot has nothing. A value already in
    // the slot is the current one; a value in an old cache is at best equally
    // old, so it must never overwrite.
    const have = loadDeviceKeys(authUserId, { adopt: false });
    const donate = {};
    for (const f of DEVICE_KEY_FIELDS) {
      if (settings[f] && !have[f]) donate[f] = settings[f];
    }
    if (Object.keys(donate).length) saveDeviceKeys(authUserId, donate);

    // The lock code is the only way to read this account's encrypted portal
    // passwords, so recovering it before the delete is what keeps the vault
    // readable. It is deliberately NOT in DEVICE_KEY_FIELDS: nothing hydrates
    // it into settings, and secretBox reads the slot directly.
    if (settings.lockCode && !getLockCode(authUserId)) {
      saveLockCode(settings.lockCode, authUserId);
    }
  }

  const clean = { ...settings };
  for (const f of EXPORT_REDACT_FIELDS) delete clean[f];
  return { blob: { ...blob, settings: clean }, changed: true };
}

/**
 * Settings with every device-only field removed, for a settings object that is
 * already in hand. Same list, same rule; this is the shape storage.js needs
 * when it is rebuilding settings rather than a whole blob.
 */
export function stripDeviceFields(settings) {
  const clean = { ...(settings || {}) };
  for (const f of EXPORT_REDACT_FIELDS) delete clean[f];
  return clean;
}

/**
 * Remove device-only material from the copies of the file already on this disk.
 *
 * Before the allowlist above, the lock code reached settings and saveData
 * (src/utils/storage.js) cached everything it was not explicitly told to drop,
 * so a blob written by an older build still holds it; a blob written before the
 * CallSync link joined DEVICE_KEY_FIELDS still holds that link. Both are
 * rewritten out of the stored blob here. Every other cached key is left exactly
 * as it was: this file is what a physician offline reads their records from.
 */
function scrubCachedSecrets(authUserId) {
  // This account's own namespaced blob, and the un-namespaced pre-namespace
  // one, which is the only other copy this device could be holding.
  for (const key of [STORAGE_KEY, `${STORAGE_KEY}:${authUserId}`]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const { blob, changed } = sanitizeCachedBlob(JSON.parse(raw), authUserId, { trusted: key !== STORAGE_KEY });
      if (!changed) continue;
      localStorage.setItem(key, JSON.stringify(blob));
    } catch { /* corrupt, or storage unavailable: nothing safe to rewrite */ }
  }
}

export function loadDeviceKeys(authUserId, { adopt = true } = {}) {
  if (!authUserId) return {};
  let found = {};
  try {
    const raw = localStorage.getItem(deviceKeySlot(authUserId));
    if (raw) found = pickDeviceFields(JSON.parse(raw));
  } catch { /* ignore */ }

  // adopt:false is the plain read of the slot, with no legacy adoption and no
  // scrub. sanitizeCachedBlob uses it to ask "does the slot already have this
  // field" while it is migrating one, which would otherwise re-enter here.
  if (!adopt) return found;

  // One-time adoption: keys used to live inside the synced settings blob.
  // Only ever read THIS ACCOUNT's own namespaced copy.
  //
  // The un-namespaced blob used to be first in this list, and the same trust
  // rule scrubCachedSecrets states twenty lines above applies here: on a
  // shared device that file can belong to whoever used the machine before,
  // and it is not this account's by default. The fields at stake are not only
  // the two AI keys, since callsyncFeedUrl is a per-user calendar feed token, so
  // adopting it billed one physician's Anthropic key to another and pulled
  // the wrong call schedule, and the scrub that runs straight afterwards
  // deleted the evidence from the blob.
  //
  // The price is the same one the lock code already pays: on a device that
  // never ran a namespaced build, the AI key and the CallSync link in that
  // file are scrubbed rather than carried over, and the physician types the
  // key in again once. Dropping a key is recoverable in a minute; handing a
  // colleague's key and calendar feed to the wrong account is not.
  if (!Object.keys(found).length) {
    try {
      const cached = JSON.parse(localStorage.getItem(`${STORAGE_KEY}:${authUserId}`) || "null");
      found = pickDeviceFields(cached?.settings);
      // Merged, not written whole: the slot may also hold the lock code, and
      // overwriting it with the adopted keys alone would take the physician's
      // encrypted portal passwords with it.
      if (Object.keys(found).length) saveDeviceKeys(authUserId, found);
    } catch { /* ignore */ }
  }

  // Runs on every load, whatever the slot held: the contamination is in the
  // cached file, and it outlives the load that created it.
  scrubCachedSecrets(authUserId);
  return found;
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
async function sbFavoriteRow(userId, collectionKey, item, owner) {
  if (!item?.id) return true; // nothing addressable — drop it
  const table = tableName(collectionKey);
  const { error } = await writeRequest(owner, () => owner.db
    .from(table)
    .update({ favorite: !!item.favorite })
    .eq("id", item.id)
    .eq("user_id", userId));
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
      } else if (op.op === "favorite") {
        ok = await sbFavoriteRow(profileId, op.collectionKey, op.payload, owner);
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
export async function ensureProfile(userId, { isCurrent = () => true } = {}) {
  if (!supabase || !userId) return null;
  const owner = writeContext(userId);
  owner.check = () => { owner.guard(); if (!isCurrent()) throw accountChangedError(); };
  owner.check();
  let initializedProfileId = null;
  if (CLERK_CONTINUITY_ENABLED) {
    const session = globalThis.window?.Clerk?.session;
    const authenticatedAt = Date.now();
    let stage = "initialize";
    try {
      // This endpoint authenticates the production JWT and resolves legacy
      // identity server-side before it may create an ordinary fresh profile.
      const receipt = await createLimitedLaunchClient({ accountId: userId, enabled: true }).initializeProfile();
      owner.check();
      initializedProfileId = receipt.profileId;
      configureSecretContinuity(null);
      if (receipt.continuity) {
        stage = "binding";
        const binding = createContinuityBinding(receipt, { subject: userId, issuer: PRODUCTION_CLERK_ISSUER,
          session, authenticatedAt, isCurrent: () => {
            try { owner.check(); return globalThis.window?.Clerk?.session === session; } catch { return false; }
          } });
        stage = "recovery";
        let recovered;
        try { recovered = await recoverContinuity(binding); }
        catch (error) {
          // A deliberate purge retires device migration, not the physician's
          // cloud account or the verified legacy password derivation.
          if (error.code !== "continuity_recovery_retired") throw error;
          recovered = { state: "complete", conflicts: [] };
        }
        owner.check();
        if (recovered.state !== "complete" || recovered.conflicts.length) {
          const error = new Error("continuity_recovery_conflict");
          error.code = "continuity_recovery_conflict";
          throw error;
        }
        stage = "binding";
        configureSecretContinuity(binding);
      }
    } catch (cause) {
      owner.check();
      throw profileInitializationError(stage, cause);
    }
  }
  const lookup = () => writeRequest(owner, () => owner.db.from("profiles")
    .select("*").eq("auth_user_id", userId).maybeSingle());
  let existing;
  try { existing = await lookup(); }
  catch (cause) {
    owner.check();
    if (initializedProfileId) throw profileInitializationError("profile", cause);
    throw cause;
  }
  owner.check();
  // A failed read is not permission to create another account.
  if (initializedProfileId && (existing.error || existing.data?.id !== initializedProfileId || existing.data?.auth_user_id !== userId)) {
    const cause = existing.error || { code: existing.data ? "profile_mismatch" : "profile_missing" };
    throw profileInitializationError("profile", cause, existing.status);
  }
  if (existing.error) throw new Error("Your account could not be loaded. Please try again.");
  if (existing.data) return existing.data;

  // The disabled legacy path creates only an ordinary pending profile. When
  // continuity is enabled, the exact initialized row must already exist above.
  const { data: created, error } = await writeRequest(owner, () => owner.db
    .from("profiles").insert({ id: crypto.randomUUID(), auth_user_id: userId }).select().single());
  owner.check();
  if (!error) return created;
  // A concurrent Clerk webhook may have created exactly this subject's row.
  // The retry retains the same account and session through token and fetch.
  if (error.code === "23505") {
    const again = await lookup();
    owner.check();
    if (!again.error && again.data) return again.data;
  }
  throw new Error("Your account could not be initialized. Please try again.");
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
    // write; replay applies it once the session is back. Device-local material
    // is stripped through the one redaction, so a queued patch sitting on disk
    // holds no more than a cloud write would.
    const clean = redactForExport(settings);
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
      const clean = redactForExport(settings); delete clean.email;
      queuePendingOp("settings", "settings", clean, owner);
      return null;
    }
    console.warn("Failed to save settings:", error.message);
    const clean = redactForExport(settings);
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

// Blob variant. downloadDocumentFile below re-encodes the same bytes as a
// base64 data URL, which costs roughly five copies of the file in memory once
// the caller decodes it again. Anything that only needs a File should use this.
export async function downloadDocumentBlob(storagePath) {
  if (!supabase || !storagePath) return null;
  const { data, error } = await supabase.storage.from("documents").download(storagePath);
  if (error || !data) return null;
  return data;
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

// A star is not an edit.
//
// This sends the `favorite` column ALONE and never touches updated_at. Routing
// it through updateItem would do two harmful things: it stamps a fresh
// updated_at, so a star tapped on a stale or offline phone would beat a real
// expiration-date edit made elsewhere in the self-heal comparison; and it sends
// the whole row, so one rejected column would reject the record's other edits
// with it. The queued replay op is narrow for the same reason.
export async function setFavorite(userId, collectionKey, item, favorite, authUserId) {
  const payload = { id: item?.id, favorite: !!favorite };
  const owner = recordContext(collectionKey, { ...item, favorite: !!favorite }, item, true, authUserId);
  if (!supabase || !userId) { queuePendingOp("favorite", collectionKey, payload, owner); return; }
  const ok = await sbFavoriteRow(userId, collectionKey, payload, owner);
  owner.check();
  if (!ok) {
    console.warn(`Failed to set favorite on ${collectionKey}`);
    queuePendingOp("favorite", collectionKey, payload, owner);
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
const deletionContexts = new WeakSet();

// Capture once when the owner opens confirmation. Data rights do not depend
// on paid membership; the caller also pins its displayed profile/load generation.
export function createDataDeletionContext(authUserId, profileId, { offline = false, isCurrent, onStart } = {}) {
  const owner = writeContext(authUserId, { cloud: !offline && !!profileId });
  owner.profileId = profileId || null;
  const guard = owner.guard;
  owner.check = () => {
    guard();
    if (isCurrent && !isCurrent()) throw accountChangedError();
  };
  let started = false;
  owner.start = () => {
    owner.check();
    if (!started) {
      onStart?.();
      started = true;
    }
    owner.check();
  };
  owner.check();
  deletionContexts.add(owner);
  return Object.freeze(owner);
}

function assertDeletionContext(owner, profileId = owner?.profileId) {
  if (!owner || !deletionContexts.has(owner) || owner.profileId !== profileId) throw accountChangedError();
  owner.check();
}

export function isCurrentDataDeletionContext(owner) {
  try { assertDeletionContext(owner); return true; }
  catch { return false; }
}

export async function deleteAllData(userId, owner) {
  assertDeletionContext(owner, userId);
  if (!owner.db || !userId) return;
  // Tombstone every id BEFORE deleting: deleted_items is not in TABLE_MAP, so
  // it survives the wipe. Without this, another device holding a stale cache
  // re-uploads everything on its next self-heal and the wipe undoes itself.
  const PAGE = 1000;
  for (const [key, table] of Object.entries(TABLE_MAP)) {
    for (let start = 0; ; start += PAGE) {
      const { data: rows, error } = await writeRequest(owner, () => owner.db
        .from(table)
        .select("id")
        .eq("user_id", userId)
        .range(start, start + PAGE - 1));
      owner.check();
      if (error || !rows || rows.length === 0) break;
      await writeRequest(owner, () => owner.db.from("deleted_items").upsert(
        rows.map((r) => ({ item_id: r.id, user_id: userId, collection: key })),
        { onConflict: "item_id" }
      ));
      owner.check();
      if (rows.length < PAGE) break;
    }
  }
  // Delete from all collection tables
  const deletes = Object.values(TABLE_MAP).map((table) =>
    writeRequest(owner, () => owner.db.from(table).delete().eq("user_id", userId))
  );
  await Promise.all(deletes);
  owner.check();
  // Reset profile (keep the row but clear fields)
  const { error: profileErr } = await writeRequest(owner, () => owner.db
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
    .eq("id", userId));
  owner.check();
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
export async function requestAccountDeletion(owner) {
  assertDeletionContext(owner);
  if (!owner.db || !owner.profileId) throw new Error("No cloud profile connection");
  // dry_run false is explicit on purpose: the function treats a missing flag
  // as a dry run and deletes nothing.
  const res = await writeRequest(owner, () => owner.db.functions.invoke("delete-account", { body: { dry_run: false } }));
  owner.check();
  if (res.error) {
    // invoke() reports every non-2xx as the same generic sentence; the
    // useful text is in the response body.
    let msg = "";
    try { msg = (await res.error.context?.json())?.error || ""; } catch { /* not JSON */ }
    owner.check();
    throw new Error(msg || res.error.message || "The server-side deletion did not finish.");
  }
  return res.data;
}
// The profile's deleted_at stamp then tells every device, on its next
// sign-in, to drop the cache it holds from before the wipe (AppContext,
// WIPE_SEEN_KEY). The stamp stays on the row; each device remembers which
// one it has honored.
