/**
 * "Email it for me" on Work log, Days & call and Expenses (2026-10-01).
 *
 * The share sheet cannot keep an invoice's paragraphs (Gmail and iOS Mail
 * flatten them) and its answer on an iPhone cannot be trusted (AbortError
 * after Mail sent it, or no answer at all), so an invoice sent from the phone
 * did not show as sent. The server email (send-invoice-email) keeps the
 * letter as written, copies the physician, and its outcome is known. So the
 * invoice preview offers it next to Send and Copy, and a confirmed send
 * records the invoice with no further tap.
 *
 * The invoice is not recorded before it goes: the function takes it as a
 * draft (supabase/functions/_shared/invoiceEmailHandler.mjs) under the id
 * the screen will record it with. Both that id and the send's request id are
 * derived from the account and the invoice number, so:
 *  - a Send retried on a weak network, or after the answer was lost, is the
 *    same request: the server answers "already sent" and mails nothing again;
 *  - that answer carries the provider id, so the screen still records it, once.
 *
 * While the request is out the screen keeps a device note for the number
 * (a reload or iOS dropping the page leaves "Did it go out?" behind, as a
 * share does). Its outcome then decides:
 *  - confirmed (2xx with the provider's id): recorded, method "emailed",
 *    dated at the send, through the screen's own record path;
 *  - refused, nothing went: nothing is recorded, the note goes, and the
 *    number is not spent here (a share of it before still spent it);
 *  - unconfirmed (the provider did not answer, or answered without an id):
 *    it may have gone, so the number is spent, the note stays and the server
 *    is told (as at a share hand-off), and the preview asks "Did it go out?".
 *
 * Pure: plain node tests import it. The notes kept while it is on its way
 * are invoiceHandoff.js's (emailSendStarted and the rest).
 */

import { checkBeforeRecord } from "./invoiceRecordCheck.js";
import { invoiceEmailedNotice } from "./invoiceEmailSend.js";

/** The `method` of an invoice recorded because the server confirmed its email. */
export const EMAILED = "emailed";
export const EMAIL_IT = "Email it for me";
export const EMAIL_IT_HINT = "Sent from CredentialDOMD with its paragraphs kept and a copy to you, and recorded as sent as soon as it goes.";
/** Why Email it for me is off while the device is offline. `other` names what still works. */
export const emailItOffline = (other) => `Email it for me needs a connection.${other ? ` ${other} still works.` : ""}`;

const norm = (n) => String(n ?? "").trim().toLowerCase();

// cyrb128: four 32-bit words from a string. Not a secret, only stable: the
// same account and number always give the same id.
function hash128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
}

/** A UUID (version 8, "custom") that is always the same for the same parts. */
export function stableUuid(...parts) {
  const hex = hash128(JSON.stringify(parts.map((p) => String(p ?? ""))));
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The ids an emailed invoice uses: `invoiceId`, the id it is recorded under
 * (the server's ledger names it), and `requestId`, the send's idempotency
 * key. Both are per account and invoice number.
 */
export function invoiceEmailKeys(account, number) {
  return {
    invoiceId: stableUuid("invoice-email-invoice", account, norm(number)),
    requestId: stableUuid("invoice-email-send", account, norm(number)),
  };
}

/**
 * The request id of a deliberate new send over an earlier one that could not
 * be confirmed ("I checked. Send it again anyway."): its own key, the same on
 * every retry of that one decision.
 */
export const againRequestId = (requestId, attemptAt) => stableUuid("invoice-email-again", requestId, attemptAt || "");

/** The draft the function reads for an invoice that is not recorded yet. */
export function emailDraftBody({ number, kind = null, entryIds = [], contractId = null, billToLabel = null }) {
  return {
    number: String(number ?? "").trim(),
    ...(kind === "expenses" ? { kind } : {}),
    entryIds: [...new Set((entryIds || []).filter(Boolean).map(String))],
    contractId: contractId || null,
    billToLabel: billToLabel ? String(billToLabel).slice(0, 200) : null,
  };
}

/** Asked when the check before the email could not reach the server. */
export const emailUncheckedQuestion = (number, items = "items") =>
  `The app could not check whether ${number} or its ${items} are already recorded on another device. Email it anyway?`;

/**
 * Before the email screen opens: the same check a one-tap "Yes, it was sent"
 * makes (invoiceRecordCheck.checkBeforeRecord). "free" to go on, "recorded",
 * "billed", or "no" when the server could not be asked and the physician
 * said not to.
 */
export async function checkBeforeEmail({ number, invoices, items, ids, read, confirm, what = "items", collection = null }) {
  const { state } = await checkBeforeRecord({ number, invoices, items, ids, read, collection });
  if (state === "unknown") return confirm(emailUncheckedQuestion(number, what)) ? "free" : "no";
  return state;
}

/** The question in the preview once an email could not be confirmed. */
export const emailAskNotice = (number, what = "these entries", cc = "") =>
  `The email of ${number} could not be confirmed, so it may have gone. Check your copy${cc ? ` at ${cc}` : ""}. If it arrived, tap Yes: it goes on the Invoices tab as emailed and ${what} are billed. Nothing is sent again.`;

/** Said once an emailed invoice is recorded. `what` names what it billed ("its entries"). */
export const emailedRecordedNotice = (sent, what = "its entries") =>
  `${invoiceEmailedNotice(sent)} It is on the Invoices tab as emailed, and ${what} are billed.`;
