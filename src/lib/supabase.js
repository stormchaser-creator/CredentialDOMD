import { accessAuthority, allowsSettingsChange, membershipWriteError } from "../utils/limitedLaunchAccess.js";
import { createClient } from "@supabase/supabase-js";
// Extensions are explicit on purpose: node resolves these specifiers as
// written, which is what lets scripts/device-secrets.test.mjs import the real
// redaction and the real hydration allowlist instead of a copy of them.
import { STORAGE_KEY, LOCAL_ONLY_SETTINGS } from "../constants/defaults.js";
import { BASE_KEYS, DEVICE_KEYS_BASE, getActiveUserId, adoptedLocalFence, localCopyCurrent, localFence, setItemMakingRoom } from "../utils/storageScope.js";
import { foundingFromProfile } from "../utils/founding.js";
import { createLimitedLaunchClient } from "../utils/limitedLaunchClient.js";
import { createContinuityBinding, recoverContinuity, continuitySourceSubject, PRODUCTION_CLERK_ISSUER } from "../utils/continuityRecovery.js";
import { accountDataDeletedAt, honorAccountDataDeletion } from "../utils/dataDeletion.js";
import { getLockCode, saveLockCode, configureSecretContinuity } from "../utils/secretBox.js";
import { profileInitializationError } from "../utils/profileIssueDiagnostics.js";
import { classifyWriteError, writeErrorCode, PERMANENT_RETRY_LIMIT, REQUIRED_COLUMN_DEFAULTS, withRequiredDefaults, documentMime, isUuid, INTEGER_COLUMNS, toIntegerOrNull, rebaseSetupState, closedTaskStamp } from "../utils/syncRules.js";

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

// The same Clerk session: the same object, or one with the same session id
// for the same user. Clerk builds a new Session object for the same session
// whenever it refreshes its client (the touch it sends each time the page
// gets focus, as an iPhone resumes the app); that is not an account change.
// A sign-out leaves none, and a new sign-in is another session id.
// (limitedLaunchClient.js sameClerkSession is the same rule.)
const clerkSessionUser = session => session?.user?.id ?? session?.userId ?? null;
function sameClerkSession(saved, current) {
  if (saved === current) return true;
  if (!saved || !current) return false;
  return typeof saved.id === "string" && saved.id !== "" && current.id === saved.id
    && clerkSessionUser(saved) !== null && clerkSessionUser(current) === clerkSessionUser(saved);
}
const liveClerkSession = () => globalThis.window?.Clerk?.session || null;

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
      || !sameClerkSession(session, liveClerkSession())) throw accountChangedError();
  };
  guard();
  // The purge fence this tab's records were loaded under when the write
  // began (storageScope.js LOCAL_FENCE_KEY). A write that fails after this
  // device purged the account's copy is not queued for replay.
  const owner = { accountId, guard, check: guard, db: null, fence: adoptedLocalFence(accountId) };
  if (supabase && cloud) owner.db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: async () => {
      owner.check();
      if (!session) throw new Error("The signed-in session is unavailable.");
      // The object Clerk holds now for this same session (checked above).
      const live = liveClerkSession() || session;
      let token;
      try { token = await live.getToken({ template: "supabase" }); }
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

function recordContext(key, item, previous, existing = false, authUserId, { keepOnRefusal = false } = {}) {
  const owner = writeContext(authUserId);
  const before = previous || accessAuthority.previousRecord(key, item?.id, owner.accountId);
  const needed = accessAuthority.mutationScopes(key, item, before);
  // guardRecord's rule for an update of unknown provenance (see there).
  if (existing && key === "documents" && !before) needed.push("credential", "practice");
  // The scopes this write was decided on. A write that is queued carries
  // them, so replay decides it on the same ones (replayScopes): a delete
  // queues only the id, and the record is no longer on this device to ask.
  owner.scopes = [...new Set(needed)];
  // A write made before this page load's first membership answer waits for
  // it (awaitAnswer), as a settings save does: kept, never refused for that.
  return authorizeOwner(owner, () => guardRecord(owner, key, item, before, existing),
    options => accessAuthority.statusFor(owner.scopes, owner.accountId, { ...options, awaitAnswer: true }), { keepOnRefusal });
}

// Writes made while the membership answer is being re-checked. The owner of a
// write whose answer is only old, or whose last check failed, inside the grace
// after an active one (limitedLaunchAccess writeStatus "verify"), waits for
// the check it starts (shared by every write waiting then, and decided at the
// same moment as the change held on the device, holdForAccess):
//   allowed        the write goes on as any allowed one, under `strict`;
//   unconfirmed    owner.awaitingAccess: the caller queues it for replay, which
//                  sends it only once a fresh answer allows it (and the
//                  database's write policies still decide it then);
//   refused        owner.authorized rejects with membershipWriteError, and
//                  nothing is sent or queued. With `keepOnRefusal` (a record
//                  of work that already left the app: an invoice sent), it
//                  is queued instead and never taken back: marked refused
//                  (owner.accessRefused) when the answer is read-only, as
//                  replay marks a kept save a later answer refuses, and sent
//                  if the membership allows changes again.
// While it waits, and when it is only queued, owner.check guards the
// identity alone. An allowed write keeps the synchronous path it always had:
// owner.authorized is null.
function authorizeOwner(owner, strict, status, { keepOnRefusal = false } = {}) {
  owner.guard();
  const now = status();
  if (now.status === "refuse") throw membershipWriteError(now.reason);
  owner.authorized = null;
  if (now.status === "allow") { owner.check = strict; owner.check(); return owner; }
  // Waiting for the page load's first answer, not a re-check (writeAheadRecord).
  owner.firstAnswer = now.reason === "no_answer";
  owner.check = owner.guard;
  owner.authorized = accessAuthority.verify().then(at => {
    // An answer's refusal is decided before the identity guard. A session
    // object replaced for the same account fails the guard, yet the screen
    // still takes a refused change back (settleHeldRound: the account is
    // served), so its queued copy must go too (heldForAccess), never stay to
    // be sent on a later load the member was told it was not kept for.
    const settled = status({ at, settled: true });
    // Clerk no longer reports this account (writeStatus "account_changed":
    // a session that ended, another account signed in): not the answer's
    // refusal, so its copy stays for that account's next sign-in (R4.1).
    if (settled.reason === "account_changed") { owner.guard(); throw accountChangedError(); }
    if (settled.status === "refuse" && accessAuthority.serves?.(owner.accountId) !== false) {
      if (keepOnRefusal === true) owner.accessRefused = settled.reason === "read_only";
      else owner.refusedByAnswer = true;
    }
    owner.guard();
    if (settled.status === "refuse") {
      if (keepOnRefusal !== true) throw membershipWriteError(settled.reason);
      owner.awaitingAccess = true;
      owner.accessRefused = settled.reason === "read_only";
      return;
    }
    if (settled.status === "allow") { owner.check = strict; owner.check(); return; }
    owner.awaitingAccess = true;
  });
  // Awaited by the caller; a rejection it never reaches is not unhandled.
  owner.authorized.catch(() => {});
  return owner;
}
// Marks an op queued for want of a membership answer (the notice counts them,
// and a fresh answer replays them without waiting for the next load).
const AWAITING_ACCESS = Object.freeze({ awaitingAccess: true });
// A kept record of work already done outside the app that the answer refused
// (authorizeOwner keepOnRefusal): queued as replay marks a refused kept save.
const KEPT_REFUSED = Object.freeze({ awaitingAccess: true, accessRefused: true });
/**
 * True when this write is to be queued rather than sent (see authorizeOwner).
 * `ahead`: its copy written to the queue before the answer (writeAheadRecord),
 * decided here as the write is: kept (marked refused, for a kept record of
 * work already done that the answer refused) when the write is held, taken
 * off the queue when it is sent or refused.
 */
async function heldForAccess(owner, ahead = null) {
  if (!owner.authorized) return false;
  try { await owner.authorized; }
  catch (error) {
    // The account changed while it waited (a session that ended or was
    // replaced): unless the answer refused it (authorizeOwner
    // owner.refusedByAnswer: the screen took it back), its copy stays on that
    // account's queue for its next load or answer, as when the change comes
    // during the record's turn (insertItem); a kept record of work done keeps
    // its refused mark. An explicit sign-out purged the queue already. Only a
    // refusal takes the copy off.
    if (ahead) {
      if (error?.code === "membership_account_changed" && owner.refusedByAnswer !== true) {
        ahead.kept = true;
        if (owner.accessRefused === true) ahead.mark = { accessRefused: true };
      }
      settleWrittenAhead(owner, ahead);
    }
    throw error;
  }
  const held = owner.awaitingAccess === true;
  if (ahead) {
    ahead.kept = held;
    if (held && owner.accessRefused === true) ahead.mark = { accessRefused: true };
    settleWrittenAhead(owner, ahead);
  }
  return held;
}
/** What a write held by heldForAccess is queued with. */
const heldMeta = owner => (owner.accessRefused === true ? KEPT_REFUSED : AWAITING_ACCESS);

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
  // Was missing: rows were written (tableName() used to fall back to the
  // key) but never loaded back, so the deduction ledger only lived in the
  // device cache and vanished on a fresh load.
  deductibles: "deductibles",
  rotations: "rotations",
  // Categories a physician, Vera or the uploader created, and the records in
  // them. Credential scope. Migration 20260925010000_custom_categories.sql;
  // scripts/check-tables-exist.mjs refuses a deploy if either table is missing.
  customCategories: "custom_categories",
  customRecords: "custom_records",
};

/**
 * Whether a collection has a cloud table. Only a TABLE_MAP key does.
 *
 * tableName() used to fall back to the raw key, so a collection nobody had
 * registered was still "written": Protected Identity (identityVault, kept on
 * the device by design) went to a table named identityVault that does not
 * exist, the failure was queued, and every later load replayed it, sending the
 * legal name and the SSN ciphertext to the REST API again each time. An
 * unregistered key now has no table: nothing is sent, nothing is queued, and
 * anything already queued for one is dropped unsent on the next replay.
 */
export function isSyncedCollection(key) {
  return typeof key === "string" && Object.hasOwn(TABLE_MAP, key);
}

function tableName(key) {
  if (!isSyncedCollection(key)) {
    const error = new Error(`${key} has no cloud table; it stays on this device.`);
    error.code = "unsynced_collection";
    throw error;
  }
  return TABLE_MAP[key];
}

/** The quiet refusal every write path gives an unregistered collection. */
function refuseUnsynced(collectionKey) {
  console.warn(`Not sent: ${collectionKey} is kept on this device only.`);
}

// Single source of truth for the syncable collection keys. Every consumer
// (load, self-heal, backup restore) derives its list from here, so a
// collection added to TABLE_MAP can never silently fall out of one of them.
export const COLLECTION_KEYS = Object.keys(TABLE_MAP);

// Fields to skip when writing to Supabase (not in DB schema)
// document base64 data stays local; fileMissing is this device's note that
// Storage had no file for the row (AppContext reconcileDocumentFiles);
// pendingUpload is its note that the bytes here are a file given again
// ("Upload it again") that has not reached Storage yet.
const SKIP_FIELDS = new Set(["data", "file_missing", "pending_upload"]);

// Columns only a server function writes. The app reads them with select * and
// shows them, but never sends them back: every write here carries the whole
// cached row, so a device that has not reloaded since the server wrote them
// would put its stale copy (or null) over the server's value. The database
// refuses such a write too (trigger invoices_keep_last_emailed, migration
// 20260925130000), which also covers older app versions.
export const SERVER_OWNED_FIELDS = Object.freeze({
  // send-invoice-email, after a confirmed send.
  invoices: Object.freeze(["last_emailed_at", "last_emailed_to"]),
  // email-inbound, on the documents it creates (migration 20260929230000).
  documents: Object.freeze(["origin"]),
});

/**
 * The row the app may write for `item`: snake_case, without device-only or
 * server-owned fields.
 *
 * A NOT NULL column with no default (cme.category, education.type... see
 * REQUIRED_COLUMN_DEFAULTS in utils/syncRules.js) left blank rejects the WHOLE
 * row, and the record then lived on one device only. `mode` "insert" (an
 * insert or an upsert, which may create the row) fills a blank one with its
 * default; "update" leaves a blank one out, so a select cleared back to
 * "Select..." cannot take the rest of the edit down with it. Rows already
 * queued on a device pass through here on replay, so they land too.
 */
function clientRow(collectionKey, item, mode = "insert") {
  const row = toSnakeObj(mode === "insert" ? withRequiredDefaults(collectionKey, item) : item);
  for (const f of SKIP_FIELDS) delete row[f];
  for (const f of SERVER_OWNED_FIELDS[collectionKey] || []) delete row[f];
  if (mode === "update") {
    for (const k of Object.keys(REQUIRED_COLUMN_DEFAULTS[collectionKey] || {})) {
      const col = camelToSnake(k);
      if (Object.hasOwn(row, col) && row[col] == null) delete row[col];
    }
  }
  if (collectionKey === "shareLog") repairShareLogRow(row, mode);
  // An integer column (publications.sort_order) given "1.5" or "abc" rejected
  // the whole row, so a publication's edit lived on one device. Rounded here,
  // or left empty, so rows already queued land too.
  for (const col of INTEGER_COLUMNS[collectionKey] || []) {
    if (Object.hasOwn(row, col)) row[col] = toIntegerOrNull(row[col]);
  }
  // documents.mime_type is NOT NULL. A row that carries its storage path but
  // not its type (a self-heal push of a document whose bytes were already
  // stripped from the cache) is given one rather than refused whole.
  if (collectionKey === "documents" && mode === "insert" && row.storage_path && !row.mime_type) row.mime_type = documentMime(item);
  return row;
}

// A share_log row cached or queued in an old shape is repaired here, on every
// way out (insert, update, replay, self-heal), rather than refused on every
// load: Vera's packet share wrote shared_at (the column is sent_at) and no
// section (NOT NULL), and two paths wrote a method the CHECK does not allow
// ("copy" is "clipboard"). Same rules as recordWrite.js shareLogShape, which
// new entries already pass through. A missing section is filled only where
// the row may be created ("insert"); an update leaves the stored one alone.
const SHARE_LOG_METHOD_ALIASES = { copy: "clipboard", download: "share" };
function repairShareLogRow(row, mode = "insert") {
  if (Object.hasOwn(row, "shared_at")) {
    if (row.sent_at == null) row.sent_at = row.shared_at;
    delete row.shared_at;
  }
  if (mode === "insert" && !row.section) row.section = "documents";
  if (SHARE_LOG_METHOD_ALIASES[row.method]) row.method = SHARE_LOG_METHOD_ALIASES[row.method];
}

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
  // The July residency began (PGY 1), for the case log's year labels. Blank
  // means plain academic years. Migration 20260929221000.
  trainingStartYear: "training_start_year",
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
 * birthMonthDay (the ACCME learner match field) is here by design, not by
 * accident: a birth date is an identifier, and identifiers stay on the
 * device. It came back blank on every online load until it was listed, and
 * the CME Passport card then said a detail was missing. The trade-off is that
 * a second device does not see it.
 *
 * Device keys are not here. They are local-only too, but loadFromSupabase
 * hydrates them from the per-user device slot (loadDeviceKeys), which is a
 * stronger place than the cached settings blob.
 */
// birthMonthDay (SYNC-015, SETTINGS-008) had the same fate with no column at
// all: the Settings birthday reset on every online load and the CME reporting
// card called it missing. It is part of a date of birth, identifiers stay on
// the device (no-PHI design), and the Privacy Policy's Profile list does not
// include it, so it is kept here rather than given a profiles column.
// The list lives in constants/defaults.js so storageScope.js, which cannot
// import this module, keeps the same keys when a session ends.
export { LOCAL_ONLY_SETTINGS };

/**
 * The settings a JSON backup may put back (Data & Backup > Restore). Derived
 * from the sync map and the local-only list, so a setting added to either is
 * restorable without anyone remembering a third list; the hand-kept one had
 * drifted and silently dropped the tax prep, the setup board and more. Left
 * out: the admin panels' "seen" stamps and the reminder bookkeeping (when the
 * last reminder went, a snooze, the alert fingerprint), which describe this
 * device's past, not the physician's data; and the switches that send
 * something (utils/restoreBackup.js MESSAGE_SWITCHES: acknowledgements to
 * requesters, the monthly backup, reminder emails, texts and alerts), which
 * stay as the physician has them now instead of going back to the file's.
 */
