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
// How long a brief call (a read, the load's wait) waits on an
// indexedDB.open: past it a read is told "not yet" (OfflineStoreBusy) and a
// brief write "unavailable", so its fallback runs (openWaited). The open
// itself is left to answer, and the connection it brings is the next call's;
// a fresh open may begin beside it (openDb). Taken for a failure, a slow open
// left the copy unread and reported "Offline copy not saved" while the
// device was working (b1071b82 review). Only an open that errors or throws,
// or has not answered in TRANSACTION_BOUND_MS, has failed.
const OPEN_TIMEOUT_MS = 4000;
let openTimeoutMs = OPEN_TIMEOUT_MS;
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
// A connection with transactions running on which none has settled for this
// long has failed (OfflineStoreStuck): the store is broken, not slow. Every
// transaction still on it fails, the connection is dropped and the next call
// opens a fresh one. So has one transaction that has not settled this long
// after its turn came (the transactions created before it on the connection
// had settled), while others around it settle. Measured from the last one that settled, not from when
// each was created: IndexedDB runs them one after another, and the time one
// spends queued behind the others is not time it was stuck (at 65 seconds a
// transaction, the file's read queued behind a large transcript and archives
// was taken for stuck at 186 seconds while every transaction was landing).
const TRANSACTION_BOUND_MS = 3 * 60 * 1000;
let transactionBoundMs = TRANSACTION_BOUND_MS;

// One wait shared by several calls (`wait`, from offlineWait): the load reads
// the transcript, the archives and the file, twice, and the first screen
// waits on all of it. Each call with a wait of its own held it for one
// TRANSACTION_TIMEOUT_MS per call (18 seconds with all three large, 12 for a
// device just under the wait). Measured on the monotonic clock, as the
// timers are.
const clock = () => (typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now());
/** A wait of `ms` (TRANSACTION_TIMEOUT_MS when undefined) from now, for the brief calls given it. */
export function offlineWait(ms) {
  return { until: clock() + (Number(ms) >= 0 ? Number(ms) : transactionTimeoutMs) };
}
/** What is left of `wait` (ms, never below 0). */
export function offlineWaitLeft(wait) {
  return wait ? Math.max(0, wait.until - clock()) : transactionTimeoutMs;
}

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

/** Tests: how long a connection may go with no transaction settling, or one transaction past its turn, before failing (ms); undefined restores the default. */
export function setOfflineTransactionBound(ms) {
  transactionBoundMs = Number(ms) > 0 ? Number(ms) : TRANSACTION_BOUND_MS;
}

/** Tests: how long an open may go unanswered before it counts as failed (ms); undefined restores the default. */
export function setOfflineOpenTimeout(ms) {
  openTimeoutMs = Number(ms) > 0 ? Number(ms) : OPEN_TIMEOUT_MS;
}

