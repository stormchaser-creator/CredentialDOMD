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
import { changesBetween } from "./heldChanges.js";
import { rebaseLocalChanges } from "./loadRebase.js";
import { offlineRead, offlineWrite, offlineUpdate, offlineRemove, offlineStoreSupported, isQuotaError, OfflineStoreUnavailable, offlineStoreState } from "./offlineStore.js";

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
  // What was typed into a form not yet saved (utils/formDrafts.js): iOS may
  // discard the app while he is in another one. Kept when a session merely
  // ends, like the running timer; Sign out and Delete All My Data remove it.
  formDrafts: "credentialdomd-form-drafts",
};

// The invoice hand-off notes (utils/invoiceHandoffStore.js purgeHandoffStores)
// go with the unrecorded-invoice notes: kept when a session merely ended,
// removed by Sign out and Delete All My Data. They live in sessionStorage and
// IndexedDB too, so main.jsx hands the purge in at launch and this module
// imports nothing more. Its IndexedDB half is recorded before the purge
// returns and finished before the notes are read again (HANDOFF_PURGE_BASE),
// so it is not awaited here.
let purgeInvoiceHandoff = null;
export function setInvoiceHandoffPurge(fn) {
  purgeInvoiceHandoff = typeof fn === "function" ? fn : null;
}

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
    if (localStorage.getItem(key) === null && !localSetWithRoom(key, "retired")) throw new Error();
    if (localStorage.getItem(key) === null) throw new Error();
  } catch { throw continuityRetirementFailure("continuity_retirement_unavailable"); }
}

// ─── localStorage is kept for small things ───────────────────
// WebKit gives an origin 5 MiB of localStorage and counts a string at 2 bytes
// a character as soon as it holds one character above U+00FF (an em dash, a
// curly apostrophe), else at 1 (measured in Playwright's WebKit, 2026-10-02:
// 5,242,816 ASCII characters fit, 2,621,376 wide ones). A busy account's
// offline file holds em dashes, so its 1.9 million characters cost 3.8 MB, and
// a copy of it in localStorage left too little for what has nowhere else to
// go: the write queue, the running timer, invoice notes, Protected Identity
// changes held aside, the purge fence. Those are what localStorage is for.
// A large store goes there only while it is small itself and leaves
// LOCAL_RESERVE_BYTES free (writeOfflineTextNow).
export const LOCAL_QUOTA_BYTES = 5 * 1024 * 1024;
export const LOCAL_RESERVE_BYTES = 1024 * 1024;
export const LARGE_LOCAL_MAX_BYTES = 1024 * 1024;
const WIDE = /[\u0100-\uffff]/;
/** What `text` costs in localStorage on WebKit (bytes). */
export function localCost(text) {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length * (WIDE.test(s) ? 2 : 1);
}
/** Bytes localStorage holds now (keys and values), counted as WebKit counts them; `except` is left out. */
export function localStorageUsed(except = null) {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k == null || k === except) continue;
      n += localCost(k) + localCost(localStorage.getItem(k));
    }
  } catch { return LOCAL_QUOTA_BYTES; }
  return n;
}
/** May a large store's `text` go into localStorage under `key` and still leave the reserve? */
export function largeCopyFitsLocally(key, text) {
  const cost = localCost(text) + localCost(key);
  return cost <= LARGE_LOCAL_MAX_BYTES && localStorageUsed(key) + cost + LOCAL_RESERVE_BYTES <= LOCAL_QUOTA_BYTES;
}

// The development-era copies an identity recovery left behind
// (continuityRecovery.js): it copies each of the old account's slots to the
// new one and never removes the old, so every device that crossed the
// 2026-09-20 cutover kept a second, dead copy of the whole file (on a
// device checked 2026-10-02: about 1.6 million characters with wide ones,
// 3.2 MB of WebKit's 5 MiB).
// A slot the journal records as copied is never read again (recoverContinuity
// skips it), so it goes: the file, the transcript, the archives and the write
// queue (which can carry a document's bytes). Everything else of the old
// account is small and stays. Returns how many were removed.
const RELEASED_SOURCE_BASES = Object.freeze([BASE_KEYS.data, BASE_KEYS.chat, BASE_KEYS.archives, BASE_KEYS.pendingOps]);
const CLERK_SUBJECT = /^user_[A-Za-z0-9]{1,120}$/;
export function releaseRecoveredContinuitySources() {
  const prefix = `${CONTINUITY_JOURNAL_BASE}:`;
  const journals = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) journals.push(k);
    }
  } catch { return 0; }
  let removed = 0;
  for (const k of journals) {
    let journal = null;
    try { journal = JSON.parse(localStorage.getItem(k)); } catch { continue; }
    const subject = journal?.subject, source = journal?.sourceSubject;
    if (journal?.schemaVersion !== 1 || !Array.isArray(journal.entries)) continue;
    if (!CLERK_SUBJECT.test(subject || "") || !CLERK_SUBJECT.test(source || "") || subject === source) continue;
    // The journal is filed under the account it recovered into.
    if (!k.startsWith(`${prefix}${subject}:`) || source === activeUserId) continue;
    for (const entry of journal.entries) {
      if (entry?.state !== "copied" || !RELEASED_SOURCE_BASES.includes(entry.base)) continue;
      const sourceKey = `${entry.base}:${source}`;
      try { if (localStorage.getItem(sourceKey) !== null) { localStorage.removeItem(sourceKey); removed += 1; } } catch { /* the next launch */ }
    }
  }
  return removed;
}

/**
 * localStorage.setItem for the small things that have nowhere else to go: when
 * localStorage is full, the dead development-era copies go first and the write
 * is made once more. True when it was stored.
 */
export function localSetWithRoom(key, value) {
  try { setItemMakingRoom(key, value); return true; } catch { return false; }
}
/** As localSetWithRoom, but throws what setItem throws (for callers that report a full device). */
export function setItemMakingRoom(key, value) {
  try { localStorage.setItem(key, value); }
  catch (error) {
    if (!isQuotaError(error) || releaseRecoveredContinuitySources() === 0) throw error;
    localStorage.setItem(key, value);
  }
}

/**
 * What fills localStorage, for a storage report: bytes by key base (account
 * ids and record ids taken out), largest first, and the total. Never a value.
 */
export function localStorageInventory(limit = 6) {
  const byBase = new Map();
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k == null) continue;
      const bytes = localCost(k) + localCost(localStorage.getItem(k));
      total += bytes;
      const base = k.startsWith("credentialdomd-") ? k.replace(/:.*$/, "") : "other";
      const owner = /:user_[A-Za-z0-9]+/.exec(k)?.[0]?.slice(1) || null;
      const label = owner && owner !== activeUserId && base !== "other" ? `${base}:other-account` : base;
      byBase.set(label, (byBase.get(label) || 0) + bytes);
    }
  } catch { return null; }
  const round = (n) => Math.round(n / 10000) * 10000;
  return {
    used: round(total),
    top: [...byBase.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([base, bytes]) => [base, round(bytes)]),
  };
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
  // The large stores are read from IndexedDB into memory from the moment the
  // account is known, long before any screen of it renders: the Assistant
  // reads its transcript synchronously when it mounts. The load awaits the
  // same hydration (storage.js readCachedData).
  if (activeUserId) hydrateOfflineStores(activeUserId).catch(() => {});
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
  return localSetWithRoom(k, value) ? value : null;
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
  return localSetWithRoom(k, value);
}
export function lsSetJSON(base, value, userId) {
  return lsSet(base, JSON.stringify(value), userId);
}
export function lsRemove(base, userId) {
  const k = scopedKey(base, userId);
  if (!k) return;
  try { localStorage.removeItem(k); } catch { /* unavailable */ }
}

// ─── The large stores, in IndexedDB (src/utils/offlineStore.js) ─────────
// The offline copy of the file and the Assistant transcript and archives
// grow with the account, and Safari gives localStorage about 5 MB for the
// whole origin (UTF-16). A 1,500-case-log account filled it, the cache write
// threw, and what opened offline was older than the screen. These three live
// in IndexedDB now, under the same scoped key; everything small (markers,
// settings, the device keys, the vault, the write queue) stays here.
//
// One rule makes the two stores safe together: a localStorage copy of one of
// these keys, when there is one, is never older than the IndexedDB copy.
// Every IndexedDB write that lands removes the localStorage copy, and
// localStorage is written only when IndexedDB refused (unavailable, full).
// Readers therefore take localStorage first when it has the key.
//
// A second keeps "could not look" apart from "nothing there". An IndexedDB
// that will not open (iOS has builds whose open never answers; WebKit loses
// the connection of an installed app that was in the background) may still
// hold the only copy of Protected Identity and the Answer Bank. A read that
// could not look says so (OfflineStoreUnavailable), and what a tab builds
// from such a read is never written over the stored copy (unreadKeys).
export const OFFLINE_STORE_BASES = Object.freeze([BASE_KEYS.data, BASE_KEYS.chat, BASE_KEYS.archives]);
// Read synchronously by the Assistant (useState initialisers), so they are
// held in memory once hydrated (hydrateOfflineStores) and written through.
const MIRRORED_BASES = Object.freeze([BASE_KEYS.chat, BASE_KEYS.archives]);
const mirror = new Map();          // scoped key -> text or null: the stored copy, once read
// Written this session over a stored copy that could not be read: held in
// memory for this session only, never stored over the copy it never saw.
const sessionOnly = new Map();     // scoped key -> text
// Keys whose stored copy this tab could not read, so what it holds of them
// was begun from nothing. Nothing is written over them until a read succeeds.
const unreadKeys = new Set();
const hydrated = new Map();        // userId -> Promise of the hydration
const writeSeq = new Map();        // scoped key -> the latest write begun
const writesInFlight = new Map();  // scoped key -> writes begun and not yet finished
let writeCounter = 0;

// The purge fence (LOCAL_FENCE_KEY) this tab's in-memory copies of an
// account's large stores were read under. A purge clears those copies only
// in the tab that runs it; another tab's Delete All My Data, or a server
// deletion honored there, moves the fence, and a tab that still held the
// deleted transcript in memory handed it to the Assistant, which wrote it
// back. Every reader and writer of that memory checks the fence first
// (syncMemoryToFence) and, once it has moved, starts again from what is
// stored.
const memoryFences = new Map();    // userId -> fence value (null before any)

/** Forget what this tab holds in memory of `userId`'s large stores. */
function forgetLargeStoreMemory(userId) {
  hydrated.delete(userId);
  for (const base of OFFLINE_STORE_BASES) {
    const key = scopedKey(base, userId);
    mirror.delete(key);
    sessionOnly.delete(key);
    unreadKeys.delete(key);
  }
}

function syncMemoryToFence(userId) {
  if (!userId) return;
  const fence = localFence(userId) ?? null;
  if (!memoryFences.has(userId)) { memoryFences.set(userId, fence); return; }
  if (memoryFences.get(userId) === fence) return;
  memoryFences.set(userId, fence);
  forgetLargeStoreMemory(userId);
}

/** Is `key` one of the IndexedDB-backed stores? */
export function isOfflineStoreKey(key) {
  return typeof key === "string" && OFFLINE_STORE_BASES.some((base) => key.startsWith(`${base}:`));
}
const isMirroredKey = (key) => typeof key === "string" && MIRRORED_BASES.some((base) => key.startsWith(`${base}:`));

/** The account a key of one of the large stores belongs to, or null. */
function keyOwner(key) {
  if (typeof key !== "string") return null;
  const base = OFFLINE_STORE_BASES.find((b) => key.startsWith(`${b}:`));
  return base ? key.slice(base.length + 1) || null : null;
}