const NOT_RESTORED_SETTINGS = new Set(["adminInboxSeenAt", "adminMessagesSeenAt", "adminErrorsSeenAt", "lastNotified", "snoozedUntil", "alertsFingerprint",
  "ackRequests", "backupMonthly", "notifyEmail", "notifyText", "notifyBrowser"]);
export const RESTORABLE_SETTINGS = Object.freeze([...Object.keys(SETTINGS_TO_PROFILE), ...LOCAL_ONLY_SETTINGS].filter((k) => !NOT_RESTORED_SETTINGS.has(k)));

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
  // Not from a tab whose records predate a purge of this account's copy on
  // this device (storageScope.js LOCAL_FENCE_KEY): Delete All My Data cleared
  // the AI keys and the lock code, and a stale tab must not put them back.
  if (!localCopyCurrent(authUserId)) return;
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

// ─── Refused writes ──────────────────────────────────────────
// A row the database refuses for a reason that never goes away (a blank
// required column, a value of the wrong type, a column the table lacks) used
// to be saved on this device, queued, and replayed on every load for ever,
// while the physician was told nothing: the record was simply missing on
// every other device and from the monthly backup. Such a refusal is now
// reported (table and error code only, never a value), shown to the
// physician by record, and retried at most PERMANENT_RETRY_LIMIT times per app
// version. Nothing is ever deleted: a later version, or the physician fixing
// the record, can still make it land.
const APP_BUILD = typeof __APP_BUILD_ID__ !== "undefined" ? __APP_BUILD_ID__ : "dev";
const syncIssues = new Map(); // accountId -> Map("collection:id" -> { collectionKey, id, code })
const syncListeners = new Set();
let rejectionReporter = null;

/** Where a refused write is reported (the app passes errorReport's reportError). */
export function setWriteRejectionReporter(fn) {
  rejectionReporter = typeof fn === "function" ? fn : null;
}

