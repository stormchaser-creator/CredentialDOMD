/**
 * Where the device keeps the invoice hand-off notes (utils/invoiceHandoff.js)
 * and the share stamps still owed to the server: sessionStorage, localStorage
 * and IndexedDB, keyed by the signed-in Clerk user id (the id storageScope
 * keys everything else by, offline or online).
 *
 * Sign out and Delete All My Data remove them with the account's other keys
 * (storageScope purgeUserStorage calls purgeHandoffStores, handed to it by
 * main.jsx); a session that merely ended keeps them, as it keeps the
 * unrecorded-invoice notes. No imports, so the purge never loads the cloud
 * client.
 *
 * The IndexedDB database is this module's own ("credentialdomd-invoice-
 * handoff", version 1), never the storage release's "credentialdomd-offline".
 * iOS has shipped builds whose first indexedDB.open never answers, and WebKit
 * drops the connection of an app left in the background: an open or a
 * transaction that does not answer in time counts as no IndexedDB, and the
 * next one opens afresh.
 *
 * A purge of the IndexedDB entry is recorded (HANDOFF_PURGE_BASE, in
 * localStorage) before it begins and the record stays until IndexedDB has
 * committed it, as the storage release does for its own database
 * (OFFLINE_PURGE_BASE): an open that timed out, or a page reloaded straight
 * after Sign out, never lets the account's old notes be read again. Every
 * read and write of the entry finishes the purge first, and the launch
 * (main.jsx sweepHandoffPurges) finishes those of accounts that never come
 * back.
 */

export const HANDOFF_KEY_BASE = "credentialdomd-invoice-handoff-v1";
export const HANDOFF_STAMPS_BASE = "credentialdomd-invoice-handoff-stamps-v1";
// The numbers whose note was answered (No, Forget it, a repeat's OK) or
// recorded: [{ number, at }]. A note in a store the answer could not reach
// (IndexedDB dropped behind Gmail, a full localStorage) is never shown again
// while its tombstone lasts (2026-10-02: a "No" came back on the next page).
export const HANDOFF_TOMBS_BASE = "credentialdomd-invoice-handoff-tombs-v1";
// Cache Storage holds a copy of the notes, the owed stamps and the
// tombstones: its quota is not localStorage's, and it opens when IndexedDB
// does not (the owner's iPhone, 2026-10-02: localStorage full, IndexedDB not
// opening). The service worker and the update keep it (public/sw.js,
// UpdatePrompt.jsx); Sign out and Delete All My Data remove it.
export const HANDOFF_CACHE_NAME = "credentialdomd-handoff-v1";
export const HANDOFF_DB_NAME = "credentialdomd-invoice-handoff";
// "<account>" -> a nonce, while a purge of that account's IndexedDB entry has
// not committed. Holds no note. Never one of storageScope's BASE_KEYS.
export const HANDOFF_PURGE_BASE = "credentialdomd-invoice-handoff-purge-v1";
// A random value, moved by every purge of hand-off notes on this device (Sign
// out, Delete All My Data), and the value this tab last honored (in its
// sessionStorage). A purge clears the stores and the memory of the tab that
// runs it; another open tab still held the notes in memory and in its own
// sessionStorage, showed "never recorded" for an invoice from before the
// deletion, and its next hand-off wrote them all back. Every tab checks the
// value before it reads or writes a note (syncHandoffGeneration) and, once it
// has moved, starts again from what is stored. One key for the device, never
// named after an account (it outlives Sign out, and would say who used the
// device), so another account's purge also clears this tab's sessionStorage
// copies; localStorage and IndexedDB keep theirs. Holds no note.
export const HANDOFF_GENERATION_KEY = "credentialdomd-handoff-generation-v1";
const GENERATION_SEEN_KEY = "credentialdomd-handoff-generation-seen-v1";
const DB_VERSION = 1;
const STORE = "notes";
const OPEN_TIMEOUT_MS = 4000;
const TRANSACTION_TIMEOUT_MS = 6000;
const waits = { openMs: OPEN_TIMEOUT_MS, txMs: TRANSACTION_TIMEOUT_MS };

/** Tests only: shorter waits for IndexedDB. */
export function _setHandoffStoreTimes(next = {}) {
  waits.openMs = Number(next.openMs) > 0 ? Number(next.openMs) : OPEN_TIMEOUT_MS;
  waits.txMs = Number(next.txMs) > 0 ? Number(next.txMs) : TRANSACTION_TIMEOUT_MS;
}