// Every purge of an account in this tab moves its epoch. A write begun before
// the purge (an IndexedDB write waits for the database to open) is refused
// when it finally runs, so a Sign out cannot be undone by a save in flight.
const purgeEpochs = new Map();
const purgeEpoch = (userId) => purgeEpochs.get(userId) || 0;
function bumpPurgeEpoch(userId) { purgeEpochs.set(userId, purgeEpoch(userId) + 1); }

// ─── The purge generation: every purge, in every tab ──────────
// A random value that every purge of the large stores moves synchronously,
// before it removes anything (purgeUserStorage: Sign out, session expiry,
// Delete All My Data, a server deletion). A write of the large stores reads
// it as it begins and again as it commits (the IndexedDB commit guard, and
// just before a localStorage fallback), and is cancelled when it moved: what
// it holds predates the purge. The purge epoch above only sees this tab's
// purges, and the purge record and the home record could not see another
// tab's Sign out that ran to the end while a write waited on IndexedDB: the
// record was written and removed again (the same value at both checks), and
// on an account's first write there was no home record to vanish. A value
// that is never the same twice is not fooled by a record that came and went.
//
// One key for the device, not one per account: it outlives every purge, and
// a key named after the account would say who used the device after Sign
// out. The cost is that another account's purge on this device cancels a
// write of this one that was in flight; the next save writes it again. It
// holds a random marker only.
export const OFFLINE_GENERATION_KEY = "credentialdomd-offline-generation";
function offlineGeneration() {
  try { return localStorage.getItem(OFFLINE_GENERATION_KEY); } catch { return null; }
}
/** Move the generation. False when localStorage refused (full, blocked). */
function advanceOfflineGeneration() {
  // Random only: a timestamp would say when the device was last signed out of.
  const value = `${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
  try {
    if (!localSetWithRoom(OFFLINE_GENERATION_KEY, value)) return false;
    return localStorage.getItem(OFFLINE_GENERATION_KEY) === value;
  } catch { return false; }
}

/**
 * Taken as a save of `userId`'s file begins: `otherAccountOnly()` says,
 * once that save was stopped, whether only another account's purge stopped
 * it. The purge generation is one for the device (a key per account would
 * name who used it), so another account's Sign out or session end on this
 * device cancels this account's write on its way. True only when the
 * generation moved and nothing of this account did: not this tab's purge
 * epoch, not the purge fence, no purge recorded, and every per-account
 * marker the save began with (the offline identity, the file's write stamp,
 * the home record) still there, as every purge of this account removes one.
 */
export function saveStopGuard(userId) {
  const epoch = purgeEpoch(userId);
  const generation = offlineGeneration();
  const fence = localFence(userId) ?? null;
  const present = () => ({
    identity: lsGet(BASE_KEYS.lastIdentity, userId) != null,
    stamp: offlineWriteStamp(userId) != null,
    home: lsGet(OFFLINE_HOME_BASE, userId) != null,
  });
  const had = present();
  return {
    otherAccountOnly() {
      if (!userId || offlineGeneration() === generation) return false;
      if (purgeEpoch(userId) !== epoch || (localFence(userId) ?? null) !== fence || !localCopyCurrent(userId)) return false;
      if (pendingPurge(userId) || getActiveUserId() !== userId) return false;
      if (!had.identity && !had.stamp && !had.home) return false;
      const now = present();
      return (!had.identity || now.identity) && (!had.stamp || now.stamp) && (!had.home || now.home);
    },
  };
}

/**
 * A check for one write into `userId`'s local copy, taken when the write is
 * begun and run again immediately before it commits (offlineWrite's guard,
 * synchronous with the transaction's creation). False once this tab purged
 * the account since, once any tab began a purge of the large stores since
 * (OFFLINE_GENERATION_KEY: another tab's Sign out), once the device's purge
 * fence moved since (another tab ran Delete All My Data or honored a server
 * deletion), or, for a writer holding records (`adopted`), once this tab's
 * records predate the fence. Moving a stored copy from one store to the
 * other holds no records from memory and passes adopted:false.
 */
export function localWriteGuard(userId, { adopted = true } = {}) {
  const epoch = purgeEpoch(userId);
  const generation = offlineGeneration();
  const fence = localFence(userId) ?? null;
  return () => purgeEpoch(userId) === epoch
    && offlineGeneration() === generation
    && (localFence(userId) ?? null) === fence
    && (!adopted || localCopyCurrent(userId));
}

// ─── Where the account's large stores may be, and purges still owed ─────
// Set by every IndexedDB write of this account as its transaction is created
// (putOffline), and kept while IndexedDB may hold any of its large stores;
// removed once a purge has left nothing of them there, and never otherwise
// (not when a write fails: another tab's may have landed). Without it nothing
// of the account was ever put in IndexedDB, so an IndexedDB that will not
// open has nothing of it either, and localStorage is the only copy (private
// modes, browsers without IndexedDB). One exception: a move with no room in
// localStorage for it, where the localStorage copy being moved stands in for
// it until the move sets it (moveToOfflineStore, hasLocalLargeCopy). Holds
// "1". Outside BASE_KEYS: only a purge that committed may remove it.
export const OFFLINE_HOME_BASE = "credentialdomd-offline-home";
// A purge of this account's IndexedDB copies that has not committed yet
// (IndexedDB would not open, or refused). Written synchronously before the
// purge's first await and removed only once IndexedDB has committed it. While
// it is there, every read and write of the account's large stores finishes
// the purge first; when that is still impossible a read takes the copies for
// gone ("all": Sign out, Delete All My Data, a server deletion) or for cut
// down to what exists only on this device ("trim": the session ended), and no
// IndexedDB write of the account is made. Value "<mode>.<nonce>". Outside
// BASE_KEYS, so the purge cannot remove its own record.
export const OFFLINE_PURGE_BASE = "credentialdomd-offline-purge";

function mayHaveOfflineCopy(userId) {
  const k = scopedKey(OFFLINE_HOME_BASE, userId);
  if (!k) return false;
  // Unreadable localStorage proves nothing: assume there may be a copy.
  try { return localStorage.getItem(k) !== null; } catch { return true; }
}
// Does localStorage hold a copy of any of the account's large stores? While
// it does, IndexedDB may hold one too without the home record: a move whose
// home record found no room in localStorage writes IndexedDB first and sets
// the record only as it removes the localStorage copy, which stands in for
// the record until then (moveToOfflineStore). A purge asks this before it
// removes anything.
function hasLocalLargeCopy(userId) {
  try {
    return OFFLINE_STORE_BASES.some((base) => {
      const k = scopedKey(base, userId);
      return !!k && localStorage.getItem(k) !== null;
    });
  } catch { return true; }
}
// Set as the first copy of the account goes into IndexedDB. With no home
// record, IndexedDB holds nothing of the account (bar the copy a move is
// writing from localStorage, which is newer than any deletion this device
// has seen), so nothing there can predate a data deletion another build
// honored: that deletion is recorded as caught up first (OFFLINE_WIPED_BASE).
// Without that, a catch-up whose marker found no room purged nothing, the
// move then freed room and set this record, and the next read's catch-up
// purged the copy just moved (Protected Identity and the Answer Bank with
// it). No room for the marker: no record either, and the write is unmarked.
function markOfflineHome(userId) {
  const k = scopedKey(OFFLINE_HOME_BASE, userId);
  if (!k) return false;
  try {
    if (localStorage.getItem(k) === null) {
      if (offlineWipeOwed(userId) && !markOfflineWipe(userId, lsGet(WIPE_SEEN_KEY, userId))) return false;
      if (!localSetWithRoom(k, "1")) return false;
    }
    return localStorage.getItem(k) !== null;
  } catch { return false; }
}
function pendingPurge(userId) {
  const raw = lsGet(OFFLINE_PURGE_BASE, userId);
  if (raw == null) return null;
  // Anything but a trim record is a full purge: a damaged record never keeps data.
  return { raw, mode: raw.startsWith("trim.") ? "trim" : "all" };
}

// ─── Who wrote the offline file last ─────────────────────────
// A random value every write of an account's offline file moves,
// synchronously as the write is committed (putOffline's commit guard, and a
// localStorage fallback as it is made). A tab remembers the value of its own
// last read or write (storage.js); a different value now means another tab
// (or another window of this account) has written the file since, and what
// this tab holds of Protected Identity and the Answer Bank may be missing
// rows that tab added. Every purge of the account removes it. Holds a random
// marker only. Outside BASE_KEYS (a purge removes it explicitly).
export const OFFLINE_WRITTEN_BASE = "credentialdomd-offline-written";

/** The account's offline-file write stamp now (null when none is recorded). */
export function offlineWriteStamp(userId) {
  return lsGet(OFFLINE_WRITTEN_BASE, userId);
}
// Move it. When localStorage refuses, the old value is removed instead, so
// no tab mistakes it for the one it knows; the writer gets a value that
// matches nothing stored, and so trusts nothing it holds either.
function bumpWriteStamp(userId) {
  const k = scopedKey(OFFLINE_WRITTEN_BASE, userId);
  const value = `${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 8)}`;
  if (!k) return value;
  try {
    localStorage.setItem(k, value);
    if (localStorage.getItem(k) === value) return value;
  } catch { /* full, or unavailable */ }
  try { localStorage.removeItem(k); } catch { /* unavailable */ }
  return `unrecorded.${value}`;
}
// The stamps this window's own writes moved it to, each with the stamp it
// replaced and whether the write held this window's text alone (`clean`: no
// other writer's rows merged in). A stamp this window moved is not another
// writer's: its own save still committing, or one refused after its
// transaction was created, made the next save merge with this window's own
// older text (a row deleted meanwhile came back) or refuse a localStorage
// fallback as unmerged.
const ownStamps = new Map();
function noteOwnStamp(stamp, prev, clean) {
  if (typeof stamp !== "string" || stamp.startsWith("unrecorded.")) return;
  ownStamps.set(stamp, { prev: prev ?? null, clean: !!clean });
  if (ownStamps.size > 64) ownStamps.delete(ownStamps.keys().next().value);
}
/**
 * Has a writer other than this window written `owner`'s file since the stamp
 * `known`? Stamps this window moved with clean writes since are passed over.
 * No stamp recorded while IndexedDB may hold a copy (localStorage had no room
 * for it) says nothing: another window's write may be behind it.
 */
function writtenSince(owner, known) {
  let now = offlineWriteStamp(owner);
  if (now == null) return known != null || mayHaveOfflineCopy(owner);
  for (let hops = 0; now !== known; hops += 1) {
    const own = ownStamps.get(now);
    if (!own || !own.clean || hops > 64) return true;
    now = own.prev;
  }
  return false;
}
const isDataKey = (key) => typeof key === "string" && key.startsWith(`${BASE_KEYS.data}:`);

// ─── The device-only sections, compared and merged ───────────
/** The device-only sections of a file, as lists (a missing one is empty). */
export function deviceOnlySectionsOf(blob) {
  const out = {};
  for (const section of Object.keys(DEVICE_ONLY_SECTIONS)) out[section] = Array.isArray(blob?.[section]) ? blob[section] : [];
  return out;
}
/** Do two sets of device-only sections hold the same rows? */
export function sameDeviceOnlySections(a, b) {
  return Object.keys(DEVICE_ONLY_SECTIONS).every(section =>
    JSON.stringify(Array.isArray(a?.[section]) ? a[section] : []) === JSON.stringify(Array.isArray(b?.[section]) ? b[section] : []));
}
/**
 * `onto` (another copy's device-only sections) with what changed from
 * `base` to `mine` laid over it: an add goes in, a delete comes out, an edit
 * sets the fields it changed (utils/loadRebase.js). Rows `onto` has that
 * `base` never had (another tab added them) stay, and rows deleted here stay
 * deleted. Returns the sections.
 */
export function rebaseDeviceOnlySections(onto, base, mine) {
  const target = deviceOnlySectionsOf(onto);
  const changes = changesBetween(deviceOnlySectionsOf(base), deviceOnlySectionsOf(mine))
    .filter(change => change.kind === "record" && change.id && Object.hasOwn(DEVICE_ONLY_SECTIONS, change.key));
  if (!changes.length) return target;
  return deviceOnlySectionsOf(rebaseLocalChanges(target, { changes }));
}

// ─── Device-only changes held aside ──────────────────────────
// A Protected Identity or Answer Bank change that was accepted, and whose
// save of the offline file then landed in no store (IndexedDB would not open
// or had no room, localStorage could not take the whole file, the copy was
// unread), or was still on its way when the session ended. The file is large;
// the changes are small. They are kept here, per account, as the sections
// the tab's copy was based on and the sections it held (`base`, `mine`), and
// every read of the file lays them over what it reads (storage.js
// readCachedData) until a write that holds them lands. A session that merely
// ended keeps them, as it keeps the rest of what exists only on this device;
// Sign out and a data deletion remove them. Outside BASE_KEYS.
//
// One hold per window, in one record per account that every window shares:
// { holds: [{ by, base, mine }] }. Each window's hold is its own change from
// the copy IT was based on, so a second window whose save also landed
// nowhere adds its change beside the first instead of replacing it (a single
// hold took the second window's `mine`, which never had the first window's
// row, and with the first window's base replayed that row as a delete).
// Every read lays each hold over the file in turn.
export const DEVICE_ONLY_PENDING_BASE = "credentialdomd-device-only-pending";
// This window (this page's module instance): whose hold is whose.
const HOLD_WINDOW_ID = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}`;

