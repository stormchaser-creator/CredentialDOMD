/**
 * IndexedDB home for the large per-account stores (the offline copy of the
 * file, the Assistant transcript and its archives).
 *
 * Why. localStorage is about 5 MB per origin on Safari, counted in UTF-16 and
 * shared by every key, and the offline copy of a busy account (1,500 case
 * logs, hundreds of work entries) outgrows it: the cache write throws
 * QuotaExceededError and what opens offline goes stale. IndexedDB's quota on
 * iOS is a share of the disk, hundreds of MB on a phone with space.
 *
 * One database, one object store, keyed by the SAME scoped key the
 * localStorage copy used (`credentialdomd-data:user_x`), so per-account
 * scoping is unchanged: an account reads its own key and never another's.
 * Values are the JSON text, exactly as localStorage held it, so a copy can
 * be verified byte for byte after a move and every existing parser and
 * sanitiser works on it unchanged.
 *
 * Deliberately dependency-free. The safety rules (the purge fence, purges,
 * scoping) live in storageScope.js and storage.js; this module only moves
 * text in and out, and gives a writer one hook, `guard`, that runs
 * synchronously immediately before the write transaction is created.
 * IndexedDB runs transactions on one store in the order they were created,
 * so a guard that passes cannot be overtaken by a purge that began after it,
 * and a purge that began before it makes the guard fail.
 */

export const OFFLINE_DB_NAME = "credentialdomd-offline";
export const OFFLINE_DB_STORE = "kv";
const OFFLINE_DB_VERSION = 1;
// iOS has shipped builds whose first indexedDB.open never answers. Past this
// the store counts as unavailable for the call and the next call tries again.
const OPEN_TIMEOUT_MS = 4000;
// After an open that failed or never answered, calls within this window are
// answered "unavailable" at once instead of each waiting out the timeout
// again (a load makes several reads in a row).
const RETRY_AFTER_MS = 30000;
// How long a caller waits on one transaction before it is told "not yet"
// (OfflineStoreBusy): the load, Sign out and every purge wait on the store,
// and none of them could hang on localStorage before. "Not yet" is not a
// failure. The transaction is left to run on the same connection, nothing is
// locked out, and what it brings is kept: a read that lands later is held for
// the next reads of the key (the retry of a load that could not read it)
// while the caller's tag says no writer has moved the key since, and
// a write that lands is saved. The owner's iPhone took longer than this for
// every transaction on his 4 MB file (2026-11, ticket b1071b82), and each
// timeout was taken for a broken store: the copy was never read again that
// session and "Offline copy not saved" was reported.
const TRANSACTION_TIMEOUT_MS = 6000;
let transactionTimeoutMs = TRANSACTION_TIMEOUT_MS;
// A transaction still unsettled this long after it was created has failed
// (OfflineStoreStuck): the store is broken, not slow. The connection is
// dropped and the next call opens a fresh one.
const TRANSACTION_BOUND_MS = 3 * 60 * 1000;
let transactionBoundMs = TRANSACTION_BOUND_MS;

let factoryOverride;
let dbPromise = null;
let openDbHandle = null;           // the connection dbPromise resolved to
let unavailableUntil = 0;

// A connection WebKit took away is a different failure from an open that
// never answers. When iOS reclaims the process serving IndexedDB while the
// installed app is suspended, every connection gets a close event and every
// open in the page fails at once with UnknownError ("Connection to Indexed
// Database server lost") or InvalidStateError (WebKit bug 273827; the owner's
// iPhone after three hours in the background, 2026-10-02 01:57). Such an open
// costs nothing to try again, so the next call may, after LOST_RETRY_MS
// rather than RETRY_AFTER_MS: a return to the app (AppContext's retry on
// visibility and focus) reopens at once instead of 30 seconds later. What
// failed is kept (offlineStoreState) for the storage report.
const LOST_RETRY_MS = 2000;
const LOST_ERRORS = new Set(["UnknownError", "InvalidStateError"]);
const health = { lost: false, lastError: null };
function noteFailure(error, fallbackName) {
  const name = typeof error?.name === "string" && error.name ? error.name : fallbackName;
  health.lastError = name || "Error";
  if (LOST_ERRORS.has(name) || name === "close") health.lost = true;
}
/** Tests and reports: whether the last failure was a lost connection, and its error name. */
export function offlineStoreState() { return { ...health }; }