/** Called with the account id whenever that account's queue or refused records change. */
export function onSyncChange(listener) {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

function notifySync(accountId) {
  for (const listener of syncListeners) { try { listener(accountId); } catch { /* a listener must not stop a write */ } }
}

/** The records of this account the cloud refused in this session. */
export function syncIssuesFor(accountId) {
  return [...(syncIssues.get(accountId)?.values() || [])];
}

function recordIdOf(payload) {
  return payload && typeof payload === "object" ? payload.id : payload;
}

/**
 * Note the outcome of one write for one record and return how its error is
 * classified (null on success). A permanent refusal is reported once per
 * session (errorReport dedupes) and listed for the physician; a later write
 * of the same record that lands clears it.
 */
function noteWriteOutcome(owner, collectionKey, id, error, { report = true } = {}) {
  const accountId = owner.accountId;
  const key = `${collectionKey}:${id}`;
  const issues = syncIssues.get(accountId);
  if (!error) {
    if (issues?.delete(key)) notifySync(accountId);
    return null;
  }
  const kind = classifyWriteError(error);
  if (kind === "permanent" && id) {
    const code = writeErrorCode(error);
    if (report) {
      try { rejectionReporter?.(`Cloud write rejected: ${TABLE_MAP[collectionKey] || collectionKey} ${code}`); } catch { /* reporting never blocks */ }
    }
    const next = issues || new Map();
    next.set(key, { collectionKey, id, code });
    syncIssues.set(accountId, next);
    notifySync(accountId);
  }
  return kind;
}

/** What a failed write adds to its queued op, so replay knows how to treat it. */
function failureMeta(error, kind = classifyWriteError(error)) {
  return error ? { code: writeErrorCode(error), permanent: kind === "permanent" } : {};
}

// Queued writes a later full-row write of the same record replaces: an
// earlier full row (upsert) or a narrow patch of it.
const SUPERSEDED_OPS = new Set(["upsert", "patch"]);
const supersedes = (op, collectionKey, id) => SUPERSEDED_OPS.has(op?.op) && op.collectionKey === collectionKey && recordIdOf(op.payload) === id;

function queuePendingOp(op, collectionKey, payload, owner, meta = {}) {
  // A device-only collection is never queued: a queued op is a promise to
  // send it later.
  if (op !== "settings" && !isSyncedCollection(collectionKey)) return;
  owner.check();
  const key = pendingOpsSlot(owner.accountId);
  if (!key) return; // no account context yet — nothing safe to namespace under
  // Begun from records this tab loaded before this device purged the
  // account's copy (Delete All My Data here, or a server deletion honored
  // here): queuing it would replay a deleted record into the reopened
  // account, and the recorded deletion stamp would stop the next load from
  // purging it. Dropped instead.
  if (!localCopyCurrent(owner.accountId, owner.fence)) return;
  let queueId = null;
  try {
    const cur = JSON.parse(localStorage.getItem(key) || "[]");
    let arr = Array.isArray(cur) ? cur : [];
    // A document's queued save carries its file. A second save of the same
    // document replaces the first instead of queueing the file again (two
    // copies of a 4 MB data URL filled an iPhone's storage); the file rides
    // along if the newer save lacks it.
    const id = recordIdOf(payload);
    // Queued behind a save of the same record that is waiting for a
    // membership answer (an edit whose UPDATE found no row because the add is
    // still queued): it waits for the same answer, and goes up with it.
    if (!meta.awaitingAccess && id && arr.some(o => o?.awaitingAccess === true && o.collectionKey === collectionKey && recordIdOf(o.payload) === id)) meta = { ...meta, ...AWAITING_ACCESS };
    if (op === "upsert" && collectionKey === "documents" && id && arr.some(o => supersedes(o, collectionKey, id))) {
      const bytes = payload.data || arr.filter(o => supersedes(o, collectionKey, id)).map(o => o.payload?.data).filter(Boolean).at(-1);
      arr = arr.filter(o => !supersedes(o, collectionKey, id));
      if (bytes && !payload.data) payload = { ...payload, data: bytes };
    }
    // The scopes the write was decided on (recordContext), for replay.
    const scopes = op !== "settings" && Array.isArray(owner.scopes) && owner.scopes.length ? { scopes: owner.scopes } : {};
    // An id the caller chose (writeAhead holds a lock named by it first).
    queueId = typeof meta.queueId === "string" && meta.queueId ? meta.queueId : crypto.randomUUID();
    arr.push({ op, collectionKey, payload, ts: Date.now(), queueId, ...scopes, ...meta });
    // Bound the queue so one permanently-failing op can't grow without limit.
    // A full localStorage first gives up the dead development-era copies.
    setItemMakingRoom(key, JSON.stringify(arr.slice(-PENDING_OPS_CAP)));
  } catch (err) {
    queueId = null;
    // Storage full (a queued document carries its file): the write could not
    // be kept for another try. Said, never silent.
    if ((err?.name === "QuotaExceededError" || err?.code === 22) && op !== "settings") {
      try { rejectionReporter?.(`Pending write not kept: ${TABLE_MAP[collectionKey] || collectionKey} storage_full`); } catch { /* reporting never blocks */ }
      const id = recordIdOf(payload);
      if (id) {
        const issues = syncIssues.get(owner.accountId) || new Map();
        issues.set(`${collectionKey}:${id}`, { collectionKey, id, code: "storage_full" });
        syncIssues.set(owner.accountId, issues);
      }
    }
  }
  notifySync(owner.accountId);
  // Its id in the queue, or null when it was not kept.
  return queueId;
}

// Queued writes that would put a record back: a delete or a tombstone of the
// same record removes them, and replay skips them for a tombstoned id.
const RECORD_WRITE_OPS = new Set(["upsert", "favorite", "patch"]);
// A restore's un-delete (clearTombstones) that could not reach the ledger is
// queued too, as one op per collection holding its ids ({ ids }): one op per
// record could push other queued writes past PENDING_OPS_CAP. A later delete
// of one of those records takes it out of the op.
const UNDELETE_OP = "untombstone";
const undeleteIds = (op) => (Array.isArray(op?.payload?.ids) ? op.payload.ids : []);

/**
 * Drop this record's queued writes. A document saved while the upload failed
 * sat in the queue with its full data URL; deleting it (a patient chart the
 * read flagged, say) succeeded against nothing, and the next load's replay
 * uploaded the file and re-created the row behind the tombstone.
 */
function dropQueuedWrites(owner, collectionKey, id) {
  const slot = pendingOpsSlot(owner.accountId);
  if (!slot || !id) return;
  noteWriteOutcome(owner, collectionKey, id, null);
  try {
    const cur = JSON.parse(localStorage.getItem(slot) || "[]");
    if (!Array.isArray(cur)) return;
    let changed = false;
    const kept = cur.flatMap(op => {
      if (op?.collectionKey !== collectionKey) return [op];
      if (RECORD_WRITE_OPS.has(op.op) && recordIdOf(op.payload) === id) { changed = true; return []; }
      if (op.op !== UNDELETE_OP || !undeleteIds(op).includes(id)) return [op];
      changed = true;
      const ids = undeleteIds(op).filter(x => x !== id);
      return ids.length ? [{ ...op, payload: { ids } }] : [];
    });
    if (!changed) return;
    if (kept.length) localStorage.setItem(slot, JSON.stringify(kept));
    else localStorage.removeItem(slot);
  } catch { /* storage unavailable: replay skips it by its tombstone */ }
  notifySync(owner.accountId);
}

/**
 * A full-row write of this record landed: the record's writes queued before
 * it (ts <= startedAt) are stale. A refused add the physician then fixed used
 * to stay queued after the fix landed: it failed on every load, was parked,
 * and listed the record as "Not saved to your account" for ever, and the one
 * retry each new app version gives a parked op could put its old values over
 * the fix. Writes queued after this one started are newer and are kept.
 */
function dropSupersededWrites(owner, collectionKey, id, startedAt) {
  const slot = pendingOpsSlot(owner.accountId);
  if (!slot || !id) return;
  try {
    const raw = localStorage.getItem(slot);
    if (!raw) return;
    const cur = JSON.parse(raw);
    if (!Array.isArray(cur)) return;
    const kept = cur.filter(op => !(supersedes(op, collectionKey, id) && !(Number(op.ts) > startedAt)));
    if (kept.length === cur.length) return;
    if (kept.length) localStorage.setItem(slot, JSON.stringify(kept));
    else localStorage.removeItem(slot);
  } catch { return; /* storage unavailable: replay drops them once a later write lands */ }
  notifySync(owner.accountId);
}

// ── An invoice another device recorded first (migration 20261002030000) ──
// The server keeps one invoice per number (23505 on the invoice) and never
// moves a billed row onto a different invoice while its own exists (23P01 on
// the row). Both mean the account already holds the other device's record
// of the same invoice, which stands (review of release/goal2, 2026-10-01):
//  - this device's invoice is dropped, never queued or retried, whether the
//    insert was live or replayed from the queue, and the account is read
//    again;
//  - what this device queued to bill rows onto it is taken out of the queue
//    (a stipend marker made for it goes whole), so the rows keep the
//    account's invoice and nothing is parked as "not saved";
//  - a row's edit refused for its invoice id goes up without it (the rest of
//    the edit is saved), or is dropped when the invoice id was all it changed.
// When this device's invoice was kept (a new number, recorded for rows the
// account already bills on another invoice), the account then holds an
// invoice listing rows another invoice bills: Home and the Invoices tab say
// so by both numbers, with the delete that settles it, on every device
// (utils/invoiceRecord.js invoicesBilledTwice, BilledTwiceInvoices). The
// sync never parks it: the duplicate is a fact about what went to the
// agency, not a save to retry.
const INVOICE_BILLED = new Set(["dutyDays", "workLog", "travelExpenses"]);
const invoiceGuardRefused = (collectionKey, error) => INVOICE_BILLED.has(collectionKey) && writeErrorCode(error) === "23P01";
const invoiceNumberTaken = (collectionKey, error) => collectionKey === "invoices" && writeErrorCode(error) === "23505";
// A marker the time engine adds only to stamp a billed stipend day
// (WorkLog markBilledAndLog): it means nothing without its invoice.
const isStipendMarker = (collectionKey, item) => collectionKey === "workLog" && item?.type === "CallDay"
  && !item.startTime && !(Number(item.durationMin) > 0);
// The op without its invoice id: null when nothing is left to send.
function withoutBilling(op) {
  const payload = op.payload && typeof op.payload === "object" ? op.payload : null;
  if (!payload) return op;
  if (Array.isArray(op.changed)) {
    const changed = op.changed.filter(k => k !== "invoiceId");
    if (!changed.length) return null;
    return { ...op, changed, payload: { ...payload, invoiceId: null } };
  }
  if (!op.changed && isStipendMarker(op.collectionKey, payload)) return null;
  const { invoiceId: _dropped, ...rest } = payload;
  return { ...op, payload: rest };
}
function invoiceRecordedElsewhere(owner, invoiceId) {
  try { rejectionReporter?.("Cloud write rejected: invoices number_recorded_elsewhere"); } catch { /* reporting never blocks */ }
  if (invoiceId) {
    const slot = pendingOpsSlot(owner.accountId);
    try {
      const raw = slot ? localStorage.getItem(slot) : null;
      const cur = raw ? JSON.parse(raw) : null;
      if (Array.isArray(cur)) {
        let changed = false;
        const kept = [];
        for (const op of cur) {
          if (!INVOICE_BILLED.has(op?.collectionKey) || !["upsert", "patch"].includes(op.op) || op.payload?.invoiceId !== invoiceId) { kept.push(op); continue; }
          changed = true;
          const next = op.op === "patch" ? (() => { const { invoiceId: _d, ...rest } = op.payload; return Object.keys(rest).some(k => k !== "id") ? { ...op, payload: rest } : null; })() : withoutBilling(op);
          if (next) kept.push(next);
        }
        if (changed) {
          if (kept.length) localStorage.setItem(slot, JSON.stringify(kept)); else localStorage.removeItem(slot);
          notifySync(owner.accountId);
        }
      }
    } catch { /* storage unavailable: replay drops them as the server refuses them */ }
  }
  try { invoiceNumberConflict?.(); } catch { /* the next load reads it */ }
}

// Writes of a record still in flight, by account, collection and id: adds,
// live edits, stars and replayed queued writes. A delete waits for the add it
// undoes instead of deleting nothing and letting the add land after. Every
// other write of a record takes its turn (takeRecordTurn), so a replayed
// older copy never lands over a newer add, edit or star (replayForOwner).
const inFlightInserts = new Map();
const flightKey = (owner, collectionKey, id) => `${owner.accountId}\u0000${collectionKey}\u0000${id}`;
async function settleInsert(owner, collectionKey, id) {
  const pending = inFlightInserts.get(flightKey(owner, collectionKey, id));
  if (!pending) return;
  await pending.catch(() => {});
  owner.check();
}
/**
 * A turn to write this record, taken at once, in call order: `ready` (null
 * when nothing was in flight) settles once every write of it taken before has
 * landed, and anything waiting on the record waits for this one too until
 * `done` is called. Always call `done`.
 */
function takeRecordTurn(owner, collectionKey, id) {
  const key = flightKey(owner, collectionKey, id);
  const before = inFlightInserts.get(key) || null;
  const ready = before ? before.then(() => {}, () => {}) : null;
  let land;
  const landing = new Promise(resolve => { land = resolve; });
  const entry = ready ? Promise.all([ready, landing]).then(() => {}) : landing;
  inFlightInserts.set(key, entry);
  return { ready, done: () => { land(); if (inFlightInserts.get(key) === entry) inFlightInserts.delete(key); } };
}

// Low-level, non-queuing writes used by the replay pass. Each returns null when
// the write landed and the error when it did not, so replay can drop only the
// ops that landed, keep the rest, and tell a refusal from an outage.
const UPLOAD_FAILED = Object.freeze({ code: "upload_failed", message: "Document file upload failed" });
async function sbUpsertRow(userId, collectionKey, item, owner, queuedAt) {
  if (!item?.id) return null; // nothing addressable — drop it
  const table = tableName(collectionKey);
  const row = clientRow(collectionKey, item);
  row.user_id = userId;
  row.created_at = row.created_at || new Date().toISOString();
  // A queued add carries no updatedAt. Stamped with the time it was queued,
  // never the time it is replayed: replayed "now", a failed add looked newer
  // than an edit made after it, and the self-heal then kept the old cloud
  // copy over the edit on every device.
  row.updated_at = row.updated_at || new Date(Number(queuedAt) || Date.now()).toISOString();
  if (collectionKey === "documents" && item.data) {
    const path = await uploadForOwner(item, owner);
    if (!path) return UPLOAD_FAILED;
    row.storage_path = path;
    row.mime_type = documentMime(item);
    row.size_bytes = item.size || null;
  }
  const { error } = await writeRequest(owner, () => owner.db.from(table).upsert(row, { onConflict: "id" }));
  return error || null;
}
// A star that matched no row did not land: the record's add has not reached
// the cloud yet (it is queued, or still in flight). PostgREST reports that as
// success, so the star was lost and the replayed add then landed unstarred.
const NO_ROW = Object.freeze({ code: "no_row", message: "No row matched" });
async function sbFavoriteRow(userId, collectionKey, item, owner) {
  if (!item?.id) return null; // nothing addressable — drop it
  const table = tableName(collectionKey);
  const { data, error } = await writeRequest(owner, () => owner.db
    .from(table)
    .update({ favorite: !!item.favorite })
    .eq("id", item.id)
    .eq("user_id", userId)
    .select("id"));
  if (error) return error;
  return Array.isArray(data) && data.length === 0 ? NO_ROW : null;
}

/**
 * Queue a star. A queued save of the same record carries the star too, so the
 * record lands starred whatever order replay meets them in.
 */
function queueFavorite(owner, collectionKey, payload, meta) {
  const slot = pendingOpsSlot(owner.accountId);
  try {
    const cur = JSON.parse(localStorage.getItem(slot) || "[]");
    if (Array.isArray(cur) && cur.some(op => op?.op === "upsert" && op.collectionKey === collectionKey && recordIdOf(op.payload) === payload.id)) {
      localStorage.setItem(slot, JSON.stringify(cur.map(op => (op?.op === "upsert" && op.collectionKey === collectionKey && recordIdOf(op.payload) === payload.id
        ? { ...op, payload: { ...op.payload, favorite: payload.favorite } } : op))));
    }
  } catch { /* storage unavailable: the favorite op below still carries it */ }
  queuePendingOp("favorite", collectionKey, payload, owner, meta);
}

/**
 * A star of this record landed. The record's writes queued before it began
 * (ts <= startedAt) still hold the old star: a full row carries the new one
 * from now on, and a queued star is dropped. Otherwise replay, reading the
 * queue after the star, sent the older row (favorite and all) over it.
 */
function settleQueuedStar(owner, collectionKey, payload, startedAt) {
  const slot = pendingOpsSlot(owner.accountId);
  if (!slot || !payload?.id) return;
  try {
    const raw = localStorage.getItem(slot);
    if (!raw) return;
    const cur = JSON.parse(raw);
    if (!Array.isArray(cur)) return;
    let changed = false;
    const next = cur.flatMap(op => {
      if (op?.collectionKey !== collectionKey || recordIdOf(op.payload) !== payload.id || Number(op.ts) > startedAt) return [op];
      if (op.op === "favorite") { changed = true; return []; }
      if (op.op !== "upsert" || !op.payload || typeof op.payload !== "object" || op.payload.favorite === payload.favorite) return [op];
      changed = true;
      return [{ ...op, payload: { ...op.payload, favorite: payload.favorite } }];
    });
    if (!changed) return;
    if (next.length) localStorage.setItem(slot, JSON.stringify(next));
    else localStorage.removeItem(slot);
  } catch { return; /* storage unavailable */ }
  notifySync(owner.accountId);
}
// `target` is the record id, or for a document { id, storagePath }: its file
// is removed first (documentObjectPaths: the stored path when it has the
// exact shape user_<id>/<this doc id>, and <sign-in id>/<id>), and a failed
// removal keeps the op queued. An op queued before the path rode along holds
// only the id, so the path is read from the row before the row goes; a failed
// read keeps the op queued too.
async function sbDeleteRow(userId, collectionKey, target, owner) {
  const itemId = recordIdOf(target);
  if (!itemId) return null;
  const table = tableName(collectionKey);
  if (collectionKey === "documents") {
    let stored = target && typeof target === "object" ? target.storagePath : null;
    if (!stored) {
      const { data: row, error: readErr } = await writeRequest(owner, () => owner.db.from(table)
        .select("storage_path").eq("id", itemId).eq("user_id", userId).maybeSingle());
      if (readErr) return readErr;
      stored = row?.storage_path || null;
    }
    const rmErr = await removeDocumentObject(owner, itemId, stored);
    if (rmErr) return rmErr;
  }
  const { error } = await writeRequest(owner, () => owner.db.from(table).delete().eq("id", itemId).eq("user_id", userId));
  return error || null;
}
// A partial write (the link sweep's { id, linkedTo }): replayed as an UPDATE of
// those columns only. Replayed as an upsert, INSERT ... ON CONFLICT checked the
// NOT NULL columns (documents.name, mime_type, storage_path) before it found
// the conflict, so it failed with 23502 on every load although the row
// existed. A patch for a row that no longer exists is simply done.
async function sbPatchRow(userId, collectionKey, item, owner) {
  if (!item?.id) return null;
  const table = tableName(collectionKey);
  const row = clientRow(collectionKey, item, "update");
  delete row.user_id;
  delete row.created_at;
  row.updated_at = new Date().toISOString();
  const { error } = await writeRequest(owner, () => owner.db.from(table).update(row).eq("id", item.id).eq("user_id", userId));
  return error || null;
}

// A queued edit (editMeta): an UPDATE of the columns it changed, its packed
// columns merged per field over the server's copy now, dated now. A row that
// does not exist (its add never landed, or it is being created by another
// queued write) is created whole, as the upsert it used to be.
async function sbEditRow(userId, collectionKey, item, owner, op) {
  if (!item?.id) return null;
  const row = clientRow(collectionKey, item, "update");
  delete row.user_id;
  delete row.created_at;
  narrowRow(row, op);
  const readError = await rebasePackedColumns(owner, userId, collectionKey, row, op, item.id);
  if (readError) return readError;
  row.updated_at = new Date().toISOString();
  const { data, error } = await writeRequest(owner, () => owner.db.from(tableName(collectionKey))
    .update(row).eq("id", item.id).eq("user_id", userId).select("id"));
  if (error) return error;
  if (Array.isArray(data) && data.length === 0) return sbUpsertRow(userId, collectionKey, item, owner, op.ts);
  return null;
}

// An "upsert" queued by an older version for a partial document write (no
// name: the link sweep sent only id and linkedTo) can never insert. It is
// replayed as the patch it always was.
const isLegacyPartialDocument = (op) => op.op === "upsert" && op.collectionKey === "documents"
  && op.payload && typeof op.payload === "object" && !op.payload.name && !op.payload.data;

async function sbTombstoneRow(userId, collectionKey, itemId, owner) {
  if (!itemId) return null;
  const { error } = await writeRequest(owner, () => owner.db.from("deleted_items").upsert(
    { item_id: itemId, user_id: userId, collection: collectionKey },
    { onConflict: "item_id" }
  ));
  return error || null;
}

async function sbUntombstoneRows(userId, itemIds, owner) {
  const { error } = await writeRequest(owner, () => owner.db.from("deleted_items").delete().eq("user_id", userId).in("item_id", itemIds));
  return error || null;
}

// Replay the queued writes for this account, in order, dropping each only on
// success. Call after the profile is known and BEFORE loadFromSupabase, so the
// replayed rows are part of the cloud snapshot the merge then reads back.
const replayInFlight = new Map();
// `tombstones` (the account's deleted ids, when the caller read them) makes
// replay drop a queued write that would re-create a record deleted anywhere.
export function replayPendingOps(profileId, authUserId = getActiveUserId() || clerkSub(), { tombstones = null } = {}) {
  const key = pendingOpsSlot(authUserId);
  if (replayInFlight.has(key)) return replayInFlight.get(key);
  const task = oneTabAtATime(key, () => replayForOwner(profileId, authUserId, tombstones)).finally(() => replayInFlight.delete(key));
  replayInFlight.set(key, task);
  return task;
}

// One tab of this browser replays an account's queue at a time (the Web Locks
// API; the queue is in localStorage, which every tab shares). Two tabs that
// read the same queue each sent every op in it, and one could land an older
// copy after the other had sent a newer one. A tab that finds another
// replaying sends nothing and does not wait: that tab is sending these ops,
// and a tab frozen in the background mid-replay must never hold up this
// one's load. The next answer or load replays whatever is still queued.
// Without the API (an older browser), each tab replays as it always did.
async function oneTabAtATime(key, run) {
  const locks = globalThis.navigator?.locks;
  if (!key || typeof locks?.request !== "function") return run();
  let ran = false;
  try {
    return await locks.request(`credentialdomd:replay:${key}`, { ifAvailable: true }, lock => {
      if (!lock) return { refused: [], skipped: true };
      ran = true;
      return run();
    });
  } catch (error) {
    if (ran) throw error;
    return run(); // the lock manager itself failed: replay as before
  }
}

async function replayForOwner(profileId, authUserId, tombstones = null) {
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
  const written = JSON.stringify(ops);
  try { localStorage.setItem(key, written); } catch { return; }
  // The queue as read belongs to the device's current purge fence. Another
  // tab purging the account's copy mid-replay (a data deletion) ends it: the
  // rest of these ops are writes from before that deletion.
  const fence = localFence(owner.accountId);
  const completed = new Set();
  // Failed ops stay queued with their attempt count and error code. A write
  // refused as permanent is parked after PERMANENT_RETRY_LIMIT attempts: kept,
  // shown, and tried again only by a newer app version, which may have fixed
  // the row's shape.
  const failed = new Map();
  // An op as the queue holds it now, or null when it was taken out since this
  // pass read the queue (the record was deleted, or a newer full write of it
  // landed): sending it would put an older copy back. Read from storage before
  // every send, because other tabs of this browser change the same queue (a
  // live edit landing there takes this record's older copies out), and a star
  // that landed meanwhile rewrites the record's queued row (settleQueuedStar).
  // Parsed again only when the stored queue changed.
  let seenRaw = written, live = new Map(ops.map(op => [op.queueId, op]));
  const queuedNow = op => {
    let raw;
    try { raw = localStorage.getItem(key); } catch { return op; /* unreadable: sent as read */ }
    if (raw !== seenRaw) {
      let current;
      try { current = JSON.parse(raw || "[]"); } catch { return op; }
      seenRaw = raw;
      live = new Map((Array.isArray(current) ? current : []).filter(item => item?.queueId).map(item => [item.queueId, item]));
    }
    return live.get(op.queueId) || null;
  };
  // Saves kept for want of a membership answer (awaitingAccess) that the
  // answer now refuses outright (the membership is read-only: writeStatus
  // "read_only", not an answer that is only old) are marked accessRefused.
  // They stay queued and on this device: the queue holds only the new copy
  // (a delete, only the id), so nothing here could put the old one back, and
  // what the member typed (an invoice that already went out) is kept. The
  // notice says they were not saved instead of promising a sync, the caller
  // reports them (the result's `refused`), and a later answer that allows
  // them again sends them and takes the mark off.
  const refusedNow = new Map(), allowedAgain = new Set();
  // Saves another page of this browser wrote ahead and is still deciding on
  // its own answer (writeAhead, writeAheadRecord): that page sends it (a
  // settings save in its profile order), or takes it back.
  const decidingElsewhere = await decidingInLivePages(ops, owner.accountId);
  for (const [index, op] of ops.entries()) {
    try { owner.guard(); } catch { break; }
    if (localFence(owner.accountId) !== fence) break;
    if (!queuedNow(op)) continue;
    // A save this tab wrote ahead while it waits for the page load's first
    // answer (saveSettings, writeAheadRecord): this tab sends it.
    if (writtenAhead.has(op.queueId) || decidingElsewhere.has(op.queueId)) continue;
    // Queued before collections were checked (identityVault from the
    // 2026-09-18 live window): dropped from the queue without being sent.
    if (op.op !== "settings" && !isSyncedCollection(op.collectionKey)) { completed.add(op.queueId); continue; }
    // Deleted since it was queued (on this device or another): sending it
    // would re-create the record behind its tombstone.
    if (tombstones?.has?.(recordIdOf(op.payload)) && RECORD_WRITE_OPS.has(op.op)) { completed.add(op.queueId); continue; }
    if (op.parkedBuild && op.parkedBuild === APP_BUILD) {
      // Parked: still listed for the physician, not sent or reported again.
      if (op.permanent && op.op !== "settings") noteWriteOutcome(owner, op.collectionKey, recordIdOf(op.payload), { code: op.code || "unknown" }, { report: false });
      continue;
    }
    // Keep denied operations in their original account queue for a later
    // authorized sync. Decided on the scopes the write that queued it was
    // decided on (replayScopes), and refused or marked refused only for one of
    // those: a Credential-only member's kept save of a document filed to a
    // licence is not held back, nor called refused, for want of Practice.
    const needed = op.op === "settings" ? null : replayScopes(op, owner.accountId);
    const writes = () => needed.every(scope => accessAuthority.allows(scope, "write", owner.accountId));
    const permitted = op.op === "settings" ? allowsSettingsChange(op.payload) : writes();
    if (!permitted) {
      // The task a board stamp closed (lastingStamp), refused by the
      // membership: dropped, never called refused, as the live stamp is.
      if (op.op === "settings" && op.automatic === true && replayRefusal(op, needed, owner.accountId) === "read_only") { completed.add(op.queueId); continue; }
      if (op.awaitingAccess === true && op.accessRefused !== true && replayRefusal(op, needed, owner.accountId) === "read_only") {
        refusedNow.set(op.queueId, op.op === "settings" ? "settings" : op.collectionKey);
      }
      continue;
    }
    if (op.accessRefused === true) allowedAgain.add(op.queueId);
    owner.check = op.op === "settings" ? () => guardSettings(owner, op.payload)
      : () => { owner.guard(); if (!writes()) throw membershipWriteError(); };
    let error = null;
    // This record's turn. A live save or star of it made while this is sent
    // waits for it to land, so the newer copy lands last. One already in
    // flight lands first: when it was a full write it took this older copy
    // out of the queue, and when it was a star it put itself into the copy,
    // so what is sent is the op as the queue holds it after that.
    const recordId = RECORD_WRITE_OPS.has(op.op) ? recordIdOf(op.payload) : null;
    const turn = recordId ? takeRecordTurn(owner, op.collectionKey, recordId) : null;
    try {
      if (turn?.ready) {
        await turn.ready;
        try { owner.guard(); } catch { break; }
        if (localFence(owner.accountId) !== fence) break;
      }
      const current = queuedNow(op);
      if (!current) continue;
      const payload = current.payload;
      if (op.op === "patch" || isLegacyPartialDocument(op)) {
        error = await sbPatchRow(profileId, op.collectionKey, payload, owner);
      } else if (op.op === "upsert") {
        const send = (o) => (Array.isArray(o.changed) ? sbEditRow(profileId, op.collectionKey, o.payload, owner, o) : sbUpsertRow(profileId, op.collectionKey, o.payload, owner, op.ts));
        error = await send(current);
        // A row's invoice id refused, the row billed on an invoice another
        // device recorded first: the rest goes without it (or nothing).
        if (error && invoiceGuardRefused(op.collectionKey, error)) {
          const bare = withoutBilling(current);
          error = bare ? await send(bare) : null;
          try { invoiceNumberConflict?.(); } catch { /* the next load reads it */ }
        }
        // An invoice whose number another invoice of the account carries:
        // recorded on another device, which stands. Dropped, as a live insert
        // is, with what this device queued to bill rows onto it.
        if (error && invoiceNumberTaken(op.collectionKey, error) && !Array.isArray(current.changed)) {
          invoiceRecordedElsewhere(owner, recordIdOf(payload));
          error = null;
        }
      } else if (op.op === "favorite") {
        error = await sbFavoriteRow(profileId, op.collectionKey, payload, owner);
        // No row: kept only while a save of that record is still waiting in
        // the queue (it replays and carries the star). With none left the
        // record is gone (deleted on another device), and the star is dropped
        // rather than retried for ever.
        if (error === NO_ROW) {
          const id = recordIdOf(op.payload);
          const waiting = ops.some(o => o.op === "upsert" && o.collectionKey === op.collectionKey && recordIdOf(o.payload) === id && !completed.has(o.queueId));
          if (!waiting) error = null;
        }
      } else if (op.op === "delete") {
        error = await sbDeleteRow(profileId, op.collectionKey, payload, owner);
        if (!error) error = await sbTombstoneRow(profileId, op.collectionKey, recordIdOf(payload), owner);
      } else if (op.op === "settings") {
        // Reapply the queued settings patch to the profile row. Later queued
        // patches overwrite earlier ones in replay order, which is the same
        // last-wins the live path has.
        const row = settingsToProfileRow(payload || {});
        // A kept Setup board save goes up as what it changed from the copy
        // it was made from, over the account's copy as it is now (one jsonb
        // column, written whole: sent as it was kept, it overwrote the skips
        // and declarations made on another device since).
        let read = null;
        if (Object.hasOwn(op, "setupBase") && payload && Object.hasOwn(payload, "setupState")) {
          read = await writeRequest(owner, () => owner.db.from("profiles").select("setup_state").eq("id", profileId).maybeSingle());
          if (!read.error) row.setup_state = rebaseSetupState(read.data?.setup_state ?? null, op.setupBase, payload.setupState);
        }
        row.updated_at = new Date().toISOString();
        const first = read?.error ? read : await writeRequest(owner, () => owner.db.from("profiles").update(row).eq("id", profileId));
        error = first.error || null;
        // A duplicate email (profiles_email_unique_key, 20260903e) is the one
        // failure retrying cannot fix: another account holds that address and
        // still will next time. Replay everything else rather than dropping
        // the physician's whole queued patch over one refused field.
        if (error && error.code === "23505" && "email" in row) {
          const { email: _refused, ...rest } = row;
          const retry = await writeRequest(owner, () => owner.db.from("profiles").update(rest).eq("id", profileId));
          error = retry.error || null;
        }
      } else if (op.op === "tombstone") {
        error = await sbTombstoneRow(profileId, op.collectionKey, payload, owner);
      } else if (op.op === UNDELETE_OP) {
        // A restore brought these records back while the ledger was out of
        // reach. Once their markers are gone, a save of one later in this
        // pass is no longer "deleted since it was queued", and the load that
        // follows pushes this device's restored copies up instead of hiding
        // them.
        const ids = undeleteIds(current).filter(isUuid);
        for (let i = 0; i < ids.length && !error; i += 100) error = await sbUntombstoneRows(profileId, ids.slice(i, i + 100), owner);
        if (!error) for (const id of ids) tombstones?.delete?.(id);
      }
      // An unknown op shape falls through with no error: discarded rather
      // than retried for ever.
    } catch (thrown) {
      // An account change stops the pass; anything else is an outage.
      if (thrown?.code === "membership_account_changed") break;
      error = thrown || { message: "replay failed" };
    } finally {
      turn?.done();
    }
    if (!error) {
      completed.add(op.queueId);
      if (op.op !== "settings") noteWriteOutcome(owner, op.collectionKey, recordIdOf(op.payload), null);
      // A full row landed: the same record's earlier queued rows and patches
      // are stale (a refused add the physician has since fixed, say). They
      // leave the queue now instead of failing, being parked and listing
      // the record as not saved on every later load.
      const id = recordIdOf(op.payload);
      if (id && op.op === "upsert" && !isLegacyPartialDocument(op)) {
        for (const earlier of ops.slice(0, index)) {
          if (supersedes(earlier, op.collectionKey, id)) { completed.add(earlier.queueId); failed.delete(earlier.queueId); }
        }
      }
      continue;
    }
    const kind = op.op === "settings" ? classifyWriteError(error)
      : noteWriteOutcome(owner, op.collectionKey, recordIdOf(op.payload), error);
    const attempts = (Number(op.attempts) || 0) + 1;
    const permanent = kind === "permanent";
    failed.set(op.queueId, {
      attempts, code: writeErrorCode(error), permanent,
      parkedBuild: permanent && attempts >= PERMANENT_RETRY_LIMIT ? APP_BUILD : undefined,
    });
  }
  const refused = new Set();
  try {
    const current = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(current)) return { refused: [] };
    const remaining = current.filter(op => !completed.has(op.queueId))
      .map(op => failed.has(op.queueId) ? { ...op, ...failed.get(op.queueId) } : op)
      .map(op => {
        if (refusedNow.has(op.queueId)) { refused.add(refusedNow.get(op.queueId)); return { ...op, accessRefused: true }; }
        if (!allowedAgain.has(op.queueId)) return op;
        const { accessRefused: _allowedAgain, ...rest } = op;
        return rest;
      });
    if (remaining.length) localStorage.setItem(key, JSON.stringify(remaining));
    else localStorage.removeItem(key);
  } catch { /* ignore */ }
  notifySync(owner.accountId);
  // The sections of the saves marked refused by this pass, for the report.
  return { refused: [...refused] };
}