function heldEntry(e) {
  return e && typeof e === "object" && e.base && typeof e.base === "object" && e.mine && typeof e.mine === "object" ? e : null;
}
function readHolds(userId) {
  const held = lsGetJSON(DEVICE_ONLY_PENDING_BASE, userId);
  if (!held || typeof held !== "object") return [];
  if (Array.isArray(held.holds)) return held.holds.map(heldEntry).filter(Boolean);
  // One hold from before holds were kept per window.
  const one = heldEntry(held);
  return one ? [{ by: null, base: one.base, mine: one.mine }] : [];
}
// The windows whose hold another window's write carried into the file
// (releaseHeldDeviceOnlyChanges): `released`, beside the holds. The holding
// window's records are based on that hold's `mine` from then on
// (takeReleasedHoldHere). Kept on the copy it was based on, it replayed the
// held add (or delete) over the file at its next save, after the member had
// deleted (or restored) the row in the other window.
function readReleased(userId) {
  const held = lsGetJSON(DEVICE_ONLY_PENDING_BASE, userId);
  return held && Array.isArray(held.released) ? held.released.filter((by) => typeof by === "string") : [];
}
// This window's hold as it last wrote it, per account.
const heldHere = new Map();
function writeHolds(userId, holds, released = readReleased(userId)) {
  const k = scopedKey(DEVICE_ONLY_PENDING_BASE, userId);
  if (!k) return false;
  if (!holds.length && !released.length) { lsRemove(DEVICE_ONLY_PENDING_BASE, userId); return true; }
  const value = JSON.stringify(released.length ? { holds, released: released.slice(-16) } : { holds });
  try {
    if (!localSetWithRoom(k, value)) return false;
    return localStorage.getItem(k) === value;
  } catch { return false; }
}

/** The changes held aside for `userId`: [{ by, base, mine }] (one per window), or null. */
export function heldDeviceOnlyChanges(userId) {
  const holds = readHolds(userId);
  return holds.length ? holds : null;
}
/**
 * Hold aside this window's change from `base` to `mine` (device-only
 * sections). This window's earlier hold, if any, is replaced and keeps its
 * base: what it held is part of this window's `mine` now. Another window's
 * hold is left as it is. Written only while this tab's records are still
 * current for the account's copy (the purge fence). Returns whether it was
 * stored.
 */
export function holdDeviceOnlyChanges(userId, base, mine) {
  if (!scopedKey(DEVICE_ONLY_PENDING_BASE, userId) || !localCopyCurrent(userId)) return false;
  // Never while a data deletion another build honored is still owed here
  // (catchUpOfflineWipe removes what is held then, as predating it).
  if (offlineWipeOwed(userId)) return false;
  const holds = readHolds(userId);
  const earlier = holds.find((h) => h.by === HOLD_WINDOW_ID);
  const others = holds.filter((h) => h !== earlier);
  const entry = { by: HOLD_WINDOW_ID, base: deviceOnlySectionsOf(earlier ? earlier.base : base), mine: deviceOnlySectionsOf(mine) };
  // Nothing changed from the base any more (a row held, then deleted again):
  // this window's hold goes, or a row deleted since came back at every read.
  if (sameDeviceOnlySections(entry.base, entry.mine)) {
    if (!earlier) return true;
    if (!writeHolds(userId, others)) return false;
    heldHere.delete(userId);
    return true;
  }
  if (!writeHolds(userId, [...others, entry])) return false;
  heldHere.set(userId, entry);
  return true;
}
/**
 * This window's hold, when another window's write has carried it into the
 * file since (releaseHeldDeviceOnlyChanges): { base, mine }, taken once.
 * storage.js moves the copy this window's records are based on forward by it.
 */
export function takeReleasedHoldHere(userId) {
  const released = readReleased(userId);
  if (!released.includes(HOLD_WINDOW_ID)) return null;
  const hold = heldHere.get(userId) || null;
  heldHere.delete(userId);
  writeHolds(userId, readHolds(userId), released.filter((by) => by !== HOLD_WINDOW_ID));
  return hold;
}
/** Does this window hold changes aside for `userId`? */
export function holdsDeviceOnlyChangesHere(userId) {
  return readHolds(userId).some((h) => h.by === HOLD_WINDOW_ID);
}
function layHold(sections, hold) { return rebaseDeviceOnlySections(sections, hold.base, hold.mine); }
/** `sections` with the changes held aside for `userId` laid over them, each window's in turn. */
export function withHeldDeviceOnlyChanges(userId, sections) {
  return readHolds(userId).reduce(layHold, deviceOnlySectionsOf(sections));
}
/**
 * A write holding `sections` landed: each hold it holds every change of
 * goes. Returns whether nothing is held aside any more.
 */
export function releaseHeldDeviceOnlyChanges(userId, sections) {
  const holds = readHolds(userId);
  if (!holds.length) return true;
  const have = deviceOnlySectionsOf(sections);
  const left = holds.filter((h) => !sameDeviceOnlySections(layHold(have, h), have));
  if (left.length === holds.length) return false;
  const gone = holds.filter((h) => !left.includes(h));
  if (gone.some((h) => h.by === HOLD_WINDOW_ID)) heldHere.delete(userId);
  // Another window's hold this write carried in: that window is told.
  const others = gone.map((h) => h.by).filter((by) => typeof by === "string" && by !== HOLD_WINDOW_ID);
  const released = readReleased(userId);
  writeHolds(userId, left, [...released.filter((by) => !others.includes(by)), ...others]);
  return left.length === 0;
}

// A session-end purge (the trim) is about to cancel this tab's save of the
// file still on its way: storage.js holds its device-only changes aside
// first (setBeforeDeviceOnlyTrim), so the trim, which keeps the device-only
// sections as they were stored, does not drop the ones that save carried.
let beforeDeviceOnlyTrim = null;
export function setBeforeDeviceOnlyTrim(fn) { beforeDeviceOnlyTrim = typeof fn === "function" ? fn : null; }