function factory() {
  if (factoryOverride !== undefined) return factoryOverride;
  try { return globalThis.indexedDB || null; } catch { return null; }
}

/** Tests: how long a caller waits on a transaction (ms); undefined restores the default. */
export function setOfflineTransactionTimeout(ms) {
  transactionTimeoutMs = Number(ms) > 0 ? Number(ms) : TRANSACTION_TIMEOUT_MS;
}

/** Tests: how long a transaction may stay unsettled before it has failed (ms); undefined restores the default. */
export function setOfflineTransactionBound(ms) {
  transactionBoundMs = Number(ms) > 0 ? Number(ms) : TRANSACTION_BOUND_MS;
}

/** Tests: use `idb` (an IDBFactory, or null for "unavailable"); undefined restores the global. */
export function setOfflineStoreFactory(idb) {
  factoryOverride = idb;
  unavailableUntil = 0;
  health.lost = false; health.lastError = null;
  const pending = dbPromise;
  dbPromise = null;
  openDbHandle = null;
  running.clear();
  arrived.clear();
  if (pending) pending.then((db) => { try { db?.close(); } catch { /* closed */ } }, () => {});
}

/**
 * Does this browser have IndexedDB at all? False means nothing can ever have
 * been stored there, which is a different answer from "it would not open".
 */
export function offlineStoreSupported() {
  const idb = factory();
  return !!idb && typeof idb.open === "function";
}

export class OfflineStoreUnavailable extends Error {
  constructor() { super("IndexedDB unavailable"); this.name = "OfflineStoreUnavailable"; }
}
/** "Not yet": the transaction is still running past the caller's wait. It is not abandoned. */
export class OfflineStoreBusy extends OfflineStoreUnavailable {
  constructor() { super(); this.name = "OfflineStoreBusy"; this.message = "IndexedDB still working"; }
}
/** A transaction unsettled past TRANSACTION_BOUND_MS: a failure. */
export class OfflineStoreStuck extends OfflineStoreUnavailable {
  constructor() { super(); this.name = "OfflineStoreStuck"; this.message = "IndexedDB transaction never settled"; }
}

function openDb() {
  if (dbPromise) return dbPromise;
  const idb = factory();
  if (!idb || typeof idb.open !== "function") return Promise.resolve(null);
  if (Date.now() < unavailableUntil) return Promise.resolve(null);
  let retryAfter = RETRY_AFTER_MS;
  const attempt = new Promise((resolve) => {
    let settled = false;
    const done = (db) => { if (!settled) { settled = true; resolve(db); } };
    const timer = setTimeout(() => { if (!settled) noteFailure(null, "OpenTimeout"); done(null); }, OPEN_TIMEOUT_MS);
    let req;
    try { req = idb.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION); }
    catch (error) { clearTimeout(timer); noteFailure(error, "OpenThrew"); if (LOST_ERRORS.has(error?.name)) retryAfter = LOST_RETRY_MS; done(null); return; }
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains(OFFLINE_DB_STORE)) db.createObjectStore(OFFLINE_DB_STORE);
      } catch { /* the open then fails and reports unavailable */ }
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      if (settled) { try { db.close(); } catch { /* closed */ } return; }
      // Another tab upgrading the database: let it, and reopen next call.
      db.onversionchange = () => { try { db.close(); } catch { /* closed */ } forget(db); };
      // Closed by the browser (the IndexedDB process went away): the next
      // call opens again (LOST_RETRY_MS).
      db.onclose = () => { noteFailure(null, "close"); forget(db); };
      health.lost = false;
      done(db);
    };
    req.onerror = () => {
      clearTimeout(timer);
      let error = null;
      try { error = req.error; } catch { /* none */ }
      noteFailure(error, "OpenError");
      if (LOST_ERRORS.has(error?.name)) retryAfter = LOST_RETRY_MS;
      done(null);
    };
  });
  dbPromise = attempt;
  attempt.then((db) => {
    if (db) { if (dbPromise === attempt) openDbHandle = db; return; }
    unavailableUntil = Date.now() + retryAfter;
    if (dbPromise === attempt) dbPromise = null;
  });
  return attempt;
}

