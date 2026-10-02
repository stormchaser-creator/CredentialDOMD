/**
 * What the server says is billed, learned after this page read the account
 * (2026-10-02, the owner's iPhone): a page loaded before the Mac recorded
 * INV-A kept INV-A's days unbilled in its copy, offered them again, and a
 * second invoice (INV-C) billed the same twelve days.
 *
 * Every server answer about billing (the picker's check, the preview's
 * check, Yes, Record as sent, Email it for me) is kept here, per collection
 * ("dutyDays", "workLog", "travelExpenses"): row id to the number of the
 * invoice that bills it (null when the server did not say which). The
 * screens leave those rows out of what they offer, as billed, until the
 * account is read again (AppContext clears this after every load, which then
 * holds the same answer in the copy itself). A request to read it again goes
 * to AppContext's quiet read (setRecordsRefresher): an installed iPhone app
 * has no reload button.
 *
 * Pure apart from its own module state; no imports.
 */

// collection -> Map(id -> { number, at }), and the id -> number view the
// screens read (rebuilt on every change, so a changed Map is a new object).
const store = new Map();
const views = new Map();
const listeners = new Set();
const EMPTY = new Map();
let refresher = null;

const emit = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* a listener never stops the others */ } } };
const rebuild = (collection) => {
  const rows = store.get(collection);
  if (!rows || !rows.size) { store.delete(collection); views.delete(collection); return; }
  views.set(collection, new Map([...rows].map(([id, v]) => [id, v.number])));
};

/**
 * The server says the rows in `billedOn` ({ id: number|null }, or an array of
 * ids) of `collection` are on an invoice. True when something new was learned.
 */
export function noteServerBilled(collection, billedOn) {
  if (!collection || !billedOn) return false;
  const entries = Array.isArray(billedOn) ? billedOn.map(id => [id, null]) : Object.entries(billedOn);
  if (!entries.length) return false;
  const rows = new Map(store.get(collection) || []);
  const at = Date.now();
  let changed = false;
  for (const [id, number] of entries) {
    if (!id) continue;
    const key = String(id);
    const n = number ? String(number) : null;
    const had = rows.get(key);
    if (had && (had.number === n || !n)) { rows.set(key, { ...had, at }); continue; }
    rows.set(key, { number: n, at });
    changed = true;
  }
  store.set(collection, rows);
  rebuild(collection);
  if (changed) emit();
  return changed;
}

/** Row id to the invoice number the server says bills it (null: not said), for `collection`. */
export const serverBilledIn = (collection) => views.get(collection) || EMPTY;

/** True when the server said row `id` of `collection` is billed. */
export const billedOnServer = (collection, id) => !!id && serverBilledIn(collection).has(String(id));

/** What the server said about `ids` of `collection`: { id: number|null } for those it has billed. */
export function billedOnOf(collection, ids) {
  const map = serverBilledIn(collection);
  return Object.fromEntries((ids || []).map(String).filter(id => map.has(id)).map(id => [id, map.get(id)]));
}

/**
 * The account was read again: what was learned before `since` (the moment
 * that read began; default now) is in its copy now and goes. An answer that
 * came while the read was under way stays, as the read may predate it.
 */
export function clearServerBilled(since = Date.now()) {
  let changed = false;
  for (const [collection, rows] of [...store]) {
    for (const [id, v] of [...rows]) if (v.at <= since) { rows.delete(id); changed = true; }
    rebuild(collection);
  }
  if (changed) emit();
}

/** Called on every change. Returns the unsubscribe. */
export function subscribeServerBilled(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** AppContext: how to read the account again, quietly. */
export function setRecordsRefresher(fn) {
  refresher = typeof fn === "function" ? fn : null;
  return () => { if (refresher === fn) refresher = null; };
}

/** Read the account again now (quietly), when the app can. */
export function requestRecordsRefresh() {
  try { refresher?.(); } catch { /* the next resume reads it */ }
}

/** Tests only. */
export function _resetServerBilled() {
  store.clear();
  views.clear();
  refresher = null;
}