// Why a queued op may not be sent now, as the membership answer says
// (writeStatus reason, "read_only" when the answer refuses it outright), or
// null when it may be, or the authority cannot say. `needed`: replayScopes.
function replayRefusal(op, needed, accountId) {
  if (typeof accessAuthority.statusFor !== "function") return null;
  // Only an answer from the server this session refuses a kept save. The one
  // this device remembered (writeStatus "read_only" with none yet) is for
  // the screens: a load's replay before the answer marks nothing refused.
  if (typeof accessAuthority.state === "function" && !accessAuthority.state(accountId)) return null;
  const result = op.op === "settings" ? accessAuthority.settingsStatus(op.payload, accountId)
    : accessAuthority.statusFor(needed, accountId);
  return result?.status === "refuse" ? result.reason : null;
}

// The scopes a queued op is sent under: the ones the write that queued it was
// decided on (recordContext; op.scopes), with the record as it was then. A
// delete, a tombstone or a star queues only the id, and the record is gone
// from this device (or never said where it was filed), so nothing here could
// work them out again. A save's payload is the record, so where it is filed
// counts too. An op queued without them (by an older version) is decided as a
// live update of it is: by the record on this device, and on both scopes for
// a document whose record is not known (guardRecord's unknown provenance).
const SCOPES = ["credential", "practice"];
const RECORD_PAYLOAD_OPS = new Set(["upsert", "patch"]);
function replayScopes(op, accountId) {
  const item = op.payload && typeof op.payload === "object" ? op.payload : { id: op.payload };
  const previous = accessAuthority.previousRecord(op.collectionKey, item.id, accountId) || null;
  const recorded = Array.isArray(op.scopes) && op.scopes.length > 0 && op.scopes.every(scope => SCOPES.includes(scope)) ? op.scopes : null;
  if (recorded) {
    return RECORD_PAYLOAD_OPS.has(op.op)
      ? [...new Set([...recorded, ...accessAuthority.mutationScopes(op.collectionKey, item, previous || item)])]
      : [...recorded];
  }
  const needed = accessAuthority.mutationScopes(op.collectionKey, item, previous);
  if (op.collectionKey === "documents" && !previous) needed.push(...SCOPES);
  return [...new Set(needed)];
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
// The bound development identity of a continuity account, from the
// authenticated binding ensureProfile validated this session, by production
// subject. Delete All My Data purges that old namespace on this device too:
// it holds the same member's development-era copy (license and DEA numbers,
// vault), and every other device of the member purges it for the deletion.
const boundContinuitySources = new Map();
export function boundContinuitySource(userId) {
  return (userId && boundContinuitySources.get(userId)) || null;
}

// A load whose identity or profile read fails for a reason that can pass (the
// answer was cut off, the network or Clerk's token was still waking, a
// timeout, a server error) tries again after these pauses, with the session
// Clerk holds then, before the load stops and asks for a reload. Only the
// final failure reaches AppContext, which reports it once.
export const PROFILE_LOAD_RETRY_DELAYS_MS = Object.freeze([1000, 3000]);
const TRANSIENT_CLIENT_PHASES = new Set(["token", "network", "timeout", "response"]);
const transientStatus = status => status === 408 || status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
// initialize-clerk-profile (limitedLaunchClient): never an answer the server
// gave (identity_conflict, continuity_unavailable, unauthorized, a 4xx, an
// update required), and never a changed session. A server status other than
// 200 that is not itself transient is an answer even when its body was cut off
// or stalled past the deadline (phase "response" or "timeout").
function transientInitializationFailure(error) {
  if (error?.code !== "membership_information_unavailable") return false;
  if (Number.isInteger(error.httpStatus) && error.httpStatus !== 200 && !transientStatus(error.httpStatus)) return false;
  return TRANSIENT_CLIENT_PHASES.has(error.phase) || (error.phase === "http" && transientStatus(error.httpStatus));
}
// The profile row read: no answer at all (status 0, a request that threw) or
// a server error. A denial (401/403) or a missing row is an answer.
const transientReadFailure = result => !!result?.error && (!result.status || transientStatus(result.status));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function withLoadRetries(owner, delays, run, transient) {
  for (let attempt = 0; ; attempt++) {
    let outcome;
    try { outcome = { value: await run() }; }
    catch (error) { outcome = { error }; }
    // A changed or signed-out account stops at once, never retried.
    owner.check();
    const failed = "error" in outcome ? outcome.error : outcome.value;
    if (!transient(failed, "error" in outcome) || attempt >= delays.length) {
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    }
    await pause(delays[attempt]);
    owner.check();
  }
}

export async function ensureProfile(userId, { isCurrent = () => true, retryDelaysMs = PROFILE_LOAD_RETRY_DELAYS_MS } = {}) {
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : PROFILE_LOAD_RETRY_DELAYS_MS;
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
      // Each try reads the session Clerk holds then (the client asks for it).
      const client = createLimitedLaunchClient({ accountId: userId, enabled: true });
      const receipt = await withLoadRetries(owner, delays, () => client.initializeProfile(),
        (error, threw) => threw && transientInitializationFailure(error));
      owner.check();
      initializedProfileId = receipt.profileId;
      configureSecretContinuity(null);
      let binding = null;
      boundContinuitySources.delete(userId);
      if (receipt.continuity) {
        stage = "binding";
        binding = createContinuityBinding(receipt, { subject: userId, issuer: PRODUCTION_CLERK_ISSUER,
          session, authenticatedAt, isCurrent: () => {
            try { owner.check(); return sameClerkSession(session, liveClerkSession()); } catch { return false; }
          } });
        boundContinuitySources.set(userId, continuitySourceSubject(binding, userId));
      }
      // The server deleted this account's data (Delete All My Data on another
      // device, or the deletion 7 days after a cancellation) and has reopened
      // it empty. Everything this device holds for it predates that, so it
      // goes BEFORE recovery can copy the old development-era copy across and
      // before AppContext replays the queue or pushes a stale cache back up.
      // Once per stamp; see src/utils/dataDeletion.js.
      if (receipt.dataDeletedAt) {
        stage = "purge";
        await honorAccountDataDeletion(userId, receipt.dataDeletedAt,
          { sourceSubject: binding ? continuitySourceSubject(binding, userId) : null });
        owner.check();
      }
      if (binding) {
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
      const error = profileInitializationError(stage, cause);
      // Still no answer from initialize-clerk-profile after the retries (a
      // weak signal at launch: every try timed out or never connected). No
      // server said anything about this identity, so AppContext opens this
      // account's own device copy, read-only, and asks again when the app
      // comes back to the front or online (IPHONE weak network, 2026-10-01).
      if (stage === "initialize" && transientInitializationFailure(cause)) error.transient = true;
      throw error;
    }
  }
  const lookup = () => writeRequest(owner, () => owner.db.from("profiles")
    .select("*").eq("auth_user_id", userId).maybeSingle());
  let existing;
  try { existing = await withLoadRetries(owner, delays, lookup, (result, threw) => !threw && transientReadFailure(result)); }
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

// The account's data-deletion stamp, read on its own: deleted_at while a
// wiped account is still closed, data_deleted_at once it has reopened
// (migration 20260930020000). AppContext asks each time the app returns to
// the foreground, so a device left open while Delete All My Data ran on
// another one stops showing the deleted records. Two columns of the member's
// own row; RLS limits it to that row. Throws on a failed read.
export async function readAccountDataDeletion(authUserId) {
  if (!supabase || !authUserId) return null;
  const { data, error } = await supabase.from("profiles")
    .select("deleted_at,data_deleted_at").eq("auth_user_id", authUserId).maybeSingle();
  if (error) throw error;
  return accountDataDeletedAt(data);
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
  //
  // The order must be total. created_at alone ties (a restore stamps a whole
  // batch with one time), and Postgres promises no order among ties between
  // two LIMIT/OFFSET queries, so a row in a tie at the 1,000 boundary could
  // come back on both pages or on neither. id (the primary key) breaks every
  // tie; duplicates are dropped as well, in case a row moved between pages.
  const fetchAll = async (key) => {
    const PAGE = 1000;
    let rows = [];
    for (let start = 0; ; start += PAGE) {
      const { data, error } = await supabase
        .from(tableName(key))
        .select("*")
        .eq("user_id", profileId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(start, start + PAGE - 1);
      if (error) return { data: rows.length ? rows : null, error };
      rows = rows.concat(data || []);
      if (!data || data.length < PAGE) {
        const seen = new Set();
        const unique = rows.filter((r) => {
          if (r?.id == null) return true;
          if (seen.has(r.id)) return false;
          seen.add(r.id);
          return true;
        });
        return { data: unique, error: null };
      }
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
// A profile field saves on every keystroke. Those saves went out side by
// side, one PATCH each, and whichever the server committed last won: a save
// held up on a slow network landed after the one for the next letter, and
// the profile kept "Spanis" for "Spanish" and a phone number short a digit
// (SETTINGS-007). Saves for one profile now go out one at a time, in the
// order they were made. A save still waiting whose every field a later save
// also carries is not sent when that later save is allowed as it stands:
// the later one writes the newer values, so typing never builds a backlog of
// one request per letter.
const settingsLines = new Map();
function inProfileOrder(key, fields, replaces, send) {
  let line = settingsLines.get(key);
  if (!line) settingsLines.set(key, line = { tail: Promise.resolve(), waiting: [] });
  const turn = { fields: new Set(fields), superseded: false };
  if (replaces) for (const earlier of line.waiting) if ([...earlier.fields].every(f => turn.fields.has(f))) earlier.superseded = true;
  line.waiting.push(turn);
  const run = line.tail.then(() => {
    line.waiting.splice(line.waiting.indexOf(turn), 1);
    return turn.superseded ? null : send();
  });
  // A save that fails does not hold up the next one.
  const tail = run.then(() => {}, () => {});
  line.tail = tail;
  tail.then(() => { if (line.tail === tail) settingsLines.delete(key); });
  return run;
}

// A save that has had no answer for this long ends as a failed one: its
// request is cancelled, it is queued for the next load like any save the
// network lost, and the saves waiting behind it go on. With no limit, one
// PATCH stalled on a captive portal or a dead cellular link held every later
// change to the profile (the rest of the field, the theme, the notification
// switches) in memory, neither sent nor queued, and a reload lost them all.
export const SETTINGS_SEND_LIMIT_MS = 15_000;
function settingsRequest(owner, build) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ data: null, error: { code: "settings_timeout", message: "The save had no answer and was cancelled." } });
    }, SETTINGS_SEND_LIMIT_MS);
  });
  return writeRequest(owner, () => Promise.race([build(controller.signal), expired])).finally(() => clearTimeout(timer));
}

// Settings saves made before the page load's first membership answer
// (settingsStatus "verify", reason "no_answer"): queueId -> account. Each
// member edit is written to the queue at once, marked awaitingAccess, so a
// reload or a page left while it waits (the Setup board flushes on pagehide)
// still has it, and the next answer sends it. While this page waits on that
// answer itself, the queued copy is this page's: replay in every page of
// this browser leaves it alone (the queue is in localStorage, which they
// share, so the mark is on the copy itself: decidingUntil, and a Web Lock
// named by its id that this page holds until it decides), and the notices
// do not count it (writtenAheadCount), so a load does not flash "1 change is
// saved on this device". The answer then decides it here: allowed, it is
// sent in profile order and the copy leaves the queue; refused, the copy
// leaves the queue; still none (no connection), the copy stays, counted, for
// the answer that comes later (the replay on each answer, AppContext).
//
// The Setup board's own stamps (automatic) are never written ahead: one
// kept past its answer was a whole setupState laid over, and later sent
// over, a newer copy from another device, for a change nobody made. They
// wait in memory, go up when the answer allows them, and are dropped when
// none comes; the next load stamps them again. A stamp the network loses
// (offline, a failed or timed-out send) is dropped the same way, never
// queued (sendSettings). All but the task that closed (lastTouched,
// lastDone): the board stamps that only as it sees the task close, never on
// a load, so that part alone is written ahead or queued, as what it changed
// (lastingStamp).
const writtenAhead = new Map();
// How long a written-ahead copy counts as being decided, at most: the
// check's own backstop (12 s), the send's (SETTINGS_SEND_LIMIT_MS), and
// saves of the same profile ahead of it. Past it (a page frozen or closed
// without its lock manager to say so), any page's replay sends it.
export const WRITE_AHEAD_DECIDING_MS = 60_000;
// A copy this young counts as decided by a live page even before its lock is
// seen by another page's query. Only a copy written after this page's code
// ran: one already on the queue by then (flushed at pagehide by the page this
// one reloaded) has no live page behind it unless its lock says so. Not
// performance.timeOrigin: a reload's new page starts at the navigation, and
// the old page's pagehide and unload (its flush) come after that, so its
// copy always looked written while this page was open.
// When the grace runs out with no lock behind the copy, the page that left it
// out asks the lock manager again (graceRunsOut): the notice is told, and a
// replay it skipped runs again (onWrittenAheadFreed).
export const WRITE_AHEAD_LOCK_GRACE_MS = 2_000;
const PAGE_OPENED_AT = Date.now();
const inGrace = (op, now) => {
  const ts = Number(op?.ts) || 0;
  return ts >= PAGE_OPENED_AT && now - ts < WRITE_AHEAD_LOCK_GRACE_MS;
};
const freedListeners = new Set();
/**
 * Called with the account id when a save another page wrote ahead,
 * which a replay here left to that page during its lock grace, turns out to
 * have no live page behind it: the caller replays the queue again (AppContext).
 */
