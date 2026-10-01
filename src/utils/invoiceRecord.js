/**
 * Recording an invoice that has left the device (ticket "Invoicce", QA3).
 *
 * An invoice is written to the Invoices tab only after it goes out: the share
 * sheet reports a send, a download lands, or Copy puts it on the clipboard.
 * Three things used to leave an invoice that did go out with no record and no
 * way to make one:
 *  - the record was refused when the share sheet closed (the membership
 *    answer had gone stale while the physician wrote the email), and the only
 *    retry was a Copy tap in a preview that closing threw away;
 *  - the share sheet reported a cancel (or the app was closed) although the
 *    physician sent the file, or the file went out some other way;
 *  - building the file threw, and nothing was said.
 * The previews now keep a refused invoice on screen until it is recorded, say
 * what happened after a cancel, and offer "Mark as sent": record the invoice
 * as it went, under the number and date on the copy that was sent, without
 * sending anything.
 *
 * Pure: no React, no DOM. The screens (WorkLog, DutyLog, Expenses) hold the
 * state and do the writing.
 */

import { localDay, sentDay, formatDate } from "./helpers.js";
import { money } from "./invoiceCover.js";

/** The `method` an invoice recorded with Mark as sent carries (invoices.method). */
export const MARKED_SENT = "marked";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The sentAt for an invoice sent on `day` (YYYY-MM-DD, the physician's local
 * calendar day): the moment itself when that is today, local noon for an
 * earlier day (so its local day, and the age the Invoices tab shows, are
 * right in every zone). Null for anything that is not a day.
 */
export function sentAtFor(day, now = new Date()) {
  if (!DAY.test(String(day || ""))) return null;
  const at = new Date(now);
  if (day === localDay(at)) return at.toISOString();
  const noon = new Date(`${day}T12:00:00`);
  return Number.isNaN(noon.getTime()) ? null : noon.toISOString();
}

/**
 * The sentAt a Mark as sent form records: the moment a remembered invoice
 * went out (`form.at`) while its day is the one in the form, else sentAtFor.
 */
export function markedSentAt(form, now = new Date()) {
  if (form?.at && sentDay(form.at) === form.day) return form.at;
  return sentAtFor(form?.day, now);
}

/**
 * Why a Mark as sent cannot be recorded as typed, or null when it can.
 * `invoices` are the account's invoices: a number already on one of them is
 * a different invoice (the number is its identity at the billing office).
 */
export function markSentProblem({ number, day, invoices = [], today = localDay() }) {
  const n = String(number ?? "").trim();
  if (!n) return "Enter the invoice number printed on the invoice you sent.";
  const taken = (invoices || []).some(i => String(i?.number ?? "").trim().toLowerCase() === n.toLowerCase());
  if (taken) return `${n} is already on the Invoices tab. Enter the number printed on the invoice you sent.`;
  if (!DAY.test(String(day || ""))) return "Enter the date you sent it.";
  if (day > today) return "The date sent cannot be later than today.";
  return null;
}

/**
 * The preview's line when the share sheet closed without reporting a send.
 * Usually a cancel; but the sheet can close without saying, and a file can
 * go out another way, so it says how to record one that did go out.
 */
export const shareClosedNotice = (number) =>
  `Nothing was recorded: the share sheet closed without reporting a send. If ${number} did go out, tap Mark as sent below.`;

/**
 * The alert and the preview's banner when the invoice went out and its
 * record was refused. `what` names what is still unbilled ("its entries").
 */
export const notRecordedMessage = (number, what = "its entries") =>
  `Invoice ${number} went out but is not on the Invoices tab yet, and ${what} are still unbilled. Tap Record as sent to save it.`;

/** Asked before a preview holding a sent, unrecorded invoice closes. */
export const closeUnrecordedQuestion = (number) =>
  `Invoice ${number} went out but is not recorded yet. Close without recording it? To record it later, build the invoice again and tap Mark as sent: this device fills in its number and date.`;

/**
 * Said in the preview (the pending banner or the Mark as sent form) each time
 * Record as sent is refused. addItem's own alert is quiet for a few seconds
 * after the last one closed (alertWriteRefused), so a tap soon after would
 * otherwise change nothing on screen. `tries` counts the refused taps, so a
 * second refusal reads differently from the first. `why` is
 * writeRefusalMessage: reconnecting, not connected, out of date, read-only.
 */
export const recordRefusedNotice = (tries, why) =>
  `Record as sent was refused${tries > 1 ? ` (${tries} times)` : ""}. ${why}`;

// ── Invoices that went out and are not recorded, remembered on the device ──
// The preview holds one only while it is open. A reload (the out-of-date
// refusal says to reload), the app being closed, or iOS dropping the PWA
// after the Mail share would forget that it went out, and recording it later
// would rest on the physician's memory of its number. So each one is also
// kept per account on the device (useUnrecordedInvoices) until an invoice
// with its number is on the Invoices tab or the physician forgets it: the
// screen it was built on says so, and Mark as sent fills in its number and
// date. A note: { number, sentAt, kind: "INV" | "EXP", contractId, total,
// periodStart, periodEnd }.

