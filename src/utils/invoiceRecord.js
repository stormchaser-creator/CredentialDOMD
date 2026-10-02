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
 * The previews now keep a refused invoice on screen until it is recorded, ask
 * "Did it go out?" when the share sheet did not report a send (2026-10-01:
 * iOS answers a cancel after Mail or Gmail sent the file, so a cancel is
 * never taken to mean it did not go), and offer "Mark as sent": record the
 * invoice as it went, under the number and date on the copy that was sent,
 * without sending anything.
 *
 * Pure: no React, no DOM. The screens (WorkLog, DutyLog, Expenses) hold the
 * state and do the writing.
 */

import { localDay, sentDay, formatDate } from "./helpers.js";
import { money } from "./invoiceCover.js";
import { coverageDaysOf } from "./stipendDays.js";

/** The `method` an invoice recorded with Mark as sent carries (invoices.method). */
export const MARKED_SENT = "marked";

/**
 * The `method` of an invoice whose file went to the share sheet, whose sheet
 * never reported a send (iOS can answer AbortError after Mail or Gmail has
 * sent it, or not answer at all), and which the physician then said went
 * out ("Yes, it was sent").
 */
export const SHARE_CONFIRMED = "share-confirmed";

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
 * The question an open preview (or sheet) asks once its file went to the
 * share sheet and the sheet has not reported a send: it closed with a
 * cancel (which iOS also answers after a completed share), or the page is
 * back in front and it still has not answered. `what` names what Yes bills
 * ("these days"). The note and the server's stamp stay until it is answered.
 */
export const shareAskTitle = (number) => `Did ${number} go out?`;
export const shareAskNotice = (number, what = "these entries") =>
  `The share sheet did not say whether ${number} was sent. If it went out from Mail or any other app, tap Yes: it goes on the Invoices tab as sent and ${what} are billed. Nothing is sent again.`;
export const SHARE_ASK_YES = "Yes, it was sent";
export const SHARE_ASK_NO = "No, it did not go out";
/** On "Yes, it was sent" while it checks that the invoice is still unrecorded (a slow network can take seconds). */
export const SHARE_ASK_CHECKING = "Checking…";

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

/** True when some invoice in `invoices` carries `number`. */
export function onAnyInvoice(invoices, number) {
  return !!number && (Array.isArray(invoices) ? invoices : []).some(i => sameNumber(i?.number, number));
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

// ── A note whose items another recorded invoice bills (2026-10-02) ──
// The owner's iPhone sent INV-C for the twelve September days the Mac had
// recorded on INV-A an hour earlier. INV-C's note then said "INV-C is not
// recorded ... its days are still unbilled": both false, and Record it
// offered to record it. A note whose items are all billed on recorded
// invoices other than its own number is a repeat: it is never recorded, it
// holds nothing, and one tap dismisses it. One whose items are partly billed
// elsewhere says so and offers no Yes.

const asList = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);

/**
 * The rows a note bills, with the collection they are in: the ids it lists
 * (dutyIds, entryIds, expenseIds), else, for an agreement's invoice, the
 * duty days and work entries of its agreement on the days it lists (notes
 * written before ids were kept). `records`: the account's data.
 */
export function noteItems(note, records = {}) {
  if (!note?.number) return { collection: null, rows: [] };
  const pick = (collection, ids) => {
    const want = new Set(ids);
    return { collection, rows: (records[collection] || []).filter(r => r && want.has(String(r.id))) };
  };
  if (note.kind === "EXP") return asList(note.expenseIds).length ? pick("travelExpenses", asList(note.expenseIds)) : { collection: "travelExpenses", rows: [] };
  if (asList(note.dutyIds).length) return pick("dutyDays", asList(note.dutyIds));
  if (asList(note.entryIds).length) return pick("workLog", asList(note.entryIds));
  const days = new Set(asList(note.days));
  if (!days.size || !note.contractId) return { collection: null, rows: [] };
  const mine = (r) => r && r.contractId === note.contractId && days.has(String(r.date || ""));
  const duty = (records.dutyDays || []).filter(r => mine(r) && (r.workedDay || (Array.isArray(r.callPeriods) && r.callPeriods.length) || r.invoiceId));
  if (duty.length) return { collection: "dutyDays", rows: duty };
  return { collection: "workLog", rows: (records.workLog || []).filter(mine) };
}

