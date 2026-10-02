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
 * A share sheet that answers a cancel takes neither back (2026-10-01: iOS
 * answered AbortError after Gmail had sent the invoice, and erasing the note
 * left nothing anywhere saying it went): the preview asks "Did it go out?",
 * and only "No, it did not go out" (or Forget it) takes both back. So does a
 * file that could not be built, and a recorded invoice (the stamp too, so
 * deleting that invoice later never brings the note back). The screens list
 * only notes whose number is on no invoice (invoiceRecord.unrecordedStill).
 * A stamp the server could not take is sent again when the page is back in
 * front, when the device is back online, and on a timer (STAMP_RETRY_MS,
 * doubling) until it lands.
 *
 * Also here: watchUnanswered (a share sheet that has not answered once the
 * page is back in front) and the reports the owner sees in client_errors
 * (event codes and counts only, never a number or an amount).
 */

import * as cloud from "../lib/supabase";
import { reportError } from "../lib/errorReport.js";
import {
  readWebNotes, writeWebNotes, readDbNotes, writeDbNotes, readStampsCopy, writeStamps, newestStamps,
  readTombs, writeTombs, writeCacheNotes, readCacheNotes, readCacheTombs, readCacheStamps,
  onHandoffPurge, syncHandoffGeneration, _resetHandoffStore, _setHandoffStoreTimes, HANDOFF_KEY_BASE, HANDOFF_STAMPS_BASE,
  HANDOFF_TOMBS_BASE, HANDOFF_GENERATION_KEY,
} from "./invoiceHandoffStore.js";
import { invoiceNumberUsed } from "./invoiceNumber.js";
import { _resetServerBilled } from "./serverBilling.js";
import { notePageState } from "./pageDiscard.js";

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
// A stamp the server could not take is sent again after this, doubling each
// time up to STAMP_RETRY_MAX_MS, until it lands: besides the page coming back
// in front and the device coming back online, which may never happen while
// the app stays open on a poor signal.
export const STAMP_RETRY_MS = 15000;
export const STAMP_RETRY_MAX_MS = 5 * 60000;
const DEFAULT_TIMES = { graceMs: SHARE_ANSWER_GRACE_MS, waitMs: SHARE_ANSWER_WAIT_MS, reportMs: UNRECORDED_REPORT_MS, listMs: SERVER_LIST_WAIT_MS, retryMs: STAMP_RETRY_MS, retryMaxMs: STAMP_RETRY_MAX_MS };
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
// account -> Map(number -> at): the tombstones (invoiceHandoffStore
// HANDOFF_TOMBS_BASE), this page's and the stores'. A note a store still
// holds (IndexedDB dropped when No was answered, a full localStorage) is not
// shown while its number has one: answered once, never asked again.
const tombs = new Map();
// Accounts whose IndexedDB copy may still hold a note answered since (its
// write did not commit): written again on every refresh until one does.
const dbOwed = new Set();
// account -> the version of the owed-stamps copy this page loaded (Cache
// Storage may hold a newer one after a relaunch).
const owedVersion = new Map();
// account -> share stamps the server has not confirmed yet (also in the web stores).
const owed = new Map();
// account|number -> the stamp request in flight: one at a time per number, in order.
const chains = new Map();
let stampSeq = 0;
// account -> { timer, delay }: the next resend of the stamps still owed.
const retries = new Map();
// Numbers whose share sheet has the file on this page and has not answered.
const inFlight = new Set();
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
  if (moved) { memory.clear(); server.clear(); forgotten.clear(); tombs.clear(); dbOwed.clear(); owedVersion.clear(); owed.clear(); loading.clear(); clearRetries(); }
  return moved;
}