export function onWrittenAheadFreed(listener) {
  freedListeners.add(listener);
  return () => freedListeners.delete(listener);
}
const graceTimers = new Map(); // accountId -> { at, timer, replay }
function graceRunsOut(accountId, ops, { replay = false } = {}) {
  const ends = ops.map(op => (Number(op?.ts) || 0) + WRITE_AHEAD_LOCK_GRACE_MS);
  if (!ends.length) return;
  const at = Math.max(...ends);
  const current = graceTimers.get(accountId);
  if (current && current.at >= at) { current.replay ||= replay; return; }
  if (current) clearTimeout(current.timer);
  const entry = { at, replay: replay || current?.replay === true, timer: null };
  entry.timer = setTimeout(() => {
    if (graceTimers.get(accountId) === entry) graceTimers.delete(accountId);
    // The notice reads the queue again (writtenAheadCount), now past the grace.
    notifySync(accountId);
    if (!entry.replay) return;
    for (const listener of freedListeners) { try { listener(accountId); } catch { /* a listener must not stop the others */ } }
  }, Math.max(0, at - Date.now()) + 50);
  entry.timer?.unref?.();
  graceTimers.set(accountId, entry);
}
const decidingLock = queueId => `credentialdomd:deciding:${queueId}`;
const stillDeciding = (op, now = Date.now()) => typeof op?.decidingUntil === "number" && op.decidingUntil > now;
const decidingLocks = () => {
  const locks = globalThis.navigator?.locks;
  return typeof locks?.query === "function" ? locks : null;
};
// Whether another page's marked copy has a live page deciding it, as the
// lock manager last said (queueId -> boolean). writtenAheadCount is read
// synchronously on every sync change, so it reads this and asks the lock
// manager again in the background, and the notice is told when the answer
// differs.
const liveDeciding = new Map();
let decidingQuery = null, askAgain = null;
function refreshLiveDeciding(accountId, marked) {
  const locks = decidingLocks();
  if (!locks) return;
  if (decidingQuery) { askAgain = [accountId, marked]; return; }
  decidingQuery = (async () => {
    let names;
    try {
      const state = await locks.query();
      names = new Set([...(state?.held || []), ...(state?.pending || [])].map(lock => lock?.name));
    } catch { return; }
    const now = Date.now();
    let changed = false;
    const graced = [];
    for (const op of marked) {
      const locked = names.has(decidingLock(op.queueId));
      const live = locked || inGrace(op, now);
      if (!locked && live) graced.push(op);
      if (liveDeciding.get(op.queueId) !== live) changed = true;
      liveDeciding.set(op.queueId, live);
    }
    // Live only by the grace: asked again once it runs out.
    graceRunsOut(accountId, graced);
    if (changed) notifySync(accountId);
  })().finally(() => {
    decidingQuery = null;
    const again = askAgain;
    askAgain = null;
    if (again) refreshLiveDeciding(...again);
  });
}
// When the earliest mark runs out nothing else may change the queue, and
// the notice would go on leaving that copy out until some later sync event.
const markExpiry = new Map(); // accountId -> { at, timer }
function noticeWhenMarksRunOut(accountId, at) {
  const current = markExpiry.get(accountId);
  if (current && current.at <= at && current.at > Date.now()) return;
  if (current) clearTimeout(current.timer);
  const timer = setTimeout(() => { markExpiry.delete(accountId); notifySync(accountId); }, Math.max(0, at - Date.now()) + 50);
  timer?.unref?.();
  markExpiry.set(accountId, { at, timer });
}
/** How many queued ops of this account are saves written ahead that a page of this browser is still deciding. */
export function writtenAheadCount(accountId) {
  const slot = pendingOpsSlot(accountId);
  if (!slot) return 0;
  let queued;
  try { queued = JSON.parse(localStorage.getItem(slot) || "[]"); } catch { return 0; }
  if (!Array.isArray(queued)) return 0;
  const now = Date.now();
  const locks = decidingLocks();
  let count = 0, earliest = Infinity;
  const marked = [];
  for (const op of queued) {
    if (writtenAhead.get(op?.queueId) === accountId) { count++; continue; }
    if (!stillDeciding(op, now)) continue;
    earliest = Math.min(earliest, op.decidingUntil);
    marked.push(op);
    // Without the Web Locks API the mark's deadline alone says so. With it,
    // a copy whose page is gone (reloaded, closed) is nobody's to decide, so
    // the notice counts it as kept. One the lock manager has not been asked
    // about yet stays out of the notice until it answers, so another tab's
    // copy does not flash on it.
    if (!locks || inGrace(op, now) || liveDeciding.get(op.queueId) !== false) count++;
  }
  for (const id of [...liveDeciding.keys()]) if (!marked.some(op => op.queueId === id)) liveDeciding.delete(id);
  if (marked.length) {
    noticeWhenMarksRunOut(accountId, earliest);
    refreshLiveDeciding(accountId, marked);
  }
  return count;
}
// The ops of `ops` another live page is still deciding. Without the Web Locks
// API the mark's deadline alone says so; with it, a copy whose page is gone
// (reloaded, closed) is no longer anybody's to decide.
async function decidingInLivePages(ops, accountId) {
  const now = Date.now();
  const marked = ops.filter(op => stillDeciding(op, now) && !writtenAhead.has(op.queueId));
  if (!marked.length) return new Set();
  const locks = decidingLocks();
  if (!locks) return new Set(marked.map(op => op.queueId));
  let names;
  try {
    const state = await locks.query();
    names = new Set([...(state?.held || []), ...(state?.pending || [])].map(lock => lock?.name));
  } catch { return new Set(marked.map(op => op.queueId)); }
  // Left to its page only by the grace: once that runs out with still no lock
  // behind it, this replay runs again rather than wait for the next answer.
  graceRunsOut(accountId, marked.filter(op => !names.has(decidingLock(op.queueId)) && inGrace(op, now)), { replay: true });
  return new Set(marked.filter(op => names.has(decidingLock(op.queueId)) || inGrace(op, now)).map(op => op.queueId));
}
function writeAhead(owner, settings, meta) {
  return writeAheadOp(owner, "settings", "settings", redactForExport(settings), meta);
}
// A record write (add, edit, star, delete, its tombstone) made before this
// page load's first answer (authorizeOwner owner.firstAnswer) is written
// ahead the same way, so a reload, or a page closed while it waits, keeps
// it: the next load lays a kept delete or star over what it reads back
// (utils/heldChanges.js applyHeldQueue), and its first answer sends it. The
// write's own wait decides the copy (heldForAccess): kept, or taken off the
// queue when it is sent or refused.
// Not a document carrying its file: a second copy of a data URL in
// localStorage could fill it (and say so) for a save that is about to be
// sent anyway. Its device copy keeps it across a reload, and the next load
// uploads it (reconcileDocumentFiles); a held one is queued as before.
function writeAheadRecord(owner, op, collectionKey, payload, meta = {}) {
  if (!owner.authorized || owner.firstAnswer !== true) return null;
  if (collectionKey === "documents" && payload && typeof payload === "object" && payload.data) return null;
  return writeAheadOp(owner, op, collectionKey, payload, meta);
}
function writeAheadOp(owner, op, collectionKey, payload, meta) {
  const queueId = crypto.randomUUID();
  // Held until this page decides it (settleWrittenAhead); released by the
  // browser if the page goes first.
  let release = null;
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request === "function") {
    const decided = new Promise(resolve => { release = resolve; });
    try { Promise.resolve(locks.request(decidingLock(queueId), () => decided)).catch(() => {}); } catch { release = null; }
  }
  const kept = queuePendingOp(op, collectionKey, payload, owner,
    { ...AWAITING_ACCESS, ...meta, queueId, decidingUntil: Date.now() + WRITE_AHEAD_DECIDING_MS });
  if (!kept) { release?.(); return null; }
  writtenAhead.set(queueId, owner.accountId);
  notifySync(owner.accountId);
  return { queueId, kept: false, release };
}
// The wait is over. Kept (no answer still): its mark comes off and it is
// counted, and replayed, from now on. Otherwise its copy leaves the queue:
// sent, refused, or a later save carries its fields.
// `ahead.mark`: fields the kept copy takes on (accessRefused, heldForAccess).
// Decided once: a later call does nothing.
function settleWrittenAhead(owner, ahead) {
  if (ahead.settled) return;
  ahead.settled = true;
  writtenAhead.delete(ahead.queueId);
  const slot = pendingOpsSlot(owner.accountId);
  try {
    const queued = JSON.parse(localStorage.getItem(slot) || "[]");
    if (Array.isArray(queued) && queued.some(op => op?.queueId === ahead.queueId)) {
      const rest = ahead.kept
        ? queued.map(op => { if (op?.queueId !== ahead.queueId) return op; const { decidingUntil: _decided, ...copy } = op; return { ...copy, ...(ahead.mark || {}) }; })
        : queued.filter(op => op?.queueId !== ahead.queueId);
      if (rest.length) localStorage.setItem(slot, JSON.stringify(rest));
      else localStorage.removeItem(slot);
    }
  } catch { /* the queue stays as it was; replay decides the copy once its mark runs out */ }
  ahead.release?.();
  notifySync(owner.accountId);
}

// What a queued settings save carries besides its fields: the setupState it
// was made from, when it changes setupState and the caller knew it
// (`previous`), so replay and a load apply it as what it changed
// (syncRules rebaseSetupState) rather than whole.
function setupBaseMeta(settings, previous) {
  if (!settings || !Object.hasOwn(settings, "setupState")) return {};
  if (!previous || typeof previous !== "object" || !Object.hasOwn(previous, "setupState")) return {};
  return { setupBase: previous.setupState ?? null };
}

// Of a board stamp, the part the next load cannot make again: the task that
// closed (syncRules closedTaskStamp). Kept like a member's change, on the
// queue as what it changed (setupBase), when the stamp itself is not; marked
// automatic, so a membership that refuses it drops it without a word.
function lastingStamp(settings, previous) {
  if (!settings || !Object.hasOwn(settings, "setupState")) return null;
  if (!previous || typeof previous !== "object" || !Object.hasOwn(previous, "setupState")) return null;
  const setupState = closedTaskStamp(previous.setupState, settings.setupState);
  return setupState ? { settings: { setupState }, meta: { setupBase: previous.setupState ?? null, automatic: true } } : null;
}

/**
 * Save profile settings. `automatic`: nobody did this (the Setup board's own
 * stamps); it is never kept on the queue, whether held for a membership
 * answer or lost by the network, except for the task that closed
 * (lastingStamp), which no later load stamps again.
 * `previous`: the settings as they were before this change (setupState),
 * for a kept copy's base.
 */
export async function saveSettings(userId, settings, authUserId, { automatic = false, previous = null } = {}) {
  const owner = writeContext(authUserId);
  authorizeOwner(owner, () => guardSettings(owner, settings), options => accessAuthority.settingsStatus(settings, owner.accountId, options));
  // The identity and the membership decision are taken now, when the change
  // was made, and an allowed change's device keys (never sent) are kept now
  // too; only the sending waits its turn.
  const allowedNow = !owner.authorized;
  if (allowedNow) saveDeviceKeys(owner.accountId, settings);
  const meta = setupBaseMeta(settings, previous);
  const lasting = automatic === true ? lastingStamp(settings, previous) : null;
  // A member's save made before the page load's first answer: on the queue
  // now (writtenAhead). The board's own stamps wait in memory only, all but
  // the task that closed, which is written ahead on its own.
  const noAnswer = owner.authorized && accessAuthority.settingsStatus(settings, owner.accountId).reason === "no_answer";
  const ahead = !noAnswer ? null
    : automatic !== true ? writeAhead(owner, settings, meta)
      : lasting ? writeAhead(owner, lasting.settings, lasting.meta) : null;
  const run = inProfileOrder(`${owner.accountId}\u0000${userId || ""}`, Object.keys(settings || {}), allowedNow,
    () => sendSettings(owner, userId, settings, allowedNow, { ahead, automatic: automatic === true, meta, lasting }));
  // Its wait decides the copy (sendSettings: heldForAccess), before any
  // PATCH goes out, so a save that reached the server is never left queued
  // to be sent again. This only settles a copy whose wait never finished:
  // an account change keeps it, unless the answer refused it.
  if (ahead) run.then(() => settleWrittenAhead(owner, ahead), error => {
    if (error?.code === "membership_account_changed" && owner.refusedByAnswer !== true) ahead.kept = true;
    settleWrittenAhead(owner, ahead);
  });
  return run;
}

async function sendSettings(owner, userId, settings, deviceKeysSaved, { ahead = null, automatic = false, meta = {}, lasting = null } = {}) {
  // A board stamp that does not go up: only the task that closed is kept.
  const keepLasting = (extra = {}) => {
    if (lasting) queuePendingOp("settings", "settings", redactForExport(lasting.settings), owner, { ...extra, ...lasting.meta });
    return null;
  };
  // A written-ahead copy is decided with the wait, as a record's is: kept
  // when held, off the queue when allowed (before the PATCH: a send that
  // fails re-queues it below) or refused.
  if (owner.authorized && await heldForAccess(owner, ahead)) {
    // Kept on this device while membership could not be confirmed: its
    // device keys are saved here, and the rest is queued like an offline edit.
    saveDeviceKeys(owner.accountId, settings);
    // Written ahead already: that copy is the queued one (a board stamp's
    // is only the task that closed).
    if (ahead) return null;
    // The board's own stamp is not kept past its answer: the next load
    // stamps it again from the account's copy, and a kept one would be laid
    // over (and sent over) whatever the member changes meanwhile.
    if (automatic) return keepLasting(AWAITING_ACCESS);
    queuePendingOp("settings", "settings", redactForExport(settings), owner, { ...AWAITING_ACCESS, ...meta });
    return null;
  }
  if (!deviceKeysSaved) saveDeviceKeys(owner.accountId, settings);
  if (!supabase || !userId) {
    // Offline (or before the profile loads) a settings edit has nowhere to
    // go and used to vanish on the next cloud merge. Queue it like any other
    // write; replay applies it once the session is back. Device-local material
    // is stripped through the one redaction, so a queued patch sitting on disk
    // holds no more than a cloud write would.
    // The board's own stamp is not kept: the next load stamps it again.
    if (automatic) return keepLasting();
    const clean = redactForExport(settings);
    queuePendingOp("settings", "settings", clean, owner, meta);
    return null;
  }
  const row = settingsToProfileRow(settings);
  row.updated_at = new Date().toISOString();
  // Read the row back so a server-enforced value (e.g. the identity lock on
  // email) is surfaced instead of being silently cached as whatever we sent.
  const { data, error } = await settingsRequest(owner, signal => owner.db
    .from("profiles")
    .update(row)
    .eq("id", userId)
    .select()
    .abortSignal(signal)
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
      const retry = await settingsRequest(owner, signal => owner.db.from("profiles").update(rest).eq("id", userId).select().abortSignal(signal).maybeSingle());
      owner.check();
      if (!retry.error) {
        console.warn("That email is on another CredentialDOMD account, so it was not saved. Everything else was.", { refused });
        forgetQueuedSettings(owner, Object.keys(settings).filter(k => k !== "email"));
        // The row as stored, so the caller can put the address it still holds
        // back on screen without another read.
        return { ...(retry.data ? profileRowToSettings(retry.data) : {}), savedExcept: "email" };
      }
      console.warn("Failed to save settings:", retry.error.message);
      if (automatic) return keepLasting();
      const clean = redactForExport(settings); delete clean.email;
      queuePendingOp("settings", "settings", clean, owner, meta);
      return null;
    }
    console.warn("Failed to save settings:", error.message);
    // A board stamp the network lost (a failed or timed-out PATCH) is not
    // queued either: the Sign out warning counts the queue as changes the
    // member made, and the next load stamps it again. The task that closed
    // is the exception (lastingStamp).
    if (automatic) return keepLasting();
    const clean = redactForExport(settings);
    queuePendingOp("settings", "settings", clean, owner, meta);
    return null;
  }
  if (data && "email" in row && data.email !== row.email) {
    console.warn("Settings email was not accepted by the server (identity lock?):", { sent: row.email, stored: data.email });
  }
  forgetQueuedSettings(owner, Object.keys(settings));
  return data ? profileRowToSettings(data) : null;
}