// A connection that is closing or lost is never handed out again: the next
// call opens a fresh one. WebKit loses the connection of an installed web app
// that was in the background ("Connection to Indexed Database server lost"),
// and every transaction on it then fails while the database itself is fine.
function forget(db) {
  if (db && openDbHandle === db) { openDbHandle = null; dbPromise = null; }
}
function dropConnection(db) {
  forget(db);
  try { db?.close(); } catch { /* closed */ }
}

/** True when IndexedDB opens on this device now (false in some private modes and old browsers). */
export async function offlineStoreAvailable() {
  return !!(await openDb());
}

function isQuota(error) {
  return error?.name === "QuotaExceededError" || error?.code === 22;
}

function run(db, mode, body) {
  return new Promise((resolve, reject) => {
    let tx, result, settled = false, timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    try {
      tx = db.transaction(OFFLINE_DB_STORE, mode);
      const req = body(tx.objectStore(OFFLINE_DB_STORE));
      if (req) req.onsuccess = () => { result = req.result; };
    } catch (error) { noteFailure(error, "TransactionThrew"); reject(error); return; }
    tx.oncomplete = () => finish(resolve, result);
    tx.onerror = () => { noteFailure(tx.error, "TransactionError"); finish(reject, tx.error || new Error("IndexedDB transaction failed")); };
    tx.onabort = () => { noteFailure(tx.error, "TransactionAbort"); finish(reject, tx.error || new Error("IndexedDB transaction aborted")); };
    timer = setTimeout(() => {
      if (settled) return;
      dropConnection(db);
      noteFailure(null, "TransactionTimeout");
      finish(reject, new OfflineStoreStuck());
    }, transactionBoundMs);
    timer?.unref?.();
  });
}

// ─── Transactions still running, per key ──────────────────────────
// The latest transaction begun on each key, until it settles. A read of a key
// while a read of it is running takes that one's answer instead of queueing
// another behind it; anything else waits for it to settle before it begins
// its own, so a slow device is never handed a queue of duplicates (every
// retry of the load used to add another 4 MB read behind the last).
const running = new Map();   // key -> { mode, tag, version, promise, patience, late }
// Every write or delete begun on a key moves its version: a read begun
// before it no longer says what the key holds.
const versions = new Map();  // key -> number
const versionOf = (key) => versions.get(key) || 0;
// A read that landed after every caller had stopped waiting for it, kept for
// the reads of the key with the same version and tag that follow (the
// retry's probe and the load's two reads take the one answer), and dropped
// once unclaimed for the bound: a 4 MB text is not kept for a session that
// never reads the key again. Only a tagged read is kept: IndexedDB tells no
// other tab about a write, so a version moves with this tab's writes alone,
// and the tag (a marker every writer in every tab moves) is all that says
// another tab has not written the key since. Kept untagged, it was taken over
// another tab's newer write and then written back over it.
const arrived = new Map();   // key -> { value, version, tag }
function hold(key, value, version, tag) {
  const done = { value, version, tag };
  arrived.set(key, done);
  const timer = setTimeout(() => { if (arrived.get(key) === done) arrived.delete(key); }, transactionBoundMs);
  timer?.unref?.();
}
let lateListener = null;
/**
 * `fn({ key, mode, ok, value, error })` when a transaction lands or fails
 * after its callers were told "not yet". Its failures are the only failures
 * of such a transaction anyone hears of.
 */