// ─── localStorage copies this build wrote ─────────────────────
// The rule that a localStorage copy of a large store is never older than the
// IndexedDB copy holds for copies this build writes. A build from before the
// IndexedDB store (a rollback) knows nothing of IndexedDB: it finds no
// localStorage copy, builds the file from the cloud with no Protected
// Identity and no Answer Bank, and saves that to localStorage. Taken as
// newer, that copy replaced the IndexedDB one on the next launch of this
// build, and the only copy of those sections was gone. So every localStorage
// copy this build writes is recorded here by its length and a hash, per
// store; a copy that does not match (written by another build, or by a
// writer outside this module) is merged with the IndexedDB copy by id
// instead of replacing it (mergeUntrustedLocal). Holds hashes only.
export const LOCAL_COPIES_BASE = "credentialdomd-offline-local";
function textHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${text.length}.${(h >>> 0).toString(36)}`;
}
function baseOfKey(key) {
  return typeof key === "string" ? OFFLINE_STORE_BASES.find((b) => key.startsWith(`${b}:`)) || null : null;
}
function localCopyRecords(owner) {
  const v = lsGetJSON(LOCAL_COPIES_BASE, owner);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function noteOwnLocalCopy(key, text) {
  const owner = keyOwner(key), base = baseOfKey(key);
  const k = scopedKey(LOCAL_COPIES_BASE, owner);
  if (!k || !base) return;
  const records = localCopyRecords(owner);
  if (text == null) { if (!(base in records)) return; delete records[base]; }
  else records[base] = textHash(text);
  try {
    if (Object.keys(records).length) localStorage.setItem(k, JSON.stringify(records));
    else localStorage.removeItem(k);
  } catch { /* full: the copy then counts as another build's, and is merged, never lost */ }
}
function ownLocalCopy(key, text) {
  const owner = keyOwner(key), base = baseOfKey(key);
  return !!owner && !!base && typeof text === "string" && localCopyRecords(owner)[base] === textHash(text);
}
/**
 * Write a localStorage copy of one of the large stores on this build's
 * behalf (a cleaned copy put back where it was read, storage.js), and record
 * it as this build's. False when localStorage refused.
 */
export function writeOwnLocalCopy(key, text) {
  if (!isOfflineStoreKey(key) || typeof text !== "string") return false;
  try { putOwnLocalCopy(key, text); } catch { return false; }
  return true;
}
// Write `text` as this build's localStorage copy of `key`: its record first,
// then the copy. A copy written with no room left for its record counted as
// another build's at the next launch, and was merged with the older IndexedDB
// copy, so every row deleted in it came back. No room for the record: no
// copy (throws, as setItem does). A copy that then does not fit puts the
// record back as it was.
function putOwnLocalCopy(key, text) {
  const owner = keyOwner(key), base = baseOfKey(key);
  const k = scopedKey(LOCAL_COPIES_BASE, owner);
  if (!k || !base) { localStorage.setItem(key, text); return; }
  const before = lsText(k);
  const records = localCopyRecords(owner);
  records[base] = textHash(text);
  localStorage.setItem(k, JSON.stringify(records));
  try { localStorage.setItem(key, text); }
  catch (error) {
    try { if (before == null) localStorage.removeItem(k); else localStorage.setItem(k, before); } catch { /* the copy there then counts as another build's: merged, never lost */ }
    throw error;
  }
}
/** Is `text` a localStorage copy of `key` this build wrote? */
export function isOwnLocalCopy(key, text) { return ownLocalCopy(key, text); }
/** A copy rewritten in place (cleaned, trimmed): still this build's if the one it replaced was. */
export function rewriteLocalCopy(key, before, after) {
  const own = ownLocalCopy(key, before);
  try { localStorage.setItem(key, after); } catch { return false; }
  if (own) noteOwnLocalCopy(key, after);
  return true;
}

/**
 * A localStorage copy another build wrote (`local`) and the IndexedDB copy
 * (`stored`), merged so that nothing only one of them holds is lost. The
 * file: the localStorage copy, with each row only the IndexedDB copy holds
 * added back by id, in every section (Protected Identity and the Answer
 * Bank, which exist only here, and the synced sections too: a record whose
 * cloud write never landed, or a document whose file never uploaded, exists
 * only in the IndexedDB copy, and an older build that rebuilt the file from
 * the cloud never had it); a document's file (`data`, with no storage path)
 * the localStorage copy holds without bytes, taken from the IndexedDB copy;
 * and a local-only setting it lacks taken from the IndexedDB copy. A record
 * deleted in the cloud meanwhile is filtered by the load (the deletion
 * ledger) as any row on the device is. The transcript and archives: merged
 * by id (mergeLargeList). A side that does not parse leaves the other.
 */
// Sections of the file that are not lists of records with ids.
const COLLECTION_ID_SKIP = new Set(["settings"]);
function mergeUntrustedLocal(key, stored, local) {
  const base = baseOfKey(key);
  if (!base || stored == null) return local;
  if (base !== BASE_KEYS.data) return mergeLargeStore(base, stored, local);
  let s, l;
  try { s = JSON.parse(stored); } catch { return local; }
  try { l = JSON.parse(local); } catch { return stored; }
  if (!s || typeof s !== "object") return local;
  if (!l || typeof l !== "object") return stored;
  let changed = false;
  const out = { ...l };
  for (const [section, theirs] of Object.entries(s)) {
    if (COLLECTION_ID_SKIP.has(section) || !Array.isArray(theirs)) continue;
    if (section in l && !Array.isArray(l[section])) continue;
    let mine = Array.isArray(l[section]) ? l[section] : [];
    if (section === "documents") {
      // A file only the IndexedDB copy still holds the bytes of.
      const bytes = new Map(theirs.filter((d) => d?.id && d.data && !d.storagePath).map((d) => [d.id, d.data]));
      if (bytes.size && mine.some((d) => d?.id && !d.data && !d.storagePath && bytes.has(d.id))) {
        mine = mine.map((d) => (d?.id && !d.data && !d.storagePath && bytes.has(d.id) ? { ...d, data: bytes.get(d.id) } : d));
        out[section] = mine;
        changed = true;
      }
    }
    const have = new Set(mine.map((row) => row?.id).filter(Boolean));
    const extra = theirs.filter((row) => row?.id && !have.has(row.id));
    if (extra.length) { out[section] = [...mine, ...extra]; changed = true; }
  }
  const settings = l.settings && typeof l.settings === "object" ? l.settings : {};
  const was = s.settings && typeof s.settings === "object" ? s.settings : {};
  const settled = { ...settings };
  for (const name of LOCAL_ONLY_SETTINGS) {
    const blank = (v) => v === undefined || v === null || v === "";
    if (blank(settled[name]) && !blank(was[name])) { settled[name] = was[name]; changed = true; }
  }
  if (changed) out.settings = settled;
  return changed ? JSON.stringify(out) : local;
}

// ─── A data deletion another build honored ───────────────────
// WIPE_SEEN_KEY records the deletion stamp this device purged for, and a
// build from before the IndexedDB store records it after purging
// localStorage only: the IndexedDB copy from before the deletion stayed, and
// this build then took the deletion as honored and read it back (and the
// self-heal pushed it up into the emptied account). This build records, next
// to it, the stamp its own purge reached IndexedDB for. When the two differ,
// the IndexedDB copies predate the deletion: they are purged before anything
// of the account is read from or written to there (settlePendingPurge). The
// localStorage copy, written after the deletion, stays. Holds a timestamp.
// Outside BASE_KEYS, like WIPE_SEEN_KEY: no purge removes it.
export const OFFLINE_WIPED_BASE = "credentialdomd-offline-wiped";

/** This build purged IndexedDB for the deletion `stamp` (recorded with WIPE_SEEN_KEY). */
export function markOfflineWipe(userId, stamp) {
  const k = scopedKey(OFFLINE_WIPED_BASE, userId);
  if (!k || typeof stamp !== "string" || !stamp) return false;
  try { localStorage.setItem(k, stamp); return localStorage.getItem(k) === stamp; } catch { return false; }
}
function offlineWipeOwed(userId) {
  const seen = lsGet(WIPE_SEEN_KEY, userId);
  return seen != null && seen !== "" && lsGet(OFFLINE_WIPED_BASE, userId) !== seen;
}
// Record the purge the IndexedDB copies owe a deletion another build honored.
// The marker goes first: a purge that could run again at every read would
// take what is written after the deletion too. No room for it: nothing is
// purged (the copy stays as it is, as it did before this existed).
//
// Device-only changes held aside (DEVICE_ONLY_PENDING_BASE) go too, first and
// whether or not the marker fits: none is held while a deletion is owed
// (holdDeviceOnlyChanges), so any there now predates it. The older build
// knows nothing of them, and every read laid them back over the emptied file.
function catchUpOfflineWipe(userId) {
  if (!userId || !offlineWipeOwed(userId)) return;
  lsRemove(DEVICE_ONLY_PENDING_BASE, userId);
  const seen = lsGet(WIPE_SEEN_KEY, userId);
  const mayHave = offlineStoreSupported() && mayHaveOfflineCopy(userId);
  if (!markOfflineWipe(userId, seen)) return;
  if (!mayHave) return;
  const recorded = beginOfflinePurge(userId, "all", true);
  if (recorded == null) return;
  bumpPurgeEpoch(userId);
  forgetLargeStoreMemory(userId);
  lsRemove(OFFLINE_WRITTEN_BASE, userId);
}

/**
 * Record a purge of `userId`'s IndexedDB copies before it begins. Returns
 * "none" when IndexedDB holds nothing of the account (nothing is recorded,
 * nothing needs doing), the pending record, or null when localStorage refused
 * the record. `mayHave`: whether IndexedDB may hold anything of the account,
 * as the purge found it before it removed anything (purgeUserStorage).
 */
function beginOfflinePurge(userId, mode, mayHave = offlineStoreSupported() && mayHaveOfflineCopy(userId)) {
  const k = scopedKey(OFFLINE_PURGE_BASE, userId);
  if (!k) return "none";
  const pending = pendingPurge(userId);
  if (!pending && !mayHave) return "none";
  // A full purge still owed covers a trim.
  if (pending?.mode === "all" && mode === "trim") return pending;
  const raw = `${mode}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  try {
    localStorage.setItem(k, raw);
    return localStorage.getItem(k) === raw ? { raw, mode } : null;
  } catch { return null; }
}

/**
 * Carry out a purge of `userId`'s IndexedDB copies: every one removed ("all"),
 * or the file cut down to what exists only on this device in one transaction
 * and the transcript and archives removed ("trim"). Resolves { done, empty }:
 * done once everything committed; empty when nothing of the account is left
 * there. The cut is cancelled when a newer purge replaced this one or the
 * purge fence moved (it was fenced when it lived in localStorage), and a cut
 * that fails leaves the stored file exactly as it was: the device-only
 * sections in it exist nowhere else. `mayHave` false (nothing of the account
 * can be there) skips it; a purge that is recorded always runs, because it
 * was recorded only when there might be something (beginOfflinePurge), and
 * the home record alone does not say so (hasLocalLargeCopy).
 */
async function purgeOfflineCopies(userId, { raw, mode }, mayHave = true) {
  if (!offlineStoreSupported() || !mayHave) return { done: true, empty: true };
  const still = () => (lsGet(OFFLINE_PURGE_BASE, userId) ?? null) === raw;
  const fenced = localWriteGuard(userId);
  let done = true, empty = true;
  for (const base of OFFLINE_STORE_BASES) {
    const key = scopedKey(base, userId);
    if (mode === "trim" && base === BASE_KEYS.data) {
      let left = null;
      try {
        const ran = await offlineUpdate(key, (text) => {
          if (text == null) return undefined;
          left = deviceOnlyFile(text);
          return left === text ? undefined : left; // null removes the key
        }, { guard: () => still() && fenced() });
        if (!ran) { done = false; left = left ?? "unknown"; }
      } catch { done = false; left = "unknown"; }
      if (left !== null) empty = false;
      continue;
    }
    if (!await offlineRemove(key)) { done = false; empty = false; }
  }
  return { done, empty };
}

function clearOfflinePurge(userId, raw, empty) {
  try {
    const k = scopedKey(OFFLINE_PURGE_BASE, userId);
    if (raw != null) {
      if (localStorage.getItem(k) !== raw) return; // a newer purge keeps its own record
      localStorage.removeItem(k);
    } else if (localStorage.getItem(k) !== null) return;
    if (empty) localStorage.removeItem(scopedKey(OFFLINE_HOME_BASE, userId));
  } catch { /* unavailable: the record stays, and the next read finishes it */ }
}

const settling = new Map(); // userId -> { raw, promise }
/**
 * Finish `userId`'s pending IndexedDB purge, if one is recorded. Resolves null
 * when none is pending (any more), or the mode still owed ("all" | "trim")
 * when IndexedDB could not complete it now. Every read and write of the
 * account's large stores runs this first.
 */
export function settlePendingPurge(userId) {
  // A deletion another build honored left the IndexedDB copies behind: they
  // are purged like any purge still owed (catchUpOfflineWipe).
  catchUpOfflineWipe(userId);
  const pending = userId ? pendingPurge(userId) : null;
  if (!pending) return Promise.resolve(null);
  const inflight = settling.get(userId);
  if (inflight) {
    if (inflight.raw === pending.raw) return inflight.promise;
    return inflight.promise.then(() => settlePendingPurge(userId));
  }
  const entry = { raw: pending.raw, promise: null };
  entry.promise = (async () => {
    let result = { done: false, empty: false };
    try { result = await purgeOfflineCopies(userId, pending); } catch { /* still owed */ }
    if (result.done) clearOfflinePurge(userId, pending.raw, result.empty);
  })().finally(() => { if (settling.get(userId) === entry) settling.delete(userId); })
    .then(() => {
      const now = pendingPurge(userId);
      if (!now) return null;
      // A newer purge began meanwhile: finish that one too.
      if (now.raw !== pending.raw) return settlePendingPurge(userId);
      return now.mode;
    });
  settling.set(userId, entry);
  return entry.promise;
}

/**
 * Run when the app opens (main.jsx), signed in or not: purges an earlier
 * session recorded and IndexedDB could not complete then (a Sign out while
 * it would not open) are finished now, so their copies do not wait for the
 * account to come back.
 */
export async function sweepPendingOfflinePurges() {
  const prefix = `${OFFLINE_PURGE_BASE}:`;
  const users = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) users.push(k.slice(prefix.length));
    }
  } catch { return; }
  for (const userId of users) { try { await settlePendingPurge(userId); } catch { /* next launch */ } }
}

// ─── Refusals, reported once per session each ────────────────────
// A cache write the device refused used to be seen only by the member
// (SyncIssuesNotice); nothing reached client_errors. The app sets the reporter
// (AppContext, errorReport.reportError). What is sent: the store, which stores
// refused and why, and the size rounded to 100 KB. Never contents.
// "storage_full" only when IndexedDB itself refused for want of space (or the
// browser has no IndexedDB and localStorage is full); a lost connection or an
// IndexedDB that would not open is "storage_unavailable", whatever
// localStorage then said.
let storageFullReporter = null;
const storageReported = new Set();
export function setStorageFullReporter(fn) { storageFullReporter = typeof fn === "function" ? fn : null; }