/** Tests: use `idb` (an IDBFactory, or null for "unavailable"); undefined restores the global. */
export function setOfflineStoreFactory(idb) {
  factoryOverride = idb;
  openEpoch += 1;
  hungSince = null;
  ready = deferred();
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
/** A transaction unsettled TRANSACTION_BOUND_MS after its turn, or on a connection where none settled for that long: a failure. */
export class OfflineStoreStuck extends OfflineStoreUnavailable {
  constructor() { super(); this.name = "OfflineStoreStuck"; this.message = "IndexedDB transaction never settled"; }
}

// The open the store waits on (dbPromise) may still be unanswered past its
// patience (OPEN_TIMEOUT_MS): it is left to answer, and a fresh open may be
// begun beside it (the load's `retryOpen` at once, any call once
// RETRY_AFTER_MS has gone by), since iOS has shipped builds whose first open
// never answers while a second one does. Whichever answers first is the
// connection, handed to every caller still waiting on either (`ready`); one
// that answers after it is closed. An open fails only when it errors, throws
// or has not answered in TRANSACTION_BOUND_MS, and only the open the store
// is waiting on speaks for it: one superseded, or begun for another factory
// (openEpoch), says nothing.
let openEpoch = 0;
// When the first open still unanswered began, with no open answering since:
// every open in the streak fails at TRANSACTION_BOUND_MS from it. Timed per
// open, each fresh one started the bound again, and with calls coming every
// few seconds no open ever failed, so an IndexedDB that never opens was
// never reported (second b1071b82 review). Once a streak has gone past the
// bound, the IndexedDB has had its minutes: each open after it, until one
// answers, has OPEN_TIMEOUT_MS to answer and is waited for that long (no
// "not yet"), as every open was before ticket b1071b82.
let hungSince = null;
const openMeta = new WeakMap();   // open attempt -> { began, answered, stale, patience }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
let ready = deferred();
function openDb({ fresh = false } = {}) {
  if (dbPromise) {
    const meta = openMeta.get(dbPromise);
    if (!meta || meta.answered || !meta.stale) return dbPromise;
    if (!fresh && Date.now() - meta.began < RETRY_AFTER_MS) return dbPromise;
  }
  const idb = factory();
  if (!idb || typeof idb.open !== "function") return Promise.resolve(null);
  if (!dbPromise && Date.now() < unavailableUntil) return Promise.resolve(null);
  const epoch = openEpoch;
  hungSince ??= Date.now();
  const expired = Date.now() >= hungSince + transactionBoundMs;
  const deadline = expired ? Date.now() + openTimeoutMs : hungSince + transactionBoundMs;
  const meta = { began: Date.now(), answered: false, stale: false, expired, patience: waitLimit(expired ? Infinity : openTimeoutMs) };
  meta.patience.promise.catch(() => { meta.stale = true; });
  let failure = null;   // { error, name, retryAfter }
  let attempt = null;
  attempt = new Promise((resolve) => {
    let settled = false;
    let bound = null;
    const done = (db) => {
      if (settled) return;
      settled = true;
      meta.answered = true;
      clearTimeout(bound);
      clearTimeout(meta.patience.timer);
      resolve(db);
    };
    const fail = (error, name) => {
      if (settled) return;
      failure = { error, name, retryAfter: LOST_ERRORS.has(error?.name) ? LOST_RETRY_MS : RETRY_AFTER_MS };
      done(null);
    };
    bound = setTimeout(() => fail(null, "OpenTimeout"), Math.max(0, deadline - Date.now()));
    bound?.unref?.();
    let req;
    try { req = idb.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION); }
    catch (error) { fail(error, "OpenThrew"); return; }
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains(OFFLINE_DB_STORE)) db.createObjectStore(OFFLINE_DB_STORE);
      } catch { /* the open then fails and reports unavailable */ }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another open answered first, or this one belongs to another factory.
      if (epoch !== openEpoch || openDbHandle) {
        try { db.close(); } catch { /* closed */ }
        done(epoch === openEpoch ? openDbHandle : null);
        return;
      }
      // Another tab upgrading the database: let it, and reopen next call.
      db.onversionchange = () => { try { db.close(); } catch { /* closed */ } forget(db); };
      // Closed by the browser (the IndexedDB process went away): the next
      // call opens again (LOST_RETRY_MS).
      db.onclose = () => { noteFailure(null, "close"); forget(db); };
      health.lost = false;
      hungSince = null;
      openDbHandle = db;
      if (settled) {
        // Answered after it was taken for failed (its bound, or the open
        // timeout once a streak had expired) and no connection is held: the
        // device is slow, not broken, so the connection is kept. Closed, a
        // device whose opens take longer than the open timeout never
        // recovered (final b1071b82 review).
        dbPromise = Promise.resolve(db);
        unavailableUntil = 0;
      } else dbPromise = attempt;
      ready.resolve(db);
      done(db);
    };
    req.onerror = () => {
      let error = null;
      try { error = req.error; } catch { /* none */ }
      fail(error, "OpenError");
    };
  });
  openMeta.set(attempt, meta);
  dbPromise = attempt;
  attempt.then((db) => {
    if (db || !failure || epoch !== openEpoch || dbPromise !== attempt) return;
    // An error of the open the store waits on is an answer, not a hang: it
    // ends the streak (hungSince), and the next open has the whole bound
    // again. One from an open already superseded says nothing, or opens
    // that each error after the open timeout, superseded before they do,
    // never reached the bound.
    if (failure.name !== "OpenTimeout") hungSince = null;
    noteFailure(failure.error, failure.name);
    unavailableUntil = Date.now() + failure.retryAfter;
    dbPromise = null;
  });
  return attempt;
}
/**
 * The connection (null when IndexedDB is unavailable), waited for no longer
 * than `limit`, and by a `brief` call no longer than the open's patience
 * (OPEN_TIMEOUT_MS from its start). A read waited for no longer is told "not
 * yet" (OfflineStoreBusy) and the open runs on for the next call. A write is
 * told "unavailable": no transaction of it has begun, so nothing would land
 * later, and the caller's fallback (localStorage) must run. Told "not yet"
 * here, a save was written nowhere (b1071b82 review).
 */