/**
 * Whether `note` repeats invoices recorded on the account: null when none of
 * its items is billed on another invoice (or it lists none). Otherwise
 * { full, on, collection, ids }: `full` when every item is billed on other
 * invoices, `on` their numbers (as far as known), `ids` the note's rows.
 * `billedOn(collection)`: what the server said since the copy was read
 * (serverBilling.serverBilledIn), a Map of row id to number.
 */
export function repeatOf(note, records = {}, invoices = [], billedOn = () => new Map()) {
  const { collection, rows } = noteItems(note, records);
  if (!rows.length) return null;
  const server = (collection && billedOn(collection)) || new Map();
  const numberOf = (id) => (invoices || []).find(i => i?.id === id)?.number || "";
  const others = [];
  const on = [];
  for (const r of rows) {
    const n = r.invoiceId ? numberOf(r.invoiceId) : server.has(String(r.id)) ? server.get(String(r.id)) || "" : null;
    if (n === null) continue;
    if (n && sameNumber(n, note.number)) continue;
    others.push(r);
    if (n && !on.includes(n)) on.push(n);
  }
  if (!others.length) return null;
  return { full: others.length === rows.length, on, collection, ids: rows.map(r => String(r.id)) };
}

/** The repeat's title and line. `items`: "days", "entries" or "expenses". */
export const repeatTitle = (note, rep) => `${note.number} repeats ${numberList(rep.on) || "another invoice"}`;
export const repeatLine = (note, rep, items = "days") => {
  const m = numberList(rep.on) || "another invoice";
  return `${note.number} repeats ${m}: the same ${items} are on ${m}, which is recorded. ${note.number} is not recorded again. `
    + `If the agency received both, ask them to disregard ${note.number}.`;
};
/** A note only some of whose items another recorded invoice bills. */
export const partialRepeatLine = (note, rep, items = "days") => {
  const m = numberList(rep.on) || "another recorded invoice";
  return `Some of the ${items} on ${note.number} are already on ${m}, which is recorded, so ${note.number} cannot be recorded as it went. `
    + `If the agency received both, ask them to disregard ${note.number}; the ${items} that are not on ${m} are still unbilled.`;
};
/** The one button of a repeat. */
export const REPEAT_OK = "OK";

// How a note's invoice left: the share sheet, or the server email whose send
// could not be confirmed ("Email it for me", utils/invoiceEmailDraft.js).
const handedHow = (note) => (note?.via === "email" ? "was emailed without a confirmation" : "went to the share sheet");

const periodOf = (n) => (n.periodStart
  ? `${formatDate(n.periodStart)}${n.periodEnd && n.periodEnd !== n.periodStart ? ` to ${formatDate(n.periodEnd)}` : ""}`
  : "");

/**
 * The screen's line for a remembered note. `what` names its work ("its
 * entries"). A `handed` note (utils/invoiceHandoff.js) is one whose file went
 * to the share sheet or the clipboard and whose sheet never answered: it may
 * or may not have gone out. `record` when the screen offers Record it.
 */
export const unrecordedBanner = (note, what = "its entries", { record = false, confirm = false } = {}) => {
  const period = periodOf(note);
  const how = confirm
    ? "tap Yes, it was sent"
    : record
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
    return `${note.number} ${handedHow(note)} ${formatDate(sentDay(note.sentAt))}${total} and was never recorded, so ${what} are still unbilled. `
      + `If it went out, ${how}. If it did not, tap ${confirm ? "No" : "Forget it"}.`;
  }
  return `${note.number} went out ${formatDate(sentDay(note.sentAt))}${total} but is not on the Invoices tab, and ${what} are still unbilled. `
    + `To record it, ${how}.`;
};

/** The Mark as sent form's hint when it is filled in from a remembered note. */
export const unrecordedHint = (note) => (note.handed && !note.refused
  ? `Filled in from ${note.number}, which ${handedHow(note)} ${formatDate(sentDay(note.sentAt))} and was never recorded. Check it against the copy you sent.`
  : `Filled in from ${note.number}, which went out ${formatDate(sentDay(note.sentAt))} without a record. Check it against the copy you sent.`);

/**
 * The line of a preview Record it (or Yes, when its items changed) opened:
 * the invoice that went out, under its own number. It records; it never
 * sends (2026-10-02: Record it took a new number with Send beside it).
 */
export const recordOnlyLine = (number) => `${number} already went out. This screen only records it.`;

/** Asked before Record it records a note known only from the server's stamp. */
export const serverNoteRecordQuestion = (number) =>
  `${number} is noted only on the server. If another device recorded it and has not synced yet, recording it here too makes a second ${number}. Record it here?`;