/** Why a write of the offline copy did not land: "full", "unread" or "unavailable". */
export function storageRefusalKind(refused) {
  const list = Array.isArray(refused) ? refused : String(refused || "").split(",");
  if (list.some((r) => r.startsWith("indexeddb_quota"))) return "full";
  const localFull = list.includes("localstorage_quota") || list.includes("localstorage_reserved");
  if (list.includes("indexeddb_unsupported") && localFull) return "full";
  // IndexedDB opened and had room; localStorage had none, not even for the
  // record that IndexedDB holds a copy (putOffline). Full, not unavailable.
  if (list.includes("indexeddb_unmarked") && localFull) return "full";
  if (list.includes("indexeddb_unread")) return "unread";
  return "unavailable";
}

export function reportStorageRefusal({ store, reason, chars = 0 }) {
  const event = storageRefusalKind(reason) === "full" ? "storage_full" : "storage_unavailable";
  if (storageReported.has(event) || !storageFullReporter) return false;
  storageReported.add(event);
  const approxBytes = Math.round((Math.max(0, Number(chars) || 0) * 2) / 100000) * 100000;
  // What fills localStorage (key bases and sizes, never a value or an account
  // id) and how IndexedDB failed (an error name), so a report says which of
  // its causes it was. The 2026-10-02 report could not.
  let local = null, idb = null;
  try { local = localStorageInventory(); } catch { /* none */ }
  try { idb = offlineStoreState(); } catch { /* none */ }
  try { storageFullReporter(`Offline copy not saved: ${event}`, { event, store, reason, approxBytes, local, idbError: idb?.lastError ?? null, idbLost: idb?.lost ?? null }); }
  catch { /* reporting never blocks */ }
  return true;
}
/** Tests only: a new session. */
export function resetStorageFullReport() { storageReported.clear(); }