// A value a save has just stored is newer than the same field in a settings
// patch queued before it (a keystroke whose save failed on a network blip).
// Replayed on the next load, that patch would put the older text back, the
// same "Spanis" by another road (SETTINGS-007). The stored fields leave the
// queued patches; a patch left with nothing is dropped.
function forgetQueuedSettings(owner, fields) {
  const slot = pendingOpsSlot(owner.accountId);
  if (!slot || !fields.length) return;
  try {
    const queued = JSON.parse(localStorage.getItem(slot) || "[]");
    if (!Array.isArray(queued)) return;
    let changed = false;
    const kept = [];
    for (const op of queued) {
      if (op?.op !== "settings" || !op.payload || typeof op.payload !== "object") { kept.push(op); continue; }
      const stale = fields.filter(field => Object.hasOwn(op.payload, field));
      if (!stale.length) { kept.push(op); continue; }
      changed = true;
      const rest = { ...op.payload };
      for (const field of stale) delete rest[field];
      if (Object.keys(rest).length) kept.push({ ...op, payload: rest });
    }
    if (!changed) return;
    if (kept.length) localStorage.setItem(slot, JSON.stringify(kept));
    else localStorage.removeItem(slot);
  } catch { return; /* the queue stays as it was */ }
  // The notice counts queued changes; without this it went on saying one had
  // not reached the account after it had, for the rest of the session.
  notifySync(owner.accountId);
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

/**
 * Put a document that is on this device only into the cloud: its file (when
 * the bytes are here) and then its whole row, with storage_path, mime_type
 * and size, as one upsert. Returns the storage path only when BOTH landed.
 *
 * The self-heal used to upload the bytes and then UPDATE a row that did not
 * exist (0 rows, no error), and set storagePath locally anyway, after which
 * the cache dropped the only local bytes: the file sat in Storage with no
 * row, on no other device. A document whose bytes were uploaded but whose row
 * never landed (storagePath, no data) gets its row the same way.
 *
 * The row carries the copy's own times, never "now". A copy never edited on
 * this device (no updatedAt) only creates a missing row: stamped "now" and
 * upserted whole, a phone's stale copy (unfiled, old name) replaced the row
 * another device had filed, looked newer than that filing, and every device
 * then took it. When the row is already there it stands, and null is
 * returned (nothing of this copy was written).
 */
export async function uploadDocumentFile(item, authUserId, userId) {
  const owner = recordContext("documents", item, undefined, true, authUserId);
  // Kept on this device while membership could not be confirmed: its
  // pendingUpload mark (or the next load's self-heal) sends it later.
  if (owner.authorized && await heldForAccess(owner)) return null;
  if (!supabase || !userId || !item?.id) return null;
  const startedAt = Date.now();
  const row = clientRow("documents", item);
  row.user_id = userId;
  const own = row.created_at || row.uploaded_at || new Date(startedAt).toISOString();
  row.created_at = own;
  const insertOnly = !row.updated_at;
  if (insertOnly) row.updated_at = own;
  if (item.data) {
    const path = await uploadForOwner(item, owner);
    if (!path) return null;
    row.storage_path = path;
    row.size_bytes = item.size || null;
  }
  if (!row.storage_path) return null; // no bytes anywhere: no row can be made
  row.mime_type = documentMime(item);
  const { data, error } = await writeRequest(owner, () => (insertOnly
    ? owner.db.from("documents").upsert(row, { onConflict: "id", ignoreDuplicates: true }).select("id")
    : owner.db.from("documents").upsert(row, { onConflict: "id" })));
  owner.check();
  noteWriteOutcome(owner, "documents", item.id, error);
  if (error) return null;
  // Insert-only, and the row was there already: it stands as it is.
  if (insertOnly && Array.isArray(data) && data.length === 0) return null;
  dropSupersededWrites(owner, "documents", item.id, startedAt);
  return row.storage_path;
}

/**
 * Where a document's file is in Storage. Uploads write `<account>/<doc id>`,
 * but a document uploaded before the Clerk continuity bind lives under the
 * SOURCE account's id, which the row's storage_path records. That path is
 * used only in the exact shape `user_<id>/<this doc id>` (no dot segments,
 * no empty segment); anything else falls back to the current account's path.
 * Storage RLS (continuity_documents_owner) still decides which prefixes this
 * session may remove, so a forged path reaches nothing it could not already.
 * Both paths are returned when they differ: a self-heal can re-upload a
 * pre-bind file under the current account, and either copy must go.
 */
export function documentObjectPaths(itemId, accountId, storagePath) {
  const id = String(itemId || "");
  if (!id) return [];
  const paths = [];
  if (typeof storagePath === "string" && !storagePath.includes("..") && !storagePath.includes("//") && !storagePath.includes("\\")) {
    const m = storagePath.match(/^(user_[A-Za-z0-9]+)\/([^/]+)$/);
    if (m && m[2] === id) paths.push(storagePath);
  }
  if (accountId) {
    const canonical = `${accountId}/${id}`;
    if (!paths.includes(canonical)) paths.push(canonical);
  }
  return paths;
}

// The removal's error, or null. A caller keeps the delete queued on an error
// (deleteItem, sbDeleteRow), so the file is retried rather than orphaned.
async function removeDocumentObject(owner, itemId, storagePath) {
  const paths = documentObjectPaths(itemId, owner.accountId, storagePath);
  if (!paths.length) return null;
  const { data: removed, error: rmErr } = await writeRequest(owner, () => owner.db.storage.from("documents").remove(paths));
  owner.check();
  if (rmErr) return rmErr;
  // Storage answers a path that matched nothing with an empty list and no
  // error; that is a miss, not a success, and is said so it can be swept.
  if (Array.isArray(removed) && removed.length === 0) console.warn(`Document file delete found nothing at ${paths.join(", ")} (object may orphan)`);
  return null;
}

async function uploadForOwner(item, owner) {
  owner.check();
  if (!supabase || !item?.data) return null;
  const path = `${owner.accountId}/${item.id}`;
  const blob = dataUrlToBlob(item.data);
  if (!blob) return null;
  // The same type the row records, so the stored object and the row agree.
  const { error } = await writeRequest(owner, () => owner.db.storage.from("documents")
    .upload(path, blob, { contentType: documentMime(item), upsert: true }));
  owner.check();
  if (error) { console.warn("Document file upload failed:", error.message); return null; }
  return path;
}

/**
 * Ask the server for the next invoice number (allocate_invoice_number,
 * migration 20260929210000): kind "INV" or "EXP", day as YYYYMMDD (the
 * device's local day), atLeast the device's own next suffix. Resolves to
 * { data, error } like any rpc. Returns null when there is no cloud client
 * (local development), so the caller works the number out on the device.
 */
export function allocateInvoiceNumberRpc(kind, day, atLeast) {
  if (!supabase) return null;
  return supabase.rpc("allocate_invoice_number", { p_kind: kind, p_day: day, p_at_least: atLeast });
}

/**
 * Stamp on the server that the invoice numbered `number` was handed to the
 * share sheet or the clipboard (`shared` false clears it: the share was
 * cancelled, or the note was forgotten). `sharedAt` is when the device
 * handed it over (ISO): a stamp sent again later is dated then, not on
 * arrival. Migration 20260930230000_invoice_number_shared.sql. A thenable of
 * { data, error } (the request is sent once it is awaited or .then'd), or
 * null without a cloud client. See utils/invoiceHandoff.js.
 */
export function markInvoiceNumberSharedRpc(number, { shared = true, contractId = null, sharedAt = null } = {}) {
  if (!supabase) return null;
  return stampDb().rpc("mark_invoice_number_shared", { p_number: number, p_shared: shared, p_contract_id: contractId, p_shared_at: shared ? sharedAt || null : null });
}

// The stamp goes out as the file goes to the share sheet, and iOS can put the
// page away for Mail or Gmail a moment later, or discard it there (the
// owner's iPhone, 2026-10-02). Sent with keepalive, a request already on its
// way finishes even if the page does not. Its own client, made on first use;
// otherwise the shared one's settings.
let stampClient = null;
function stampDb() {
  if (typeof fetch !== "function") return supabase;
  stampClient ||= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: getClerkSupabaseToken,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init = {}) => fetch(input, { ...init, keepalive: true }) },
  });
  return stampClient;
}

// A call day (YYYY-MM-DD), and the one `by` days from it.
const CALL_DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayShift = (day, by) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};

/**
 * What the server holds now, before a one-tap "Yes, it was sent" records an
 * invoice (utils/invoiceRecordCheck.js): whether an invoice with `number`
 * exists, and which of `ids` in `collectionKey` ("dutyDays", "workLog",
 * "travelExpenses") are on an invoice already. Another device may have
 * recorded it, and this device's copy is read only when the app loads.
 * `profileId` narrows the read to the account (RLS does too). A promise of
 * { data: { numberTaken, billedIds, billedOn }, error } (billedOn: row id to
 * the number of the invoice that bills it), or null without a cloud client.
 * An empty `number` checks the rows only.
 *
 * Read only with the member's token (memberDb). The shared client sends the
 * anon key when Clerk cannot mint one (window.Clerk.session briefly null as
 * the iPhone resumes from Mail, exactly when Yes is tapped), and these
 * tables' policies are `to authenticated`: that read answered no rows and no
 * error, which said "free" and let Yes record a second invoice under a number
 * already recorded on another device. Without a token it is an error now,
 * which the check answers "unknown" (asked first).
 *
 * `stipend` ({ contractId, days }, Work log only): also the billed work log
 * rows of that contract filed under those call days, as `stipendRows`
 * ({ id, invoiceId, number, contractId, type, callDay, date, startTime,
 * endTime, billedMin }), so the screen can tell which days' stipends another
 * invoice has charged (utils/stipendDays.js withStipendDays). A coverage day
 * with nothing logged has no row of its own to ask about by id (review of
 * release/goal2, 2026-10-02).
 */
export function readInvoiceRecordState(number, collectionKey, ids = [], profileId = null, stipend = null) {
  if (!supabase) return null;
  const db = memberDb();
  const n = String(number ?? "").trim();
  // ilike: the same number in any case (Mark as sent takes what is typed);
  // its wildcards are matched as themselves.
  const like = n.replace(/[\\%_]/g, (c) => `\\${c}`);
  const mine = (q) => (profileId ? q.eq("user_id", profileId) : q);
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  const days = collectionKey === "workLog" && stipend?.contractId
    ? [...new Set((stipend.days || []).map(String).filter((d) => CALL_DAY.test(d)))].sort()
    : [];
  return Promise.all([
    // No number: a check of the items only (the day picker, before a number).
    n ? mine(db.from("invoices").select("id").ilike("number", like)).limit(1) : Promise.resolve({ data: [], error: null }),
    list.length && collectionKey
      ? mine(db.from(tableName(collectionKey)).select("id,invoice_id").in("id", list)).not("invoice_id", "is", null)
      : Promise.resolve({ data: [], error: null }),
    // The contract's billed rows on those call days: stamped with the day,
    // or (a row from before the stamp) dated within a day of it, its call
    // day worked out on the device.
    days.length
      ? mine(db.from(tableName("workLog")).select("id,invoice_id,contract_id,type,call_day,date,start_time,end_time,billed_min")
        .eq("contract_id", String(stipend.contractId))).not("invoice_id", "is", null)
        .or(`call_day.in.(${days.join(",")}),and(call_day.is.null,date.gte.${dayShift(days[0], -1)},date.lte.${dayShift(days[days.length - 1], 1)})`)
      : Promise.resolve({ data: [], error: null }),
  ]).then(async ([inv, rows, dayRows]) => {
    const error = inv?.error || rows?.error || dayRows?.error || null;
    if (error) return { data: null, error };
    // Only rows it asked about that an invoice bills (the filters say so;
    // checked here too, so a server that ignored one never marks a row
    // billed that is not).
    const asked = new Set(list);
    const billed = (rows.data || []).filter((r) => r?.invoice_id && asked.has(String(r.id)));
    const onDays = (dayRows.data || []).filter((r) => r?.invoice_id && String(r.contract_id) === String(stipend?.contractId));
    // Which invoice bills each row, so the screen can name it ("already on
    // INV-A"). A failed lookup still answers which rows are billed.
    const invoiceIds = [...new Set([...billed, ...onDays].map((r) => r.invoice_id).filter(Boolean).map(String))];
    let numbers = new Map();
    if (invoiceIds.length) {
      try {
        const named = await mine(db.from("invoices").select("id,number").in("id", invoiceIds));
        if (!named?.error) numbers = new Map((named.data || []).map((r) => [String(r.id), r.number]));
      } catch { /* named as "another invoice" */ }
    }
    return {
      data: {
        numberTaken: (inv.data || []).length > 0,
        billedIds: billed.map((r) => String(r.id)),
        billedOn: Object.fromEntries(billed.map((r) => [String(r.id), numbers.get(String(r.invoice_id)) || null])),
        ...(days.length ? {
          stipendRows: onDays.map((r) => ({
            id: String(r.id), invoiceId: String(r.invoice_id), number: numbers.get(String(r.invoice_id)) || null,
            contractId: String(r.contract_id), type: r.type || null, callDay: r.call_day || null, date: r.date || null,
            startTime: r.start_time || null, endTime: r.end_time || null, billedMin: r.billed_min ?? null,
          })),
        } : {}),
      },
      error: null,
    };
  }, (error) => ({ data: null, error }));
}

/**
 * Whether the server holds an invoice numbered `number` now (any case), read
 * with the member's token only (memberDb). A promise of { data: boolean,
 * error }, or null without a cloud client. The stamp of a recorded invoice is
 * cleared only once its record is there (utils/invoiceHandoff.js): until
 * then the stamp is the only trace on the server that it went.
 */
export function readInvoiceNumberRecorded(number) {
  const read = readInvoiceRecordState(number, null, [], null);
  return read ? read.then((r) => (r.error ? { data: null, error: r.error } : { data: !!r.data?.numberTaken, error: null })) : null;
}

/** The account's numbers handed to the share sheet that no invoice carries yet: [{ number, shared_at, contract_id }]. */
export function listSharedInvoiceNumbersRpc() {
  if (!supabase) return null;
  return supabase.rpc("list_shared_invoice_numbers");
}

/**
 * The file as a Blob, or null. downloadDocumentFile below re-encodes the same
 * bytes as a base64 data URL, which costs roughly five copies of the file in
 * memory once the caller decodes it again. Anything that only needs a File
 * should use this. `signal` aborts the request (the certificate prefetch's
 * time budget). With { detail: true } it says why not, like
 * downloadDocumentFile: { blob } | { missing: true } | { failed: true }.
 * `onProgress(bytesSoFar)` is called when Storage answers and as each chunk
 * of the file arrives, so a caller can time out a download that has stalled
 * rather than one that is slow (a large scan on a weak link).
 */
export async function downloadDocumentBlob(storagePath, { signal, detail = false, onProgress } = {}) {
  const answer = (value) => (detail ? value : value.blob || null);
  if (!supabase || !storagePath) return answer({ failed: true });
  const { data, error } = await fetchDocumentFile(storagePath, signal, onProgress);
  if (error || !data) return answer((await isMissingObject(error)) ? { missing: true } : { failed: true });
  return answer({ blob: data });
}

// Document files are read through their own client, which never sends the
// anon key. The shared client falls back to `Bearer <anon key>` whenever
// Clerk cannot mint a token (a token refresh that failed, a network blip,
// window.Clerk.session briefly null), and the documents bucket's policies
// are `to authenticated` only, so Storage answers that request exactly as it
// answers a deleted object: HTTP 400, statusCode 404, "Object not found". No
// body can tell the two apart, and a file read as missing tells the member to
// upload it again or delete the entry. So a download without the member's
// token is never sent: this token callback throws instead, and the helpers
// say "failed" (tried again later). Made on the first download.
// The same client answers the reads whose empty answer would be taken as
// "nothing there" (readInvoiceRecordState): a read the RLS policies would
// answer with no rows for the anon key is never sent without the token.
let memberClient = null;
function memberDb() {
  memberClient ||= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: async () => {
      const token = await getClerkSupabaseToken();
      if (!token) throw new Error("No signed-in session to read this with.");
      return token;
    },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return memberClient;
}
function documentFiles() {
  return memberDb().storage.from("documents");
}