// Sign out and Delete All My Data (invoiceHandoffStore purgeHandoffStores):
// nothing of the account stays in this page either.
onHandoffPurge((account) => {
  honorPurges();
  memory.delete(account); server.delete(account); forgotten.delete(account); tombs.delete(account); dbOwed.delete(account); owedVersion.delete(account); owed.delete(account); loading.delete(account);
  clearRetries(account);
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
  invoice_share_aborted_after_handoff: "Invoice share sheet answered a cancel after the hand-off (asked the member)",
  invoice_share_confirmed_by_member: "Invoice the share sheet never reported was recorded on the member's answer",
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
// The account's tombstones, read from the web stores once per page and kept
// up to date here; one older than HANDOFF_KEPT_DAYS is dropped, as its note
// would be.
function tombsOf(account) {
  if (!tombs.has(account)) {
    const map = new Map();
    for (const t of readTombs(account)) if (t?.number && fresh({ sentAt: t.at })) map.set(norm(t.number), String(t.at || ""));
    tombs.set(account, map);
  }
  return tombs.get(account);
}
function saveTombs(account) {
  const map = tombsOf(account);
  for (const [k, at] of [...map]) if (!fresh({ sentAt: at })) map.delete(k);
  writeTombs(account, [...map].map(([number, at]) => ({ number, at })).slice(-KEPT * 3));
}
function addTombs(account, list) {
  const map = tombsOf(account);
  let changed = false;
  for (const t of list || []) {
    const k = norm(t?.number);
    if (!k || !fresh({ sentAt: t.at })) continue;
    if (!map.has(k) || String(t.at || "") > map.get(k)) { map.set(k, String(t.at || "")); changed = true; }
  }
  return changed;
}
const tombstoned = (account, number) => tombsOf(account).has(norm(number));
const isForgotten = (account, number) => (forgotten.get(account) || new Set()).has(norm(number)) || tombstoned(account, number);
// A server stamp is hidden by a tombstone only when the stamp is older: a
// number shared again since (from any device) shows again.
const serverHidden = (account, n) => {
  if ((forgotten.get(account) || new Set()).has(norm(n.number))) return true;
  const at = tombsOf(account).get(norm(n.number));
  return at !== undefined && (!n.sentAt || String(n.sentAt) <= at);
};

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
  writeCacheNotes(account, list);
  const write = writeDbNotes(account, list, (stored) => {
    const unread = stored.filter(valid).filter(n => !isForgotten(account, n.number) && !list.some(x => same(x.number, n.number)));
    if (!unread.length) return list;
    if (memory.has(account)) {
      memory.set(account, merged(memory.get(account), unread).filter(n => !isForgotten(account, n.number)));
      emit();
    }
    return merged(list, unread);
  });
  // Not committed (IndexedDB dropped behind Gmail): what it holds may be a
  // note answered since. Written again on the next refresh, and every one
  // after, until it commits.
  const durable = write.then((ok) => { if (ok) dbOwed.delete(account); else dbOwed.add(account); return ok; });
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
  // Kept again (handed over again, a send reported after No): its
  // tombstone goes.
  if (tombsOf(account).delete(norm(note.number))) saveTombs(account);
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
 *
 * The number is spent on this device as it goes (invoiceNumber.js): the
 * file may reach the agency whatever the sheet answers (iOS answers a cancel
 * after Gmail sent it, 2026-10-01), so the next invoice built on this page
 * never goes out under it, even when this one is never recorded, or its
 * preview is closed unanswered. "No, it did not go out" does not give it
 * back: a gap in the numbers costs nothing, two invoices under one number
 * at the agency do (PRAC-030).
 */
export function handOffInvoice(account, note) {
  invoiceNumberUsed(note?.number);
  inFlight.add(norm(note?.number));
  notePageState({ shareInFlight: true });
  return keepSentInvoiceNote(account, note);
}

/**
 * The invoice `note` describes went out (the share sheet reported a send)
 * and this screen records nothing for it (some items are on another
 * invoice): its note and server stamp are kept again, so the reminder holds
 * it even after "No, it did not go out" removed them.
 */
export function keepSentInvoiceNote(account, note) {
  const handed = { ...note, handed: true };
  const kept = keepInvoiceNote(account, handed);
  if (handed.number) stamp(account, handed.number, { shared: true, contractId: handed.contractId || null, at: handed.sentAt });
  return kept;
}

/**
 * The share sheet holding `number` answered (a send, a cancel, an error) or
 * its preview gave up on it: the note is no longer "with the share sheet now",
 * so a screen may report it as unrecorded (useUnrecordedInvoices).
 */
export function shareAnswered(number) {
  if (inFlight.delete(norm(number))) emit();
  notePageState({ shareInFlight: inFlight.size > 0 });
}
/**
 * `number` is with a send on this page that has not answered yet (the
 * server email, "Email it for me"): like a share sheet that has the file, it
 * is not reported as unrecorded until shareAnswered.
 */
export function holdInFlight(number) {
  if (!number) return;
  inFlight.add(norm(number));
  notePageState({ shareInFlight: true });
  emit();
}
/** True while the share sheet on this page has `number` and has not answered. */
export const shareInFlight = (number) => inFlight.has(norm(number));

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
  if (!owed.has(account)) {
    const copy = readStampsCopy(account);
    owedVersion.set(account, copy.v);
    owed.set(account, (copy.list || []).filter(s => s && s.number && s.seq && (!s.shared || fresh({ sentAt: s.at }))));
  }
  return owed.get(account);
};
function setOwed(account, list) {
  owed.set(account, list);
  writeStamps(account, list);
  owedVersion.set(account, "\uffff"); // this page wrote last: nothing older replaces it
}

// `recordedAs`: the unstamp of an invoice just recorded, under that number
// (its own, or the one typed into Mark as sent). It waits until the server
// holds that invoice (recordLanded): the record's own cloud write is queued
// apart and, once the network lost it, is sent again only on the next load,
// while this stamp goes the moment the device is back online. Sent first, it
// left the server with neither the stamp nor the invoice, and another device
// showed its days as unbilled with nothing saying it went.
// That unstamp never replaces a share stamp still owed for the number (the
// network was down at the hand-off): the share stamp stays owed and goes
// first, and the unstamp waits for it too (sendNow). Replaced, the server got
// neither until the record landed, and the Mac had nothing saying it went.
function stamp(account, number, { shared, contractId = null, at = null, recordedAs = null }) {
  const n = String(number ?? "").trim();
  if (!ISSUED.test(n)) return Promise.resolve();
  const when = Number.isFinite(Date.parse(at || "")) ? new Date(at).toISOString() : new Date().toISOString();
  const entry = { number: n, shared: !!shared, contractId: shared ? contractId || null : null, at: shared ? when : null, seq: nextSeq() };
  const after = String(recordedAs ?? "").trim();
  if (!shared && after) { entry.after = after; entry.since = new Date().toISOString(); }
  const stays = (s) => !same(s.number, n) || (!!entry.after && s.shared);
  setOwed(account, [...owedOf(account).filter(stays), entry].slice(-KEPT));
  return send(account, entry);
}
const nextSeq = () => `${Date.now()}-${++stampSeq}`;
// A share stamp for the same number still owed (and so sent first): an
// unstamp waits for it, so the two never land in the wrong order.
const shareOwed = (account, entry) => !entry.shared && owedOf(account).some(s => s.shared && same(s.number, entry.number));

function send(account, entry) {
  const key = `${account}|${norm(entry.number)}`;
  const run = (chains.get(key) || Promise.resolve()).then(() => sendNow(account, entry));
  chains.set(key, run);
  run.then(() => { if (chains.get(key) === run) chains.delete(key); });
  return run;
}

// An unstamp that waits for its invoice's record (stamp's `recordedAs`):
// true once the server holds an invoice under that number, or when there is
// no cloud client to ask. One owed for HANDOFF_KEPT_DAYS goes anyway: its
// note would be dropped by then too.
async function recordLanded(entry) {
  if (entry.shared || !entry.after) return true;
  const since = Date.parse(entry.since || "");
  if (Number.isFinite(since) && Date.now() - since >= HANDOFF_KEPT_DAYS * 86400000) return true;
  let call = null;
  try { call = typeof cloud.readInvoiceNumberRecorded === "function" ? cloud.readInvoiceNumberRecorded(entry.after) : null; } catch { call = null; }
  if (!call || typeof call.then !== "function") return true;
  const res = await within(Promise.resolve(call), times.listMs, null);
  return !!(res && !res.error && res.data === true);
}

async function sendNow(account, entry) {
  // A newer stamp for this number replaced it, or the server has it already.
  if (!owedOf(account).some(s => s.seq === entry.seq)) return;
  // The share stamp for this number has not landed yet: still owed, sent
  // once it has (the resend sends it first).
  if (shareOwed(account, entry)) { retryLater(account); return; }
  // Its invoice is not on the server yet (offline, its write still queued, or
  // kept on the device while membership is checked): still owed.
  if (!(await recordLanded(entry))) {
    if (owedOf(account).some(s => s.seq === entry.seq)) retryLater(account);
    return;
  }
  if (!owedOf(account).some(s => s.seq === entry.seq) || shareOwed(account, entry)) return;
  let call = null;
  try { call = typeof cloud.markInvoiceNumberSharedRpc === "function" ? cloud.markInvoiceNumberSharedRpc(entry.number, { shared: entry.shared, contractId: entry.contractId, sharedAt: entry.at || null }) : null; } catch { call = null; }
  // No cloud client: nothing to send now or later.
  if (!call || typeof call.then !== "function") { settle(account, entry); return; }
  let res;
  // .then sends the request (a Supabase builder is lazy).
  try { res = await call; } catch { retryLater(account); return; /* offline: still owed */ }
  const code = String(res?.error?.code || "");
  // A request that never reached the server (supabase-js answers a failed
  // fetch with an error and no code), an expired session (PGRST3xx), or no
  // session at all (42501: offline mode, or a Clerk token that could not be
  // minted, sends the anon key): still owed, sent again once signed in.
  if (res?.error && (!code || code.startsWith("PGRST3") || code === "42501")) { retryLater(account); return; }
  // PGRST202/42883: the migration is not applied yet. Nothing to tell.
  if (res?.error && code !== "PGRST202" && code !== "42883") reportHandoffEvent("invoice_handoff_stamp_failed", { code: code.slice(0, 12) });
  settle(account, entry);
}

function settle(account, entry) {
  const list = owedOf(account);
  if (list.some(s => s.seq === entry.seq)) setOwed(account, list.filter(s => s.seq !== entry.seq));
  // Nothing owed any more: no resend waits. Something still owed starts again
  // from the shortest wait, as the server just answered.
  if (!owedOf(account).length) clearRetries(account);
  else { const r = retries.get(account); if (r) r.delay = times.retryMs; }
}

// The stamps still owed for `account` are sent again after a wait (doubling,
// up to retryMaxMs), and again until none is owed. One timer per account; a
// resend that lands clears it (settle).
function retryLater(account) {
  wakeOnReturn();
  const r = retries.get(account) || { timer: null, delay: times.retryMs };
  retries.set(account, r);
  if (r.timer) return;
  r.timer = setTimeout(() => {
    r.timer = null;
    const owedNow = owedOf(account);
    if (!owedNow.length) { retries.delete(account); return; }
    r.delay = Math.min(r.delay * 2, times.retryMaxMs);
    for (const s of owedNow) send(account, s);
  }, r.delay);
  r.timer?.unref?.();
}
function clearRetries(account) {
  for (const [key, r] of [...retries]) {
    if (account !== undefined && key !== account) continue;
    if (r.timer) clearTimeout(r.timer);
    retries.delete(key);
  }
}
/** The stamps `account` still owes the server (tests and the screens' report). */
export const owedStamps = (account) => owedOf(account).map(s => ({ number: s.number, shared: s.shared }));

// Back in front, or back online: every stamp still owed goes now, whichever
// screen is open (the screens' own refresh covers only theirs).
const woken = new WeakSet();
function wakeOnReturn() {
  const resend = () => { for (const account of [...retries.keys()]) for (const s of owedOf(account)) send(account, s); };
  const doc = globalThis.document;
  const win = globalThis.window;
  try {
    if (doc && typeof doc.addEventListener === "function" && !woken.has(doc)) {
      woken.add(doc);
      doc.addEventListener("visibilitychange", () => { if (doc.visibilityState !== "hidden") resend(); });
    }
  } catch { /* no document */ }
  try {
    if (win && typeof win.addEventListener === "function" && !woken.has(win)) {
      woken.add(win);
      win.addEventListener("online", resend);
    }
  } catch { /* no window */ }
}

/**
 * The note for `number` is done with: the invoice is recorded, or it did not
 * go (a cancelled share, a file that could not be built, Forget it). With
 * `unstamp` the server's stamp goes too: always once it is recorded, so a
 * later delete of that invoice, or a record under another number, never
 * brings the note back on any device. Once recorded, pass `recordedAs` (the
 * number it was recorded under): the stamp then goes only after that
 * invoice is on the server (stamp).
 */
export function forgetInvoiceNote(account, number, { unstamp = false, recordedAs = null } = {}) {
  if (!number) return;
  if (!forgotten.has(account)) forgotten.set(account, new Set());
  forgotten.get(account).add(norm(number));
  // A tombstone, in both web stores and Cache Storage: a copy the answer
  // could not reach (IndexedDB dropped, a full localStorage) never brings the
  // note back on a later page (2026-10-02).
  tombsOf(account).set(norm(number), new Date().toISOString());
  saveTombs(account);
  const list = deviceNotes(account).filter(n => !same(n.number, number));
  memory.set(account, list);
  persist(account, list);
  if (server.has(account)) server.set(account, server.get(account).filter(n => !same(n.number, number)));
  if (unstamp) stamp(account, number, { shared: false, recordedAs });
  emit();
}

/**
 * The invoice `number` was deleted on this device (the Invoices tab). Its
 * note and server stamp go now, whatever else is owed: an unstamp that was
 * waiting for that invoice to reach the server (forgetInvoiceNote's
 * `recordedAs`) would otherwise wait for an invoice that is gone, and keep
 * the stamp, and "went to the share sheet and is not recorded" on every
 * other device, for HANDOFF_KEPT_DAYS. The unstamps of other numbers recorded
 * under it (Mark as sent with a typed number) stop waiting too.
 */
export function invoiceDeleted(account, number) {
  const n = String(number ?? "").trim();
  if (!n) return;
  forgetInvoiceNote(account, n, { unstamp: true });
  const list = owedOf(account);
  const waiting = list.filter(s => !s.shared && s.after && same(s.after, n));
  if (!waiting.length) return;
  // A new seq: a send of the waiting entry still in flight finds it gone.
  const released = waiting.map((s) => { const r = { ...s, seq: nextSeq() }; delete r.after; delete r.since; return r; });
  setOwed(account, list.map(s => released[waiting.indexOf(s)] || s));
  for (const s of released) send(account, s);
}

/** Every note this page knows for `account`: the device's, then the server's for numbers the device has none for. */
export function invoiceNotes(account) {
  return merged(deviceNotes(account), (server.get(account) || []).filter(n => !serverHidden(account, n)));
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
  // Cache Storage first (its own quota; opens when IndexedDB does not): the
  // tombstones, then the notes and the stamps a relaunch lost from
  // sessionStorage with localStorage full.
  const cached = (async () => {
    const [cacheTombs, cacheNotes, cacheStamps] = await Promise.all([readCacheTombs(account), readCacheNotes(account), readCacheStamps(account)]);
    if (loading.get(account) !== run) return;
    let changed = false;
    if (addTombs(account, cacheTombs)) {
      // Answers this page had not seen (a relaunch lost sessionStorage's):
      // what the page shows and IndexedDB holds follow them.
      saveTombs(account);
      if (memory.has(account)) memory.set(account, (memory.get(account) || []).filter(n => !isForgotten(account, n.number)));
      if (server.has(account)) server.set(account, server.get(account).filter(n => !serverHidden(account, n)));
      dbOwed.add(account);
      persist(account, deviceNotes(account));
      changed = true;
    }
    const notes = cacheNotes.filter(valid).filter(n => !isForgotten(account, n.number));
    if (notes.some(n => !(memory.get(account) || []).some(x => same(x.number, n.number)))) {
      memory.set(account, merged(memory.get(account), notes));
      changed = true;
    }
    // Stamps owed in a newer copy than this page loaded (a relaunch that lost
    // sessionStorage's): owed again, and sent.
    const have = owedVersion.get(account) ?? "";
    if (cacheStamps && cacheStamps.v > have && have !== "\uffff") {
      const list = newestStamps([cacheStamps]).list.filter(s => s && s.number && s.seq && (!s.shared || fresh({ sentAt: s.at })));
      owed.set(account, list);
      owedVersion.set(account, cacheStamps.v);
      for (const st of list) send(account, st);
    }
    if (changed) emit();
  })();
  const device = readDbNotes(account).then((fromDb) => {
    const all = fromDb.filter(valid);
    const ok = all.filter(n => !isForgotten(account, n.number));
    // IndexedDB still holds a note answered on an earlier page (its write
    // never committed): written again without it.
    if (ok.length !== all.length) dbOwed.add(account);
    if (ok.length && loading.get(account) === run) { memory.set(account, merged(memory.get(account), ok)); emit(); }
    if (dbOwed.has(account)) persist(account, deviceNotes(account));
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
    server.set(account, res.data.map(fromServer).filter(valid).filter(n => !unstamped.some(x => same(x, n.number))).filter(n => !serverHidden(account, n)));
    emit();
  })();
  const run = Promise.all([cached, device, listed]).then(() => {}, () => {}).finally(() => { if (loading.get(account) === run) loading.delete(account); });
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
 * called once the sheet answers. `number`: the invoice the sheet has. Once
 * the page is back in front and the screen asks about it, it is no longer
 * "with the share sheet now" (shareAnswered): a sheet that never answers
 * would otherwise keep it out of the unrecorded report for as long as the
 * page stays open. After SHARE_ANSWER_WAIT_MS with the page never having left
 * the front it stays with the sheet: that is the Mail sheet over the app,
 * which still has the file, and reporting it as not recorded then was a
 * false alarm. A page that did leave the front is released and reported
 * when the wait runs out, as when it comes back. Closing or replacing the preview releases it (the screens
 * call shareAnswered), as does the sheet answering.
 */
export function watchUnanswered(onUnanswered, { number = null, graceMs = times.graceMs, waitMs = times.waitMs, doc = globalThis.document, win = globalThis.window } = {}) {
  let done = false;
  let grace = null;
  // The page has left the front since the hand-off (the full Mail or Gmail
  // app, not the Mail sheet over this one). Once it has, the wait running out
  // means the same as coming back: iOS runs an overdue timer the moment the
  // page resumes, before the grace that the return starts can.
  let left = false;
  const fire = (cameBack) => {
    if (done) return;
    stop();
    if (cameBack || left) {
      if (number) shareAnswered(number);
      reportHandoffEvent("invoice_share_unanswered");
    }
    try { onUnanswered(); } catch { /* the screen's own business */ }
  };
  const back = () => {
    if (done) return;
    if (doc?.visibilityState === "hidden") { left = true; if (grace) { clearTimeout(grace); grace = null; } return; }
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
  memory.clear(); server.clear(); forgotten.clear(); tombs.clear(); dbOwed.clear(); owedVersion.clear(); owed.clear(); chains.clear(); loading.clear(); reported.clear();
  _resetServerBilled();
  clearRetries(); inFlight.clear();
  memoryGeneration = undefined;
  _resetHandoffStore();
  if (stores) {
    for (const name of ["sessionStorage", "localStorage"]) {
      let s = null;
      try { s = globalThis[name] || null; } catch { s = null; }
      try { for (let i = (s?.length || 0) - 1; i >= 0; i--) { const k = s.key(i); if (k?.startsWith(HANDOFF_KEY_BASE) || k?.startsWith(HANDOFF_STAMPS_BASE) || k?.startsWith(HANDOFF_TOMBS_BASE)) s.removeItem(k); } } catch { /* none */ }
    }
  }
}

// ── "Email it for me" (utils/invoiceEmailDraft.js) ──
// The server email of an invoice not recorded yet: noted on the device while
// it is on its way, as a share is, and decided by its outcome.

/**
 * The send is about to go: the note is kept on the device (no server stamp
 * yet; nothing has gone) and the number is held as in flight. Returns what
 * emailSendFailed needs: whether this send made the note (an earlier
 * unconfirmed send's note is never taken back by a later failure).
 */
export function emailSendStarted(account, note) {
  const had = invoiceNotes(account).some((n) => same(n.number, note.number));
  holdInFlight(note.number);
  if (!had) keepInvoiceNote(account, { ...note, handed: true, via: "email" });
  return { number: note.number, mine: !had };
}

/** Nothing went: the note this send made goes, and nothing is spent or stamped. */
export function emailSendFailed(account, started) {
  if (!started?.number) return;
  shareAnswered(started.number);
  if (started.mine) forgetInvoiceNote(account, started.number);
}

/**
 * It may have gone: the number is spent, the note stays and the server is
 * told, as at a share hand-off, so every device asks whether it went.
 */
export function emailSendUnconfirmed(account, note) {
  shareAnswered(note.number);
  invoiceNumberUsed(note.number);
  keepSentInvoiceNote(account, { ...note, via: "email" });
}

/** It went: the screen records it (its record path forgets the note and stamp). */
export function emailSendConfirmed(number) {
  shareAnswered(number);
}

