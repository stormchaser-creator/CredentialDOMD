/**
 * Per-user namespace for everything the app keeps on the device.
 *
 * Every localStorage key that holds one physician's data is suffixed with
 * the signed-in Clerk user id, e.g. `credentialdomd-data:user_2abc`. Two
 * people sharing an iPad, or a session that lapses without the Sign out
 * button, can no longer hand one account's file to the next: the other
 * account reads a different key and finds nothing.
 *
 * AppContext sets the active user id the moment Clerk resolves. Until then,
 * and whenever nobody is signed in, there is no key at all and every helper
 * here reads empty and writes nothing. Nothing is written to an
 * un-namespaced key any more; the pre-namespace keys are migrated once by
 * adoptLegacyStorage() and then removed.
 */
import { STORAGE_KEY, LOCAL_ONLY_SETTINGS } from "../constants/defaults.js";
import { clearSupportTextDrafts } from "./supportTextDrafts.js";
import { DEVICE_ONLY_SECTIONS } from "./pausedApplicationRecords.js";

export const BASE_KEYS = {
  data: STORAGE_KEY,                       // the whole file (mirror of the cloud)
  vault: "credentialdomd-private-vault",   // patient-identifying notes, device-only
  chat: "credentialdomd-assistant-chat",
  archives: "credentialdomd-assistant-archives",
  timer: "credentialdomd-live-timer",
  lastContract: "credentialdomd-last-contract", // the Work Log contract last used, a bare id
  // The Work Log contract picked for one call day, { contractId, callDay }
  // (utils/scheduledContract.js): it outranks the schedule for that call day
  // only. Kept apart from lastContract so the contract last used stays a bare
  // id and neither overwrites the other.
  contractPick: "credentialdomd-contract-pick",
  pendingOps: "credentialdomd-pending-ops", // writes that failed to reach the cloud, replayed next load
  // Who last completed a signed-in load on this device (offline fallback
  // identity, src/utils/offlineSession.js). Listed here so purgeUserStorage
  // removes it with everything else: a session that ended in sign-out leaves
  // no identity behind, and the offline fallback can never activate.
  lastIdentity: "credentialdomd-last-identity",
  // CallSync sync bookkeeping (last check, last result); the feed link
  // itself lives in the device-key slot with the AI keys.
  callsync: "credentialdomd-callsync",
  // The server's last membership answer for this account, two booleans
  // (src/utils/limitedLaunchAccess.js): which archive a cold start opens on
  // before this session's first check answers.
  accessAnswer: "credentialdomd-access-answer",
  // Invoices that went out while their record was refused, until they are on
  // the Invoices tab (utils/invoiceRecord.js): number, day sent, amount,
  // period. They exist nowhere else, so a session that ends keeps them, as it
  // keeps the running timer; Sign out and Delete All My Data remove them.
  unrecordedInvoices: "credentialdomd-unrecorded-invoices",
};

// The profiles.deleted_at stamp this device last purged its cache for
// (AppContext, after a server-side account deletion). Deliberately NOT in
// BASE_KEYS: purgeUserStorage and the sign-out purge must leave it, or every
// sign-in after a wipe would purge again. It holds a timestamp, nothing else.
export const WIPE_SEEN_KEY = "credentialdomd-wipe-seen";

// The purge fence (src/utils/dataDeletion.js). A new random value is written
// BEFORE each purge a data deletion causes on this device (Delete All My Data
// run here, or a server deletion honored here), and whenever this device
// records a deletion stamp. Every tab of the account remembers the value its
// records were loaded under (adoptLocalFence) and, once the device's value
// has moved past it, writes nothing more into this account's local copy: not
// the cached file, not the write queue, not the vault or the device keys. A
// tab left open with records from before a deletion therefore cannot put
// them back for the self-heal push or the queue replay to send up again.
// Not in BASE_KEYS, so no purge removes it. It holds a random marker only.
export const LOCAL_FENCE_KEY = "credentialdomd-local-fence";

