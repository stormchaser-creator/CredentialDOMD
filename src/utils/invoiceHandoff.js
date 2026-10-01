/**
 * An invoice handed to the share sheet (or the clipboard) is noted BEFORE
 * the file goes, not after the sheet answers (ticket "Invoicce", 2026-09-30).
 *
 * The record of a sent invoice is written only when the share sheet answers.
 * On an iPhone the page was reloaded (an automatic update as the physician
 * came back from Mail) or thrown away by iOS before it answered, twice in one
 * day: the invoice was with the agency and nothing on any device said so.
 * The one note the app did keep (a refused record, useUnrecordedInvoices)
 * went to localStorage, which was full on that phone, and was dropped
 * without a word.
 *
 * So, as the file is handed over:
 *  - the device keeps a note ({ number, sentAt, kind, contractId, total,
 *    periodStart, periodEnd, days, handed: true }) in IndexedDB, and in
 *    sessionStorage and localStorage where they take it (invoiceHandoffStore.js,
 *    keyed by the Clerk user id and purged by Sign out and Delete All My
 *    Data). IndexedDB has its own quota, so a full localStorage does not lose it;
 *  - the server is told the number went out (mark_invoice_number_shared,
 *    migration 20260930230000), without waiting, so the tap still opens the
 *    share sheet. That note is the one another device (the Mac) sees. A
 *    stamp the server could not take (offline) is sent again later, dated
 *    when the file was handed over.
 * A cancelled share or a file that could not be built takes both back, and
 * so does a recorded invoice (the stamp too, so deleting that invoice later
 * never brings the note back). The screens list only notes whose number is
 * on no invoice (invoiceRecord.unrecordedStill).
 *
 * Also here: watchUnanswered (a share sheet that has not answered once the
 * page is back in front) and the reports the owner sees in client_errors
 * (event codes and counts only, never a number or an amount).
 */

import * as cloud from "../lib/supabase";
import { reportError } from "../lib/errorReport.js";
import {
  readWebNotes, writeWebNotes, readDbNotes, writeDbNotes, readStamps, writeStamps,
  onHandoffPurge, syncHandoffGeneration, _resetHandoffStore, _setHandoffStoreTimes, HANDOFF_KEY_BASE, HANDOFF_STAMPS_BASE,
  HANDOFF_GENERATION_KEY,
} from "./invoiceHandoffStore.js";

// A note older than this is dropped: whatever happened to that invoice, the
// Invoices tab and the agency know by now.
export const HANDOFF_KEPT_DAYS = 45;
const KEPT = 20;
// How long a share sheet may stay unanswered once the page is back in front.
export const SHARE_ANSWER_GRACE_MS = 3000;
// And with the page never leaving the front (the Mail sheet over the app).
export const SHARE_ANSWER_WAIT_MS = 45000;
// A note still unrecorded this long after a screen shows it is reported
// (by then the account's invoices have loaded).
export const UNRECORDED_REPORT_MS = 15000;
// The server's list of stamps is waited for this long at most: a request
// that never answers must not hold every later refresh.
export const SERVER_LIST_WAIT_MS = 15000;
const DEFAULT_TIMES = { graceMs: SHARE_ANSWER_GRACE_MS, waitMs: SHARE_ANSWER_WAIT_MS, reportMs: UNRECORDED_REPORT_MS, listMs: SERVER_LIST_WAIT_MS };
const times = { ...DEFAULT_TIMES };
/** The waits above, as used now. */
export const handoffTimes = () => ({ ...times });
/** Tests only: shorter waits (openMs and txMs for IndexedDB too). */
export function _setHandoffTimes(next = {}) {
  const { openMs, txMs, ...rest } = next;
  Object.assign(times, DEFAULT_TIMES, rest);
  _setHandoffStoreTimes({ openMs, txMs });
}