export const handoffKey = (account) => `${HANDOFF_KEY_BASE}:${account || "signed-out"}`;
const stampsKey = (account) => `${HANDOFF_STAMPS_BASE}:${account || "signed-out"}`;
const tombsKey = (account) => `${HANDOFF_TOMBS_BASE}:${account || "signed-out"}`;
const purgeKey = (account) => `${HANDOFF_PURGE_BASE}:${account || "signed-out"}`;

const webStore = (name) => { try { return globalThis[name] || null; } catch { return null; } };
function readList(name, key) {
  try {
    const raw = webStore(name)?.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function writeList(name, key, list) {
  const store = webStore(name);
  if (!store) return false;
  try {
    if (list.length) store.setItem(key, JSON.stringify(list));
    else store.removeItem(key);
    return true;
  } catch { return false; } // QuotaExceededError on a full device
}
const removeKey = (name, key) => { try { webStore(name)?.removeItem(key); } catch { /* unavailable */ } };

/** The notes `name` ("sessionStorage" or "localStorage") holds for `account`. */
export const readWebNotes = (name, account) => readList(name, handoffKey(account));
/** True when `name` took the list (an empty one removes the key). */
export const writeWebNotes = (name, account, list) => writeList(name, handoffKey(account), list);
/** Cache Storage's copy of the notes (see HANDOFF_CACHE_NAME). */
export const writeCacheNotes = (account, list) => cachePut("notes", account, list);
export const readCacheNotes = async (account) => { const v = await cacheGet("notes", account); return Array.isArray(v) ? v : []; };
export const readCacheTombs = async (account) => { const v = await cacheGet("tombs", account); return Array.isArray(v) ? v : []; };
export const readCacheStamps = async (account) => {
  const v = await cacheGet("stamps", account);
  return v && Array.isArray(v.list) ? { v: String(v.v || ""), list: v.list } : null;
};

// The owed stamps are written as { v, list }: `v` orders the writes, so the
// newest list wins whichever store holds it. A full localStorage keeps an
// older list than sessionStorage (2026-10-02: a share stamp owed only in
// sessionStorage was dropped after a reload, as the older localStorage list
// was read first), and an empty list is written, not removed, so a stamp
// the server took never comes back from an older copy. A plain array (the
// earlier format) counts as the oldest.
let writeCount = 0;
const nextVersion = () => `${String(Date.now()).padStart(15, "0")}-${String(++writeCount).padStart(6, "0")}`;
function readVersioned(name, key) {
  try {
    const raw = webStore(name)?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { v: "", list: parsed };
    if (parsed && Array.isArray(parsed.list)) return { v: String(parsed.v || ""), list: parsed.list };
  } catch { /* unreadable: none */ }
  return null;
}
const seqOf = (s) => String(s?.seq || "").split("-").map(Number);
const newerSeq = (a, b) => { const x = seqOf(a), y = seqOf(b); return (x[0] || 0) !== (y[0] || 0) ? (x[0] || 0) > (y[0] || 0) : (x[1] || 0) > (y[1] || 0); };
/** The newest of several { v, list } copies; copies of the same age are merged, the newest stamp per number. */
export function newestStamps(copies) {
  const have = (copies || []).filter(Boolean);
  if (!have.length) return { v: "", list: [] };
  const top = have.reduce((a, b) => (b.v > a.v ? b : a));
  const same = have.filter(c => c.v === top.v);
  if (same.length === 1) return top;
  const by = new Map();
  for (const c of same) for (const st of c.list || []) {
    const k = String(st?.number || "").trim().toLowerCase();
    if (!k) continue;
    if (!by.has(k) || newerSeq(st, by.get(k))) by.set(k, st);
  }
  return { v: top.v, list: [...by.values()].sort((a, b) => (newerSeq(a, b) ? 1 : -1)) };
}
/** The share stamps not yet confirmed by the server, newest last (the newest copy of sessionStorage and localStorage). */
export function readStamps(account) {
  return newestStamps([readVersioned("sessionStorage", stampsKey(account)), readVersioned("localStorage", stampsKey(account))]).list;
}
/** The copy readStamps chose, with its version (for Cache Storage). */
export function readStampsCopy(account) {
  return newestStamps([readVersioned("sessionStorage", stampsKey(account)), readVersioned("localStorage", stampsKey(account))]);
}
export function writeStamps(account, list) {
  const copy = { v: nextVersion(), list };
  const value = JSON.stringify(copy);
  const put = (name) => { const st = webStore(name); if (!st) return false; try { st.setItem(stampsKey(account), value); return true; } catch { return false; } };
  const session = put("sessionStorage");
  const local = put("localStorage");
  cachePut("stamps", account, copy);
  return session || local;
}

// ── Tombstones ──
/** The numbers answered or recorded on this device: [{ number, at }], newest per number, from both web stores. */
export function readTombs(account) {
  const by = new Map();
  for (const name of ["sessionStorage", "localStorage"]) {
    for (const t of readList(name, tombsKey(account))) {
      const k = String(t?.number || "").trim().toLowerCase();
      if (!k) continue;
      if (!by.has(k) || String(t.at || "") > String(by.get(k).at || "")) by.set(k, t);
    }
  }
  return [...by.values()];
}
/** Both web stores (and Cache Storage) get the list; true when one of the web stores took it. */
export function writeTombs(account, list) {
  const session = writeList("sessionStorage", tombsKey(account), list);
  const local = writeList("localStorage", tombsKey(account), list);
  cachePut("tombs", account, list);
  return session || local;
}

// ── Cache Storage (HANDOFF_CACHE_NAME) ──
// Keys are URLs on a host that is never fetched; each holds one JSON value.
const cacheUrl = (kind, account) => `https://handoff.credentialdomd.invalid/${kind}/${encodeURIComponent(account || "signed-out")}`;
const cacheApi = () => { try { const c = globalThis.caches; return c && typeof c.open === "function" ? c : null; } catch { return null; } };
const cacheWrites = new Map();
// One operation at a time per key, in the order asked: a purge never lands
// before a write it follows.
function cacheChain(url, op) {
  const run = (cacheWrites.get(url) || Promise.resolve()).then(op, op);
  cacheWrites.set(url, run);
  run.then(() => { if (cacheWrites.get(url) === run) cacheWrites.delete(url); });
  return run;
}
/** Writes `value` (JSON) under `kind` for `account`. Resolves true when stored. */
export function cachePut(kind, account, value) {
  const api = cacheApi();
  if (!api || typeof globalThis.Response !== "function") return Promise.resolve(false);
  const url = cacheUrl(kind, account);
  const body = JSON.stringify(value);
  return cacheChain(url, async () => {
    try {
      const cache = await api.open(HANDOFF_CACHE_NAME);
      await cache.put(url, new Response(body, { headers: { "content-type": "application/json" } }));
      return true;
    } catch { return false; }
  });
}
/** The JSON value under `kind` for `account`, or null. Waits for writes still on their way. */
export async function cacheGet(kind, account) {
  const api = cacheApi();
  if (!api) return null;
  const url = cacheUrl(kind, account);
  try { await cacheWrites.get(url); } catch { /* read anyway */ }
  try {
    const cache = await api.open(HANDOFF_CACHE_NAME);
    const hit = await cache.match(url);
    return hit ? await hit.json() : null;
  } catch { return null; }
}
/** Removes `account`'s entries (Sign out, Delete All My Data), after any write still on its way. */
function cachePurge(account) {
  const api = cacheApi();
  if (!api) return Promise.resolve();
  return Promise.all(["notes", "stamps", "tombs"].map((k) => {
    const url = cacheUrl(k, account);
    return cacheChain(url, async () => {
      try { const cache = await api.open(HANDOFF_CACHE_NAME); await cache.delete(url); } catch { /* the next purge */ }
    });
  })).then(() => {});
}


const readItem = (name, key) => { try { return webStore(name)?.getItem(key) ?? null; } catch { return null; } };
/** The device's purge generation now (null before any purge). */
export const handoffGeneration = () => readItem("localStorage", HANDOFF_GENERATION_KEY);

/**
 * This tab's sessionStorage catches up with the device's purges: notes and
 * stamps kept there under an older generation are removed (they would
 * otherwise survive a reload of this tab). Returns the generation now.
 */
export function syncHandoffGeneration() {
  const now = handoffGeneration();
  const session = webStore("sessionStorage");
  if (!session) return now;
  if (readItem("sessionStorage", GENERATION_SEEN_KEY) === now) return now;
  try {
    for (let i = (session.length || 0) - 1; i >= 0; i -= 1) {
      const k = session.key(i);
      if (k && (k.startsWith(`${HANDOFF_KEY_BASE}:`) || k.startsWith(`${HANDOFF_STAMPS_BASE}:`) || k.startsWith(`${HANDOFF_TOMBS_BASE}:`))) session.removeItem(k);
    }
    if (now == null) session.removeItem(GENERATION_SEEN_KEY);
    else session.setItem(GENERATION_SEEN_KEY, now);
  } catch { /* unavailable: checked again next time */ }
  return now;
}

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  let idb = null;
  try { idb = globalThis.indexedDB || null; } catch { idb = null; }
  if (!idb) return Promise.resolve(null);
  const opening = new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (db) => {
      if (settled) { try { db?.close?.(); } catch { /* gone */ } return; }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    timer = setTimeout(() => done(null), waits.openMs);
    timer?.unref?.();
    let req;
    try { req = idb.open(HANDOFF_DB_NAME, DB_VERSION); } catch { done(null); return; }
    req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch { /* already there */ } };
    req.onsuccess = () => {
      const db = req.result;
      try {
        db.onclose = () => { if (dbPromise === opening) dbPromise = null; };
        db.onversionchange = () => { try { db.close(); } catch { /* gone */ } if (dbPromise === opening) dbPromise = null; };
      } catch { /* a database without the handlers */ }
      done(db);
    };
    req.onerror = () => done(null);
    req.onblocked = () => done(null);
  });
  dbPromise = opening;
  opening.then((db) => { if (!db && dbPromise === opening) dbPromise = null; });
  return opening;
}