// An explicit purge must also retire unfinished development-to-production
// recovery. Keep this outside BASE_KEYS so the purge cannot remove its own
// protection. It contains only a fixed marker, never cached data or secrets.
export const CONTINUITY_RETIREMENT_BASE = "credentialdomd-continuity-retired-v1";
export const CONTINUITY_JOURNAL_BASE = "credentialdomd-continuity-recovery-v1";
const retiredContinuitySubjects = new Set();
const knownContinuitySubjects = new Set();

/** Register only after authenticated continuity validation, before any await. */
export function registerContinuityRecoverySubject(userId) {
  if (userId) knownContinuitySubjects.add(userId);
}

function hasContinuityRecovery(userId) {
  if (knownContinuitySubjects.has(userId) || retiredContinuitySubjects.has(userId)) return true;
  try {
    if (localStorage.getItem(`${CONTINUITY_RETIREMENT_BASE}:${userId}`) !== null) return true;
    const prefix = `${CONTINUITY_JOURNAL_BASE}:${userId}:`;
    for (let i = 0; i < localStorage.length; i += 1) {
      if (localStorage.key(i)?.startsWith(prefix)) return true;
    }
  } catch {
    // Preserve the existing ordinary-account purge contract when there is no
    // known continuity. A caller with authenticated continuity must register it
    // first; unavailable storage cannot establish that history after a reload.
  }
  return false;
}

function continuityRetirementFailure(code) {
  const error = new Error(code === "continuity_recovery_retired"
    ? "Automatic recovery of this account's old device data has been retired."
    : "Could not save the protection against restoring old device data. The local purge did not begin. Free device storage and try again.");
  error.code = code;
  return error;
}

/** Synchronous, durable barrier BEFORE any deliberate local deletion. */
export function retireContinuityRecovery(userId) {
  if (!userId || !hasContinuityRecovery(userId)) return;
  // Also stop already pending work when persistence fails. This memory barrier
  // cannot survive a reload, so failure MUST abort the purge and reach the UI.
  retiredContinuitySubjects.add(userId);
  const key = `${CONTINUITY_RETIREMENT_BASE}:${userId}`;
  try {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, "retired");
    if (localStorage.getItem(key) === null) throw new Error();
  } catch { throw continuityRetirementFailure("continuity_retirement_unavailable"); }
}

/** Check at every recovery await/commit, including asynchronous adapters. */
export function assertContinuityRecoveryAllowed(userId) {
  if (retiredContinuitySubjects.has(userId)) throw continuityRetirementFailure("continuity_recovery_retired");
  let marker;
  try { marker = localStorage.getItem(`${CONTINUITY_RETIREMENT_BASE}:${userId}`); }
  catch { throw continuityRetirementFailure("continuity_retirement_unavailable"); }
  // Any present value is a denial. A damaged marker must never enable a copy.
  if (marker !== null) throw continuityRetirementFailure("continuity_recovery_retired");
}

// AI keys and the portal-password lock code, one slot per user
// (src/lib/supabase.js, src/utils/secretBox.js). Deliberately NOT in
// BASE_KEYS: purgeUserStorage also runs on an involuntary sign-out (session
// expiry, revocation from the Clerk dashboard), and a token timing out must
// not take the physician's own AI key, or the lock code that is the only way
// to read their encrypted portal passwords, with it. The explicit Sign out
// button and Delete All My Data clear it, through purgeForSignOut() and
// clearDeviceKeys().
export const DEVICE_KEYS_BASE = "credentialdomd-keys";

let activeUserId = null;

// An account that becomes active here again takes back the writes an
// involuntary sign-out kept for it (purgeUserStorage): they are live again
// and no longer age out (sweepLapsedQueues).
export function setActiveUserId(id) {
  activeUserId = id || null;
  if (activeUserId) reclaimKeptQueue(activeUserId);
}
export function getActiveUserId() { return activeUserId; }

/** The namespaced key for `base`, or null when nobody is signed in. */
export function scopedKey(base, userId = activeUserId) {
  return userId ? `${base}:${userId}` : null;
}