// { data, error } like storage-js, never a throw: a download that could not
// be sent is an error (so "failed"), whatever threw it.
async function fetchDocumentFile(storagePath, signal, onProgress) {
  try {
    const request = documentFiles().download(storagePath, {}, signal ? { signal } : undefined);
    if (typeof onProgress !== "function" || typeof request?.asStream !== "function") return await request;
    // Read as a stream to see the bytes arrive. The error path is storage-js's
    // own (the same request), so a missing object still reads as missing.
    const { data: body, error } = await request.asStream();
    if (error || !body) return { data: null, error };
    onProgress(0);
    const reader = body.getReader();
    const parts = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value?.byteLength || 0;
      onProgress(received);
    }
    return { data: new Blob(parts), error: null };
  } catch (error) {
    return { data: null, error };
  }
}

// Storage answers a missing object with HTTP 400 and { statusCode: "404",
// error: "not_found", message: "Object not found" } (or a plain 404). A
// download asks storage-js not to parse the answer (noResolveJson), so its
// error is not that body: storage-js 2.97 hands back a StorageUnknownError
// whose message is "{}" (JSON.stringify of a Response) and whose
// originalError is the unread Response. The facts are in that body, so it is
// read here; a missing object and an expired session are both HTTP 400 and
// only the body tells them apart. Without this every missing file read as
// "failed" and was asked for again on every load (and CME showed "{}").
async function storageErrorFacts(error) {
  if (!error) return null;
  const res = error.originalError;
  if (res && typeof res.status === "number" && typeof res.text === "function") {
    let body = null;
    try { body = JSON.parse(await res.text()); } catch { /* no body, or not JSON */ }
    return { status: res.status, statusCode: body?.statusCode, code: body?.error ?? body?.code, message: body?.message };
  }
  return { status: error.status, statusCode: error.statusCode, code: typeof error.error === "string" ? error.error : undefined, message: error.message };
}

async function isMissingObject(error) {
  const facts = await storageErrorFacts(error);
  if (!facts) return false;
  return String(facts.statusCode) === "404" || facts.status === 404
    || /object not found|not_found|no ?such ?key/i.test(`${facts.message || ""} ${facts.code || ""}`);
}

/**
 * The file as a data URL, or null. With { detail: true } it says why not:
 * { dataUrl } | { missing: true } (Storage has no such object: re-trying will
 * not help) | { failed: true } (offline, expired session: retried later). A
 * download that failed used to leave the document "Fetching" for ever.
 */
export async function downloadDocumentFile(storagePath, { detail = false } = {}) {
  const answer = (value) => (detail ? value : value.dataUrl || null);
  if (!supabase || !storagePath) return answer({ failed: true });
  const { data, error } = await fetchDocumentFile(storagePath);
  if (error || !data) return answer((await isMissingObject(error)) ? { missing: true } : { failed: true });
  const dataUrl = await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = (e) => resolve(e.target.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(data);
  });
  return answer(dataUrl ? { dataUrl } : { failed: true });
}

// ─── Collection CRUD ─────────────────────────────────────────
// Answers with the document's storage path once its file AND its row are both
// saved (AppContext records it on the device: utils/docStoragePath.js), and
// null when the write was queued or failed. Other collections answer null.
// `keepOnRefusal`: the record of work already done outside the app (an
// invoice that went out), kept and queued even when the check it waits for
// refuses it (authorizeOwner).
// What runs when an invoice insert finds its number on another invoice of the
// account (main.jsx: read the account again, utils/serverBilling.js).
let invoiceNumberConflict = null;
export function setInvoiceNumberConflictHandler(fn) { invoiceNumberConflict = typeof fn === "function" ? fn : null; }

export async function insertItem(userId, collectionKey, item, { keepOnRefusal = false } = {}) {
  if (!isSyncedCollection(collectionKey)) return refuseUnsynced(collectionKey);
  const owner = recordContext(collectionKey, item, undefined, false, undefined, { keepOnRefusal });
  const ahead = writeAheadRecord(owner, "upsert", collectionKey, item);
  // The record's turn: a delete, edit or star of it waits for this add, and
  // this add waits for a replayed queued write of the same id in flight.
  const turn = takeRecordTurn(owner, collectionKey, item?.id);
  try {
    if (turn.ready) { await turn.ready; owner.check(); }
    return await insertForOwner(userId, collectionKey, item, owner, ahead);
  } finally {
    turn.done();
    // Stopped before its wait decided it (the account changed): replay does.
    if (ahead && !ahead.settled) { ahead.kept = true; settleWrittenAhead(owner, ahead); }
  }
}

async function insertForOwner(userId, collectionKey, item, owner, ahead = null) {
  // Kept on this device while membership could not be confirmed: queued
  // (written ahead already, before the page load's first answer).
  if (owner.authorized && await heldForAccess(owner, ahead)) { if (!ahead) queuePendingOp("upsert", collectionKey, item, owner, heldMeta(owner)); return null; }
  // No cloud target yet (offline / local dev): queue so it isn't lost.
  if (!supabase || !userId) { queuePendingOp("upsert", collectionKey, item, owner); return null; }
  const startedAt = Date.now();
  const table = tableName(collectionKey);
  // Without fields not in DB, or written only by the server
  const row = clientRow(collectionKey, item);
  row.user_id = userId;
  row.created_at = row.created_at || new Date().toISOString();
  row.updated_at = new Date().toISOString();
  // Documents: push the file bytes to Storage and record where they live.
  if (collectionKey === "documents" && item.data) {
    const path = await uploadForOwner(item, owner);
    if (!path) { queuePendingOp("upsert", collectionKey, item, owner); return null; }
    row.storage_path = path;
    // Never null: a file the browser typed as "" (an Office file on iOS or
    // Windows, a .heic) used to upload its bytes and then have its row refused.
    row.mime_type = documentMime(item);
    row.size_bytes = item.size || null;
  }
  let { error } = await writeRequest(owner, () => owner.db.from(table).insert(row));
  owner.check();
  // Its own id already there: the record reached the cloud another way while
  // this insert was on its way (a load's self-heal push or file reconcile,
  // made while the app was in the background, landed first). Saved, not "it
  // duplicates another record" (review of 9484782c). An invoice number
  // another invoice carries is handled below.
  if (error && writeErrorCode(error) === "23505" && item?.id) {
    const found = await writeRequest(owner, () => owner.db.from(table).select("id").eq("id", item.id).eq("user_id", userId).maybeSingle());
    owner.check();
    const landed = Array.isArray(found?.data) ? found.data[0] : found?.data;
    if (!found?.error && landed?.id === item.id) error = null;
  }
  // Its number is another invoice's on the account (the server keeps one
  // invoice per number, migration 20261002030000): recorded on another
  // device. Not queued and never retried; the account is read again, and the
  // load leaves the cloud's invoice standing (AppContext). 2026-10-02.
  if (error && invoiceNumberTaken(collectionKey, error)) {
    noteWriteOutcome(owner, collectionKey, item.id, null);
    invoiceRecordedElsewhere(owner, item?.id);
    return null;
  }
  const kind = noteWriteOutcome(owner, collectionKey, item.id, error);
  if (error) {
    console.warn(`Failed to insert ${collectionKey}:`, error.message);
    queuePendingOp("upsert", collectionKey, item, owner, failureMeta(error, kind));
    return null;
  }
  dropSupersededWrites(owner, collectionKey, item.id, startedAt);
  // A document's storage path, once its file and row both landed: the caller
  // records it so the cached copy can drop the bytes (utils/storage saveData).
  return row.storage_path || null;
}

// An edit sends only the columns it changed from the record it started from
// (IOS-SYNC-3, 2026-10-01). The whole record went up, so an iPhone app back
// from days in memory that changed only a license's notes put back the name
// the member had changed at the desk since, with no warning. A column this
// edit left as it found it is the server's to keep. The whole record still
// goes when there is nothing to compare with, or while a queued write of the
// record that is the whole record (an add that never landed) waits. A queued
// edit is itself a list of changed columns (editMeta): this edit carries
// those columns too, so its landing can take the queued copy out
// (dropSupersededWrites).
//
// The same holds once queued (review of 9484782c): a failed, held or offline
// edit used to wait as the whole record and replay as an upsert of every
// column, so the queue sent when the signal came back put the phone's old
// expiration date and star over the desk's renewal. It now keeps the columns
// it changed (`changed`, the record's own keys) and replays as an UPDATE of
// those alone (sbEditRow), falling back to an upsert of the whole record only
// when the row does not exist.
//
// A packed column (jsonb holding many fields: a custom record's field
// values, a category's fields) is merged per field against the copy the edit
// started from (`base`), over the server's copy as it is now: a change to one
// field no longer sends the phone's stale copy of every other. Every table's
// custom_fields is one (review of 5cb89c90): an archive of a locum contract
// (customFields.archivedAt), a license's topic answers, a case log's
// cptDetail each sent the phone's stale copy of the other keys whole.
const sameColumnValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const PACKED_COLUMNS = Object.freeze({
  customRecords: Object.freeze(["field_values", "field_labels", "custom_fields", "document_ids"]),
  customCategories: Object.freeze(["fields", "aliases", "custom_fields"]),
});
const PACKED_EVERYWHERE = Object.freeze(["custom_fields"]);
const packedColumns = collectionKey => PACKED_COLUMNS[collectionKey] || PACKED_EVERYWHERE;
const EDIT_UNCOMPARED = new Set(["id", "user_id", "created_at", "updated_at"]);
// What is queued for this record: null (nothing), "whole" (a write that is
// the whole record, or a queue that cannot be read), or the columns queued
// edits changed, with the base each packed column started from (the oldest).
function queuedEdits(owner, collectionKey, id) {
  const slot = pendingOpsSlot(owner.accountId);
  if (!slot) return "whole";
  let cur;
  try { cur = JSON.parse(localStorage.getItem(slot) || "[]"); } catch { return "whole"; }
  if (!Array.isArray(cur)) return "whole";
  const mine = cur.filter(op => supersedes(op, collectionKey, id));
  if (!mine.length) return null;
  const changed = new Set(), base = {};
  for (const op of mine) {
    if (op.op === "patch") { for (const key of Object.keys(op.payload || {})) if (key !== "id") changed.add(key); continue; }
    if (!Array.isArray(op.changed)) return "whole";
    for (const key of op.changed) changed.add(key);
    for (const [col, value] of Object.entries(op.base || {})) if (!Object.hasOwn(base, col)) base[col] = value;
  }
  return { changed, base };
}
/**
 * An edit as what it changed: { changed: [the record's keys], base: {packed
 * column: its value in the record the edit started from} }, or null when it
 * must go whole (nothing to compare with, or the whole record queued).
 */
function editMeta(owner, collectionKey, item, previous) {
  if (!item?.id || !previous || typeof previous !== "object" || previous.id !== item.id) return null;
  const queued = queuedEdits(owner, collectionKey, item.id);
  if (queued === "whole") return null;
  const mine = clientRow(collectionKey, item, "update");
  const before = clientRow(collectionKey, previous, "update");
  const changed = new Set(queued?.changed || []);
  for (const key of Object.keys(item)) {
    const col = camelToSnake(key);
    if (EDIT_UNCOMPARED.has(col) || !Object.hasOwn(mine, col)) continue;
    if (!(Object.hasOwn(before, col) && sameColumnValue(mine[col], before[col]))) changed.add(key);
  }
  const base = { ...(queued?.base || {}) };
  for (const col of packedColumns(collectionKey)) {
    if (Object.hasOwn(base, col)) continue;
    if ([...changed].some(key => camelToSnake(key) === col)) base[col] = Object.hasOwn(before, col) ? before[col] : null;
  }
  return { changed: [...changed], base };
}
// An edit's meta as a queued op carries it ({} for a whole record).
const editMetaFields = meta => (meta ? { changed: meta.changed, base: meta.base } : {});
// The row narrowed to the edit's changed columns (id kept).
function narrowRow(row, meta) {
  if (!meta || !Array.isArray(meta.changed)) return;
  const cols = new Set(meta.changed.map(camelToSnake));
  for (const col of Object.keys(row)) if (col !== "id" && !cols.has(col)) delete row[col];
}
const isPlainObject = v => !!v && typeof v === "object" && !Array.isArray(v);
const keyedList = v => Array.isArray(v) && v.length > 0 && v.every(x => isPlainObject(x) && typeof x.key === "string");
/**
 * A packed column's value: the server's copy now, with what `mine` changed
 * from `base` laid over it, field by field. An object is merged per key, a
 * list of fields per field key, a list of plain values as a set. Anything
 * else is `mine`.
 */
export function rebasePacked(server, base, mine) {
  if (isPlainObject(mine) || (mine == null && isPlainObject(base))) {
    const out = isPlainObject(server) ? { ...server } : {};
    const was = isPlainObject(base) ? base : {}, now = isPlainObject(mine) ? mine : {};
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (sameColumnValue(now[key], was[key])) continue;
      if (Object.hasOwn(now, key)) out[key] = now[key]; else delete out[key];
    }
    return out;
  }
  if (Array.isArray(mine)) {
    const theirs = Array.isArray(server) ? server : [];
    const was = Array.isArray(base) ? base : [];
    if (keyedList(mine) || keyedList(was) || keyedList(theirs)) {
      const byKey = list => new Map(list.filter(isPlainObject).map(x => [x.key, x]));
      const wasBy = byKey(was), nowBy = byKey(mine);
      const touched = new Set([...wasBy.keys(), ...nowBy.keys()].filter(key => !sameColumnValue(nowBy.get(key), wasBy.get(key))));
      const out = [];
      const seen = new Set();
      for (const x of theirs) {
        const key = isPlainObject(x) ? x.key : undefined;
        if (key !== undefined) seen.add(key);
        if (key === undefined || !touched.has(key)) { out.push(x); continue; }
        if (nowBy.has(key)) out.push(nowBy.get(key));
      }
      for (const x of mine) if (isPlainObject(x) && touched.has(x.key) && !seen.has(x.key)) out.push(x);
      return out;
    }
    const added = mine.filter(x => !was.some(y => sameColumnValue(x, y)));
    const removed = was.filter(x => !mine.some(y => sameColumnValue(x, y)));
    const out = theirs.filter(x => !removed.some(y => sameColumnValue(x, y)));
    for (const x of added) if (!out.some(y => sameColumnValue(x, y))) out.push(x);
    return out;
  }
  return mine;
}
// The packed columns of an edit's row, rebased on the server's copy now.
// Returns the read's error; no row leaves `row` as it is (the update then
// finds no row and the whole record goes).
async function rebasePackedColumns(owner, userId, collectionKey, row, meta, id) {
  const cols = packedColumns(collectionKey).filter(col => Object.hasOwn(row, col) && meta?.base && Object.hasOwn(meta.base, col));
  if (!cols.length) return null;
  const { data, error } = await writeRequest(owner, () => owner.db.from(tableName(collectionKey))
    .select(cols.join(",")).eq("id", id).eq("user_id", userId).maybeSingle());
  if (error) return error;
  const server = Array.isArray(data) ? data[0] : data;
  if (!server) return null;
  for (const col of cols) row[col] = rebasePacked(server[col], meta.base[col], row[col]);
  return null;
}
/**
 * The queued edits as what they changed, for a load to lay over the rows it
 * read back (AppContext self-heal): `${collectionKey}:${id}` -> the record's
 * changed keys. Only edits queued as changed columns.
 */
export function queuedEditKeys(authUserId) {
  const out = new Map();
  const slot = pendingOpsSlot(authUserId);
  if (!slot) return out;
  try {
    const cur = JSON.parse(localStorage.getItem(slot) || "[]");
    for (const op of Array.isArray(cur) ? cur : []) {
      if (op?.op !== "upsert" || !Array.isArray(op.changed)) continue;
      const id = recordIdOf(op.payload);
      if (!id) continue;
      const key = `${op.collectionKey}:${id}`;
      const keys = out.get(key) || new Set();
      for (const k of op.changed) keys.add(k);
      out.set(key, keys);
    }
  } catch { /* unreadable: nothing laid over */ }
  return out;
}