async function openWaited(limit, { brief = true, mode = "readonly", fresh = false } = {}) {
  const attempt = openDb({ fresh });
  const meta = openMeta.get(attempt);
  const limits = brief && meta && !meta.answered ? [limit, meta.patience] : [limit];
  // A save waiting it out starts a fresh open beside one past its patience,
  // as the load's retry does: left to the next call, a save on a hung open
  // waited the whole bound when nothing else called.
  if (!brief && meta && !meta.answered) meta.patience.promise.catch(() => { if (!meta.answered) openDb({ fresh: true }); });
  try { return await within(Promise.race([attempt, ready.promise]), ...limits); }
  catch (error) {
    if (error instanceof OfflineStoreBusy && mode !== "readonly") throw new OfflineStoreUnavailable();
    throw error;
  }
}

// A connection that is closing or lost is never handed out again: the next
// call opens a fresh one. WebKit loses the connection of an installed web app
// that was in the background ("Connection to Indexed Database server lost"),
// and every transaction on it then fails while the database itself is fine.
function forget(db) {
  if (db && openDbHandle === db) { openDbHandle = null; dbPromise = null; ready = deferred(); }
}
function dropConnection(db) {
  forget(db);
  try { db?.close(); } catch { /* closed */ }
}

/** True when IndexedDB opens on this device now (false in some private modes and old browsers). */
export async function offlineStoreAvailable() {
  try { return !!(await openWaited(waitLimit(Infinity))); } catch { return false; }
}

function isQuota(error) {
  return error?.name === "QuotaExceededError" || error?.code === 22;
}

// The transactions still unsettled on each connection, in the order they
// were created, and the bound running since the last of them settled
// (TRANSACTION_BOUND_MS). Each one also has a bound of its own, from its
// turn: when every transaction created before it on the connection has
// settled, so time spent queued is never counted. Without it, one transaction
// that never settled went unbounded while the others kept settling around it.
const watches = new WeakMap();   // db -> { pending: [{ fail, timer }], timer }
function watchOf(db) {
  let watch = watches.get(db);
  if (!watch) { watch = { pending: [], timer: null }; watches.set(db, watch); }
  return watch;
}
function stuck(db, failing) {
  dropConnection(db);
  noteFailure(null, "TransactionTimeout");
  for (const t of failing) t.fail();
}
// The bound starts again: a transaction settled, or one began on an idle
// connection. The first transaction still unsettled has its turn from now.
function rearm(db, watch) {
  clearTimeout(watch.timer);
  watch.timer = null;
  if (!watch.pending.length) return;
  watch.timer = setTimeout(() => {
    watch.timer = null;
    if (watch.pending.length) stuck(db, [...watch.pending]);
  }, transactionBoundMs);
  watch.timer?.unref?.();
  const first = watch.pending[0];
  if (first.timer) return;
  first.timer = setTimeout(() => { if (watch.pending.includes(first)) stuck(db, [first]); }, transactionBoundMs);
  first.timer?.unref?.();
}

