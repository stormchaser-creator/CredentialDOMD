/**
 * Before an invoice is recorded, built for sending, sent, copied or emailed:
 * is it still unrecorded, and are its items still unbilled?
 *
 * This device's invoices and items are a copy read when the app loads (and
 * again when it comes back to the front, when that read works). The question
 * can be open on the phone while the same invoice is recorded on the Mac, or
 * the phone can be on an old copy (a poor signal at launch). 2026-10-02, the
 * owner's iPhone: a page whose copy predated the Mac's record of INV-A built
 * INV-C for the same twelve days and sent it to the agency. So every one of
 * those taps asks first:
 *   - this device's copy: an invoice with that number, or an item already on
 *     an invoice;
 *   - the server, now: the same two questions (readInvoiceRecordState), and
 *     which invoice bills each item (`billedOn`).
 * The answer is one of:
 *   "free"     nothing says it is recorded or billed: go on;
 *   "recorded" an invoice with that number exists: record nothing;
 *   "billed"   the number is free but some of its items are on another
 *              invoice: record or send nothing;
 *   "unknown"  the server could not be asked (offline, an error, no answer in
 *              time): never recorded on a guess (Yes, Record as sent); a send
 *              asks once.
 * Every server answer about billed items is kept for the page
 * (serverBilling.js), so the screens stop offering them at once.
 * Without a cloud client (local development) there is nothing to ask and
 * this device's copy decides.
 *
 * Pure apart from the injected `read` and serverBilling's page state: plain
 * node tests import it.
 */

import { noteServerBilled } from "./serverBilling.js";

export const RECORD_CHECK_WAIT_MS = 6000;

const norm = (n) => String(n ?? "").trim().toLowerCase();

function localAnswer({ number, invoices = [], items = [], ids = [] }) {
  const n = norm(number);
  const want = new Set((ids || []).filter(Boolean).map(String));
  if (n && (invoices || []).some(i => norm(i?.number) === n)) return { state: "recorded", billedIds: [], billedOn: {} };
  const billedHere = (items || []).filter(x => x && want.has(String(x.id)) && x.invoiceId);
  if (billedHere.length) {
    const billedOn = Object.fromEntries(billedHere.map(x => [String(x.id), (invoices || []).find(i => i?.id === x.invoiceId)?.number || null]));
    return { state: "billed", billedIds: billedHere.map(x => String(x.id)), billedOn };
  }
  return null;
}

function serverAnswer(res, want, collection) {
  if (!res || res.error || !res.data) return { state: "unknown", billedIds: [], billedOn: {} };
  const billed = (res.data.billedIds || []).map(String).filter(id => want.has(id));
  const on = res.data.billedOn && typeof res.data.billedOn === "object" ? res.data.billedOn : {};
  const billedOn = Object.fromEntries(billed.map(id => [id, on[id] ? String(on[id]) : null]));
  if (collection && billed.length) noteServerBilled(collection, billedOn);
  if (res.data.numberTaken) return { state: "recorded", billedIds: billed, billedOn };
  if (billed.length) return { state: "billed", billedIds: billed, billedOn };
  return { state: "free", billedIds: [], billedOn: {} };
}

/**
 * The check, answered at once when it can be: this device's copy decides, or
 * there is no server to ask. Otherwise a promise of the answer. Callers that
 * must not wait a tick when nothing is asked (a tap that records at once in
 * local development) use this; the rest await checkBeforeRecord.
 *
 * `number`: the invoice's number (empty for a check of the items only).
 * `invoices`: this device's invoices. `items`: this device's rows of what it
 * bills ({ id, invoiceId }). `ids`: the ids it bills. `read(number, ids)`:
 * readInvoiceRecordState bound to the collection, a promise of
 * { data: { numberTaken, billedIds, billedOn }, error } or null without a
 * cloud client. `collection`: where the server's answer is kept for the page.
 * Answers { state, billedIds, billedOn }.
 */
export function beginRecordCheck({ number, invoices = [], items = [], ids = [], read = null, timeoutMs = RECORD_CHECK_WAIT_MS, collection = null } = {}) {
  const want = new Set((ids || []).filter(Boolean).map(String));
  const here = localAnswer({ number, invoices, items, ids });
  if (here) return here;
  let call = null;
  try { call = typeof read === "function" ? read(String(number ?? "").trim(), [...want]) : null; } catch { call = null; }
  if (!call || typeof call.then !== "function") return { state: "free", billedIds: [], billedOn: {} };
  let timer;
  return Promise.race([
    Promise.resolve(call).then(r => r, () => null),
    new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); timer?.unref?.(); }),
  ]).then((res) => { clearTimeout(timer); return serverAnswer(res, want, collection); });
}

/** beginRecordCheck, always as a promise. */
export async function checkBeforeRecord(opts = {}) {
  return beginRecordCheck(opts);
}