// One request on the store: `run(store, finish)` calls finish(value). A
// transaction that throws (a lost connection) or does not answer in time
// gives `fallback`, and the next request opens the database again.
async function request(mode, fallback, run) {
  const db = await openDb();
  if (!db) return fallback;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const lost = () => { dbPromise = null; finish(fallback); };
    timer = setTimeout(lost, waits.txMs);
    timer?.unref?.();
    try {
      const tx = db.transaction(STORE, mode);
      run(tx, tx.objectStore(STORE), finish);
    } catch { lost(); }
  });
}

// The purge still owed for `account` (its record's value), or null.
const owedPurge = (account) => { try { return webStore("localStorage")?.getItem(purgeKey(account)) ?? null; } catch { return null; } };
// Removed only while it is still the record `raw`: a newer purge keeps its own.
function clearPurge(account, raw) {
  try { const ls = webStore("localStorage"); if (ls?.getItem(purgeKey(account)) === raw) ls.removeItem(purgeKey(account)); } catch { /* the next read finishes it */ }
}
// Delete the entry; the record goes once that commits. True when committed.
// The record is checked again inside the transaction, after every earlier
// write of the entry has committed: a note written in between (signed in
// again, a hand-off) completed the purge itself, and is never deleted.
// `unrecorded`: the record `raw` could never be kept (a full or blocked
// localStorage), so no write can have cleared it; the entry goes unless a
// newer purge recorded its own, which finishes it.
function finishPurge(account, raw, { unrecorded = false } = {}) {
  return request("readwrite", false, (tx, store, finish) => {
    const key = handoffKey(account);
    tx.oncomplete = () => { clearPurge(account, raw); finish(true); };
    tx.onerror = () => finish(false);
    tx.onabort = () => finish(false);
    const req = store.get(key);
    req.onsuccess = () => {
      const owed = owedPurge(account);
      if (owed === raw || (unrecorded && owed == null)) store.delete(key);
    };
    req.onerror = () => { try { tx.abort(); } catch { finish(false); } };
  });
}