// ─── The purge fence (LOCAL_FENCE_KEY above) ──────────────────
// What this tab's records were loaded under, per account. Module state is
// per tab, which is exactly the writer the fence has to stop. An account this
// tab never loaded has no entry and is not fenced: nothing of it is in memory.
const adoptedFences = new Map();

/** The device's current fence value for `userId` (null before any purge). */
export function localFence(userId) {
  return lsGet(LOCAL_FENCE_KEY, userId);
}

/**
 * Move the fence, before a purge. Returns the new value, or null when storage
 * refused the write (full, blocked); the caller then tries again after the
 * purge has freed space.
 */
export function advanceLocalFence(userId) {
  const k = scopedKey(LOCAL_FENCE_KEY, userId);
  if (!k) return null;
  const value = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}`;
  try { localStorage.setItem(k, value); return value; } catch { return null; }
}

/** This tab's records for `userId` now belong to `fence` (default: the device's current value). */
export function adoptLocalFence(userId, fence = localFence(userId)) {
  if (userId) adoptedFences.set(userId, fence ?? null);
}

/** The fence this tab adopted for `userId`, or undefined when it never loaded that account. */
export function adoptedLocalFence(userId) {
  return adoptedFences.has(userId) ? adoptedFences.get(userId) : undefined;
}

/**
 * May a writer whose records belong to `fence` still write this account's
 * local copy? False once this device has purged it since (another tab ran
 * Delete All My Data, or honored a server deletion).
 */
export function localCopyCurrent(userId, fence = adoptedLocalFence(userId)) {
  if (!userId || fence === undefined) return true;
  return (localFence(userId) ?? null) === (fence ?? null);
}

// ─── Small typed accessors (null key = no-op) ─────────────────
export function lsGet(base, userId) {
  const k = scopedKey(base, userId);
  if (!k) return null;
  try { return localStorage.getItem(k); } catch { return null; }
}
export function lsGetJSON(base, userId) {
  const raw = lsGet(base, userId);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const FENCED_BASES = new Set(Object.values(BASE_KEYS));
export function lsSet(base, value, userId) {
  const k = scopedKey(base, userId);
  if (!k) return false;
  // One of the account's data keys, written by a tab whose records predate a
  // purge on this device: refused (the vault, the Assistant transcript, the
  // timer and the rest go through here). See LOCAL_FENCE_KEY.
  if (FENCED_BASES.has(base) && !localCopyCurrent(userId === undefined ? activeUserId : userId)) return false;
  try { localStorage.setItem(k, value); return true; } catch { return false; }
}
export function lsSetJSON(base, value, userId) {
  return lsSet(base, JSON.stringify(value), userId);
}
export function lsRemove(base, userId) {
  const k = scopedKey(base, userId);
  if (!k) return;
  try { localStorage.removeItem(k); } catch { /* unavailable */ }
}

/**
 * The file cut down to what exists only on this device, or null when none of
 * it holds anything: the device-only sections (DEVICE_ONLY_SECTIONS:
 * Protected Identity, the Answer Bank) and the settings the cloud has no
 * column for (LOCAL_ONLY_SETTINGS: the ACCME birthday, Vera's and the
 * coder's model choice), which the next sign-in's load carries back
 * (withLocalOnlySettings). Everything the cloud also holds is dropped.
 */
function deviceOnlyFile(raw) {
  let blob;
  try { blob = JSON.parse(raw); } catch { return null; }
  const kept = {};
  for (const section of Object.keys(DEVICE_ONLY_SECTIONS)) {
    if (Array.isArray(blob?.[section]) && blob[section].length) kept[section] = blob[section];
  }
  const settings = blob?.settings && typeof blob.settings === "object" ? blob.settings : {};
  const local = {};
  for (const k of LOCAL_ONLY_SETTINGS) {
    if (settings[k] !== undefined && settings[k] !== null && settings[k] !== "") local[k] = settings[k];
  }
  if (Object.keys(local).length) kept.settings = local;
  return Object.keys(kept).length ? JSON.stringify(kept) : null;
}

/**
 * Remove every namespaced key belonging to `userId`.
 *
 * `keepVault` is for involuntary sign-outs (session expiry, revocation from
 * the Clerk dashboard): the vault holds patient notes that exist nowhere
 * else, and a token timing out must not destroy them. The key is still
 * unreadable to any other account. The explicit Sign out button and Delete
 * All My Data pass keepVault=false.
 *
 * `keepDeviceOnly` (with keepVault, never with retireRecovery) is the rest of
 * that promise, used by the session-end listener only (purgeAfterSessionEnd):
 * the unsynced-edits queue, the running timer and the invoices that went out
 * unrecorded stay where they are, and the file is cut down to its device-only
 * sections and local-only settings instead of removed. Nothing is
 * created: a key that is not there stays absent. The offline identity slot and
 * every cloud-mirrored record still go, so the offline fallback cannot reopen.
 *
 * The queue kept that way holds writes that have not reached the cloud and
 * exist nowhere else; the explicit Sign out button at least warns about them
 * first. It is keyed by this Clerk user id and replayed only under that same
 * account's session (lib/supabase.js writeContext), so the next sign-in of
 * this account sends them. A server wipe (retireRecovery) drops the queue too,
 * or replay would push pre-wipe records back up.
 *
 * The kept queue holds records (licence and DEA numbers) and, for a document,
 * its whole file, so it is kept for KEPT_QUEUE_MAX_AGE_MS only: each op is
 * stamped keptAt, the account taking it back on this device clears the stamp
 * (setActiveUserId), and sweepLapsedQueues, run whenever the app opens here,
 * removes what its account never came back for. A session revoked on a shared
 * workstation no longer leaves them there for ever.
 */
export async function purgeUserStorage(userId, { keepVault = false, retireRecovery = false, keepDeviceOnly = false } = {}) {
  if (!userId) return;
  const keepLocal = keepDeviceOnly && keepVault && !retireRecovery;
  // A real server wipe may preserve a private vault but must still prevent
  // recovery. Ordinary involuntary sign-out uses keepVault:true without this.
  if (!keepVault || retireRecovery) retireContinuityRecovery(userId);
  // Session expiry keeps this account's text for re-sign-in. Deliberate
  // sign-out/deletion removes it; screenshots are never stored here.
  if (!keepVault || retireRecovery) clearSupportTextDrafts(userId);
  for (const [name, base] of Object.entries(BASE_KEYS)) {
    if (name === "vault" && keepVault) continue;
    // Session expiry also keeps the membership answer (two booleans), so the
    // re-sign-in opens on the right screens instead of "Checking membership".
    // Sign out and a server wipe remove it with everything else.
    if (name === "accessAnswer" && keepVault && !retireRecovery) continue;
    if (keepLocal && name === "pendingOps") { markQueueKept(userId); continue; }
    if (keepLocal && (name === "timer" || name === "unrecordedInvoices")) continue;
    if (keepLocal && name === "data") {
      const raw = lsGet(base, userId);
      if (raw == null) continue;
      const kept = deviceOnlyFile(raw);
      if (kept) lsSet(base, kept, userId); else lsRemove(base, userId);
      continue;
    }
    lsRemove(base, userId);
  }
  const nativeKey = scopedKey(BASE_KEYS.data, userId);
  try {
    if (keepLocal && window.storage?.get) {
      const r = await window.storage.get(nativeKey);
      const kept = r?.value ? deviceOnlyFile(r.value) : null;
      if (kept) { await window.storage.set(nativeKey, kept); return; }
    }
    await window.storage?.remove?.(nativeKey);
  } catch { /* unavailable */ }
}

// Set by the Sign out button just before its purge. Clerk's session-end
// listener fires during that Sign out too, and in every other open tab once
// Clerk broadcasts it; a sibling tab's late cache write can put the whole
// file back after the purge. A listener that finds a recent marker purges
// the way it always did, so a deliberate Sign out never leaves Protected
// Identity behind. Outside BASE_KEYS so the purge cannot remove it first.
// Holds a timestamp, nothing else.
//
// The key names the account, so it must not outlive the Sign out: on a
// shared device it would say who used it. What the listeners need is kept in
// memory instead. The tab that signs out notes it (markDeliberateSignOut),
// every other open tab notes it from the storage event the key's write sends
// (watchSignOutIntents), and a tab that opens while it is there notes it at
// boot (sweepSignOutIntents). The key itself goes as soon as the deliberate
// purge has run (purgeForSignOut, purgeAfterSessionEnd), and the boot sweep
// removes any that outlived SIGNOUT_INTENT_MS (a tab closed mid-purge).
export const SIGNOUT_INTENT_BASE = "credentialdomd-signout-intent";
export const SIGNOUT_INTENT_MS = 2 * 60 * 1000;
const SIGNOUT_INTENT_PREFIX = `${SIGNOUT_INTENT_BASE}:`;
const signOutIntents = new Map(); // Clerk user id -> when its Sign out began

function intentTime(raw) {
  const at = Number(raw);
  return raw != null && Number.isFinite(at) && at > 0 ? at : null;
}
function intentFresh(at, now) {
  return at != null && now - at >= 0 && now - at < SIGNOUT_INTENT_MS;
}
function noteSignOutIntent(userId, at, now = Date.now()) {
  if (!userId || !intentFresh(at, now)) return;
  if (!(signOutIntents.get(userId) >= at)) signOutIntents.set(userId, at);
}

export function markDeliberateSignOut(userId, now = Date.now()) {
  if (!userId) return;
  signOutIntents.set(userId, now);
  lsSet(SIGNOUT_INTENT_BASE, String(now), userId);
}

/** A new session for `userId` on this device: no earlier Sign out claims its listener. */
export function clearDeliberateSignOut(userId) {
  if (userId) signOutIntents.delete(userId);
  lsRemove(SIGNOUT_INTENT_BASE, userId);
}

// The marker's key only, once the deliberate purge has run. What this tab
// (and every tab that saw the key) noted in memory stays for its two minutes.
function removeSignOutIntentKey(userId) {
  lsRemove(SIGNOUT_INTENT_BASE, userId);
}

function deliberateSignOutRecent(userId, now = Date.now()) {
  const noted = signOutIntents.get(userId);
  if (intentFresh(noted ?? null, now)) return true;
  if (noted !== undefined) signOutIntents.delete(userId);
  return intentFresh(intentTime(lsGet(SIGNOUT_INTENT_BASE, userId)), now);
}

/**
 * Note another tab's Sign out as its marker is written. The key is removed
 * again as soon as that tab's purge has run, which can be before Clerk's
 * broadcast reaches this tab's listener. Installed once per window at boot
 * (main.jsx). Returns a function that removes the listener.
 */
export function watchSignOutIntents(target = typeof window !== "undefined" ? window : null) {
  if (typeof target?.addEventListener !== "function") return () => {};
  const onStorage = (event) => {
    const k = event?.key;
    if (typeof k !== "string" || !k.startsWith(SIGNOUT_INTENT_PREFIX)) return;
    noteSignOutIntent(k.slice(SIGNOUT_INTENT_PREFIX.length), intentTime(event.newValue));
  };
  target.addEventListener("storage", onStorage);
  return () => { try { target.removeEventListener?.("storage", onStorage); } catch { /* already gone */ } };
}

/**
 * Run when the app opens (main.jsx), signed in or not. A marker older than
 * SIGNOUT_INTENT_MS (or unreadable, or dated ahead of the clock) is removed:
 * its Sign out is over, and the key would only say who used this device. A
 * fresh one belongs to a Sign out still running in another tab, which
 * removes it; this tab notes it so its own listener purges whole too.
 */
export function sweepSignOutIntents(now = Date.now()) {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SIGNOUT_INTENT_PREFIX)) keys.push(k);
    }
  } catch { return; }
  for (const k of keys) {
    let at = null;
    try { at = intentTime(localStorage.getItem(k)); } catch { continue; }
    if (intentFresh(at, now)) { noteSignOutIntent(k.slice(SIGNOUT_INTENT_PREFIX.length), at, now); continue; }
    try { localStorage.removeItem(k); } catch { /* unavailable */ }
  }
}

/**
 * What the Clerk listener runs when this account's session ends without the
 * Sign out button (expiry, revocation, "sign out of all devices"): everything
 * that exists only on this device is kept for the next sign-in. After a
 * deliberate Sign out it is the plain keepVault purge it always was, and the
 * marker's key goes with the rest.
 */
export async function purgeAfterSessionEnd(userId) {
  if (!userId) return;
  if (deliberateSignOutRecent(userId)) {
    // purgeUserStorage removes the localStorage keys before its first await.
    const purged = purgeUserStorage(userId, { keepVault: true });
    removeSignOutIntentKey(userId);
    return purged;
  }
  return purgeUserStorage(userId, { keepVault: true, keepDeviceOnly: true });
}

/**
 * How long writes kept by an involuntary sign-out wait on this device for
 * their account to sign in here again (purgeUserStorage).
 */
export const KEPT_QUEUE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Rewrite one account's queue: `fn` returns the ops to keep (the same array
// when nothing changes). A queue that does not parse can never replay and goes.
function rewriteQueue(key, fn) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return;
    let ops = null;
    try { ops = JSON.parse(raw); } catch { /* unreadable */ }
    if (!Array.isArray(ops)) { localStorage.removeItem(key); return; }
    const next = fn(ops);
    if (next === ops) return;
    if (next.length) localStorage.setItem(key, JSON.stringify(next));
    else localStorage.removeItem(key);
  } catch { /* storage unavailable */ }
}

function markQueueKept(userId, now = Date.now()) {
  const key = scopedKey(BASE_KEYS.pendingOps, userId);
  if (key) rewriteQueue(key, (ops) => ops.map((op) => (op && typeof op === "object" ? { ...op, keptAt: Number(op.keptAt) || now } : op)));
}

function reclaimKeptQueue(userId) {
  const key = scopedKey(BASE_KEYS.pendingOps, userId);
  if (!key) return;
  rewriteQueue(key, (ops) => (ops.some((op) => op?.keptAt)
    ? ops.map((op) => { if (!op?.keptAt) return op; const { keptAt: _kept, ...live } = op; return live; })
    : ops));
}

/**
 * Remove the kept writes whose account has not signed in on this device
 * within KEPT_QUEUE_MAX_AGE_MS of the sign-out that kept them. Run when the
 * app opens (main.jsx), signed in or not. A live account's writes carry no
 * keptAt and are never touched.
 */
export function sweepLapsedQueues(now = Date.now()) {
  const prefix = `${BASE_KEYS.pendingOps}:`;
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
  } catch { return; }
  const lapsed = (op) => Number(op?.keptAt) > 0 && now - Number(op.keptAt) > KEPT_QUEUE_MAX_AGE_MS;
  for (const key of keys) rewriteQueue(key, (ops) => (ops.some(lapsed) ? ops.filter((op) => !lapsed(op)) : ops));
}

/**
 * The explicit Sign out purge. Everything purgeUserStorage covers, the vault
 * included, plus the device-key slot. Nothing of this account stays on the
 * device: the record set (license and DEA numbers included) is gone from
 * localStorage, and the offline fallback, which needs the lastIdentity slot
 * and the cached file, can never reopen as this user. Other accounts' keys
 * on the same device are untouched. Same path as Delete All My Data.
 *
 * The Sign out marker's key (SIGNOUT_INTENT_BASE) goes last, once the purge
 * has run: it names the account, and every other open tab receives its write
 * as a storage event ahead of its removal. The listeners purge whole from
 * what they noted in memory. A purge refused before it began (the recovery
 * barrier could not be saved) touches nothing, the marker included; the boot
 * sweep or the account's next sign-in removes it.
 */
export async function purgeForSignOut(userId) {
  if (!userId) return;
  await purgeUserStorage(userId, { keepVault: false });
  lsRemove(DEVICE_KEYS_BASE, userId);
  removeSignOutIntentKey(userId);
}

/**
 * Cloud writes queued on this device that have not landed yet
 * (src/lib/supabase.js queuePendingOp). The explicit sign-out purge destroys
 * the queue, so the Sign out button warns when this is non-zero; a session
 * that merely expired keeps it for the same account's next sign-in.
 */
export function pendingOpCount(userId) {
  const ops = lsGetJSON(BASE_KEYS.pendingOps, userId);
  return Array.isArray(ops) ? ops.length : 0;
}

/**
 * How many of those were queued for want of a membership answer (a save kept
 * on this device while the check failed or timed out, lib/supabase.js
 * AWAITING_ACCESS). They go up when a check next answers.
 */
export function awaitingAccessOpCount(userId) {
  const ops = lsGetJSON(BASE_KEYS.pendingOps, userId);
  return Array.isArray(ops) ? ops.filter(op => op?.awaitingAccess === true).length : 0;
}

/**
 * How many of those the membership answer then refused (read-only now,
 * lib/supabase.js accessRefused): not in the account, kept on this device,
 * and sent only if a later answer allows changes again.
 */
export function accessRefusedOpCount(userId) {
  const ops = lsGetJSON(BASE_KEYS.pendingOps, userId);
  return Array.isArray(ops) ? ops.filter(op => op?.awaitingAccess === true && op.accessRefused === true).length : 0;
}

/**
 * How many rows each device-only section (DEVICE_ONLY_SECTIONS: Protected
 * Identity, the Answer Bank) holds for `userId`, counted across everything
 * the Sign out purge erases: the in-memory file passed in, this account's
 * localStorage copy and, on a native build, its Capacitor copy. Memory alone
 * is not enough. The identity-check failure screen and "Checking your
 * membership..." both hold empty defaults on purpose while the disk copy
 * still has the rows, and both offer Sign out. A row is counted once across
 * the copies by its id; a row without one counts by its position.
 */
export async function deviceOnlyRecordCounts(userId, inMemory = null) {
  const seen = {};
  for (const section of Object.keys(DEVICE_ONLY_SECTIONS)) seen[section] = new Set();
  const tally = (blob) => {
    for (const section of Object.keys(seen)) {
      const rows = blob?.[section];
      if (!Array.isArray(rows)) continue;
      rows.forEach((row, i) => seen[section].add(typeof row?.id === "string" && row.id ? `id:${row.id}` : `at:${i}`));
    }
  };
  const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  tally(inMemory);
  const raw = lsGet(BASE_KEYS.data, userId);
  if (raw != null) tally(parse(raw));
  const nativeKey = scopedKey(BASE_KEYS.data, userId);
  if (nativeKey) {
    try {
      if (window.storage?.get) {
        const r = await window.storage.get(nativeKey);
        if (r?.value) tally(parse(r.value));
      }
    } catch { /* unavailable */ }
  }
  return Object.fromEntries(Object.entries(seen).map(([section, ids]) => [section, ids.size]));
}

// ─── One-time migration of the pre-namespace keys ─────────────
const COLLECTION_ID_SKIP = new Set(["settings"]);

function collectIds(blob) {
  const ids = new Set();
  if (!blob || typeof blob !== "object") return ids;
  for (const [key, val] of Object.entries(blob)) {
    if (COLLECTION_ID_SKIP.has(key) || !Array.isArray(val)) continue;
    for (const x of val) if (x?.id) ids.add(x.id);
  }
  return ids;
}

function readLegacy(base) {
  try { return localStorage.getItem(base); } catch { return null; }
}
function removeLegacy(base) {
  try { localStorage.removeItem(base); } catch { /* unavailable */ }
}
/** Move a legacy value under the user's key, never overwriting a namespaced one. */
function moveLegacy(base, userId) {
  const raw = readLegacy(base);
  // An empty placeholder ("[]", "{}", "null") written by a component that
  // mounted before adoption ran does not count as a namespaced value; the
  // legacy content wins over it.
  const cur = lsGet(base, userId);
  const curEmpty = cur == null || /^\s*(\[\s*\]|\{\s*\}|null|"")\s*$/.test(cur);
  if (raw != null && curEmpty) lsSet(base, raw, userId);
  removeLegacy(base);
}

/** True while any pre-namespace key is still on the device. */
export function hasLegacyStorage() {
  return [BASE_KEYS.data, BASE_KEYS.vault, BASE_KEYS.chat, BASE_KEYS.archives, BASE_KEYS.timer, BASE_KEYS.lastContract]
    .some(base => readLegacy(base) != null);
}

/**
 * Decide what happens to the un-namespaced keys left by builds before this
 * one, the first time a signed-in user loads with the cloud reachable.
 *
 * Rule: the legacy file is adopted by this user only if their cloud profile
 * already holds data AND at least one record id in the legacy file exists
 * in that cloud data (the local file is a mirror of the cloud, so the true
 * owner always overlaps; a different account never does, ids are UUIDs).
 * Adopted: the file, chat, archives, timer and last-contract move under
 * the user's key and the self-heal sync then runs on it as before.
 * Not adopted: those keys are removed. The file is a cloud mirror and the
 * rest is the previous account's transcript and timer state; a new account
 * must never see it, let alone push it up.
 *
 * The vault is decided on its own evidence: it is adopted when the file
 * was, or when any note is attached to a record that exists in this user's
 * cloud (vault keys are `section:recordId`). Otherwise it is left in place
 * untouched, unreadable to anyone but the account whose records it names,
 * because those notes exist nowhere else and no automatic step deletes them.
 *
 * Returns the adopted legacy file, or null.
 */
export function adoptLegacyStorage(userId, { cloudIds, cloudHasData }) {
  if (!userId) return null;
  const legacyRaw = readLegacy(BASE_KEYS.data);
  let legacy = null;
  if (legacyRaw) { try { legacy = JSON.parse(legacyRaw); } catch { legacy = null; } }

  let adopted = false;
  if (legacy && cloudHasData && cloudIds?.size) {
    for (const id of collectIds(legacy)) {
      if (cloudIds.has(id)) { adopted = true; break; }
    }
  }

  const movable = [BASE_KEYS.data, BASE_KEYS.chat, BASE_KEYS.archives, BASE_KEYS.timer, BASE_KEYS.lastContract];
  if (adopted) {
    for (const base of movable) moveLegacy(base, userId);
    // Capacitor copy of the file, when present.
    (async () => {
      try {
        const legacyCap = await window.storage?.get?.(BASE_KEYS.data);
        if (legacyCap?.value) await window.storage.set(scopedKey(BASE_KEYS.data, userId), legacyCap.value);
        await window.storage?.remove?.(BASE_KEYS.data);
      } catch { /* unavailable */ }
    })();
    console.log("CredentialDOMD: adopted the pre-namespace local file for this account");
  } else {
    for (const base of movable) if (readLegacy(base) != null) removeLegacy(base);
    try { window.storage?.remove?.(BASE_KEYS.data); } catch { /* unavailable */ }
    if (legacy) console.log("CredentialDOMD: discarded a local file that belongs to another account");
  }

  // Vault: independent evidence, never auto-deleted while it holds notes.
  const vaultRaw = readLegacy(BASE_KEYS.vault);
  if (vaultRaw != null) {
    let vault = null;
    try { vault = JSON.parse(vaultRaw); } catch { vault = null; }
    const entries = vault && typeof vault === "object" ? Object.entries(vault) : [];
    if (entries.length === 0) {
      removeLegacy(BASE_KEYS.vault);
    } else {
      const owns = adopted || entries.some(([k]) => cloudIds?.has(k.slice(k.indexOf(":") + 1)));
      if (owns) {
        // Merge, existing namespaced notes win.
        const current = lsGetJSON(BASE_KEYS.vault, userId) || {};
        lsSetJSON(BASE_KEYS.vault, { ...Object.fromEntries(entries), ...current }, userId);
        removeLegacy(BASE_KEYS.vault);
      }
    }
  }

  return adopted ? legacy : null;
}