/** Runs `then(answer)` at once when the check answered at once, else when it does. */
export function whenChecked(answer, then) {
  if (answer && typeof answer.then === "function") return answer.then(then);
  return then(answer);
}

const numberList = (numbers) => {
  const u = [...new Set((numbers || []).filter(Boolean))];
  return u.length <= 1 ? (u[0] || "") : `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
};
/** The invoices `billedOn` names ("INV-A", "INV-A and INV-B"), or "another invoice". */
export const billedOnNames = (billedOn) => numberList(Object.values(billedOn || {})) || "another invoice";

/** Said when the invoice turns out recorded already (another device, most likely). The page's copy follows on its own. */
export const alreadyRecordedNotice = (number) =>
  `${number} is already on the Invoices tab (recorded on another device). Nothing was recorded again.`;

/** Said when some of what it bills is on another invoice. `what` names them ("days"). */
export const alreadyBilledNotice = (number, what = "days", billedOn = null) =>
  `Some of the ${what} ${number} bills are already on ${billedOnNames(billedOn)} (recorded on another device). Nothing was recorded.`;

/** Said when the server could not be asked: nothing is recorded on a guess, and the note stays. */
export const uncheckedRecordNotice = (number) =>
  `Could not reach the server to check whether ${number} is already recorded. Nothing was recorded. Tap Yes again when you have a signal.`;

/** Mark as sent's line when the server could not be asked. */
export const uncheckedMarkNotice = (number) =>
  `Could not reach the server to check whether ${number} is already recorded. Nothing was recorded. Tap Record as sent again when you have a signal.`;

// ── Before an invoice is built or sent (the picker, the preview) ──

/** The preview's line while it asks the server whether its items are still unbilled. */
export const sendCheckingLabel = (what = "days") => `Checking the ${what} are still unbilled…`;

/** The preview's Send while its items turned out billed on another device: it no longer sends. */
export const billedElsewhereSendLabel = (what = "days") => `These ${what} are on another invoice now`;

/** Said when an invoice being built bills items the server has on another invoice: it closes, nothing is sent. */
export const billedBeforeSendNotice = (what, billedOn) =>
  `Some of these ${what} are already on ${billedOnNames(billedOn)} (recorded on another device), so this invoice was not sent. Pick the ${what} again: those are left out now.`;

// ── Copy tapped while the check of the page's return runs ──
// A tap lets the page write the clipboard only for a short while after it:
// about 5 s in WebKit (measured, review of release/goal2 2026-10-02), the
// time a "send anyway?" question is open included. A Copy that waited out a
// slow check on the iPhone then wrote too late, and "Could not copy the
// invoice" came up although nothing was wrong. So the tap waits for the
// answer only so long, and a copy that still came too late says to tap
// again (the answer is in by then, and the next tap copies at once).

/** How long a Copy tap waits for that check's answer. */
export const COPY_WAIT_MS = 3000;
/** Past this long after the tap, a clipboard write is refused (WebKit's window, less a margin). */
export const COPY_TAP_WINDOW_MS = 4500;

/** The check's `answer` (a promise of its state), or "late" once `waitMs` passes first. */
export function answerWithin(answer, waitMs = COPY_WAIT_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(answer),
    new Promise(resolve => { timer = setTimeout(() => resolve("late"), waitMs); timer?.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/** Said when Copy stopped waiting for the check: nothing copied, tap again. */
export const copyStillCheckingNotice = (what = "days") =>
  `Still checking that these ${what} are unbilled, so nothing was copied or marked billed. Tap Copy again in a moment.`;

/** Said when the copy failed after the tap waited for the check (the tap's window had passed). */
export const copyTooLateNotice = () =>
  "The invoice was not copied because the check took too long after your tap. Nothing was marked billed. Tap Copy again.";

/** Said when the copy failed at once. */
export const copyFailedNotice = () =>
  "Could not copy the invoice. Nothing was marked billed. Use Send invoice… instead, or try again.";

/** Asked once, on Send, Copy or Email it for me, when the server could not be asked. */
export const uncheckedSendQuestion = (what = "days") =>
  `Could not reach the server to check that these ${what} are still unbilled. If another device billed them, this sends them a second time. Send anyway?`;

/** The picker's mark for an item the server has on another invoice. */
export const billedElsewhereMark = (number) => `on ${number || "another invoice"} (recorded on another device)`;

/** The picker's line when it left items out for that reason. */
export const billedElsewherePickNotice = (what, billedOn) => {
  const many = new Set(Object.values(billedOn || {}).filter(Boolean)).size > 1;
  return `${billedOnNames(billedOn)} already ${many ? "bill" : "bills"} the ${what} marked "recorded on another device", so they are not on this invoice.`;
};

/** The expense sheet's line when it left expenses out for that reason. */
export const billedElsewhereSheetNotice = (what, billedOn) =>
  `Some ${what} are already on ${billedOnNames(billedOn)} (recorded on another device), so they are left out of this invoice.`;