export function setOfflineLateListener(fn) { lateListener = typeof fn === "function" ? fn : null; }

/** Forget a read held for `key` (a purge of it has begun). */
export function forgetOfflineRead(key) { if (key) arrived.delete(key); }

/** Is a transaction on `key` still running? */
export function offlineRunning(key) { return !!key && running.has(key); }

/** Resolves once nothing is running on `key` (at once when nothing is). */
export function offlineIdle(key) {
  const entry = key ? running.get(key) : null;
  return entry ? entry.promise.then(() => offlineIdle(key), () => offlineIdle(key)) : Promise.resolve();
}

// A wait that ends in OfflineStoreBusy after `ms` (never, for Infinity).
function waitLimit(ms) {
  const limit = { timer: null, promise: null };
  limit.promise = ms < Infinity
    ? new Promise((_, reject) => { limit.timer = setTimeout(() => reject(new OfflineStoreBusy()), ms); })
    : new Promise(() => {});
  limit.promise.catch(() => {});
  return limit;
}
const within = (promise, ...limits) => Promise.race([promise, ...limits.map((l) => l.promise)]);

function begin(db, mode, body, key, tag) {
  if (key && mode === "readwrite") { versions.set(key, versionOf(key) + 1); arrived.delete(key); }
  const entry = { mode, tag, version: versionOf(key), late: false, patience: waitLimit(transactionTimeoutMs) };
  entry.promise = run(db, mode, body);
  const settle = (ok, valueOrError) => {
    clearTimeout(entry.patience.timer);
    if (running.get(key) === entry) running.delete(key);
    if (!entry.late) return;
    if (ok && mode === "readonly" && tag != null && entry.version === versionOf(key)) hold(key, valueOrError, entry.version, tag);
    try { lateListener?.({ key, mode, ok, value: ok ? valueOrError : undefined, error: ok ? null : valueOrError }); }
    catch { /* a listener never stops the store */ }
  };
  if (key) {
    running.set(key, entry);
    entry.promise.then((value) => settle(true, value), (error) => settle(false, error));
  }
  return entry;
}

/**
 * One transaction on `key`, on a connection that works. A transaction that
 * fails for anything but space (InvalidStateError on a closing connection,
 * UnknownError on a lost one, an abort) drops the connection and runs once
 * more on a fresh one. `brief` (reads and deletes by default): the caller
 * waits TRANSACTION_TIMEOUT_MS at most, all told, and is then told
 * OfflineStoreBusy while the transaction runs on; otherwise it waits for the
 * transaction to settle, which is at most TRANSACTION_BOUND_MS
 * (OfflineStoreStuck). `tag`: a read joins, or takes the held answer of, a
 * read begun with the same tag only (the caller's account of what the key
 * may hold, such as another tab's write stamp); an untagged read is never
 * held for a later one. `guard` runs synchronously
 * immediately before each transaction is created; false cancels (resolves
 * { cancelled: true }). `retryOpen` gives an open that failed a second try at
 * once instead of waiting out RETRY_AFTER_MS.
 */