const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const norm = (n) => String(n ?? "").trim().toLowerCase();
const fresh = (n, now = Date.now()) => {
  const at = Date.parse(n?.sentAt || "");
  return !Number.isFinite(at) || now - at < HANDOFF_KEPT_DAYS * 86400000;
};
const valid = (n) => !!(n && typeof n === "object" && n.number && fresh(n));
// A number this app issues (mark_invoice_number_shared takes no other): a
// number typed into Mark as sent is never stamped or unstamped.
const ISSUED = /^(INV|EXP)-[0-9]{8}-[0-9]{1,4}(-[A-Z0-9]{3})?$/;

// account -> notes this page knows (written here, or read from the stores).
const memory = new Map();
// account -> notes the server lists (another device's, or this one's before a reload).
const server = new Map();
// account -> numbers forgotten on this page: a store read late never brings one back.
const forgotten = new Map();
// account -> share stamps the server has not confirmed yet (also in the web stores).
const owed = new Map();
// account|number -> the stamp request in flight: one at a time per number, in order.
const chains = new Map();
let stampSeq = 0;
const loading = new Map();
const listeners = new Set();
let reporter = (message, extra) => reportError(message, "error", extra);
const reported = new Set();

const emit = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* a listener never stops the others */ } } };

// The device's purge generation this page's memory was read under
// (invoiceHandoffStore HANDOFF_GENERATION_KEY); undefined before the first
// read. Sign out or Delete All My Data in another tab moves it: everything
// this page holds is dropped before it is shown or written anywhere, and read
// again from the stores. True when it was dropped.
let memoryGeneration;
function honorPurges() {
  const now = syncHandoffGeneration();
  const moved = memoryGeneration !== undefined && memoryGeneration !== now;
  memoryGeneration = now;
  if (moved) { memory.clear(); server.clear(); forgotten.clear(); owed.clear(); loading.clear(); }
  return moved;
}

// Sign out and Delete All My Data (invoiceHandoffStore purgeHandoffStores):
// nothing of the account stays in this page either.
onHandoffPurge((account) => {
  honorPurges();
  memory.delete(account); server.delete(account); forgotten.delete(account); owed.delete(account); loading.delete(account);
  emit();
});
// Another tab's purge: the open screens drop its notes now.
try {
  globalThis.addEventListener?.("storage", (e) => {
    if (e?.key != null && e.key !== HANDOFF_GENERATION_KEY) return;
    if (honorPurges()) emit();
  });
} catch { /* no window */ }

/** Where the owner is told (client_errors). Tests pass their own. */
export function setInvoiceHandoffReporter(fn) {
  reporter = typeof fn === "function" ? fn : (message, extra) => reportError(message, "error", extra);
  reported.clear();
}

const MESSAGES = {
  invoice_share_unanswered: "Invoice share sheet did not answer after the page came back",
  invoice_handoff_unrecorded: "Invoice handed to the share sheet is not recorded",
  invoice_handoff_not_kept: "Invoice handoff note not kept on this device (storage_full)",
  unrecorded_note_storage_full: "Unrecorded invoice note not kept in localStorage (storage_full)",
  invoice_handoff_stamp_failed: "Invoice handoff stamp refused by the server",
};

/** Once per page per event: the event code and a count, nothing else. */
export function reportHandoffEvent(event, extra = {}) {
  if (!MESSAGES[event] || reported.has(event)) return false;
  reported.add(event);
  try { reporter(MESSAGES[event], { event, ...extra }); } catch { /* reporting never blocks */ }
  return true;
}

// ── The device's notes ──
const readWeb = (name, account) => readWebNotes(name, account).filter(valid);

/** `list` with `note` in it (one per number, newest last, at most KEPT). */
function withNote(list, note) {
  return [...list.filter(n => !same(n.number, note.number)), note].slice(-KEPT);
}
function merged(...lists) {
  let out = [];
  for (const list of lists) for (const n of list || []) if (valid(n) && !out.some(x => same(x.number, n.number))) out = withNote(out, n);
  return out.sort((a, b) => String(a.sentAt || "").localeCompare(String(b.sentAt || "")));
}
const isForgotten = (account, number) => (forgotten.get(account) || new Set()).has(norm(number));