export const UNRECORDED_KEPT = 20;
const sameNumber = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** `list` with `note` added, newest last (one per number, at most UNRECORDED_KEPT). */
export function withUnrecorded(list, note) {
  if (!note?.number) return Array.isArray(list) ? list : [];
  const rest = (Array.isArray(list) ? list : []).filter(n => n && !sameNumber(n.number, note.number));
  return [...rest, note].slice(-UNRECORDED_KEPT);
}

/** `list` without the note for `number`. */
export function withoutUnrecorded(list, number) {
  return (Array.isArray(list) ? list : []).filter(n => n && !sameNumber(n.number, number));
}

/**
 * The notes for one screen that are still not on the Invoices tab, newest
 * last: `kind` "INV" (with `contractId`, that agreement's) or "EXP".
 */
export function unrecordedStill(list, invoices, { kind, contractId = null } = {}) {
  const onTab = (invoices || []).map(i => i?.number);
  return (Array.isArray(list) ? list : []).filter(n => n?.number
    && (!kind || n.kind === kind)
    && (kind !== "INV" || !contractId || n.contractId === contractId)
    && !onTab.some(x => sameNumber(x, n.number)));
}

const periodOf = (n) => (n.periodStart
  ? `${formatDate(n.periodStart)}${n.periodEnd && n.periodEnd !== n.periodStart ? ` to ${formatDate(n.periodEnd)}` : ""}`
  : "");

/**
 * The screen's line for a remembered note. `what` names its work ("its
 * entries"). A `handed` note (utils/invoiceHandoff.js) is one whose file went
 * to the share sheet or the clipboard and whose sheet never answered: it may
 * or may not have gone out. `record` when the screen offers Record it.
 */
export const unrecordedBanner = (note, what = "its entries", { record = false } = {}) => {
  const period = periodOf(note);
  const how = record
    ? "tap Record it: its number and date are filled in"
    : `build its invoice${period ? ` (${period})` : ""} and tap Mark as sent: its number and date are filled in`;
  const total = Number(note.total) > 0 ? ` for ${money(note.total)}` : "";
  // Known only from the server's stamp: the device that sent it may have
  // recorded it already, with the record still on its way (offline, or a
  // membership check running there).
  if (note.handed && !note.refused && note.fromServer) {
    return `${note.number} went to the share sheet ${formatDate(sentDay(note.sentAt))} (noted on the server) and is not on the Invoices tab yet, so ${what} are still unbilled here. `
      + `If another device sent it, open the app there first: its record may not have synced yet. If it went out and is recorded nowhere, ${how}. If it did not go out, tap Forget it.`;
  }
  if (note.handed && !note.refused) {
    return `${note.number} went to the share sheet ${formatDate(sentDay(note.sentAt))}${total} and was never recorded, so ${what} are still unbilled. `
      + `If it went out, ${how}. If it did not, tap Forget it.`;
  }
  return `${note.number} went out ${formatDate(sentDay(note.sentAt))}${total} but is not on the Invoices tab, and ${what} are still unbilled. `
    + `To record it, ${how}.`;
};

/** The Mark as sent form's hint when it is filled in from a remembered note. */
export const unrecordedHint = (note) => (note.handed && !note.refused
  ? `Filled in from ${note.number}, which went to the share sheet ${formatDate(sentDay(note.sentAt))} and was never recorded. Check it against the copy you sent.`
  : `Filled in from ${note.number}, which went out ${formatDate(sentDay(note.sentAt))} without a record. Check it against the copy you sent.`);

/** Asked before Record it records a note known only from the server's stamp. */
export const serverNoteRecordQuestion = (number) =>
  `${number} is noted only on the server. If another device recorded it and has not synced yet, recording it here too makes a second ${number}. Record it here?`;

/**
 * The day picker's line when Record it opened it: `matched` when the days the
 * note billed are all still unbilled here and are checked; otherwise none is
 * checked and the physician picks them from the copy that was sent.
 */
export const pickFromNoteHint = (number, matched) => (matched
  ? `The days ${number} billed are checked. Check them against the copy that was sent.`
  : `This device does not know which days ${number} billed, or they have changed since. Check the days on the copy that was sent.`);

/** Asked before Mark as sent records a note's number for days that come to another total. */
export const noteTotalQuestion = (number, sentTotal, total) =>
  `${number} went out for ${money(sentTotal)}, and the days checked here come to ${money(total)}. Record ${number} for these days anyway?`;

/**
 * The preview's line when its file is with the share sheet and the sheet has
 * not answered although the page is back in front (iOS can leave it
 * unanswered for good). Mark as sent opens with the preview's number.
 */
export const shareUnansweredNotice = (number) =>
  `The share sheet has not said whether ${number} went out. If it did, tap Mark as sent below: its number is filled in. Until then nothing is recorded.`;

/** Asked before a remembered note is dropped. */
export const forgetUnrecordedQuestion = (number) =>
  `Forget ${number}? This device stops reminding you that it went out without a record.`;

/** The preview's line when the invoice file could not be built or shared. */
export const sendFailedNotice = (err) =>
  `The invoice could not be sent: ${err?.message || "unknown error"}. Nothing was sent or recorded, so you can try again.`;
