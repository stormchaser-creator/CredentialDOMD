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
// The same failure one step later: a connection that opened, and a
// transaction on it that never completes, errors or aborts. Everything that
// waits on the store waits on its transactions (the load, Sign out, every
// purge), and none of them could hang on localStorage before. Past this the
// transaction counts as unavailable, the connection is dropped, and the
// store is answered "unavailable" for RETRY_AFTER_MS. A transaction that
// commits after all changes nothing about that: transactions run in the
// order they were created, so a purge recorded meanwhile runs after it.
const TRANSACTION_TIMEOUT_MS = 6000;
let transactionTimeoutMs = TRANSACTION_TIMEOUT_MS;

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

/** Tests: how long a transaction may take (ms); undefined restores the default. */
export function setOfflineTransactionTimeout(ms) {
  transactionTimeoutMs = Number(ms) > 0 ? Number(ms) : TRANSACTION_TIMEOUT_MS;
}

/** Tests: use `idb` (an IDBFactory, or null for "unavailable"); undefined restores the global. */
export function setOfflineStoreFactory(idb) {
  factoryOverride = idb;
  unavailableUntil = 0;
  health.lost = false; health.lastError = null;
  const pending = dbPromise;
  dbPromise = null;
  openDbHandle = null;
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
      unavailableUntil = Date.now() + RETRY_AFTER_MS;
      finish(reject, new OfflineStoreUnavailable());
    }, transactionTimeoutMs);
  });
}

/**
 * One transaction, on a connection that works. A transaction that fails for
 * anything but space (InvalidStateError on a closing connection, UnknownError
 * on a lost one, an abort) drops the connection and runs once more on a fresh
 * one. A transaction that does not answer within TRANSACTION_TIMEOUT_MS
 * throws OfflineStoreUnavailable, as an open that does not answer does.
 * `guard` runs synchronously immediately before each transaction is
 * created; false cancels (resolves { cancelled: true }). `retryOpen` gives an
 * open that failed a second try at once instead of waiting out RETRY_AFTER_MS.
 */
async function transact(mode, body, { guard, retryOpen = false } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let db = await openDb();
    if (!db && retryOpen && attempt === 0 && offlineStoreSupported()) {
      unavailableUntil = 0;
      db = await openDb();
    }
    if (!db) throw new OfflineStoreUnavailable();
    if (guard && !guard()) return { cancelled: true };
    try {
      return { result: await run(db, mode, body) };
    } catch (error) {
      // A transaction that never answered is not tried again at once.
      if (isQuota(error) || error instanceof OfflineStoreUnavailable || attempt > 0) throw error;
      dropConnection(db);
    }
  }
}

/**
 * The text stored under `key`, or null when there is none. Throws
 * OfflineStoreUnavailable when IndexedDB cannot be opened, so a caller can
 * tell "nothing stored" from "could not look". `retryOpen`: see transact.
 */
export async function offlineRead(key, { retryOpen = false } = {}) {
  if (!key) return null;
  const { result: value } = await transact("readonly", (store) => store.get(key), { retryOpen });
  return typeof value === "string" ? value : null;
}

/**
 * Store `text` under `key`. `guard`, when given, runs synchronously just
 * before the write transaction is created; returning false cancels the write
 * (resolves false). Resolves true once the transaction has committed. Throws
 * OfflineStoreUnavailable, or the transaction's error (QuotaExceededError
 * when the device is out of space).
 */
export async function offlineWrite(key, text, { guard } = {}) {
  if (!key || typeof text !== "string") return false;
  const { cancelled } = await transact("readwrite", (store) => store.put(text, key), { guard });
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
export async function offlineUpdate(key, update, { guard } = {}) {
  if (!key || typeof update !== "function") return false;
  const { cancelled } = await transact("readwrite", (store) => {
    const req = store.get(key);
    req.onsuccess = () => {
      const next = update(typeof req.result === "string" ? req.result : null);
      if (next === null) store.delete(key);
      else if (typeof next === "string") store.put(next, key);
    };
    return null;
  }, { guard });
  return !cancelled;
}

/**
 * Remove `key`. Resolves true when removed (or absent, or when this browser
 * has no IndexedDB at all); false when IndexedDB is unavailable or refused.
 */
export async function offlineRemove(key) {
  if (!key) return true;
  if (!offlineStoreSupported()) return true;
  try {
    await transact("readwrite", (store) => store.delete(key));
    return true;
  } catch { return false; }
}

export { isQuota as isQuotaError };