function lsText(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

/**
 * The IndexedDB copy of `key`, as the rules above make it: a purge still owed
 * is finished first, or applied to what is read when it cannot be. Resolves
 * the text, or null when there is none. Throws OfflineStoreUnavailable when
 * IndexedDB could not be read and may hold a copy of the account's (it was
 * written there before): "could not look" is never "nothing there".
 * `retryOpen` gives an open that failed a second try at once.
 */
export async function readOfflineCopy(key, { retryOpen = false } = {}) {
  if (!key) return null;
  const owner = keyOwner(key);
  const owed = owner ? await settlePendingPurge(owner) : null;
  if (owed === "all") return null;
  // Nothing of the account was ever put in IndexedDB (no home record, and no
  // localStorage copy standing in for one mid-move): there is nothing there
  // to read, and no reason to wait on an open that may never answer (iOS
  // builds whose first open hangs held a brand-new account's first screen
  // for two open timeouts).
  if (owner && owed == null && !mayHaveOfflineCopy(owner) && !hasLocalLargeCopy(owner)) return null;
  let text;
  try { text = await offlineRead(key, { retryOpen }); }
  catch {
    // A browser with no IndexedDB at all never stored anything there.
    if (!owner || !offlineStoreSupported() || !mayHaveOfflineCopy(owner)) return null;
    throw new OfflineStoreUnavailable();
  }
  if (owed === "trim") return key.startsWith(`${BASE_KEYS.data}:`) && text != null ? deviceOnlyFile(text) : null;
  return text;
}

/**
 * The stored text for one IndexedDB-backed key, and where it was found:
 * { text, where: "local" | "offline" }, or null when neither store holds it.
 * localStorage first, by the rule above. Throws OfflineStoreUnavailable when
 * localStorage has none and IndexedDB could not be read (readOfflineCopy).
 */
export async function readOfflineText(key, { retryOpen = false } = {}) {
  if (!key) return null;
  // A purge still owed is finished whenever it can be, even when localStorage
  // answers this read: the copies it owes stay out of IndexedDB no longer
  // than they must.
  const owner = keyOwner(key);
  if (owner && (pendingPurge(owner) || offlineWipeOwed(owner))) await settlePendingPurge(owner);
  const local = lsText(key);
  if (local != null) {
    // A copy another build left (a rollback) is merged with the IndexedDB
    // copy, never taken over it: it may have been built without what only
    // IndexedDB holds. When IndexedDB cannot be read, this cannot be told,
    // and the read says it could not look.
    if (owner && !ownLocalCopy(key, local) && offlineStoreSupported() && mayHaveOfflineCopy(owner)) {
      const stored = await readOfflineCopy(key, { retryOpen });
      if (stored != null && stored !== local) return { text: mergeUntrustedLocal(key, stored, local), where: "local" };
    }
    return { text: local, where: "local" };
  }
  const text = await readOfflineCopy(key, { retryOpen });
  return text != null ? { text, where: "offline" } : null;
}

/**
 * A read of this account's offline file (storage.js readCachedData): what the
 * records a load puts on screen are built from. When it could not look, even
 * after a second try at opening IndexedDB, the file is marked unread and no
 * write of it is made from this tab (writeOfflineText) until a load that read
 * it has put its records on screen (markOfflineCopyRead): records built
 * without it have no Protected Identity or Answer Bank, and would replace the
 * only copy of them.
 *
 * A read that gets through never clears the mark itself. The mark belongs to
 * the records in memory, and those are still the ones built without the file
 * until the load that read it replaces them: a second load in the same
 * session read the file at its first step (the id repair), cleared the mark,
 * and the debounced save of the records still on screen then wrote over the
 * only copy while that load waited on the cloud. `receipt` (an object) is
 * given `read` (whether this read got through) and, when it did, `token`,
 * which markOfflineCopyRead and a write of the text just read
 * (writeOfflineText `readToken`) accept.
 */
export async function readOfflineFile(userId, receipt = null) {
  const key = scopedKey(BASE_KEYS.data, userId);
  if (receipt) { receipt.read = false; receipt.token = null; receipt.stamp = null; }
  if (!key) return null;
  const epoch = purgeEpoch(userId);
  // Who had written the file as this read began (OFFLINE_WRITTEN_BASE). None
  // recorded while IndexedDB may hold a copy (a move or a write that found no
  // room for it, a session-end trim) is recorded now when there is room: this
  // read sees every write made before it, and every write after moves it.
  // Left unrecorded, this window took its own next localStorage fallback for
  // another writer's and refused it (localstorage_unmerged).
  if (offlineWriteStamp(userId) == null && mayHaveOfflineCopy(userId)) bumpWriteStamp(userId);
  const stamp = offlineWriteStamp(userId);
  try {
    const found = await readOfflineText(key, { retryOpen: true });
    if (receipt && purgeEpoch(userId) === epoch) { receipt.read = true; receipt.token = { key, epoch }; receipt.stamp = stamp; }
    return found;
  } catch {
    // The mark belongs to the records on screen. Not set by a read whose load
    // has been overtaken (`receipt.current`): a newer load has put records on
    // screen, and a stale read failing afterwards refused every save of the
    // session. Nor when the records on screen are known to hold at least what
    // the stored copy holds (`receipt.trustMemory`: built from a read that got
    // through, and nothing has written the file since but this tab): nothing
    // is built from this failed read, and those records are saved as usual.
    const stale = typeof receipt?.current === "function" && !receipt.current();
    const trusted = typeof receipt?.trustMemory === "function" && receipt.trustMemory();
    if (purgeEpoch(userId) === epoch && !stale && !trusted) unreadKeys.add(key);
    return null;
  }
}

/**
 * Can `userId`'s offline file be read now? A read that got through, with
 * nothing kept of it (the retry of a load that could not read it, AppContext).
 */
export async function probeOfflineFile(userId) {
  const key = scopedKey(BASE_KEYS.data, userId);
  if (!key) return false;
  try { await readOfflineText(key, { retryOpen: true }); return true; } catch { return false; }
}

// A token from a read of `key` that got through (readOfflineFile), taken
// since this tab last purged the account.
function readTokenValid(key, token) {
  if (!token || typeof token !== "object" || token.key !== key) return false;
  return purgeEpoch(keyOwner(key)) === token.epoch;
}

/**
 * A load is putting records on screen built from the read `receipt` came
 * from (readOfflineFile): the file is read, and the records in memory hold
 * what it held. Called immediately before that load's setData, after its
 * last await, and never by a read whose records are not the ones shown (the
 * id repair's). Returns whether the mark was cleared; a receipt from a read
 * that could not look, or from before a purge, leaves it.
 */
export function markOfflineCopyRead(userId, receipt) {
  const key = scopedKey(BASE_KEYS.data, userId);
  if (!key || !readTokenValid(key, receipt?.token)) return false;
  unreadKeys.delete(key);
  return true;
}

/**
 * True from a load that could not read `userId`'s offline file until a load
 * that read it puts its records on screen (readOfflineFile, markOfflineCopyRead).
 */
export function offlineCopyUnread(userId) {
  const key = scopedKey(BASE_KEYS.data, userId);
  return !!key && unreadKeys.has(key);
}

/**
 * Bring a localStorage copy of `key` up to `text`, synchronously as a write
 * of `text` into IndexedDB is committed (putOffline's guard). Without it the
 * rule above breaks for a moment: once the IndexedDB write has landed and
 * before the writer removes the localStorage copy, that copy is OLDER than
 * the IndexedDB one, and another tab's move taken in that moment put it back
 * over the newer write. With the copy already holding `text`, a move that
 * read the older copy finds it changed and stands aside, and one that reads
 * it now moves `text` itself. No room for it: left as it was.
 */
function supersedeLocalCopy(key, text) {
  try {
    const local = localStorage.getItem(key);
    if (local != null && local !== text) { localStorage.setItem(key, text); noteOwnLocalCopy(key, text); return true; }
  } catch { /* full, or unavailable */ }
  return false;
}

/**
 * Put `text` in IndexedDB under `key`, after any purge still owed there.
 * Resolves "saved", "stopped" (a purge since the write began, or the caller's
 * guard refused) or the refusal: "indexeddb_purge_pending",
 * "indexeddb_unsupported", "indexeddb_unmarked" (the home record could not be
 * written), "indexeddb_quota", "indexeddb_unavailable" or "indexeddb_error".
 *
 * `how.generation`: the purge generation when the write began
 * (OFFLINE_GENERATION_KEY). A purge begun since, in this tab or another,
 * cancels the write, however that purge ended. `how.latest`: whether this is
 * still the latest write of the key in this tab (a localStorage copy is
 * brought up to the latest write only, supersedeLocalCopy). `how.moving`: the
 * write moves the key's localStorage copy (moveToOfflineStore); `how.markLater`
 * is then set when it went ahead without the home record.
 *
 * The home record (OFFLINE_HOME_BASE) is set in the commit guard,
 * synchronously as the write transaction is created, so it is set exactly
 * when a write may land: after the database opened, and with no purge of the
 * account recorded. It is never taken back when a write fails. A write fails
 * in one tab while another tab's lands, and neither can see the other's; a
 * home record left over costs at most a read that says "could not look"
 * instead of "nothing there", while one removed from under a stored copy
 * made that copy invisible to every read and every purge after it.
 *
 * A write with no room in localStorage for the home record is refused
 * ("indexeddb_unmarked"), except a move: the localStorage copy it moves shows
 * that IndexedDB may hold one (every purge looks for it before it removes
 * anything, hasLocalLargeCopy), and the move sets the record as it removes
 * that copy, which frees the room.
 */
async function putOffline(key, text, guard, how = {}) {
  const { generation = offlineGeneration(), latest = null, moving = false } = how;
  const owner = keyOwner(key);
  if (!owner) return "indexeddb_error";
  if (!offlineStoreSupported()) return "indexeddb_unsupported";
  if (await settlePendingPurge(owner)) return "indexeddb_purge_pending";
  if (!("expectedStamp" in how)) how.expectedStamp = how.knownStamp;
  how.foreign = !!how.foreign || !!how.mergeAlways;
  let unmarked = false;
  const clear = () => {
    how.markLater = false;
    // A purge begun since this write began, in any tab, however it ended.
    if (offlineGeneration() !== generation) return false;
    // A purge still owed, recorded in any tab.
    if (pendingPurge(owner) !== null) return false;
    if (guard && !guard()) return false;
    if (!markOfflineHome(owner)) {
      if (!moving || lsText(key) == null) { unmarked = true; return false; }
      how.markLater = true;
    }
    // The localStorage copy as it is before this write brings it up to date:
    // with one there, it is the newest copy, and a merge is made against it.
    // Taken once: when the transaction fails and is made again on a fresh
    // connection (transact), the copy there now is the one this write put
    // there, and a merge against it was a merge with nothing. Taken again
    // only when another writer has changed it since.
    const localNow = lsText(key);
    if (!("localBefore" in how) || localNow !== ("localWritten" in how ? how.localWritten : how.localBefore)) {
      how.localBefore = localNow;
      delete how.localWritten;
    }
    // A copy another build wrote (a tab still on a build from before this
    // store, which never moves the stamp) is another writer's: merged with
    // the IndexedDB copy, and this write merged with that. Taken as this
    // window's own, its Protected Identity rows were written over and the
    // copy then removed.
    if (typeof how.merge === "function" && how.localBefore != null && !ownLocalCopy(key, how.localBefore)) how.foreign = true;
    // The file is written: every other tab learns it from the stamp. Whether
    // another writer has written it since the stamp the caller knew is taken
    // here, as the transaction is created, not when the write began: a save
    // begun just after another window's, and created after it, merged with
    // nothing and wrote over the row that window had just stored.
    if (isDataKey(key)) {
      const prev = offlineWriteStamp(owner);
      if (writtenSince(owner, how.expectedStamp)) how.foreign = true;
      how.stamp = bumpWriteStamp(owner);
      noteOwnStamp(how.stamp, prev, !how.foreign);
      how.expectedStamp = offlineWriteStamp(owner);
    }
    // A localStorage copy this build wrote is brought up to what this write
    // will hold: with a merge, the merge with that copy, never the unmerged
    // text (which put a copy without the other writer's rows over the only
    // copy of them). A copy another build wrote is merged with the IndexedDB
    // copy first, so it is left as it is until the transaction reads that.
    const local = how.localBefore;
    let final = text;
    if (typeof how.merge === "function" && local != null) {
      if (!ownLocalCopy(key, local)) final = null;
      else if (how.foreign && local !== text) { const out = how.merge(local); if (typeof out === "string") final = out; }
    }
    if (final != null && !moving && (!latest || latest()) && supersedeLocalCopy(key, final)) how.localWritten = final;
    return true;
  };
  how.finalText = text;
  how.merged = false;
  try {
    let ran;
    if (typeof how.merge === "function") {
      // Read and written in one transaction: `how.merge(stored)` returns the
      // text to write in place of `text` (the device-only rows another tab
      // wrote since this one last read, kept), or nothing to write `text`.
      // Asked only when the stamp had moved from `how.knownStamp` as the
      // transaction was created (or `how.mergeAlways`).
      ran = await offlineUpdate(key, (stored) => {
        const local = how.localBefore;
        const theirs = local == null ? stored : ownLocalCopy(key, local) ? local : mergeUntrustedLocal(key, stored, local);
        let final = text;
        if (how.foreign && theirs != null && theirs !== text) {
          const out = how.merge(theirs);
          if (typeof out === "string") final = out;
        }
        how.finalText = final;
        how.merged = true;
        if (!moving && (!latest || latest()) && supersedeLocalCopy(key, final)) how.localWritten = final;
        return final;
      }, { guard: clear });
    } else ran = await offlineWrite(key, text, { guard: clear });
    if (ran) return "saved";
    return unmarked ? "indexeddb_unmarked" : "stopped";
  } catch (error) {
    return isQuotaError(error) ? "indexeddb_quota" : error instanceof OfflineStoreUnavailable ? "indexeddb_unavailable" : "indexeddb_error";
  }
}

/**
 * Move `key`'s localStorage copy into IndexedDB, never losing the only copy:
 * written, read back and compared, and only then removed from localStorage
 * (and only if localStorage still holds exactly what was copied). Ordered
 * with writeOfflineText: the move's write is made only if no write of the key
 * has begun since the move began, none is still on its way, no purge has
 * begun since (in any tab), and localStorage still holds what it read,
 * checked synchronously as the transaction is created; otherwise that write
 * is newer and the move stands aside. A write in another tab brings the
 * localStorage copy up to what it writes as its own transaction is created
 * (supersedeLocalCopy), so the last check also stands the move aside for
 * another tab's newer write. Returns "moved", "none" (nothing to move), or
 * "kept" (IndexedDB unavailable, full, refused by the guard, overtaken, or
 * the read-back differed: localStorage keeps it).
 *
 * When localStorage has no room for the home record (an older build left a
 * large copy there and the rest filled up), the move goes ahead without it:
 * the copy being moved stands in for the record until, in one synchronous
 * step, it is removed and the record written in the room it freed. A record
 * that still does not fit puts the copy back.
 */
export async function moveToOfflineStore(key, guard) {
  const raw = lsText(key);
  if (raw == null) return "none";
  const owner = keyOwner(key);
  const generation = offlineGeneration();
  const seqAtStart = writeSeq.get(key);
  const unchanged = () => offlineGeneration() === generation
    && writeSeq.get(key) === seqAtStart && !writesInFlight.has(key) && lsText(key) === raw;
  // A copy another build wrote (a rollback) is merged with what IndexedDB
  // holds, never moved over it (mergeUntrustedLocal). IndexedDB unreadable:
  // it stays where it is, and the read says it could not look.
  let text = raw;
  if (!ownLocalCopy(key, raw) && owner && offlineStoreSupported() && mayHaveOfflineCopy(owner)) {
    let stored;
    try { stored = await readOfflineCopy(key); } catch { return "kept"; }
    if (stored != null && stored !== raw) text = mergeUntrustedLocal(key, stored, raw);
  }
  const how = { generation, moving: true };
  const put = await putOffline(key, text, () => unchanged() && (!guard || guard()), how);
  if (put !== "saved") {
    if (put === "indexeddb_quota") reportStorageRefusal({ store: key.slice(0, key.indexOf(":")), reason: "indexeddb_quota_on_move", chars: raw.length });
    return "kept";
  }
  let back;
  try { back = await offlineRead(key); } catch { return "kept"; }
  if (back !== text) return "kept";
  // Overtaken since: the localStorage copy is not this move's to remove.
  // While it is there it still stands in for a missing home record.
  if (!unchanged()) return "moved";
  try { localStorage.removeItem(key); } catch { return "kept"; }
  noteOwnLocalCopy(key, null);
  if (how.markLater && !markOfflineHome(owner)) {
    try { localStorage.setItem(key, raw); } catch { /* the room it freed was taken meanwhile */ }
    return "kept";
  }
  return "moved";
}

/**
 * Write one IndexedDB-backed key: IndexedDB first; localStorage only when
 * IndexedDB refused and no newer write of the key has begun since. Resolves
 * { saved, stopped, refused: [reasons], chars }. `stopped` is a write the
 * guard refused (a purge since it began): nothing was written anywhere. A key
 * whose stored copy could not be read (unreadKeys) is written nowhere:
 * refused ["indexeddb_unread"]. `how.readToken`: the text is the stored copy
 * itself, just read (readOfflineFile's receipt) and rewritten (sanitised, its
 * ids repaired), so it holds everything the stored copy held and the unread
 * mark does not stop it.
 *
 * A write refused only because localStorage had no room for the home record
 * ("indexeddb_unmarked") while a localStorage copy of the key is still there
 * (an older build's copy whose move at the start of the session found
 * IndexedDB closed) moves that copy first, which frees its room and sets the
 * record in it (moveToOfflineStore), and is then made once more. Without
 * that, every save of the session was refused as soon as IndexedDB answered
 * again, and what was added meanwhile existed nowhere.
 */
export async function writeOfflineText(key, text, guard, how = {}) {
  const first = await writeOfflineTextOnce(key, text, guard, how);
  const { seq, result } = first;
  if (result.saved || result.stopped || result.superseded || !result.refused.includes("indexeddb_unmarked")) return result;
  // Only while this is still the latest write of the key, and a copy is there to move.
  if (writeSeq.get(key) !== seq || lsText(key) == null) return result;
  if (await moveToOfflineStore(key, guard) !== "moved" || writeSeq.get(key) !== seq) return result;
  return (await writeOfflineTextOnce(key, text, guard, how)).result;
}

async function writeOfflineTextOnce(key, text, guard, how) {
  const seq = ++writeCounter;
  const generation = offlineGeneration();
  writeSeq.set(key, seq);
  writesInFlight.set(key, (writesInFlight.get(key) || 0) + 1);
  try { return { seq, result: await writeOfflineTextNow(key, text, guard, seq, generation, how) }; }
  finally {
    const n = (writesInFlight.get(key) || 1) - 1;
    if (n > 0) writesInFlight.set(key, n); else writesInFlight.delete(key);
  }
}

async function writeOfflineTextNow(key, text, guard, seq, generation, how = {}) {
  const latest = () => writeSeq.get(key) === seq;
  const chars = text.length;
  if (unreadKeys.has(key) && !readTokenValid(key, how.readToken)) return { saved: false, stopped: false, refused: ["indexeddb_unread"], chars };
  const put_how = { generation, latest, merge: how.merge, knownStamp: how.knownStamp, mergeAlways: how.mergeAlways };
  const put = await putOffline(key, text, guard, put_how);
  if (put === "saved") {
    // Landed: any localStorage copy is older now, and the space it held is
    // freed. Only by the latest write, so an older fallback is never left
    // standing over a newer IndexedDB copy.
    // Not a copy written since the transaction read localStorage (a tab on
    // an older build): this write never saw it.
    const seen = "localWritten" in put_how ? put_how.localWritten : put_how.localBefore;
    if (latest() && (!("localBefore" in put_how) || lsText(key) === seen)) {
      try { localStorage.removeItem(key); } catch { /* unavailable */ }
      noteOwnLocalCopy(key, null);
    }
    return { saved: true, stopped: false, refused: [], chars, text: put_how.finalText, stamp: put_how.stamp ?? null, where: "offline" };
  }
  if (put === "stopped") return { saved: false, stopped: true, refused: [], chars };
  const refused = [put];
  if (!latest()) return { saved: false, stopped: false, refused, chars, superseded: true };
  // A purge begun since this write began (another tab's Sign out, even one
  // that has finished), or the caller's guard: its text predates it.
  if (offlineGeneration() !== generation || (guard && !guard())) return { saved: false, stopped: true, refused, chars };
  // The localStorage copy, when there is one, is the newest: a merge is made
  // against it here as it is against IndexedDB (putOffline).
  let final = text;
  const localNow = lsText(key);
  const foreign = put_how.foreign || (isDataKey(key) && writtenSince(keyOwner(key), "expectedStamp" in put_how ? put_how.expectedStamp : how.knownStamp))
    // A copy another build wrote is another writer's here too (putOffline).
    || (typeof how.merge === "function" && localNow != null && !ownLocalCopy(key, localNow));
  if (typeof how.merge === "function" && foreign) {
    const now = lsText(key);
    // What the transaction saw of localStorage (putOffline), unchanged since:
    // the copy there is this write's own, and the one to merge with is the
    // one it replaced.
    const seen = "localWritten" in put_how ? put_how.localWritten : put_how.localBefore;
    const unchanged = "localBefore" in put_how && now === seen;
    // Nothing written since this write's transaction was created.
    const quiet = !isDataKey(key) || offlineWriteStamp(keyOwner(key)) === put_how.expectedStamp;
    if (put_how.merged && unchanged && quiet) {
      // The transaction read the newest copy (IndexedDB's, or localStorage's
      // merged with it) and merged before it failed: that is the text.
      final = put_how.finalText;
    } else {
      const theirs = unchanged ? put_how.localBefore : now;
      // Another writer has written the file since this tab's copy, and what
      // it wrote is in IndexedDB, which this write could not read (no
      // localStorage copy to merge with), or in a localStorage copy another
      // build wrote, which is merged with IndexedDB's before it is trusted.
      // Written here as this build's own copy, it stood in front of the newer
      // IndexedDB copy for every window, and the next save there merged
      // against it and removed the rows it lacked. Refused: the device-only
      // changes are held aside (storage.js), and a later try that can read
      // IndexedDB merges.
      // Only while IndexedDB may hold a copy that counts: none was ever put
      // there, or a full purge of it is owed (a deletion), and there is
      // nothing newer to lose.
      const owner = keyOwner(key);
      const newerThere = offlineStoreSupported() && mayHaveOfflineCopy(owner)
        && pendingPurge(owner)?.mode !== "all" && !offlineWipeOwed(owner);
      if (newerThere && (theirs == null || !ownLocalCopy(key, theirs))) {
        return { saved: false, stopped: false, refused: [...refused, "localstorage_unmerged"], chars };
      }
      if (theirs != null && theirs !== text) { const out = how.merge(theirs); if (typeof out === "string") final = out; }
    }
  }
  // Into localStorage only while the copy is small and leaves the reserve for
  // what has nowhere else to go (LOCAL_RESERVE_BYTES). The owner's 3.8 MB file
  // went there whenever IndexedDB stopped answering, and the queue, the timer
  // and the notes written after it found no room (2026-10-02). Refused, the
  // save is made again when IndexedDB answers (storage.js retryOfflineSave),
  // and Protected Identity and Answer Bank changes are held aside meanwhile.
  // A browser with no IndexedDB at all has no other store: any size that
  // leaves the reserve.
  const fits = put === "indexeddb_unsupported"
    ? localStorageUsed(key) + localCost(final) + localCost(key) + LOCAL_RESERVE_BYTES <= LOCAL_QUOTA_BYTES
    : largeCopyFitsLocally(key, final);
  if (!fits) {
    refused.push("localstorage_reserved");
    return { saved: false, stopped: false, refused, chars };
  }
  try {
    putOwnLocalCopy(key, final);
    const prev = isDataKey(key) ? offlineWriteStamp(keyOwner(key)) : null;
    const stamp = isDataKey(key) ? bumpWriteStamp(keyOwner(key)) : null;
    if (stamp) noteOwnStamp(stamp, prev, !foreign);
    return { saved: true, stopped: false, refused, chars, text: final, stamp, where: "local" };
  } catch (error) {
    refused.push(isQuotaError(error) ? "localstorage_quota" : "localstorage_error");
  }
  return { saved: false, stopped: false, refused, chars };
}

/** Did a write refuse for want of space (in either store)? */
export function refusedForSpace(refused) {
  return Array.isArray(refused) && refused.some((r) => r.endsWith("_quota"));
}

// Write one of the mirrored stores through to IndexedDB (localStorage if it
// refuses), and report a refusal that kept it from the device.
function storeMirrored(key, value, userId) {
  writeOfflineText(key, value, localWriteGuard(userId)).then((result) => {
    if (result.stopped) return;
    if (!result.saved || result.refused.includes("indexeddb_quota")) {
      reportStorageRefusal({ store: key.slice(0, key.indexOf(":")), reason: result.refused.join(","), chars: result.chars });
    }
  }, () => {});
}

/**
 * Prepare this account's large stores for the session: move each localStorage
 * copy into IndexedDB (the offline file, the transcript, the archives), and
 * hold the transcript and archives in memory for their synchronous readers.
 * Run by the load (storage.js readCachedData) before anything is rendered, so
 * the Assistant never mounts over an empty transcript and writes it back. Once
 * per account per tab, when every store was read; a store that could not be
 * read is left out of memory (unreadKeys) and the next call tries it again. A
 * purge of the account resets it.
 */
export function hydrateOfflineStores(userId) {
  if (!userId) return Promise.resolve();
  syncMemoryToFence(userId);
  const existing = hydrated.get(userId);
  if (existing) return existing;
  const epoch = purgeEpoch(userId);
  const fence = localFence(userId) ?? null;
  // Purged while this ran, here (the epoch) or in another tab by a deletion
  // (the fence): what it read predates the purge, and nothing goes into memory.
  const purged = () => purgeEpoch(userId) !== epoch || (localFence(userId) ?? null) !== fence;
  const run = (async () => {
    let complete = true;
    await moveToOfflineStore(scopedKey(BASE_KEYS.data, userId), localWriteGuard(userId, { adopted: false }));
    for (const base of MIRRORED_BASES) {
      const key = scopedKey(base, userId);
      if (mirror.has(key)) continue;
      // This session keeps its own copy apart from a stored one it began without.
      if (sessionOnly.has(key) && !unreadKeys.has(key)) continue;
      await moveToOfflineStore(key, localWriteGuard(userId, { adopted: false }));
      let found;
      try { found = await readOfflineText(key); }
      catch {
        if (purged()) return false;
        unreadKeys.add(key);
        complete = false;
        continue;
      }
      // Purged while this ran: the purge cleared the mirror; nothing goes back.
      if (purged()) return false;
      // A write that happened meanwhile is newer than what was read.
      if (mirror.has(key)) continue;
      unreadKeys.delete(key);
      if (sessionOnly.has(key)) {
        // Written this session while the stored copy could not be read. If
        // there was none after all, this session's copy is the copy. If there
        // was, this session began without it: the two are merged by id
        // (mergeLargeStore) and the merge is the copy from here on, so
        // neither the earlier conversation nor this session's is lost. The
        // Assistant on screen takes the merge in (onLargeStoreMerged); held
        // apart instead, every later write of this session stayed in memory
        // and a reload dropped the whole session's conversation.
        const value = sessionOnly.get(key);
        sessionOnly.delete(key);
        const merged = found == null ? value : mergeLargeStore(base, found.text, value);
        mirror.set(key, merged);
        if (found == null || merged !== found.text) storeMirrored(key, merged, userId);
        if (found != null && merged !== value) notifyLargeStoreMerged(base, userId);
        continue;
      }
      mirror.set(key, found ? found.text : null);
    }
    return complete;
  })();
  hydrated.set(userId, run);
  const retryNextTime = () => { if (hydrated.get(userId) === run) hydrated.delete(userId); };
  run.then((complete) => { if (!complete) retryNextTime(); }, retryNextTime);
  return run;
}

/**
 * One of the mirrored stores (the transcript, the archives) merged by id: the
 * entries of `stored` this session never had, and every entry of `session`,
 * where an entry on both sides is taken from `session`. The transcript runs
 * oldest first, so the stored conversation goes above this session's; the
 * archives run newest first, so this session's stay on top. An entry with no
 * id is kept from both sides.
 */
export function mergeLargeList(base, stored, session) {
  const idOf = (entry) => (entry && typeof entry === "object" && typeof entry.id === "string" && entry.id ? entry.id : null);
  const have = new Set((session || []).map(idOf).filter(Boolean));
  const extra = (stored || []).filter((entry) => { const id = idOf(entry); return !id || !have.has(id); });
  return base === BASE_KEYS.archives ? [...(session || []), ...extra] : [...extra, ...(session || [])];
}

/** mergeLargeList over the stored texts. A side that is not a list counts as empty. */
function mergeLargeStore(base, storedText, sessionText) {
  const list = (text) => { try { const v = JSON.parse(text); return Array.isArray(v) ? v : null; } catch { return null; } };
  const stored = list(storedText), session = list(sessionText);
  if (!stored) return sessionText;
  if (!session) return storedText;
  const merged = mergeLargeList(base, stored, session);
  return merged.length === session.length ? sessionText : JSON.stringify(merged);
}

// Told when a stored transcript or archives list this session began without
// has been merged with the session's own (hydrateOfflineStores): the
// Assistant on screen merges it into what it holds, or its next write would
// put back only this session's part.
const largeStoreListeners = new Set();
/** `listener(base)` for the active account; returns a function that removes it. */
export function onLargeStoreMerged(listener) {
  if (typeof listener !== "function") return () => {};
  largeStoreListeners.add(listener);
  return () => largeStoreListeners.delete(listener);
}
function notifyLargeStoreMerged(base, userId) {
  if (userId !== activeUserId) return;
  for (const listener of largeStoreListeners) { try { listener(base); } catch { /* a listener must not stop the merge */ } }
}

/**
 * A large-store copy written straight into localStorage by a writer outside
 * this module (continuity recovery, continuityRecovery.js). localStorage
 * outranks IndexedDB, so it is the key's value from now on, and the copy the
 * Assistant reads from memory follows it; its next write moves it into
 * IndexedDB as usual.
 */
export function noteLocalCopyWritten(key, text) {
  if (!isMirroredKey(key) || typeof text !== "string") return;
  syncMemoryToFence(keyOwner(key));
  mirror.set(key, text);
  sessionOnly.delete(key);
  unreadKeys.delete(key);
}

/** One of the mirrored stores (the transcript, the archives), synchronously. */
export function largeGet(base, userId = activeUserId) {
  const k = scopedKey(base, userId);
  if (!k) return null;
  syncMemoryToFence(userId);
  if (mirror.has(k)) return mirror.get(k);
  if (sessionOnly.has(k)) return sessionOnly.get(k);
  return lsText(k);
}
export function largeGetJSON(base, userId = activeUserId) {
  const raw = largeGet(base, userId);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Write one of the mirrored stores: memory at once and IndexedDB behind it,
 * localStorage only if IndexedDB refuses. Before this account's stores have
 * been read (hydrateOfflineStores), the write waits for that read and lands
 * over what it found. A store whose copy could not be read keeps this
 * session's writes in memory only: begun from an empty read, they would
 * replace the only copy of the transcript and its archives. Each such write
 * tries the read again, and once it gets through the two are merged and
 * written (hydrateOfflineStores).
 */
export function largeSet(base, value, userId = activeUserId) {
  const k = scopedKey(base, userId);
  if (!k) return false;
  if (!localCopyCurrent(userId)) return false;
  syncMemoryToFence(userId);
  if (mirror.has(k)) {
    mirror.set(k, value);
    storeMirrored(k, value, userId);
    return true;
  }
  if (sessionOnly.has(k) || unreadKeys.has(k)) {
    sessionOnly.set(k, value);
    // Another try at reading it: there may have been nothing there after all.
    if (unreadKeys.has(k) && !hydrated.has(userId)) hydrateOfflineStores(userId).catch(() => {});
    return true;
  }
  const pending = hydrated.get(userId) || hydrateOfflineStores(userId);
  pending.then(() => {
    if (mirror.has(k) || sessionOnly.has(k) || unreadKeys.has(k)) largeSet(base, value, userId);
  }, () => {});
  return true;
}
export function largeSetJSON(base, value, userId = activeUserId) {
  return largeSet(base, JSON.stringify(value), userId);
}

/**
 * Read one of the mirrored stores (the transcript, the archives) again from
 * where it is stored, and hold what was read in memory. IndexedDB tells no
 * other tab about a write, so what this tab read when the account loaded can
 * be older than what another tab has stored since (a conversation archived
 * there). The Assistant reads both again as it opens and writes nothing
 * until they are back (AssistantSection). Resolves the stored text (null
 * when none is stored), or undefined when it could not be read: the key is
 * then unread, and this session's writes are held in memory until a read
 * gets through and are merged with it then (largeSet, hydrateOfflineStores).
 * What this tab wrote itself since the read began is newer, and is kept.
 */
export async function rereadLargeStore(base, userId = activeUserId) {
  const key = scopedKey(base, userId);
  if (!key || !MIRRORED_BASES.includes(base)) return undefined;
  syncMemoryToFence(userId);
  const held = () => (mirror.has(key) ? mirror.get(key) : undefined);
  // Not read in this tab yet, or it could not be: the hydration reads it,
  // and merges in what this session wrote meanwhile.
  if (!mirror.has(key)) {
    try { await hydrateOfflineStores(userId); } catch { /* unread */ }
    return held();
  }
  const epoch = purgeEpoch(userId);
  const fence = localFence(userId) ?? null;
  const seq = writeSeq.get(key);
  const untouched = () => purgeEpoch(userId) === epoch && (localFence(userId) ?? null) === fence
    && writeSeq.get(key) === seq && !writesInFlight.has(key);
  if (!untouched()) return held();
  // A copy another writer left in localStorage (continuity recovery) moves
  // into IndexedDB first, as the hydration moves one.
  await moveToOfflineStore(key, localWriteGuard(userId, { adopted: false }));
  let found;
  try { found = await readOfflineText(key, { retryOpen: true }); }
  catch {
    if (!untouched()) return held();
    // Could not look. What memory holds may be older than the stored copy,
    // and nothing begun from it is written over that copy.
    mirror.delete(key);
    unreadKeys.add(key);
    hydrated.delete(userId);
    return undefined;
  }
  if (!untouched()) return held();
  const text = found ? found.text : null;
  mirror.set(key, text);
  return text;
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
 *
 * Resolves true when the purge is durable: IndexedDB committed it, or it is
 * recorded (OFFLINE_PURGE_BASE) to be finished before anything of the
 * account is read from there again. False only when IndexedDB refused and
 * not even the record could be kept; a deletion is then not marked honored
 * (dataDeletion.js), so the next load purges again.
 */
export async function purgeUserStorage(userId, { keepVault = false, retireRecovery = false, keepDeviceOnly = false } = {}) {
  if (!userId) return true;
  const keepLocal = keepDeviceOnly && keepVault && !retireRecovery;
  // A real server wipe may preserve a private vault but must still prevent
  // recovery. Ordinary involuntary sign-out uses keepVault:true without this.
  if (!keepVault || retireRecovery) retireContinuityRecovery(userId);
  // The session merely ended: a save of the file this tab still has on its
  // way is about to be cancelled, and the device-only changes it carries are
  // held aside first (setBeforeDeviceOnlyTrim), as the rest of what exists
  // only on this device is kept.
  if (keepLocal && beforeDeviceOnlyTrim) { try { beforeDeviceOnlyTrim(userId); } catch { /* the trim goes on */ } }
  // Every write of the large stores begun before this point, in this tab or
  // another, is refused when it comes to commit (the generation, and this
  // tab's epoch), and the in-memory transcript goes with the rest.
  const advanced = advanceOfflineGeneration();
  // Asked before anything is removed: a localStorage copy of a large store is
  // itself a sign that IndexedDB may hold one (hasLocalLargeCopy).
  const mayHave = offlineStoreSupported() && (mayHaveOfflineCopy(userId) || hasLocalLargeCopy(userId));
  bumpPurgeEpoch(userId);
  forgetLargeStoreMemory(userId);
  memoryFences.delete(userId);
  // Session expiry keeps this account's text for re-sign-in. Deliberate
  // sign-out/deletion removes it; screenshots are never stored here.
  if (!keepVault || retireRecovery) clearSupportTextDrafts(userId);
  let keptOwnCopy = null;
  for (const [name, base] of Object.entries(BASE_KEYS)) {
    if (name === "vault" && keepVault) continue;
    // Session expiry also keeps the membership answer (two booleans), so the
    // re-sign-in opens on the right screens instead of "Checking membership".
    // Sign out and a server wipe remove it with everything else.
    if (name === "accessAnswer" && keepVault && !retireRecovery) continue;
    if (keepLocal && name === "pendingOps") { markQueueKept(userId); continue; }
    if (keepLocal && (name === "timer" || name === "unrecordedInvoices" || name === "formDrafts")) continue;
    // The invoice hand-off notes go with the unrecorded-invoice notes.
    if (name === "unrecordedInvoices" && purgeInvoiceHandoff) { try { purgeInvoiceHandoff(userId); } catch { /* the purge goes on */ } }
    if (keepLocal && name === "data") {
      const raw = lsGet(base, userId);
      if (raw == null) continue;
      const kept = deviceOnlyFile(raw);
      const own = ownLocalCopy(scopedKey(base, userId), raw);
      if (kept) { if (lsSet(base, kept, userId)) keptOwnCopy = own ? kept : null; } else lsRemove(base, userId);
      continue;
    }
    lsRemove(base, userId);
  }
  // The file's write stamp and the record of this build's localStorage
  // copies go with the copies (a trimmed copy this build wrote stays its
  // own). Device-only changes held aside go too, unless the session merely
  // ended: they exist nowhere else.
  lsRemove(OFFLINE_WRITTEN_BASE, userId);
  lsRemove(LOCAL_COPIES_BASE, userId);
  if (keptOwnCopy != null) noteOwnLocalCopy(scopedKey(BASE_KEYS.data, userId), keptOwnCopy);
  if (!keepLocal) lsRemove(DEVICE_ONLY_PENDING_BASE, userId);
  // This tab's copies of what localStorage had no room for (the running
  // timer, utils/runningTimerStore.js; open form drafts, utils/formDrafts.js)
  // go too, unless the session merely ended.
  if (!keepLocal) {
    for (const base of [BASE_KEYS.timer, BASE_KEYS.formDrafts]) {
      try { globalThis.sessionStorage?.removeItem(scopedKey(base, userId)); } catch { /* unavailable */ }
    }
  }
  // localStorage was full: the removals above made room for it.
  if (!advanced) advanceOfflineGeneration();
  // The IndexedDB copies. The purge is recorded before the first await
  // (callers rely on everything in localStorage going before it), and the
  // record stays until IndexedDB has committed it: an IndexedDB that will not
  // open now, or whose connection was lost, is purged by the next read or
  // write of the account, or the next launch (sweepPendingOfflinePurges),
  // before anything of it is read. The file is cut down to what exists only
  // on this device exactly as above when the session merely ended; everything
  // else goes. Durable when committed, or recorded to be.
  const mode = keepLocal ? "trim" : "all";
  const recorded = beginOfflinePurge(userId, mode, mayHave);
  let durable = true;
  if (recorded && recorded !== "none") {
    await settlePendingPurge(userId);
  } else if (recorded === null) {
    // Not even the record could be kept: purge now, and say whether it held.
    let result = { done: false, empty: false };
    try { result = await purgeOfflineCopies(userId, { raw: null, mode }, mayHave); } catch { /* not done */ }
    if (result.done) clearOfflinePurge(userId, null, result.empty);
    durable = result.done;
  }
  const nativeKey = scopedKey(BASE_KEYS.data, userId);
  try {
    if (keepLocal && window.storage?.get) {
      const r = await window.storage.get(nativeKey);
      const kept = r?.value ? deviceOnlyFile(r.value) : null;
      if (kept) { await window.storage.set(nativeKey, kept); return durable; }
    }
    await window.storage?.remove?.(nativeKey);
  } catch { /* unavailable */ }
  return durable;
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
  if (!userId) return true;
  const durable = await purgeUserStorage(userId, { keepVault: false });
  lsRemove(DEVICE_KEYS_BASE, userId);
  removeSignOutIntentKey(userId);
  return durable;
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
 *
 * Resolves { counts, unread }. `unread` is true when the IndexedDB copy may
 * hold rows and could not be read (it would not open, even on a second try)
 * and no localStorage copy stands in for it: the counts then leave out what
 * the purge would erase from there, and Sign out has to say so. That is not
 * only the case after a load that could not read the file (offlineCopyUnread):
 * Sign out is offered before any load has read it, on the identity-check and
 * membership screens.
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
  // The IndexedDB copy, where the file lives now (offlineStore.js), with any
  // purge still owed applied first.
  let unread = false;
  try {
    const stored = await readOfflineCopy(scopedKey(BASE_KEYS.data, userId), { retryOpen: true });
    if (stored != null) tally(parse(stored));
  } catch {
    // Could not look. A localStorage copy is never older than the IndexedDB
    // one, so with one counted above nothing is missing.
    unread = raw == null;
  }
  const nativeKey = scopedKey(BASE_KEYS.data, userId);
  if (nativeKey) {
    try {
      if (window.storage?.get) {
        const r = await window.storage.get(nativeKey);
        if (r?.value) tally(parse(r.value));
      }
    } catch { /* unavailable */ }
  }
  return { counts: Object.fromEntries(Object.entries(seen).map(([section, ids]) => [section, ids.size])), unread };
}

// ─── One-time migration of the pre-namespace keys ─────────────

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
function moveLegacy(base, userId, { namespacedExists = false } = {}) {
  const raw = readLegacy(base);
  // An empty placeholder ("[]", "{}", "null") written by a component that
  // mounted before adoption ran does not count as a namespaced value; the
  // legacy content wins over it. The transcript and archives are read where
  // they live now (largeGet: memory once hydrated, IndexedDB behind it), and
  // a file already in IndexedDB (namespacedExists) is never replaced by the
  // legacy one: a localStorage copy would outrank it on the next read.
  const mirrored = MIRRORED_BASES.includes(base);
  // A transcript whose stored copy could not be read this session: the legacy
  // one stays where it is, for a load that can compare the two.
  const k = scopedKey(base, userId);
  if (mirrored && (unreadKeys.has(k) || sessionOnly.has(k))) return;
  const cur = mirrored ? largeGet(base, userId) : lsGet(base, userId);
  const curEmpty = !namespacedExists && (cur == null || /^\s*(\[\s*\]|\{\s*\}|null|"")\s*$/.test(cur));
  if (raw != null && curEmpty) { if (mirrored) largeSet(base, raw, userId); else lsSet(base, raw, userId); }
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
 * `readReceipt`: the receipt of the calling load's own read of the file
 * (readOfflineFile). The unread mark stays until that load puts its records
 * on screen (markOfflineCopyRead), so a load that did read the file says so.
 *
 * Returns the adopted legacy file, or null.
 */
export function adoptLegacyStorage(userId, { cloudIds, cloudHasData, hasLocalFile = false, readReceipt = null }) {
  if (!userId) return null;
  // This load could not read the account's file in IndexedDB. A legacy file
  // put in localStorage now would outrank it, and deciding without it could
  // discard the newer one: nothing moves, and the next load decides.
  if (offlineCopyUnread(userId) && !readTokenValid(scopedKey(BASE_KEYS.data, userId), readReceipt?.token)) return null;
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
    for (const base of movable) moveLegacy(base, userId, { namespacedExists: base === BASE_KEYS.data && hasLocalFile });
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