function deviceNotes(account) {
  honorPurges();
  return merged(memory.get(account), readWeb("sessionStorage", account), readWeb("localStorage", account))
    .filter(n => !isForgotten(account, n.number));
}

// Every store gets the whole list; true when at least one kept it now
// (IndexedDB answers later, `durable`). IndexedDB keeps, besides, the notes
// it holds that this page never read (its first open timed out) and has not
// forgotten, and this page learns of them.
function persist(account, list) {
  const session = writeWebNotes("sessionStorage", account, list);
  const local = writeWebNotes("localStorage", account, list);
  const durable = writeDbNotes(account, list, (stored) => {
    const unread = stored.filter(valid).filter(n => !isForgotten(account, n.number) && !list.some(x => same(x.number, n.number)));
    if (!unread.length) return list;
    if (memory.has(account)) {
      memory.set(account, merged(memory.get(account), unread).filter(n => !isForgotten(account, n.number)));
      emit();
    }
    return merged(list, unread);
  });
  return { now: session || local, durable };
}

/**
 * Keep `note` on the device (no server stamp). Returns { kept, durable }:
 * `kept` when sessionStorage or localStorage took it, `durable` a promise of
 * whether IndexedDB did. Nothing taking it is reported.
 */
export function keepInvoiceNote(account, note) {
  if (!note?.number) return { kept: false, durable: Promise.resolve(false) };
  forgotten.get(account)?.delete(norm(note.number));
  const list = withNote(deviceNotes(account), note);
  memory.set(account, list);
  const { now, durable } = persist(account, list);
  const checked = durable.then((ok) => {
    if (!ok && !now) reportHandoffEvent("invoice_handoff_not_kept");
    return ok;
  });
  emit();
  return { kept: now, durable: checked };
}

/**
 * The invoice `note` describes is being handed to the share sheet or the
 * clipboard: kept on the device and stamped on the server, neither awaited.
 * Call it inside the tap, just before the share. `account` is the signed-in
 * Clerk user id (the same offline and online).
 */
export function handOffInvoice(account, note) {
  const handed = { ...note, handed: true };
  const kept = keepInvoiceNote(account, handed);
  stamp(account, handed.number, { shared: true, contractId: handed.contractId || null, at: handed.sentAt });
  return kept;
}

// ── The server's stamps ──
// Each stamp is owed (kept on the device) until the server answers it, and
// sent again on the next refresh when it could not be (offline, a page
// dropped first). One request at a time per number, in the order asked, and
// only the newest for a number is ever sent: a cancel that follows a share
// can never land first, nor be lost to a lost signal.
// A share stamp carries the hand-off time (`at`): the server dates the share
// by it, not by when the stamp finally arrives. One older than
// HANDOFF_KEPT_DAYS is dropped, like its note.
const owedOf = (account) => {
  honorPurges();
  if (!owed.has(account)) owed.set(account, readStamps(account).filter(s => s && s.number && s.seq && (!s.shared || fresh({ sentAt: s.at }))));
  return owed.get(account);
};
function setOwed(account, list) {
  owed.set(account, list);
  writeStamps(account, list);
}

function stamp(account, number, { shared, contractId = null, at = null }) {
  const n = String(number ?? "").trim();
  if (!ISSUED.test(n)) return Promise.resolve();
  const when = Number.isFinite(Date.parse(at || "")) ? new Date(at).toISOString() : new Date().toISOString();
  const entry = { number: n, shared: !!shared, contractId: shared ? contractId || null : null, at: shared ? when : null, seq: `${Date.now()}-${++stampSeq}` };
  setOwed(account, [...owedOf(account).filter(s => !same(s.number, n)), entry].slice(-KEPT));
  return send(account, entry);
}