/**
 * The picker's line when Record it opened it: `matched` when the items the
 * note billed are all still unbilled here and are checked; otherwise none is
 * checked and the physician picks them from the copy that was sent. `items`
 * names them: "days" (Work log, Days & call) or "expenses".
 */
export const pickFromNoteHint = (number, matched, items = "days") => (matched
  ? `The ${items} ${number} billed are checked. Check them against the copy that was sent.`
  : `This device does not know which ${items} ${number} billed, or they have changed since. Check the ${items} on the copy that was sent.`);

/** Asked before Mark as sent records a note's number for items (`items`, as above) that come to another total. */
export const noteTotalQuestion = (number, sentTotal, total, items = "days") =>
  `${number} went out for ${money(sentTotal)}, and the ${items} checked here come to ${money(total)}. Record ${number} for these ${items} anyway?`;

/**
 * Record it filled in Mark as sent from `note`: the form, with the note's
 * number and date, and what noteTotalDiffers checks on Record.
 */
export const markSentFromNote = (note, today) => ({
  number: note.number, day: sentDay(note.sentAt) || today, from: unrecordedHint(note), at: note.sentAt || null,
  problem: null, tries: 0, noteNumber: note.number, noteTotal: Number(note.total) > 0 ? Number(note.total) : null,
});

/**
 * True when Mark as sent is recording the Record it note's own number for
 * items that come to another total than the note went out for.
 */
export const noteTotalDiffers = (form, number, total) => !!(form?.noteTotal
  && String(number ?? "").trim().toLowerCase() === String(form.noteNumber || "").trim().toLowerCase()
  && Math.abs(form.noteTotal - (Number(total) || 0)) > 0.005);

/**
 * The notice once Yes, it was sent recorded a note's invoice from the
 * screen's reminder. `what` names what it billed ("its days").
 */
export const confirmedFromNoteNotice = (number, sentAt, what = "its entries") =>
  `${number} is on the Invoices tab as sent ${formatDate(sentDay(sentAt))}, and ${what} are billed.`;

/** True when a note's total (when it has one) is the total the items come to now. */
export const noteTotalMatches = (note, total) => !(Number(note?.total) > 0) || Math.abs(Number(note.total) - (Number(total) || 0)) <= 0.005;

/**
 * Which of `unbilled` (keys) a Record it note listed (`listed`): all of
 * them still unbilled, or none (a server note lists none, and one deleted or
 * changed since means the copy that was sent is the only guide).
 */
export function itemsFromNote(listed, unbilled) {
  const keys = Array.isArray(listed) ? listed.filter(Boolean) : [];
  const matched = keys.length > 0 && keys.every(k => unbilled.includes(k));
  return { matched, keys: matched ? [...new Set(keys)] : [] };
}

/**
 * The items a new invoice must not take by default: those an invoice that
 * went out (or may have) and is not recorded yet may bill (2026-10-01: with
 * "Did INV-A go out?" unanswered, the picker checked INV-A's days and a
 * second invoice billed them again). `notes` are the screen's notes still
 * unrecorded (unrecordedStill); `keys` the picker's items (day keys, or
 * expense ids). A note that lists its items (`itemsOf`) holds those; one
 * that lists none (a server note, known only by its number) holds every item
 * dated (`dateOf`) on or before the day it went, as it could have billed any
 * of them. Returns a Map of key to the number that holds it (the oldest).
 */
export function heldByNotes(notes, keys, { itemsOf = (n) => n.days, dateOf = (k) => k } = {}) {
  const held = new Map();
  for (const n of Array.isArray(notes) ? notes : []) {
    if (!n?.number) continue;
    const listed = itemsOf(n);
    const day = sentDay(n.sentAt);
    const mine = Array.isArray(listed) && listed.length
      ? (keys || []).filter(k => listed.includes(k))
      : (keys || []).filter(k => !day || String(dateOf(k) || "") <= day);
    for (const k of mine) if (!held.has(k)) held.set(k, n.number);
  }
  return held;
}

