// The number a new invoice goes out under (PRAC-030).
//
// An AP department treats the number as the invoice's identity, so no two
// invoices of one account may share it: not two made on two devices at the
// same time, and not a new one and a deleted one the billing office already
// holds. The server hands the numbers out (allocate_invoice_number, migration
// 20260929210000_invoice_number_reservations.sql) and never issues one twice.
//
// The number is fixed when the preview is built, before its text can be
// copied or shared, and the share cannot wait for the network inside the
// tap (the browser would refuse the share sheet or the clipboard), so the
// preview starts with the device's own number and the server's replaces it
// a moment later; Send and Copy wait for it.
//
// Without the server:
//   - no cloud client (local development) or no function yet (the migration
//     not applied): the device's own number, exactly as before;
//   - offline, an error or no answer in time: the device's own number with a
//     short suffix (INV-20260929-03-K7Q), which no other device will issue.
//
// A number the server issued to a preview that was closed unsent is kept for
// the next preview on this device, so a cancelled preview leaves no gap.
//
// A number that left the device (sent, shared, copied) is spent on this
// device even when its record was refused and so never reaches the list the
// next number is worked out from. The server's ledger covers its own numbers;
// the device's own (no function yet, no cloud client, offline) are covered by
// the spent list below, kept for the tab's session so a reload keeps it too.
//
// Pure apart from the injected rpc and the tab's sessionStorage when there is
// one: plain node tests import it.

import { nextInvoiceNumber } from "./helpers.js";

export const RESERVE_TIMEOUT_MS = 6000;

// "account|prefix" ("<profile id>|INV-20260929-") -> a number the server
// issued to this device for that account that no invoice carries yet. Keyed
// by account so a number reserved before a sign-out never goes to another.
const held = new Map();

// account -> the numbers that left this device for that account, newest last.
// The next number is never one of them, whatever the invoice list says.
const spent = new Map();
// number -> the account it was handed to here, so invoiceNumberUsed(number)
// spends it for the right account.
const issuedTo = new Map();
const SPENT_KEY = "credentialdomd-spent-invoice-numbers";
const SPENT_KEPT = 60; // per account: far more than a day's invoices

const tabStore = () => { try { return globalThis.sessionStorage || null; } catch { return null; } };
function readStored() {
  try {
    const parsed = JSON.parse(tabStore()?.getItem(SPENT_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function spentFor(account) {
  if (!spent.has(account)) {
    const saved = readStored()[account];
    spent.set(account, new Set(Array.isArray(saved) ? saved.map(String) : []));
  }
  return spent.get(account);
}
function spend(account, number) {
  const set = spentFor(account);
  set.delete(number);
  set.add(number);
  while (set.size > SPENT_KEPT) set.delete(set.values().next().value);
  try {
    const all = readStored();
    all[account] = [...set];
    tabStore()?.setItem(SPENT_KEY, JSON.stringify(all));
  } catch { /* memory still holds it for this page */ }
}

// "INV-20260929-03" (or "INV-20260929-03-K7Q"): prefix "INV-20260929-", day, suffix 3.
const parts = (number) => String(number).match(/^([A-Z]+-(\d{8})-)(\d+)/) || [];
const prefixOf = (number) => parts(number)[1] || "";
const dayOf = (number) => parts(number)[2] || "";
const suffixOf = (number) => parseInt(parts(number)[3] || "1", 10);

/** A short tag that keeps an offline number apart from every other device's. */
export function deviceTag(random = Math.random) {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 3 }, () => letters[Math.floor(random() * letters.length)]).join("");
}

// PostgREST's answer when the function does not exist (migration not applied).
const functionMissing = (error) => !!error && (error.code === "PGRST202" || error.code === "42883"
  || /could not find the function|function .* does not exist/i.test(String(error.message || "")));

/**
 * Start working out the next number for `kind` ("INV" or "EXP").
 * Returns { number, pending, done }: `number` to show now, and when
 * `pending`, `done` resolves to the number the invoice must carry.
 * `rpc(kind, day, atLeast)` is allocateInvoiceNumberRpc (src/lib/supabase.js):
 * a promise of { data, error }, or null when there is no cloud client.
 * `account` is the signed-in profile's id.
 */
export function reserveInvoiceNumber(invoices, kind = "INV", { rpc, account = "", online = true, timeoutMs = RESERVE_TIMEOUT_MS, random = Math.random } = {}) {
  const who = account || "";
  const retired = spentFor(who);
  const local = nextInvoiceNumber(invoices, kind, { retired: [...retired] });
  const prefix = prefixOf(local);
  const key = `${who}|${prefix}`;
  const used = new Set([...(invoices || []).map(i => String(i?.number || "")), ...retired]);
  const issue = (n) => { issuedTo.set(n, who); return n; };
  const kept = held.get(key);
  if (kept && !used.has(kept)) return { number: issue(kept), pending: false, done: Promise.resolve(kept) };
  held.delete(key);

  const offline = () => `${local}-${deviceTag(random)}`;
  if (!online) { const n = issue(offline()); return { number: n, pending: false, done: Promise.resolve(n) }; }
  let call = null;
  try { call = typeof rpc === "function" ? rpc(kind, dayOf(local), suffixOf(local)) : null; } catch { call = null; }
  if (!call || typeof call.then !== "function") return { number: issue(local), pending: false, done: Promise.resolve(local) };

  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); });
  const done = Promise.race([Promise.resolve(call), timeout])
    .then((res) => {
      if (res?.timedOut) return offline();
      const { data, error } = res || {};
      if (error) return functionMissing(error) ? local : offline();
      if (typeof data === "string" && data.startsWith(prefix)) { held.set(key, data); return data; }
      return offline();
    }, () => offline())
    .then(issue)
    .finally(() => clearTimeout(timer));
  return { number: local, pending: true, done };
}

/**
 * The invoice with this number left the device (recorded or not): the next
 * preview needs a new one, and this device never issues it again. `account`
 * defaults to the account it was issued to here.
 */
export function invoiceNumberUsed(number, account) {
  const n = String(number || "");
  if (!n) return;
  for (const [key, h] of held) if (h === n) held.delete(key);
  spend(account ?? issuedTo.get(n) ?? "", n);
}

/** Tests only: forget the numbers kept between previews and the spent ones. */
export function _resetHeldInvoiceNumbers() {
  held.clear(); spent.clear(); issuedTo.clear();
  try { tabStore()?.removeItem(SPENT_KEY); } catch { /* nothing kept */ }
}