function send(account, entry) {
  const key = `${account}|${norm(entry.number)}`;
  const run = (chains.get(key) || Promise.resolve()).then(() => sendNow(account, entry));
  chains.set(key, run);
  run.then(() => { if (chains.get(key) === run) chains.delete(key); });
  return run;
}

async function sendNow(account, entry) {
  // A newer stamp for this number replaced it, or the server has it already.
  if (!owedOf(account).some(s => s.seq === entry.seq)) return;
  let call = null;
  try { call = typeof cloud.markInvoiceNumberSharedRpc === "function" ? cloud.markInvoiceNumberSharedRpc(entry.number, { shared: entry.shared, contractId: entry.contractId, sharedAt: entry.at || null }) : null; } catch { call = null; }
  // No cloud client: nothing to send now or later.
  if (!call || typeof call.then !== "function") { settle(account, entry); return; }
  let res;
  // .then sends the request (a Supabase builder is lazy).
  try { res = await call; } catch { return; /* offline: still owed */ }
  const code = String(res?.error?.code || "");
  // A request that never reached the server (supabase-js answers a failed
  // fetch with an error and no code), an expired session (PGRST3xx), or no
  // session at all (42501: offline mode, or a Clerk token that could not be
  // minted, sends the anon key): still owed, sent again once signed in.
  if (res?.error && (!code || code.startsWith("PGRST3") || code === "42501")) return;
  // PGRST202/42883: the migration is not applied yet. Nothing to tell.
  if (res?.error && code !== "PGRST202" && code !== "42883") reportHandoffEvent("invoice_handoff_stamp_failed", { code: code.slice(0, 12) });
  settle(account, entry);
}

function settle(account, entry) {
  const list = owedOf(account);
  if (list.some(s => s.seq === entry.seq)) setOwed(account, list.filter(s => s.seq !== entry.seq));
}

/**
 * The note for `number` is done with: the invoice is recorded, or it did not
 * go (a cancelled share, a file that could not be built, Forget it). With
 * `unstamp` the server's stamp goes too: always once it is recorded, so a
 * later delete of that invoice, or a record under another number, never
 * brings the note back on any device.
 */
export function forgetInvoiceNote(account, number, { unstamp = false } = {}) {
  if (!number) return;
  if (!forgotten.has(account)) forgotten.set(account, new Set());
  forgotten.get(account).add(norm(number));
  const list = deviceNotes(account).filter(n => !same(n.number, number));
  memory.set(account, list);
  persist(account, list);
  if (server.has(account)) server.set(account, server.get(account).filter(n => !same(n.number, number)));
  if (unstamp) stamp(account, number, { shared: false });
  emit();
}

/** Every note this page knows for `account`: the device's, then the server's for numbers the device has none for. */
export function invoiceNotes(account) {
  return merged(deviceNotes(account), (server.get(account) || []).filter(n => !isForgotten(account, n.number)));
}

const fromServer = (row) => (row?.number ? {
  number: String(row.number), sentAt: row.shared_at || null,
  kind: String(row.number).startsWith("EXP") ? "EXP" : "INV",
  contractId: row.contract_id || null, total: null, periodStart: null, periodEnd: null,
  handed: true, fromServer: true,
} : null);

const within = (promise, ms, fallback) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(fallback), ms);
  t?.unref?.();
  promise.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
});

/**
 * Read what the device's IndexedDB and the server hold for `account` into
 * this page (on load, whenever the page is back in front, and back online),
 * and send the stamps still owed. The two reads run side by side and each is
 * shown as it lands: an IndexedDB that never answers never holds the
 * server's list back. One at a time per account.
 */