// `partial`: `item` carries only some columns (the link sweep's { id,
// linkedTo }). It is queued as a narrow "patch", never as an upsert, which
// could not insert a row from a few columns and so failed for ever.
export async function updateItem(userId, collectionKey, item, previous, authUserId, { partial = false, keepOnRefusal = false } = {}) {
  if (!isSyncedCollection(collectionKey)) return refuseUnsynced(collectionKey);
  const owner = recordContext(collectionKey, item, previous, true, authUserId, { keepOnRefusal });
  const retryOp = partial ? "patch" : "upsert";
  // Queued, it keeps what it changed (editMeta), never the whole record.
  const asQueued = () => (partial ? {} : editMetaFields(editMeta(owner, collectionKey, item, previous)));
  const ahead = writeAheadRecord(owner, retryOp, collectionKey, item, asQueued());
  try {
    if (owner.authorized && await heldForAccess(owner, ahead)) { if (!ahead) queuePendingOp(retryOp, collectionKey, item, owner, { ...heldMeta(owner), ...asQueued() }); return; }
  } finally { if (ahead && !ahead.settled) { ahead.kept = true; settleWrittenAhead(owner, ahead); } }
  if (!supabase || !userId) { queuePendingOp(retryOp, collectionKey, item, owner, asQueued()); return; }
  // The record's add may still be uploading (a document is read before it is
  // stored, so its card can be saved the moment the upload starts). Sent
  // first, the UPDATE matched no row, the whole document (file included) was
  // queued, and the add then landed with the values from before the edit.
  // And a queued older copy of this record that replay is sending lands
  // first. This edit's turn lasts until it has landed and taken the record's
  // older queued copies out of the queue: a replay that reaches one of them
  // meanwhile waits for it, then finds the copy gone (replayForOwner).
  const turn = takeRecordTurn(owner, collectionKey, item.id);
  try {
    if (turn.ready) { await turn.ready; owner.check(); }
    const table = tableName(collectionKey);
    const row = clientRow(collectionKey, item, "update");
    delete row.user_id;
    delete row.created_at;
    const meta = partial ? null : editMeta(owner, collectionKey, item, previous);
    narrowRow(row, meta);
    const rebaseError = await rebasePackedColumns(owner, userId, collectionKey, row, meta, item.id);
    owner.check();
    if (rebaseError) {
      console.warn(`Failed to read ${collectionKey} before an edit:`, rebaseError.message);
      queuePendingOp(retryOp, collectionKey, item, owner, { ...failureMeta(rebaseError), ...editMetaFields(meta) });
      return;
    }
    const startedAt = Date.now();
    row.updated_at = new Date(startedAt).toISOString();
    let { data, error } = await writeRequest(owner, () => owner.db
      .from(table)
      .update(row)
      .eq("id", item.id)
      .eq("user_id", userId)
      .select("id"));
    owner.check();
    // Its invoice id refused: the row is on an invoice another device
    // recorded first, which stands. The rest of the edit goes without it;
    // nothing goes when that was all it changed. The account is read again.
    if (error && invoiceGuardRefused(collectionKey, error) && Object.hasOwn(row, "invoice_id")) {
      const { invoice_id: _refused, ...rest } = row;
      if (Object.keys(rest).some(col => col !== "id" && col !== "updated_at")) {
        ({ data, error } = await writeRequest(owner, () => owner.db.from(table).update(rest).eq("id", item.id).eq("user_id", userId).select("id")));
        owner.check();
      } else { data = [{ id: item.id }]; error = null; }
      try { invoiceNumberConflict?.(); } catch { /* the next load reads it */ }
    }
    // No error and no row: the record's add never reached the cloud (its
    // insert is still queued). The edit used to report success here and be
    // lost; the queued add then replayed the old values. Queue the edit behind
    // the add, so replay ends on the edit.
    if (!error && Array.isArray(data) && data.length === 0) {
      // A partial write cannot create the row; the record's own add carries it.
      if (!partial) queuePendingOp("upsert", collectionKey, item, owner);
      return;
    }
    const kind = noteWriteOutcome(owner, collectionKey, item.id, error);
    if (error) {
      console.warn(`Failed to update ${collectionKey}:`, error.message);
      // Replay as an upsert: if the row was never inserted (a failed add), the
      // update would no-op, so upsert recovers both cases. A partial write
      // replays as a patch.
      queuePendingOp(retryOp, collectionKey, item, owner, { ...failureMeta(error, kind), ...(partial ? {} : editMetaFields(editMeta(owner, collectionKey, item, previous))) });
    } else if (!partial) {
      // The whole record landed: its earlier queued writes are stale.
      dropSupersededWrites(owner, collectionKey, item.id, startedAt);
    }
  } finally { turn.done(); }
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
  if (!isSyncedCollection(collectionKey)) return refuseUnsynced(collectionKey);
  const payload = { id: item?.id, favorite: !!favorite };
  const owner = recordContext(collectionKey, { ...item, favorite: !!favorite }, item, true, authUserId);
  const ahead = writeAheadRecord(owner, "favorite", collectionKey, payload);
  try {
    if (owner.authorized && await heldForAccess(owner, ahead)) { if (!ahead) queueFavorite(owner, collectionKey, payload, AWAITING_ACCESS); return; }
  } finally { if (ahead && !ahead.settled) { ahead.kept = true; settleWrittenAhead(owner, ahead); } }
  if (!supabase || !userId) { queueFavorite(owner, collectionKey, payload); return; }
  // The record's turn. Its add may still be in flight (a star sent first
  // matches no row), or replay may be sending a queued older copy of it: the
  // star waits for either to land. A replayed copy that reaches the record
  // while the star is in flight waits for the star, and then carries it.
  const turn = takeRecordTurn(owner, collectionKey, payload.id);
  try {
    if (turn.ready) { await turn.ready; owner.check(); }
    const startedAt = Date.now();
    const error = await sbFavoriteRow(userId, collectionKey, payload, owner);
    owner.check();
    if (error) {
      console.warn(`Failed to set favorite on ${collectionKey}`);
      queueFavorite(owner, collectionKey, payload, error === NO_ROW ? {} : failureMeta(error));
      return;
    }
    settleQueuedStar(owner, collectionKey, payload, startedAt);
  } finally { turn.done(); }
}

export async function deleteItem(userId, collectionKey, itemId, previous) {
  if (!isSyncedCollection(collectionKey)) return refuseUnsynced(collectionKey);
  const owner = recordContext(collectionKey, previous || { id: itemId }, previous, true);
  // A document's file is where its row says it is. The path is NOT always
  // <this sign-in>/<id>: a continuity-migrated account's files sit under its
  // old sign-in id, and removing the computed path deleted nothing while the
  // row and the tombstone went, leaving the credential file in Storage. RLS
  // limits a removal to this account's own prefixes, so a stored path cannot
  // reach another account's files. The queued op carries the path, so a
  // delete made offline removes the file on replay too (it used to delete
  // only the row).
  const before = previous || accessAuthority.previousRecord(collectionKey, itemId, owner.accountId);
  const payload = collectionKey === "documents" ? { id: itemId, storagePath: before?.storagePath || `${owner.accountId}/${itemId}` } : itemId;
  const ahead = writeAheadRecord(owner, "delete", collectionKey, payload);
  let held;
  try { held = !!owner.authorized && await heldForAccess(owner, ahead); }
  finally { if (ahead && !ahead.settled) { ahead.kept = true; settleWrittenAhead(owner, ahead); } }
  // The add this delete undoes may still be uploading. Deleting first matched
  // nothing, and the add then landed behind the tombstone.
  await settleInsert(owner, collectionKey, itemId);
  dropQueuedWrites(owner, collectionKey, itemId);
  if (held) { if (!ahead) queuePendingOp("delete", collectionKey, payload, owner, AWAITING_ACCESS); return; }
  if (!supabase || !userId) { queuePendingOp("delete", collectionKey, payload, owner); return; }
  let fileError = null;
  if (collectionKey === "documents") {
    // Await the removal so a failure is visible (and retried) instead of
    // silently orphaning the stored object.
    fileError = await removeDocumentObject(owner, itemId, before?.storagePath);
    if (fileError) console.warn("Document file delete failed (queued to retry):", fileError.message);
  }
  const table = tableName(collectionKey);
  const { error } = await writeRequest(owner, () => owner.db
    .from(table)
    .delete()
    .eq("id", itemId)
    .eq("user_id", userId));
  owner.check();
  if (error || fileError) {
    if (error) console.warn(`Failed to delete ${collectionKey}:`, error.message);
    queuePendingOp("delete", collectionKey, payload, owner, failureMeta(error || fileError));
  }
}

// ─── Bulk sync (for initial migration from localStorage) ─────
export async function bulkSync(userId, collectionKey, items, authUserId) {
  if (!isSyncedCollection(collectionKey)) return refuseUnsynced(collectionKey);
  const owner = writeContext(authUserId);
  const previous = items.map(item => accessAuthority.previousRecord(collectionKey, item?.id, owner.accountId));
  authorizeOwner(owner, () => items.forEach((item, index) => guardRecord(owner, collectionKey, item, previous[index], true)),
    options => accessAuthority.statusFor(items.flatMap((item, index) => [
      ...accessAuthority.mutationScopes(collectionKey, item, previous[index]),
      ...(collectionKey === "documents" && !previous[index] ? ["credential", "practice"] : []),
    ]), owner.accountId, { ...options, awaitAnswer: true }));
  // Kept on this device while membership could not be confirmed: none of
  // these rows went up (the caller counts them; the next load pushes them).
  if (owner.authorized && await heldForAccess(owner)) return items.length;
  if (!supabase || !userId || !items.length) return;
  const table = tableName(collectionKey);
  const startedAt = Date.now();
  const now = new Date(startedAt).toISOString();
  const rows = items.map((item) => {
    const row = clientRow(collectionKey, item);
    row.user_id = userId;
    if (!row.created_at) row.created_at = now;
    if (!row.updated_at) row.updated_at = now;
    return row;
  });
  const { error } = await writeRequest(owner, () => owner.db.from(table).upsert(rows, { onConflict: "id" }));
  owner.check();
  if (!error) {
    for (const row of rows) {
      noteWriteOutcome(owner, collectionKey, row.id, null);
      dropSupersededWrites(owner, collectionKey, row.id, startedAt);
    }
    return 0;
  }
  // One bad row must not strand the rest — retry each row alone so the
  // failure is contained to the row that actually has the problem.
  console.warn(`Bulk sync ${collectionKey} failed (${error.message}) — retrying row-by-row`);
  let failed = 0;
  for (const row of rows) {
    let { error: e2 } = await writeRequest(owner, () => owner.db.from(table).upsert(row, { onConflict: "id" }));
    owner.check();
    // Its invoice id refused (billed on an invoice recorded elsewhere first):
    // pushed without it, the account's invoice stands.
    if (e2 && invoiceGuardRefused(collectionKey, e2) && Object.hasOwn(row, "invoice_id")) {
      const { invoice_id: _refused, ...rest } = row;
      ({ error: e2 } = await writeRequest(owner, () => owner.db.from(table).upsert(rest, { onConflict: "id" })));
      owner.check();
    }
    // The self-heal push is how a refused record comes back every load, so
    // a refusal here is reported and listed like one on the save itself.
    noteWriteOutcome(owner, collectionKey, row.id, e2 || null);
    if (e2) { failed += 1; console.warn(`Row ${row.id} of ${collectionKey} still failing:`, e2.message); }
    else dropSupersededWrites(owner, collectionKey, row.id, startedAt);
  }
  // How many rows did not land, for a caller that must say so (a restore).
  return failed;
}

// ─── Deletion ledger ─────────────────────────────────────────
// A delete recorded here is final across all devices: loads prune these ids
// and the self-healing push skips them, so stale devices can't resurrect.
export async function recordTombstone(userId, collectionKey, itemId, previous) {
  // A device-only record has nothing in the cloud to keep deleted.
  if (!isSyncedCollection(collectionKey)) return refuseUnsynced(collectionKey);
  const owner = recordContext(collectionKey, previous || { id: itemId }, previous, true);
  if (!itemId) return;
  const ahead = writeAheadRecord(owner, "tombstone", collectionKey, itemId);
  let held;
  try { held = !!owner.authorized && await heldForAccess(owner, ahead); }
  finally { if (ahead && !ahead.settled) { ahead.kept = true; settleWrittenAhead(owner, ahead); } }
  await settleInsert(owner, collectionKey, itemId);
  dropQueuedWrites(owner, collectionKey, itemId);
  if (held) { if (!ahead) queuePendingOp("tombstone", collectionKey, itemId, owner, AWAITING_ACCESS); return; }
  if (!supabase || !userId) { queuePendingOp("tombstone", collectionKey, itemId, owner); return; }
  const { error } = await writeRequest(owner, () => owner.db.from("deleted_items").upsert(
    { item_id: itemId, user_id: userId, collection: collectionKey },
    { onConflict: "item_id" }
  ));
  owner.check();
  if (error) {
    console.warn("Failed to record deletion:", error.message);
    queuePendingOp("tombstone", collectionKey, itemId, owner, failureMeta(error));
  }
}

/**
 * Un-delete: remove these ids from the deletion ledger, for a backup restore
 * that brings them back. Without it the restore upserted each record while
 * its tombstone stayed, so every load hid it again (row and tombstone both in
 * the database). Queued deletes and tombstones of the same ids are dropped
 * too, or a later replay would delete them again. Returns true only when the
 * ledger was cleared (or there was nothing to clear).
 *
 * With `collectionKey`, what could not be cleared (offline, no profile yet, a
 * failed request) is queued like any failed write, and the next load's replay
 * clears it before the ledger is read: the restored records the caller kept
 * on this device are then pushed up by the self-heal. Without it they stayed
 * behind their markers, and the next load hid them for good although the
 * restore had said to open the app again online to retry.
 */
export async function clearTombstones(userId, ids, authUserId, { collectionKey } = {}) {
  const owner = writeContext(authUserId);
  const wanted = [...new Set(ids || [])].filter(isUuid);
  if (!wanted.length) return true;
  const slot = pendingOpsSlot(owner.accountId);
  try {
    const cur = JSON.parse(localStorage.getItem(slot) || "[]");
    if (Array.isArray(cur)) {
      const set = new Set(wanted);
      const kept = cur.filter(op => !((op?.op === "delete" || op?.op === "tombstone") && set.has(recordIdOf(op.payload))));
      if (kept.length !== cur.length) {
        if (kept.length) localStorage.setItem(slot, JSON.stringify(kept)); else localStorage.removeItem(slot);
        notifySync(owner.accountId);
      }
    }
  } catch { /* storage unavailable */ }
  const queueRest = (rest, error) => {
    if (isSyncedCollection(collectionKey)) queuePendingOp(UNDELETE_OP, collectionKey, { ids: rest }, owner, failureMeta(error));
  };
  if (!supabase || !userId) { queueRest(wanted, null); return false; }
  for (let i = 0; i < wanted.length; i += 100) {
    const chunk = wanted.slice(i, i + 100);
    const error = await sbUntombstoneRows(userId, chunk, owner);
    owner.check();
    if (error) { queueRest(wanted.slice(i), error); return false; }
  }
  return true;
}

export async function listTombstones(userId) {
  if (!supabase || !userId) return new Set();
  // PostgREST caps a single response at 1,000 rows; a long-lived account can
  // hold more tombstones than that, so page until a short page ends it.
  const PAGE = 1000;
  const ids = new Set();
  for (let start = 0; ; start += PAGE) {
    // item_id is unique (the upsert conflicts on it): a total order, so no
    // tombstone is skipped or read twice across pages.
    const { data, error } = await supabase
      .from("deleted_items")
      .select("item_id")
      .eq("user_id", userId)
      .order("item_id", { ascending: true })
      .range(start, start + PAGE - 1);
    // A ledger that could not be read is not an empty ledger. Returning the
    // partial set let the self-heal push this device's copies of records
    // deleted on another device straight back up.
    if (error || !Array.isArray(data)) {
      const failure = new Error("The deletion ledger could not be read.");
      failure.code = "tombstones_unavailable";
      throw failure;
    }
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
  owner.continuitySource = boundContinuitySource(authUserId);
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
// The account then stays closed until its owner signs in again, when
// initialize-clerk-profile reopens it empty (migration 20260930020000). Its
// deletion stamp (deleted_at, then data_deleted_at, and the sign-in receipt's
// dataDeletedAt) tells every device to drop the copy it holds from before the
// wipe, once (src/utils/dataDeletion.js, WIPE_SEEN_KEY). The reply carries
// deleted_at so the device that asked records the wipe as already purged.