function run(db, mode, body) {
  return new Promise((resolve, reject) => {
    let tx, result, settled = false;
    const watch = watchOf(db);
    const self = { fail: () => finish(reject, new OfflineStoreStuck()), timer: null };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(self.timer);
      const at = watch.pending.indexOf(self);
      if (at >= 0) watch.pending.splice(at, 1);
      rearm(db, watch);
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
    watch.pending.push(self);
    if (watch.pending.length === 1) rearm(db, watch);
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
 * transaction to settle, or for TRANSACTION_BOUND_MS from its turn or with
 * none on the connection settling (OfflineStoreStuck). A brief call waits on
 * the open as well no longer than that. `wait` (offlineWait): a brief call waits no longer
 * than what is left of it, so the calls given one wait share it; with none
 * left, the transaction is still begun and runs on as above. `tag`: a read joins, or takes the held answer of, a
 * read begun with the same tag only (the caller's account of what the key
 * may hold, such as another tab's write stamp); an untagged read is never
 * held for a later one. `guard` runs synchronously
 * immediately before each transaction is created; false cancels (resolves
 * { cancelled: true }). `retryOpen` gives an open that failed a second try at
 * once instead of waiting out RETRY_AFTER_MS.
 */
async function transact(mode, body, { key = null, tag = null, guard, retryOpen = false, brief = mode === "readonly", wait = null } = {}) {
  const limit = waitLimit(brief ? Math.min(transactionTimeoutMs, wait ? offlineWaitLeft(wait) : Infinity) : Infinity);
  try {
    const held = () => {
      const done = mode === "readonly" && key ? arrived.get(key) : null;
      return done && done.version === versionOf(key) && done.tag === tag ? done : null;
    };
    let dropped = false;
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
      // An open still unanswered is waited for no longer than the call (a
      // brief one: the load's wait) nor than OPEN_TIMEOUT_MS, and is then
      // "not yet" (OfflineStoreBusy): it runs on, and the connection it
      // brings is the next call's. Waited for in full, it held the first
      // screen for the open timeout, twice with `retryOpen`; taken for a
      // failure, it left the copy unread on a device that was only slow.
      // The retry after a connection this call dropped opens again even
      // inside the backoff of an open that failed meanwhile (another
      // transaction's retry on the same connection): handed null untried,
      // the write was refused as unavailable while IndexedDB would open
      // (the owner's iPhone, 2026-10-31, ticket b1071b82: "indexeddb_unavailable"
      // with the abort as the last error on record).
      if (dropped) unavailableUntil = 0;
      let db;
      try { db = await openWaited(limit, { brief, mode }); }
      catch (error) {
        // The load's first try, on an open unanswered past its patience: a
        // fresh open beside it, as one that failed is tried again at once.
        if (!(retryOpen && attempt === 0 && error instanceof OfflineStoreBusy)) throw error;
        db = await openWaited(limit, { brief, mode, fresh: true });
      }
      if (!db && retryOpen && attempt === 0 && offlineStoreSupported()) {
        unavailableUntil = 0;
        db = await openWaited(limit, { brief, mode });
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
        dropped = true;
      }
    }
  } finally { clearTimeout(limit.timer); }
}

/**
 * The text stored under `key`, or null when there is none. Throws
 * OfflineStoreUnavailable when IndexedDB cannot be opened, so a caller can
 * tell "nothing stored" from "could not look", and OfflineStoreBusy when the
 * read is still running past the wait. `retryOpen`, `tag`, `wait`: see transact.
 */
export async function offlineRead(key, { retryOpen = false, tag = null, wait = null } = {}) {
  if (!key) return null;
  const { result: value } = await transact("readonly", (store) => store.get(key), { key, tag, retryOpen, wait });
  return typeof value === "string" ? value : null;
}

/**
 * Store `text` under `key`. `guard`, when given, runs synchronously just
 * before the write transaction is created; returning false cancels the write
 * (resolves false). Resolves true once the transaction has committed, however
 * long that takes, or with `brief` throws OfflineStoreBusy past the wait, or
 * past what is left of `wait` (the write goes on). Throws OfflineStoreUnavailable (OfflineStoreStuck past the
 * bound), or the transaction's error (QuotaExceededError when the device is
 * out of space).
 */
export async function offlineWrite(key, text, { guard, brief = false, wait = null } = {}) {
  if (!key || typeof text !== "string") return false;
  const { cancelled } = await transact("readwrite", (store) => store.put(text, key), { key, guard, brief, wait });
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
export async function offlineUpdate(key, update, { guard, brief = false, wait = null } = {}) {
  if (!key || typeof update !== "function") return false;
  const { cancelled } = await transact("readwrite", (store) => {
    const req = store.get(key);
    req.onsuccess = () => {
      const next = update(typeof req.result === "string" ? req.result : null);
      if (next === null) store.delete(key);
      else if (typeof next === "string") store.put(next, key);
    };
    return null;
  }, { key, guard, brief, wait });
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