export function refreshInvoiceNotes(account) {
  honorPurges();
  if (loading.has(account)) return loading.get(account);
  for (const s of owedOf(account)) send(account, s);
  const device = readDbNotes(account).then((fromDb) => {
    const ok = fromDb.filter(valid);
    if (ok.length && loading.get(account) === run) { memory.set(account, merged(memory.get(account), ok)); emit(); }
  });
  const listed = (async () => {
    // A cancel or a record whose unstamp is owed as the list is asked for, or
    // still owed when it answers, is not listed again.
    const unstamped = owedOf(account).filter(s => !s.shared).map(s => s.number);
    let call = null;
    try { call = typeof cloud.listSharedInvoiceNumbersRpc === "function" ? cloud.listSharedInvoiceNumbersRpc() : null; } catch { call = null; }
    if (!call || typeof call.then !== "function") return;
    const res = await within(Promise.resolve(call), times.listMs, null);
    if (!res || res.error || !Array.isArray(res.data) || loading.get(account) !== run) return;
    unstamped.push(...owedOf(account).filter(s => !s.shared).map(s => s.number));
    server.set(account, res.data.map(fromServer).filter(valid).filter(n => !unstamped.some(x => same(x, n.number))));
    emit();
  })();
  const run = Promise.all([device, listed]).then(() => {}, () => {}).finally(() => { if (loading.get(account) === run) loading.delete(account); });
  loading.set(account, run);
  return run;
}

/** Called on every change to the notes. Returns the unsubscribe. */
export function subscribeInvoiceNotes(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * While a share sheet has the invoice: `onUnanswered` runs once when the page
 * is back in front (visible, or focused) and the sheet has still not
 * answered SHARE_ANSWER_GRACE_MS later, or after SHARE_ANSWER_WAIT_MS in any
 * case. Only the first is reported to the owner: with the page never having
 * left the front, the sheet is usually the Mail sheet over the app with a
 * cover note being written, which answers in its own time. Returns stop(),
 * called once the sheet answers.
 */
export function watchUnanswered(onUnanswered, { graceMs = times.graceMs, waitMs = times.waitMs, doc = globalThis.document, win = globalThis.window } = {}) {
  let done = false;
  let grace = null;
  const fire = (cameBack) => {
    if (done) return;
    stop();
    if (cameBack) reportHandoffEvent("invoice_share_unanswered");
    try { onUnanswered(); } catch { /* the screen's own business */ }
  };
  const back = () => {
    if (done) return;
    if (doc?.visibilityState === "hidden") { if (grace) { clearTimeout(grace); grace = null; } return; }
    if (!grace) { grace = setTimeout(() => fire(true), graceMs); grace?.unref?.(); }
  };
  // unref: a test process (node) never waits on these.
  const wait = setTimeout(() => fire(false), waitMs);
  wait?.unref?.();
  try { doc?.addEventListener?.("visibilitychange", back); } catch { /* no document */ }
  try { win?.addEventListener?.("focus", back); } catch { /* no window */ }
  function stop() {
    done = true;
    clearTimeout(wait);
    if (grace) clearTimeout(grace);
    try { doc?.removeEventListener?.("visibilitychange", back); } catch { /* gone */ }
    try { win?.removeEventListener?.("focus", back); } catch { /* gone */ }
  }
  return stop;
}

/** Tests only: a new page (memory gone; the stores stay). */
export function _resetInvoiceHandoff({ stores = false } = {}) {
  memory.clear(); server.clear(); forgotten.clear(); owed.clear(); chains.clear(); loading.clear(); reported.clear();
  memoryGeneration = undefined;
  _resetHandoffStore();
  if (stores) {
    for (const name of ["sessionStorage", "localStorage"]) {
      let s = null;
      try { s = globalThis[name] || null; } catch { s = null; }
      try { for (let i = (s?.length || 0) - 1; i >= 0; i--) { const k = s.key(i); if (k?.startsWith(HANDOFF_KEY_BASE) || k?.startsWith(HANDOFF_STAMPS_BASE)) s.removeItem(k); } } catch { /* none */ }
    }
  }
}