function readEntry(account) {
  return request("readonly", [], (tx, store, finish) => {
    const req = store.get(handoffKey(account));
    req.onsuccess = () => finish(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => finish([]);
  });
}

/** What IndexedDB holds for `account` ([] when it cannot be read, or a purge of it is still owed). */
export function readDbNotes(account) {
  // A purge still owed: what is there predates it and is never read. Once
  // it is done (or a write completed it first), what is there now is read.
  const raw = owedPurge(account);
  if (raw != null) return finishPurge(account, raw).then(() => (owedPurge(account) == null ? readEntry(account) : []));
  return readEntry(account);
}

/**
 * True once IndexedDB has the list (an empty one removes the entry). With
 * `combine(stored)`, the list written is what it returns for the list stored
 * now, read in the same transaction: a page whose first read of IndexedDB
 * timed out never knew that list, and a blind put would erase notes kept
 * only there (a full localStorage, a sessionStorage gone with the page).
 */
export function writeDbNotes(account, list, combine = null) {
  // A purge still owed: what is stored is the purged account's, never merged
  // in. The list replaces it, and that completes the purge.
  const raw = owedPurge(account);
  if (raw != null) combine = null;
  return request("readwrite", false, (tx, store, finish) => {
    const key = handoffKey(account);
    const write = (next) => { if (next.length) store.put(next, key); else store.delete(key); };
    tx.oncomplete = () => { if (raw != null) clearPurge(account, raw); finish(true); };
    tx.onerror = () => finish(false);
    tx.onabort = () => finish(false);
    if (typeof combine !== "function") { write(list); return; }
    const req = store.get(key);
    req.onsuccess = () => {
      let next = list;
      try { next = combine(Array.isArray(req.result) ? req.result : []); } catch { next = list; }
      write(Array.isArray(next) ? next : list);
    };
    req.onerror = () => { try { tx.abort(); } catch { finish(false); } };
  });
}

const purgeListeners = new Set();
/** `fn(account)` runs when the account's notes are purged. Returns the unsubscribe. */
export function onHandoffPurge(fn) {
  purgeListeners.add(fn);
  return () => purgeListeners.delete(fn);
}

/**
 * Sign out and Delete All My Data (storageScope purgeUserStorage): the
 * account's notes and owed stamps leave every store, and this page's memory
 * of them; every other open tab drops its own (HANDOFF_GENERATION_KEY). The web stores go, and the IndexedDB purge is recorded, before
 * this returns; the entry itself goes when IndexedDB commits. Resolves true
 * when the purge is durable: committed, or recorded to be finished before
 * the entry is read again. False only when IndexedDB refused and not even
 * the record could be kept.
 */
export function purgeHandoffStores(account) {
  if (!account) return Promise.resolve(false);
  syncHandoffGeneration();
  for (const name of ["sessionStorage", "localStorage"]) {
    removeKey(name, handoffKey(account));
    removeKey(name, stampsKey(account));
    removeKey(name, tombsKey(account));
  }
  cachePurge(account);
  // Every other open tab drops what it holds (its memory, its sessionStorage).
  // After the removals above, so a full localStorage has room for it.
  const generation = `${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
  try { webStore("localStorage")?.setItem(HANDOFF_GENERATION_KEY, generation); } catch { /* full or blocked: this tab still purges */ }
  syncHandoffGeneration();
  for (const fn of [...purgeListeners]) { try { fn(account); } catch { /* a listener never stops the purge */ } }
  const raw = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  let recorded = false;
  try {
    const ls = webStore("localStorage");
    ls?.setItem(purgeKey(account), raw);
    recorded = ls?.getItem(purgeKey(account)) === raw;
  } catch { recorded = false; }
  return finishPurge(account, raw, { unrecorded: !recorded }).then((done) => done || recorded);
}

/**
 * At launch (main.jsx), signed in or not: purges an earlier page recorded and
 * IndexedDB did not commit (it would not open, or the page reloaded first)
 * are finished now, so a signed-out account's notes do not wait for it.
 */
export async function sweepHandoffPurges() {
  const prefix = `${HANDOFF_PURGE_BASE}:`;
  const pending = [];
  try {
    const ls = webStore("localStorage");
    for (let i = 0; i < (ls?.length || 0); i += 1) {
      const k = ls.key(i);
      if (k && k.startsWith(prefix)) pending.push(k.slice(prefix.length));
    }
  } catch { return; }
  // Each record is read again just before its purge: one an earlier purge's
  // slow open let a write complete meanwhile is not owed any more.
  for (const account of pending) {
    const raw = owedPurge(account);
    if (raw == null) continue;
    try { await finishPurge(account, raw); } catch { /* next launch */ }
  }
}

/** Tests only: a new page (the connection is opened again). */
export function _resetHandoffStore() {
  dbPromise = null;
  cacheWrites.clear();
}