async function transact(mode, body, { key = null, tag = null, guard, retryOpen = false, brief = mode === "readonly" } = {}) {
  const limit = waitLimit(brief ? transactionTimeoutMs : Infinity);
  try {
    const held = () => {
      const done = mode === "readonly" && key ? arrived.get(key) : null;
      return done && done.version === versionOf(key) && done.tag === tag ? done : null;
    };
    for (let attempt = 0; ; attempt += 1) {
      let done = held();
      if (done) return { result: done.value };
      for (let before = key ? running.get(key) : null; before; before = running.get(key)) {
        if (mode === "readonly" && before.mode === "readonly" && before.version === versionOf(key) && before.tag === tag) {
          // Its answer is this read's answer. Waited for no longer than that
          // read's own caller was: the second read of a load does not add a
          // second wait to the first screen.
          try { return { result: await within(before.promise, limit, before.patience) }; }
          catch (error) { if (error instanceof OfflineStoreBusy) before.late = true; throw error; }
        }
        try { await within(before.promise, limit); }
        catch (error) { if (error instanceof OfflineStoreBusy) { before.late = true; throw error; } }
        done = held();
        if (done) return { result: done.value };
      }
      let db = await openDb();
      if (!db && retryOpen && attempt === 0 && offlineStoreSupported()) {
        unavailableUntil = 0;
        db = await openDb();
      }
      if (!db) throw new OfflineStoreUnavailable();
      // Another transaction on the key began while this one waited for the
      // connection (two reads made in the same tick): joined, or waited for,
      // as above, never queued behind as a second 4 MB transaction.
      if (key && running.has(key)) { attempt -= 1; continue; }
      if (guard && !guard()) return { cancelled: true };
      const entry = begin(db, mode, body, key, tag);
      try {
        return { result: await within(entry.promise, limit) };
      } catch (error) {
        if (error instanceof OfflineStoreBusy) { entry.late = true; throw error; }
        // A transaction that never settled is not tried again at once.
        if (isQuota(error) || error instanceof OfflineStoreUnavailable || attempt > 0) throw error;
        dropConnection(db);
      }
    }
  } finally { clearTimeout(limit.timer); }
}

/**
 * The text stored under `key`, or null when there is none. Throws
 * OfflineStoreUnavailable when IndexedDB cannot be opened, so a caller can
 * tell "nothing stored" from "could not look", and OfflineStoreBusy when the
 * read is still running past the wait. `retryOpen`, `tag`: see transact.
 */
export async function offlineRead(key, { retryOpen = false, tag = null } = {}) {
  if (!key) return null;
  const { result: value } = await transact("readonly", (store) => store.get(key), { key, tag, retryOpen });
  return typeof value === "string" ? value : null;
}

/**
 * Store `text` under `key`. `guard`, when given, runs synchronously just
 * before the write transaction is created; returning false cancels the write
 * (resolves false). Resolves true once the transaction has committed, however
 * long that takes, or with `brief` throws OfflineStoreBusy past the wait (the
 * write goes on). Throws OfflineStoreUnavailable (OfflineStoreStuck past the
 * bound), or the transaction's error (QuotaExceededError when the device is
 * out of space).
 */
export async function offlineWrite(key, text, { guard, brief = false } = {}) {
  if (!key || typeof text !== "string") return false;
  const { cancelled } = await transact("readwrite", (store) => store.put(text, key), { key, guard, brief });
  return !cancelled;
}

/**
 * Read and rewrite `key` in ONE transaction, so nothing can land between the
 * read and the write. `update(text|null)` returns the new text, null to
 * delete the key, or undefined to leave it as it is. Resolves true once
 * committed (or when there was nothing to change), false when `guard`
 * cancelled it. Throws like offlineWrite; a transaction that fails changes
 * nothing.
 */
export async function offlineUpdate(key, update, { guard, brief = false } = {}) {
  if (!key || typeof update !== "function") return false;
  const { cancelled } = await transact("readwrite", (store) => {
    const req = store.get(key);
    req.onsuccess = () => {
      const next = update(typeof req.result === "string" ? req.result : null);
      if (next === null) store.delete(key);
      else if (typeof next === "string") store.put(next, key);
    };
    return null;
  }, { key, guard, brief });
  return !cancelled;
}

/**
 * Remove `key`. Resolves true when removed (or absent, or when this browser
 * has no IndexedDB at all); false when IndexedDB is unavailable or refused,
 * or still busy with the key past the wait (offlineIdle says when it is not).
 */
export async function offlineRemove(key) {
  if (!key) return true;
  if (!offlineStoreSupported()) return true;
  try {
    await transact("readwrite", (store) => store.delete(key), { key, brief: true });
    return true;
  } catch { return false; }
}

export { isQuota as isQuotaError };