const numberList = (numbers) => {
  const u = [...new Set(numbers)];
  return u.length <= 1 ? (u[0] || "") : `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
};

/** The picker's line when items are held (heldByNotes). `items`: "days" or "expenses". */
export const heldPickNotice = (numbers, items = "days") => {
  const u = [...new Set(numbers)];
  return `${numberList(u)} ${u.length === 1 ? "is" : "are"} not recorded yet and may bill the ${items} marked "may be on" below, so they are unchecked: this invoice does not bill them a second time. `
    + `Answer "Did it go out?" first, or check them only if ${u.length === 1 ? "it" : "they"} did not bill them.`;
};

/** A held item's mark in the picker. */
export const heldMark = (number) => `may be on ${number}`;

/** Asked before an invoice is built with held items checked. */
export const heldBuildQuestion = (count, numbers, items = "days") =>
  `${count} of the ${items} checked may already be on ${numberList(numbers)}, which ${[...new Set(numbers)].length === 1 ? "is" : "are"} not recorded yet. Bill ${count === 1 ? "it" : "them"} on this invoice too?`;

/** Said in the expense sheet while held expenses are checked (no question inside the Send tap). */
export const heldCheckedNotice = (count, numbers, items = "expenses") =>
  `${count} of the ${items} checked may already be on ${numberList(numbers)}, which ${[...new Set(numbers)].length === 1 ? "is" : "are"} not recorded yet. Sending bills ${count === 1 ? "it" : "them"} a second time if ${[...new Set(numbers)].length === 1 ? "it" : "they"} did.`;

/**
 * The line for a note from another agreement than the one on screen (Work
 * log shows only its own agreement's notes, and after a relaunch it can open
 * on another one). `facility` names the agreement.
 */
export const otherAgreementNoteLine = (note, facility) => {
  const went = note.handed && !note.refused
    ? `${handedHow(note)} ${formatDate(sentDay(note.sentAt))} and is not recorded`
    : `went out ${formatDate(sentDay(note.sentAt))} but is not on the Invoices tab`;
  return `${note.number}${facility ? ` (${facility})` : ""} ${went}. Open ${facility || "its agreement"} to answer.`;
};

/**
 * Home's and the Invoices tab's line for a note (UnansweredInvoices): the
 * screens show only their own (Work log only its agreement's), and the app
 * opens on Home. `where` names the screen that answers it.
 */
export const unansweredTitle = (note) => (note.handed && !note.refused
  ? `${note.number} is not recorded. Did it go out?`
  : `${note.number} went out and is not recorded`);
export const unansweredLine = (note, where) => {
  const total = Number(note.total) > 0 ? ` for ${money(note.total)}` : "";
  const went = note.handed && !note.refused
    ? `It ${handedHow(note)} ${formatDate(sentDay(note.sentAt))}${total}${note.fromServer ? " (noted on the server)" : ""}, and its work is still unbilled until it is answered.`
    : `It went out ${formatDate(sentDay(note.sentAt))}${total}, and its work is still unbilled.`;
  return `${went} Open ${where} to ${note.handed && !note.refused ? "answer" : "record it"}.`;
};

/** Asked before a remembered note is dropped. */
export const forgetUnrecordedQuestion = (number) =>
  `Forget ${number}? This device stops reminding you that it went out without a record.`;

/** The preview's line when the invoice file could not be built or shared. */
export const sendFailedNotice = (err) =>
  `The invoice could not be sent: ${err?.message || "unknown error"}. Nothing was sent or recorded, so you can try again.`;

// ── A recorded invoice whose items are on another recorded invoice ──
// Review of release/goal2 (2026-10-01): Days & call open on the iPhone with
// no signal, "Send anyway" answered, INV-C shared for days the Mac had
// recorded on INV-A. INV-C is a new number, so it is recorded; each day's
// move onto it is refused by the server (a billed row never moves to another
// invoice while its own exists, migration 20261002030000), the day keeps
// INV-A, and the sync goes on without the move (lib/supabase.js). INV-C
// then stood on the Invoices tab with its full total for days billed on
// INV-A, and nothing said the agency had two bills for the same work. That
// state is read from the account's records here, on every device, until the
// physician deletes or writes off the duplicate.

/**
 * The account's invoices that bill items another of its invoices holds:
 * `records` the account's data. Each is { invoice, on, count, listed, full,
 * items }: `on` the other invoices' numbers, `count` how many of its items
 * they hold, `listed` how many of its items are on the account, `full` when
 * all of them are, `items` "days", "entries" or "expenses". A written off
 * invoice is settled and not listed; one with nothing elsewhere neither.
 *
 * A stipend contract's call day is an item too (review of release/goal2,
 * 2026-10-02): a coverage day with nothing logged bills its stipend with no
 * entry for entryIds to name (stipendDays.js), so INV-A and INV-C could both
 * charge the same stipends with nothing in common in their lists. Two
 * invoices of one contract with a coverage line on the same day charge that
 * stipend twice (computeBilling never writes a second one). Such an invoice's
 * items are counted as days: its coverage days and its entries' call days.
 *
 * Which of the two holds a stipend day is decided the way it is for an entry
 * (review of release/goal2, 2026-10-02): when one of them holds rows the
 * other lists (the server's move guard kept them there), it holds the day.
 * Ordering by sentAt alone listed both: INV-C recorded offline on the phone
 * at 10:00 and synced after the Mac's INV-A of 11:00 lost its entry to INV-A
 * but came first for the days, so each card told its own invoice to go, and
 * deleting INV-A set free the entry INV-C had billed. Only when neither holds
 * the other's rows does the one recorded first (sentAt) hold the day.
 *
 * `days` on each result: the call days it shares with the invoices in `on`
 * whose stipend one of those holds (removeInvoice's warning leaves those
 * out, deleteSharesCallDay). `keeps`: shared call days whose stipend this
 * invoice alone charges; deleting it alone would lose that stipend, so the
 * warning stays and the card says to delete both.
 */
export function invoicesBilledTwice(records = {}) {
  const invoices = (records?.invoices || []).filter(i => i?.id);
  if (invoices.length < 2) return [];
  const byId = new Map(invoices.map(i => [i.id, i]));
  const rows = new Map();
  for (const collection of ["dutyDays", "workLog", "travelExpenses"]) {
    for (const r of records?.[collection] || []) if (r?.id) rows.set(String(r.id), { collection, r });
  }
  // `holds(a, b)`: a holds a row b lists (the server kept it on a).
  const holds = (a, b) => asList(b.entryIds).some(id => rows.get(id)?.r?.invoiceId === a.id);
  const earlier = (a, b) => String(a.sentAt || a.createdAt || "").localeCompare(String(b.sentAt || b.createdAt || ""))
    || String(a.id).localeCompare(String(b.id));
  // Each contract's stipend day: the invoices that charge it, then the one
  // that holds it (first).
  const charging = new Map();
  const coverage = new Map();
  for (const inv of invoices) {
    if (inv.kind === "expenses" || !inv.contractId) continue;
    const days = coverageDaysOf(inv);
    if (!days.size) continue;
    coverage.set(inv.id, days);
    for (const day of days) {
      const key = `${inv.contractId}|${day}`;
      if (!charging.has(key)) charging.set(key, []);
      charging.get(key).push(inv);
    }
  }
  const first = new Map();
  for (const [key, list] of charging) {
    // Not one whose rows another of them holds; each holding the other's
    // (a split the move guard should never leave) falls back to sentAt.
    const kept = list.filter(b => !list.some(a => a !== b && holds(a, b) && !holds(b, a)));
    first.set(key, [...(kept.length ? kept : list)].sort(earlier)[0]);
  }
  const dayOf = (r) => String(r?.callDay || r?.date || "");
  const out = [];
  for (const inv of invoices) {
    if (inv.writeOffAt) continue;
    const ids = asList(inv.entryIds);
    const days = coverage.get(inv.id) || new Set();
    if (!ids.length && !days.size) continue;
    const expenses = inv.kind === "expenses";
    const on = [];
    const name = (other) => {
      const n = String(other?.number ?? "").trim();
      if (n && !on.includes(n)) on.push(n);
    };
    let listed = 0;
    let count = 0;
    let duty = 0;
    const listedDays = new Set(days);
    const hitDays = new Set();
    for (const id of ids) {
      const hit = rows.get(id);
      if (!hit || (hit.collection === "travelExpenses") !== expenses) continue;
      listed += 1;
      if (hit.collection === "dutyDays") duty += 1;
      if (hit.collection === "workLog" && dayOf(hit.r)) listedDays.add(dayOf(hit.r));
      const other = hit.r.invoiceId && hit.r.invoiceId !== inv.id ? byId.get(hit.r.invoiceId) : null;
      if (!other) continue;
      count += 1;
      if (hit.collection === "workLog" && dayOf(hit.r)) hitDays.add(dayOf(hit.r));
      name(other);
    }
    for (const day of days) {
      const other = first.get(`${inv.contractId}|${day}`);
      if (!other || other.id === inv.id) continue;
      hitDays.add(day);
      name(other);
    }
    // A stipend charged twice: counted in days.
    const stipendTwice = [...days].some(day => first.get(`${inv.contractId}|${day}`)?.id !== inv.id);
    if (stipendTwice) {
      const keeps = new Set([...hitDays].filter(day => first.get(`${inv.contractId}|${day}`)?.id === inv.id));
      out.push({ invoice: inv, on, count: hitDays.size, listed: listedDays.size, full: hitDays.size === listedDays.size, items: "days",
        days: new Set([...hitDays].filter(day => !keeps.has(day))), keeps });
      continue;
    }
    if (!count) continue;
    // A call day whose stipend this invoice alone charges (it is `first` for
    // it) is not one the other invoice keeps: deleting this one drops that
    // stipend, since the other's row on the day proves it billed (review of
    // release/goal2, 2026-10-02). Such days stay out of `days`, so the
    // delete still warns, and the card says to delete both (`keeps`).
    const keeps = new Set([...hitDays].filter(day => first.get(`${inv.contractId}|${day}`)?.id === inv.id));
    out.push({ invoice: inv, on, count, listed, full: count === listed, items: expenses ? "expenses" : duty ? "days" : "entries",
      days: new Set([...hitDays].filter(day => !keeps.has(day))), keeps });
  }
  return out;
}

/**
 * Whether deleting `inv` leaves a call day another invoice of its contract
 * also bills work on (Invoices.jsx removeInvoice's "Delete BOTH" warning):
 * `records` the account's data, `callDayOf` billing.js's. A billed twice
 * invoice skips the warning only for the days it shares with the invoices it
 * duplicates (`days` above): those keep their stipend on the other invoice.
 * Any other shared day still warns (review of release/goal2, 2026-10-02):
 * INV-C charged 09-01 (also on INV-A) and 09-13 alone, INV-B then billed late
 * work on 09-13; deleting INV-C with no warning left 09-13's stipend proved
 * by INV-B's row, never offered again, and the card's "bill the days that
 * are not on INV-A again" could not be done.
 *
 * A day the duplicate alone charges the stipend for (`keeps`) warns too,
 * though the duplicate holds no row of its own there (review of r5,
 * 2026-10-02): the phone sent INV-C offline listing only e1 plus 09-01's
 * coverage line, the Mac billed e1 on INV-A with no stipend, and the server
 * kept e1 on INV-A. INV-C held no row on 09-01, so its delete was the plain
 * question while its card said to delete both, and deleting it alone lost
 * the stipend for good (e1 on INV-A proves the day billed).
 */
export function deleteSharesCallDay(records = {}, inv, callDayOf) {
  if (!inv?.id) return false;
  const log = records?.workLog || [];
  const myDays = new Set(log.filter(x => x?.invoiceId === inv.id).map(callDayOf));
  const twice = invoicesBilledTwice(records).find(b => b.invoice.id === inv.id);
  const doubled = twice?.days || new Set();
  const keeps = twice?.keeps || new Set();
  return log.some(x => x?.invoiceId && x.invoiceId !== inv.id && x.contractId === inv.contractId
    && ((myDays.has(callDayOf(x)) && !doubled.has(callDayOf(x))) || keeps.has(callDayOf(x))));
}

/** Its title and line. */
export const billedTwiceTitle = (b) => `${b.invoice.number} bills ${b.items} already on ${numberList(b.on) || "another invoice"}`;
export const billedTwiceLine = (b) => {
  const m = numberList(b.on) || "another invoice";
  const n = b.invoice.number;
  const what = b.full ? `All ${b.count} of its ${b.items}` : `${b.count} of its ${b.listed} ${b.items}`;
  // `keeps`: the other invoice holds the rows but this one alone charges a
  // shared day's stipend, so its total is not simply a second charge.
  if (b.keeps?.size) {
    return `${what} are on ${m}, which holds them, so ${n} asks for them a second time. `
      + `Only ${n} charges the stipend for ${b.keeps.size === 1 ? "a call day" : `${b.keeps.size} call days`} they share, so deleting ${n} alone loses it. `
      + `If the agency received both, ask them to disregard both, then delete ${n} and ${m} here and bill their ${b.items} again on one invoice.`;
  }
  return `${what} are on ${m}, which was recorded first, so ${n} asks for them a second time and its total of ${money(b.invoice.totalAmount)} counts them again. `
    + `If the agency received both, ask them to disregard ${n}, then delete ${n} here`
    + (b.full ? "." : ` and bill the ${b.items} that are not on ${m} again.`);
};
