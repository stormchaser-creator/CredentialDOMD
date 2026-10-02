/**
 * send-invoice-email, the decisions. Deno wiring is in
 * invoiceEmailDependencies.ts; this file does no I/O of its own, so
 * tests/invoice-email/handler.test.mjs drives it under node with a fake store,
 * fake Storage and a fake Resend.
 *
 * Owner approved 2026-09-25 (tickets e8cc2a02, 821d2f76): iOS Mail and the
 * share sheet flatten line breaks, so an invoice sent from the phone arrived
 * as one run-on paragraph. Mail this function sends is multipart: text/plain
 * with real line breaks and an HTML part built from the same letter by the
 * same shared code (app/utils/invoiceEmail.js invoiceEmailHtml).
 *
 * Two actions, both POST with a Clerk JWT (deployed with --no-verify-jwt; the
 * token is verified in _shared/clerkAuth.ts):
 *
 *   { action: "check", invoiceId, pdfBytes }
 *     Nothing is sent and nothing is reserved. Answers who the email is from
 *     (sender), which of the invoice's receipts can ride and which cannot and
 *     why (receipts.attachable / receipts.missing), when and to whom this
 *     invoice was last emailed (lastSend), its most recent attempt that did
 *     not fail (lastAttempt: sent, unknown or sending, with a 'sending' row
 *     older than SENDING_STALE_MS reported as unknown), and the address to
 *     pre-fill (suggestedTo: this invoice's last recipient, else the most
 *     recent recipient of another invoice billed to the same party). The app
 *     builds its preview from this, so a receipt that cannot be attached is
 *     named BEFORE the Send tap and the letter never counts it.
 *
 *   { action: "send", invoiceId, requestId, to, subject, letter, receiptIds,
 *     pdf: { name, base64 }, preview, confirmResend? }
 *     `preview` is the message the physician looked at (from, to, cc,
 *     replyTo, subject, text, attachment names). The function composes the
 *     message itself with the same shared code (app/utils/invoiceEmail.js)
 *     and refuses (409 preview_stale) unless the two are identical, so what
 *     goes out is exactly what was on the screen.
 *     When the invoice's most recent attempt under ANOTHER request id is
 *     unconfirmed (unknown, or still sending), a new send is refused (409
 *     recent_attempt_unconfirmed) unless `confirmResend` is true: the
 *     physician was shown that attempt and chose to send again anyway.
 *
 * Not recorded yet (2026-10-01, "Email it for me" on Work log, Days & call
 * and Expenses): both actions also take `draft` ({ number, kind, entryIds,
 * contractId, billToLabel }) for an invoice the app records only once this
 * function confirms the send, under `invoiceId` (the id the app will record
 * it with). While no invoice row has that id the draft stands in for it:
 * its receipts are those of the listed expenses no other invoice bills, and
 * a number already on one of the account's invoices is refused (409
 * invoice_number_recorded), since sending it would bill the agency twice.
 * Once the row exists the draft is ignored and the row is used, so a retried
 * Send after the app recorded the invoice is answered from the ledger like
 * any other. The app keys the request id to the invoice number, so a retry
 * on a weak network is a replay, never a second email.
 *
 * Mail: from "<Name>, <Degree> via CredentialDOMD" <docs@credentialdomd.com>,
 * reply_to and cc the physician's own mailbox (profiles.verified_email when
 * set, else profiles.email; cc dropped when the physician is the recipient),
 * attachments the invoice PDF the app generated, then the receipts the
 * invoice bills, read from Storage here and never from a device. Caps are
 * send-packet-email's: 10 files, 25 MB of base64. The PDF must be a PDF and
 * at most 5 MB.
 *
 * Access: Practice write (invoices are Practice records), the same server
 * decision the rest of the app's writes use (accessWrite.mjs). A
 * Credential-only or lapsed account is refused before anything is read.
 *
 * Sent once. The app sends a requestId (a UUID made when the email screen
 * opens) and reuses it on every retry of the same Send. The ledger
 * public.invoice_email_sends is unique on (user_id, client_request_id):
 *   sent     a retry answers 200 { replay: true } with the original
 *            recipient and time, and nothing is mailed again;
 *   sending  another tap is in flight: 409 send_in_progress. A 'sending'
 *            row older than SENDING_STALE_MS belongs to a run that was killed
 *            (a platform limit, a lost finish write): it is marked unknown and
 *            answered as unknown, never "in progress" forever;
 *   unknown  the POST to Resend did not come back, the email may exist:
 *            409 send_unconfirmed, and only a NEW requestId (a deliberate new
 *            send, confirmed over the warning the check shows) can mail it
 *            again;
 *   failed   nothing went out (Resend refused, a receipt vanished): the same
 *            requestId may try again, with a fresh Resend Idempotency-Key.
 *
 * Rate limit: 30 emails an hour per account, counted in the ledger
 * send-packet-email already uses (public.send_reservations via
 * reserve_send), so the two paths share one budget over the sending domain.
 * A ledger that cannot answer refuses (429 send_ledger_unavailable with
 * Retry-After), never sends unmetered. A replay takes no reservation.
 *
 * Record: after a confirmed send the invoice row gets last_emailed_at and
 * last_emailed_to, written alone (updated_at untouched, like a favorite star)
 * and never moved backwards, so an edit on another device is not overwritten
 * and the Resend screen can say when and to whom it last went. The two
 * columns are server-owned: the app never writes them (SERVER_OWNED_FIELDS in
 * src/lib/supabase.js) and the database keeps them on any user-token write
 * (trigger invoices_keep_last_emailed), so a stale device cannot erase or
 * roll them back, and the address pre-filled from them is the server's.
 * A draft has no row to stamp: the row the app records is stamped from this
 * ledger as it is inserted (trigger invoices_stamp_from_email_ledger,
 * migration 20261002040000). A draft that went out, or may have, gets its
 * number stamped as shared on the number ledger instead (draftWent), so
 * every device asks whether it went until it is recorded.
 *
 * Receipts are attached under the names the app's share sheet gives them
 * (docLabel.js outgoingFileNames): what each is and whose, never a camera's
 * "image.jpg".
 */

import { accessWriteDecision } from "./accessWrite.mjs";
import { isOwnStorageObjectForSubjects } from "./storagePath.ts";
import {
  INVOICE_EMAIL_CAPS as CAPS, invoiceEmailSender, recipientProblem, composeInvoiceEmail,
  receiptClaimProblem, safeAttachmentName, invoicePdfName, base64Length, normalizeAddress,
} from "./app/utils/invoiceEmail.js";
import { billedReceiptDocs } from "./app/utils/receiptFiles.js";
import { outgoingFileNames } from "./app/utils/docLabel.js";
import { agencyKey } from "./app/utils/contractsForDate.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A 5 MB PDF is 6.7 MB of base64; the rest of the body is a letter and ids.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const SEND_WINDOW_MS = 60 * 60 * 1000;
// From the claim to the POST: reading the receipts from Storage has this long.
// Past it nothing is posted (the row becomes 'failed', the same Send may try
// again), so a run's POST always starts inside this bound.
export const DELIVER_DEADLINE_MS = 90 * 1000;
// A 'sending' row older than this was left by a run that no longer exists.
// It must exceed DELIVER_DEADLINE_MS plus the 60 s Resend timeout
// (invoiceEmailDependencies.ts) plus the ledger writes, with room to spare.
export const SENDING_STALE_MS = 5 * 60 * 1000;
const PREVIEW_FIELDS = ["from", "to", "cc", "replyTo", "subject", "text", "attachments"];
const DRAFT_FIELDS = ["number", "kind", "entryIds", "contractId", "billToLabel"];
// The numbers the app prints (INV-20261001-3, EXP-20261001-4-ABC) and any a
// physician types into Mark as sent: letters, digits and a few separators.
const DRAFT_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;
const DRAFT_MAX_ITEMS = 1000;
// A number the app issues, as mark_invoice_number_shared takes it
// (migration 20260930230000): INV-/EXP-, the day, a suffix, an offline tag.
const ISSUED_NUMBER = /^(INV|EXP)-[0-9]{8}-[0-9]{1,4}(-[A-Z0-9]{3})?$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class Refusal extends Error {
  constructor(status, code, error, extra = {}) { super(code); this.status = status; this.code = code; this.error = error; this.extra = extra; }
}
const refuse = (status, code, error, extra) => { throw new Refusal(status, code, error, extra); };

/** Read the body with a hard ceiling, so a huge upload is cut off rather than buffered. */
async function readJson(req) {
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) refuse(413, "request_too_large", "That invoice is too large to email.");
  if (!req.body) refuse(400, "invalid_request", "Bad request.");
  const reader = req.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); refuse(413, "request_too_large", "That invoice is too large to email."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return refuse(400, "invalid_request", "Bad request."); }
}

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function onlyFields(input, allowed) {
  if (!isPlainObject(input) || Object.keys(input).some((k) => !allowed.includes(k))) refuse(400, "invalid_request", "Bad request.");
}

/**
 * The invoice a `draft` describes, shaped like the row store.invoice reads,
 * for an invoice the app has not recorded yet (it records it once the send
 * is confirmed). Refuses anything that is not exactly a draft.
 */
export function draftInvoice(profileId, invoiceId, draft) {
  onlyFields(draft, DRAFT_FIELDS);
  const number = typeof draft.number === "string" ? draft.number.trim() : "";
  if (!DRAFT_NUMBER.test(number)) refuse(400, "invalid_request", "Bad request.");
  if (draft.kind !== undefined && draft.kind !== null && draft.kind !== "expenses") refuse(400, "invalid_request", "Bad request.");
  const ids = draft.entryIds ?? [];
  if (!Array.isArray(ids) || ids.length > DRAFT_MAX_ITEMS || ids.some((id) => typeof id !== "string" || !id || id.length > 64)
    || new Set(ids).size !== ids.length) refuse(400, "invalid_request", "Bad request.");
  const contractId = draft.contractId ?? null;
  // Compared with other rows' contract_id only (the suggested recipient), never queried by.
  if (contractId !== null && (typeof contractId !== "string" || !contractId || contractId.length > 64)) refuse(400, "invalid_request", "Bad request.");
  const label = draft.billToLabel ?? null;
  if (label !== null && (typeof label !== "string" || label.length > 200)) refuse(400, "invalid_request", "Bad request.");
  return {
    id: invoiceId, user_id: profileId, number, kind: draft.kind === "expenses" ? "expenses" : null,
    entry_ids: ids, contract_id: contractId, bill_to_label: label,
    last_emailed_at: null, last_emailed_to: null, draft: true,
  };
}

const NUMBER_RECORDED = (number) => `${number} is already on your Invoices tab, so it was not emailed. Nothing was sent. Reload the app, then email it from the Invoices tab if it still needs to go.`;
// 2026-10-02: a page whose copy predated another device's record of INV-A
// built INV-C for the same days. A draft whose items another invoice already
// bills is never mailed, whatever its number.
const ITEMS_BILLED = (number) => `Some of what ${number} bills is already on another invoice (recorded on another device), so it was not emailed. Nothing was sent.`;

/** Base64 of bytes, chunked; btoa exists in Deno and node. */
export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Bytes of a strict base64 string, or null when it is not one. */
export function fromBase64(text) {
  if (typeof text !== "string" || text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch { return null; }
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const isPdf = (bytes) => bytes.length > PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b);

function guessMime(filename, fallback) {
  const ext = (String(filename).match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const map = {
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain", csv: "text/csv",
  };
  return map[ext] ?? fallback;
}

/** The instant the hourly window opens, as reserve_send's p_since. */
export function sendWindowStart(now = Date.now(), windowMs = SEND_WINDOW_MS) {
  return new Date(now - windowMs).toISOString();
}

/**
 * reserve_send's answer, read the way send-packet-email reads it: a row is a
 * reservation, no row is over the cap, an error is a ledger that cannot
 * answer, which REFUSES (retryably) rather than sending unmetered.
 */
export function reservationVerdict(result) {
  if (!result || result.error) {
    return { send: false, status: 429, code: "send_ledger_unavailable", error: "The send could not be recorded just now, so nothing was sent. Try again in a minute.", retryAfter: 60 };
  }
  const data = result.data;
  if (data == null || (Array.isArray(data) && data.length === 0)) {
    return { send: false, status: 429, code: "send_cap_reached", error: `Send limit reached (${CAPS.sendsPerHour} emails per hour). Try again later.`, retryAfter: null };
  }
  return { send: true };
}

/**
 * A 'sending' row whose run is gone: last touched (claimed) more than
 * SENDING_STALE_MS ago. A time that cannot be read counts as stale, so no row
 * can answer "still being sent" forever.
 */
export function isStaleSending(row, now = Date.now(), staleMs = SENDING_STALE_MS) {
  if (row?.status !== "sending") return false;
  const touched = Date.parse(row.updated_at || row.created_at || "");
  return !Number.isFinite(touched) || now - touched > staleMs;
}

/** A ledger row as the app is told about it: a stale 'sending' reads as unknown. */
export function attemptOf(row, now = Date.now()) {
  if (!row) return null;
  const status = isStaleSending(row, now) ? "unknown" : row.status;
  return { status, at: row.sent_at || row.updated_at || row.created_at || null, to: row.recipient || "", cc: row.cc || "" };
}

const checkYourCopy = (cc) => `Check your copy${cc ? ` at ${cc}` : ""} before sending again.`;

const ACCESS_TEXT = {
  membership_read_only: "Your membership does not include sending Practice records right now. Your invoices are still readable.",
  membership_unavailable: "Your membership could not be confirmed. Sign in again and retry.",
  access_policy_unavailable: "Your membership could not be checked just now. Nothing was sent. Try again in a minute.",
};

export function createInvoiceEmailHandler(deps) {
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
  const nowMs = () => Number(deps.now?.() ?? Date.now());
  const log = (msg) => { try { (deps.log || console.error)(msg); } catch { /* logging never breaks a send */ } };

  /**
   * The receipts this invoice bills, from the account's own rows: the
   * expenses stamped with this invoice AND listed in its entryIds, then the
   * documents linked to them (receiptFiles.js billedReceiptDocs, the same
   * intersection the app uses). Ordered, with the Storage path each would be
   * read from and whether that path is inside the account's own folder.
   */
  async function billedReceipts(profileId, profile, invoice) {
    if (invoice.kind !== "expenses") return [];
    // A draft's expenses are the ones it lists that no other invoice bills
    // yet (the app stamps them with this invoice only once it is recorded).
    const expenses = invoice.draft
      ? ((await deps.store.expensesByIds(profileId, invoice.entry_ids)) || [])
        .filter((e) => e && (e.invoice_id == null || e.invoice_id === invoice.id)).map((e) => ({ ...e, invoice_id: invoice.id }))
      : (await deps.store.expenses(profileId, invoice.id)) || [];
    if (!expenses.length) return [];
    const docs = (await deps.store.receiptDocuments(profileId, expenses.map((e) => `travelExpenses:${e.id}`))) || [];
    const subjects = await deps.store.storageSubjects(profileId);
    const billed = billedReceiptDocs(
      { id: invoice.id, kind: invoice.kind, entryIds: Array.isArray(invoice.entry_ids) ? invoice.entry_ids : [] },
      expenses.map((e) => ({ id: e.id, invoiceId: e.invoice_id })),
      docs.filter((d) => d && d.user_id === profileId).map((d) => ({ id: d.id, linkedTo: d.linked_to, name: d.name, row: d })),
    );
    const sorted = billed
      .map((d) => {
        const path = d.row.storage_path || (profile.auth_user_id ? `${profile.auth_user_id}/${d.id}` : "");
        return {
          id: d.id, linkedTo: d.linkedTo, name: safeAttachmentName(d.name, "receipt"), stored: d.name, row: d.row,
          path, own: isOwnStorageObjectForSubjects(subjects, path), uploaded: !!d.row.storage_path,
        };
      })
      .sort((a, b) => a.linkedTo.localeCompare(b.linkedTo) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    // Named for what they are, as the share sheet names them (docLabel.js
    // outgoingFileNames): a camera's "image.jpg" goes out as "Lodging,
    // Synthetic Inn, <physician>.jpg", a name the physician gave is kept.
    // The preview takes these names from the check, so the two still match.
    const names = outgoingFileNames(
      sorted.map((r) => ({ name: r.stored, linkedTo: r.linkedTo, type: r.row.mime_type || r.row.type || "" })),
      {
        settings: { name: profile.name || "", degreeType: profile.degree_type || "" },
        travelExpenses: expenses.map((e) => ({ id: e.id, category: e.category, vendor: e.vendor })),
      },
    );
    return sorted.map(({ stored: _stored, ...r }, i) => ({ ...r, name: safeAttachmentName(names[i]?.name || r.name, "receipt") }));
  }

  const lastSendOf = async (profileId, invoice) => {
    const row = await deps.store.lastSend(profileId, invoice.id);
    // Emailed before it was recorded (a draft): the row came after the send,
    // with no stamp. Stamped now, so the Invoices tab and the suggested
    // recipient of the next invoice know it too.
    if (row?.sent_at && !invoice.draft && (!invoice.last_emailed_at || String(invoice.last_emailed_at) < String(row.sent_at))) {
      await stamp(profileId, invoice.id, row.sent_at, row.recipient);
    }
    if (row?.sent_at) return { at: row.sent_at, to: row.recipient };
    return invoice.last_emailed_at ? { at: invoice.last_emailed_at, to: invoice.last_emailed_to || "" } : null;
  };

  /**
   * The address to pre-fill: this invoice's last recipient, else the most
   * recent recipient of another invoice billed to the same party (the same
   * agreement, or, for an invoice with none such as an expense invoice, the
   * same agency by name, spelling-insensitive). Read here from the stamps
   * only this function writes, never from a device's copy, which can be stale.
   */
  async function suggestedRecipient(profileId, invoice, lastSend, own) {
    // A test send to the physician's own mailbox is never offered back as the
    // billing office's address.
    const usable = (to) => !!to && !own.has(normalizeAddress(to));
    if (usable(lastSend?.to)) return lastSend.to;
    const party = invoice.contract_id ? null : agencyKey(invoice.bill_to_label);
    if (!invoice.contract_id && !party) return "";
    const rows = (await deps.store.emailedInvoices(profileId)) || [];
    const same = rows.filter((r) => r && r.id !== invoice.id && r.last_emailed_at && usable(r.last_emailed_to)
      && (invoice.contract_id ? r.contract_id === invoice.contract_id : !r.contract_id && agencyKey(r.bill_to_label) === party));
    same.sort((a, b) => String(b.last_emailed_at).localeCompare(String(a.last_emailed_at)));
    return same[0]?.last_emailed_to || "";
  }

  const stamp = async (profileId, invoiceId, at, to) => {
    try { await deps.store.stampInvoice(profileId, invoiceId, at, to); } catch (e) { log(`invoice stamp failed for ${invoiceId}: ${e?.message || e}`); }
  };

  // A draft that went out, or may have (review of release/goal2,
  // 2026-10-01): until the phone records it, the only trace was a note on
  // that phone. A lost answer and a page iOS threw away left the Mac with
  // the days unbilled and nothing asking, and a second invoice a tap away.
  // Its number is stamped as shared now, as the app's share hand-off stamps
  // it, so every device asks "Did it go out?" and holds the days it may
  // bill; the app clears the stamp once the invoice is recorded, and the
  // list leaves out a number an invoice carries. Only the numbers the app
  // issues (mark_invoice_number_shared's rule); a failed stamp is logged.
  async function draftWent(profileId, invoice, at) {
    if (typeof deps.store.markNumberShared !== "function" || !ISSUED_NUMBER.test(invoice.number)) return;
    try { await deps.store.markNumberShared(profileId, invoice.number, invoice.contract_id || null, at); } catch (e) { log(`invoice number stamp failed for ${invoice.number}: ${e?.message || e}`); }
  }

  /** The answer for a requestId the ledger already holds. null = a failed attempt this call may retry. */
  async function answerExisting(existing, profileId, invoice) {
    if (existing.invoice_id !== invoice.id) {
      return json(409, { code: "request_reused", error: "That send was for a different invoice. Close this screen and open the email again." });
    }
    if (existing.status === "sent") {
      if (!invoice.draft) await stamp(profileId, invoice.id, existing.sent_at, existing.recipient);
      return json(200, { ok: true, replay: true, emailId: existing.provider_id || null, sentAt: existing.sent_at, to: existing.recipient, cc: existing.cc || "" });
    }
    if (existing.status === "sending" && isStaleSending(existing, nowMs())) {
      // The run that claimed this row is gone. Whether it reached Resend is
      // unknowable, so the row becomes unknown (only if it is still this
      // same stale claim) and the physician is sent to their copy.
      try { await deps.store.finishSend(existing, "unknown"); } catch (e) { log(`invoice_email_sends expire failed for ${existing.id}: ${e?.message || e}`); }
      return json(409, { code: "send_unconfirmed", error: `The send could not be confirmed. ${checkYourCopy(existing.cc)}` });
    }
    if (existing.status === "sending") {
      return json(409, { code: "send_in_progress", error: "This email is still being sent. Check again in a moment; it will not be sent twice." });
    }
    if (existing.status === "unknown") {
      return json(409, { code: "send_unconfirmed", error: `The send could not be confirmed. ${checkYourCopy(existing.cc)}` });
    }
    return null;
  }

  // Another invoice of the account already carries the draft's number (any
  // case, as Mark as sent takes what is typed).
  const numberTaken = async (profileId, invoice) => {
    const rows = (await deps.store.invoicesNumbered(profileId, invoice.number)) || [];
    const n = invoice.number.trim().toLowerCase();
    return rows.some((r) => r && r.id !== invoice.id && String(r.number ?? "").trim().toLowerCase() === n);
  };

  // A draft's items (duty days, work entries or expenses, by id) that another
  // invoice bills now. Deployments without the read skip it.
  const itemsBilled = async (profileId, invoice) => {
    if (!invoice.draft || typeof deps.store.billedItems !== "function") return false;
    const ids = Array.isArray(invoice.entry_ids) ? invoice.entry_ids : [];
    if (!ids.length) return false;
    const rows = (await deps.store.billedItems(profileId, ids, invoice.kind)) || [];
    return rows.some((r) => r && r.invoice_id && r.invoice_id !== invoice.id);
  };

  async function check(who, input, profile, sender, invoice) {
    onlyFields(input, ["action", "invoiceId", "pdfBytes", "draft"]);
    if (invoice.draft && await numberTaken(who.profileId, invoice)) refuse(409, "invoice_number_recorded", NUMBER_RECORDED(invoice.number));
    if (await itemsBilled(who.profileId, invoice)) refuse(409, "invoice_items_billed", ITEMS_BILLED(invoice.number));
    const pdfBytes = Number(input.pdfBytes);
    if (!Number.isSafeInteger(pdfBytes) || pdfBytes <= 0 || pdfBytes > CAPS.maxPdfBytes) {
      refuse(400, "pdf_invalid", "The invoice PDF could not be prepared. Try again.");
    }
    const attachable = [];
    const missing = [];
    let files = 1;
    let total = base64Length(pdfBytes);
    for (const r of await billedReceipts(who.profileId, profile, invoice)) {
      const base = { id: r.id, name: r.name, linkedTo: r.linkedTo };
      if (!r.own) { missing.push({ ...base, reason: "unavailable" }); continue; }
      if (files >= CAPS.maxFiles) { missing.push({ ...base, reason: "too_many" }); continue; }
      let probe = null;
      try { probe = await deps.probeFile(r.path); } catch { probe = null; }
      const size = Number(probe?.size);
      if (!(size > 0)) { missing.push({ ...base, reason: r.uploaded ? "unavailable" : "never_uploaded" }); continue; }
      if (total + base64Length(size) > CAPS.maxTotalBase64) { missing.push({ ...base, reason: "too_large" }); continue; }
      files++;
      total += base64Length(size);
      attachable.push({ ...base, size });
    }
    const lastSend = await lastSendOf(who.profileId, invoice);
    const own = new Set([sender.replyTo, sender.cc, profile.email, profile.verified_email].map(normalizeAddress).filter(Boolean));
    return json(200, {
      ok: true,
      sender: { from: sender.from, fromName: sender.fromName, displayName: sender.displayName, replyTo: sender.replyTo, cc: sender.cc },
      receipts: { attachable, missing },
      lastSend,
      lastAttempt: attemptOf(await deps.store.lastAttempt(who.profileId, invoice.id, null), nowMs()),
      suggestedTo: await suggestedRecipient(who.profileId, invoice, lastSend, own),
    });
  }

  async function send(who, input, profile, sender, invoice) {
    onlyFields(input, ["action", "invoiceId", "requestId", "to", "subject", "letter", "receiptIds", "pdf", "preview", "confirmResend", "draft"]);
    const requestId = String(input.requestId ?? "").toLowerCase();
    if (!UUID.test(requestId)) refuse(400, "invalid_request", "Bad request.");
    if (input.confirmResend !== undefined && typeof input.confirmResend !== "boolean") refuse(400, "invalid_request", "Bad request.");
    if (typeof input.to !== "string" || typeof input.subject !== "string" || typeof input.letter !== "string") refuse(400, "invalid_request", "Bad request.");
    const problem = recipientProblem(input.to);
    if (problem) refuse(400, "recipient_invalid", problem);
    if (!input.letter.trim()) refuse(400, "letter_missing", "The letter is empty. Close this screen and open the email again.");
    if (input.letter.length > CAPS.maxLetter) refuse(400, "letter_too_long", `The letter is limited to ${CAPS.maxLetter} characters.`);
    if (!Array.isArray(input.receiptIds) || input.receiptIds.some((id) => typeof id !== "string" || !UUID.test(id))
      || new Set(input.receiptIds).size !== input.receiptIds.length) refuse(400, "invalid_request", "Bad request.");
    if (1 + input.receiptIds.length > CAPS.maxFiles) refuse(400, "too_many_files", `One email carries at most ${CAPS.maxFiles} files.`);
    if (!isPlainObject(input.pdf) || typeof input.pdf.name !== "string" || typeof input.pdf.base64 !== "string") refuse(400, "pdf_invalid", "The invoice PDF is missing.");
    if (!isPlainObject(input.preview)) refuse(400, "invalid_request", "Bad request.");

    // A requestId the ledger already holds is answered from the ledger:
    // a tap retried after a send that went out never sends again.
    const existing = await deps.store.findSend(who.profileId, requestId);
    if (existing) {
      const answered = await answerExisting(existing, who.profileId, invoice);
      if (answered) return answered;
    }
    // Not recorded yet, and its number is on another invoice of the account
    // now (recorded on another device since the preview): sending it would
    // bill the agency twice under one number. Nor when its items are.
    if (invoice.draft && await numberTaken(who.profileId, invoice)) refuse(409, "invoice_number_recorded", NUMBER_RECORDED(invoice.number));
    if (await itemsBilled(who.profileId, invoice)) refuse(409, "invoice_items_billed", ITEMS_BILLED(invoice.number));

    const pdf = fromBase64(input.pdf.base64);
    if (!pdf || !isPdf(pdf)) refuse(400, "pdf_invalid", "The invoice PDF could not be read. Close this screen and try again.");
    if (pdf.byteLength > CAPS.maxPdfBytes) refuse(413, "pdf_too_large", "The invoice PDF is over 5 MB.");
    const pdfName = safeAttachmentName(input.pdf.name, invoicePdfName(invoice.number));
    if (!/\.pdf$/i.test(pdfName)) refuse(400, "pdf_invalid", "The invoice PDF is missing.");

    // Every receipt must be one this invoice bills, from this account's own
    // rows, right now. One that stopped being billed since the preview (the
    // invoice was regenerated, the expense moved) is a changed preview.
    const billed = new Map((await billedReceipts(who.profileId, profile, invoice)).map((r) => [r.id, r]));
    const receipts = input.receiptIds.map((id) => billed.get(id) || null);
    if (receipts.some((r) => !r)) {
      refuse(409, "receipts_changed", "A receipt in this email is no longer part of this invoice, so nothing was sent. Review the updated email, then send.",
        { missing: input.receiptIds.filter((id) => !billed.has(id)).map((id) => ({ id, name: "a receipt no longer on this invoice", linkedTo: "", reason: "unavailable" })) });
    }

    const email = composeInvoiceEmail({
      sender, to: input.to, subject: input.subject, letter: input.letter,
      attachments: [{ name: pdfName }, ...receipts.map((r) => ({ name: r.name }))],
    });
    if (!email.subject) refuse(400, "subject_missing", "The subject is empty.");
    const claimProblem = receiptClaimProblem(email.text, receipts.length);
    if (claimProblem) refuse(400, "receipt_claim_mismatch", claimProblem);
    // What goes out must be exactly what the physician looked at.
    // The HTML part is compared too once the app sends it; an app that
    // predates it (open during a deploy) still sends, and its HTML is built
    // from the same letter the text comparison just matched.
    const previewFields = "html" in input.preview ? [...PREVIEW_FIELDS, "html"] : PREVIEW_FIELDS;
    for (const field of previewFields) {
      if (JSON.stringify(email[field] ?? "") !== JSON.stringify(input.preview[field] ?? "")) {
        refuse(409, "preview_stale", "Something changed since this preview (your name or email, a receipt, or the invoice). Review the updated email, then send.", { field });
      }
    }
    const unreachable = receipts.filter((r) => !r.own);
    if (unreachable.length) {
      refuse(409, "receipts_changed", "A receipt can no longer be attached, so nothing was sent. Review the updated email, then send.",
        { missing: unreachable.map((r) => ({ id: r.id, name: r.name, linkedTo: r.linkedTo, reason: "unavailable" })) });
    }

    // A new request id is a new opening of the email screen. If the invoice's
    // latest attempt under another id may have gone (unknown) or may still be
    // going (sending), mailing it again needs the physician's explicit say-so,
    // given over the warning the check showed. Without this, closing and
    // reopening the screen after "could not be confirmed" mailed the billing
    // office a second time with nothing said.
    const prior = attemptOf(await deps.store.lastAttempt(who.profileId, invoice.id, requestId), nowMs());
    if (prior && prior.status !== "sent" && input.confirmResend !== true) {
      refuse(409, "recent_attempt_unconfirmed",
        `An earlier send of this invoice to ${prior.to} could not be confirmed, so it may already have arrived. ${checkYourCopy(prior.cc)}`,
        { attempt: prior });
    }

    // The hourly budget, taken before any bytes are read and before the claim.
    let reservation;
    try { reservation = await deps.reserveSend(who.profileId, sendWindowStart(nowMs())); } catch (e) { reservation = { error: e }; }
    const verdict = reservationVerdict(reservation);
    if (!verdict.send) {
      if (verdict.code === "send_ledger_unavailable") log(`send-invoice-email: reservation unavailable, refusing: ${reservation?.error?.message || reservation?.error || "no result"}`);
      return json(verdict.status, { code: verdict.code, error: verdict.error }, verdict.retryAfter ? { "Retry-After": String(verdict.retryAfter) } : {});
    }

    // Claim the requestId. Two taps that both got this far race on the
    // unique index; the loser is answered from the winner's row.
    const fields = {
      invoice_id: invoice.id, recipient: email.to, cc: email.cc || null, reply_to: email.replyTo,
      subject: email.subject, attachment_count: 1 + receipts.length, receipt_count: receipts.length,
    };
    let claim;
    if (existing) {
      claim = await deps.store.reclaimSend(existing, fields);
    } else {
      const inserted = await deps.store.insertSend({ user_id: who.profileId, client_request_id: requestId, status: "sending", attempts: 1, ...fields });
      claim = inserted?.conflict ? null : inserted;
    }
    if (!claim) {
      const now = await deps.store.findSend(who.profileId, requestId);
      const answered = now ? await answerExisting(now, who.profileId, invoice) : null;
      return answered || json(409, { code: "send_in_progress", error: "This email is still being sent. Check again in a moment; it will not be sent twice." });
    }
    return deliver(who, invoice, email, pdf, receipts, claim);
  }

  async function deliver(who, invoice, email, pdf, receipts, claim) {
    const finish = async (status, extra = {}) => {
      try { await deps.store.finishSend(claim, status, extra); } catch (e) { log(`invoice_email_sends finish (${status}) failed for ${claim.id}: ${e?.message || e}`); }
    };
    let attempted = false;
    const claimedAt = nowMs();
    try {
      // Receipt bytes from Storage, within the caps. A receipt that cannot be
      // read now was listed in the preview and counted by the letter, so the
      // whole send stops: the letter must never claim a missing receipt.
      const attachments = [{ filename: email.attachments[0], content: toBase64(pdf), content_type: "application/pdf" }];
      let total = attachments[0].content.length;
      const missing = [];
      for (const [i, r] of receipts.entries()) {
        let bytes = null;
        try { bytes = await deps.readFile(r.path, CAPS.maxTotalBase64); } catch { bytes = null; }
        if (!bytes || bytes.byteLength === 0) { missing.push({ id: r.id, name: r.name, linkedTo: r.linkedTo, reason: r.uploaded ? "unavailable" : "never_uploaded" }); continue; }
        const content = toBase64(bytes);
        if (total + content.length > CAPS.maxTotalBase64) { missing.push({ id: r.id, name: r.name, linkedTo: r.linkedTo, reason: "too_large" }); continue; }
        total += content.length;
        const fromRow = [r.row.mime_type, r.row.type].find((t) => typeof t === "string" && t.includes("/"));
        attachments.push({ filename: email.attachments[i + 1], content, content_type: fromRow || guessMime(r.name, "application/octet-stream") });
      }
      if (missing.length) {
        await finish("failed");
        return json(409, { code: "receipts_changed", error: "A receipt could not be attached, so nothing was sent. Review the updated email, then send.", missing });
      }

      const payload = {
        from: email.from,
        to: [email.to],
        reply_to: [email.replyTo],
        subject: email.subject,
        text: email.text,
        html: email.html,
        attachments,
      };
      if (email.cc) payload.cc = [email.cc];

      // Storage was slow enough that this run might outlive the stale bound
      // of its own claim. Nothing has been posted, so stop cleanly: the same
      // Send may try again.
      if (nowMs() - claimedAt > DELIVER_DEADLINE_MS) {
        log(`send-invoice-email: receipts took over ${DELIVER_DEADLINE_MS} ms to read; not posting ${claim.id}`);
        await finish("failed");
        return json(503, { code: "unavailable", error: "The receipts took too long to read, so nothing was sent. Try again." });
      }

      attempted = true;
      let outcome;
      try { outcome = await deps.sendMail(payload, `invoice-email-${claim.id}-${claim.attempts}`); } catch { outcome = { state: "unknown" }; }
      if (outcome?.state === "sent") {
        const sentAt = new Date(nowMs()).toISOString();
        await finish("sent", { providerId: outcome.providerId || null, sentAt });
        // A draft has no row to stamp yet; its row is stamped from the ledger
        // as it arrives (migration 20261002040000).
        if (!invoice.draft) await stamp(who.profileId, invoice.id, sentAt, email.to);
        else await draftWent(who.profileId, invoice, sentAt);
        return json(200, {
          ok: true, replay: false, emailId: outcome.providerId || null, sentAt,
          to: email.to, cc: email.cc, sent: { ...email },
        });
      }
      if (outcome?.state === "failed") {
        await finish("failed");
        return json(502, { code: "send_failed", error: "The email was not sent. Nothing went out. Try again in a minute." });
      }
      await finish("unknown");
      if (invoice.draft) await draftWent(who.profileId, invoice, new Date(nowMs()).toISOString());
      return json(502, { code: "send_unconfirmed", error: `The send could not be confirmed. Check your copy${email.cc ? ` at ${email.cc}` : ""} before sending again.` });
    } catch (e) {
      log(`send-invoice-email deliver failed: ${e?.message || e}`);
      // Before the POST nothing can have gone out, so the same Send may try
      // again. After it, the email may exist, so it may not.
      await finish(attempted ? "unknown" : "failed");
      if (attempted && invoice.draft) await draftWent(who.profileId, invoice, new Date(nowMs()).toISOString());
      return attempted
        ? json(502, { code: "send_unconfirmed", error: `The send could not be confirmed. Check your copy${email.cc ? ` at ${email.cc}` : ""} before sending again.` })
        : json(503, { code: "unavailable", error: "Could not send the invoice. Nothing went out. Try again." });
    }
  }

  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json(405, { code: "method_not_allowed", error: "POST only" });
    if (!deps.configured()) return json(500, { code: "not_configured", error: "Email is not configured." });
    try {
      const who = await deps.authenticate(req);
      if (!who?.profileId || !UUID.test(who.profileId)) return json(401, { code: "unauthorized", error: "Not signed in" });
      const input = await readJson(req);
      if (!isPlainObject(input) || !["check", "send"].includes(input.action) || typeof input.invoiceId !== "string" || !UUID.test(input.invoiceId)) {
        refuse(400, "invalid_request", "Bad request.");
      }

      // Invoices are Practice records: Practice write, decided by the server.
      const access = await accessWriteDecision(deps.accessDb, who.profileId, who.clerkSubject, "practice");
      if (!access.allowed) return json(access.status, { code: access.error, error: ACCESS_TEXT[access.error] || ACCESS_TEXT.membership_unavailable });

      const profile = await deps.store.profile(who.profileId);
      if (!profile) return json(401, { code: "unauthorized", error: "Not signed in" });
      const sender = invoiceEmailSender({ name: profile.name, degree: profile.degree_type, email: profile.email, verifiedEmail: profile.verified_email });
      if (!sender.ok) return json(400, { code: "sender_email_missing", error: sender.problem });

      const invoiceId = input.invoiceId.toLowerCase();
      // A draft stands in only while no row has its id: once the app recorded
      // it, the row is the invoice (and the ledger answers a retried Send).
      let invoice = await deps.store.invoice(who.profileId, invoiceId);
      if (!invoice && input.draft !== undefined) invoice = draftInvoice(who.profileId, invoiceId, input.draft);
      if (!invoice || invoice.user_id !== who.profileId) {
        return json(404, { code: "invoice_not_found", error: "This invoice has not reached your account yet. Check your connection, wait a moment and try again." });
      }
      return input.action === "check"
        ? await check(who, input, profile, sender, invoice)
        : await send(who, input, profile, sender, invoice);
    } catch (e) {
      if (e instanceof Refusal) return json(e.status, { code: e.code, error: e.error, ...e.extra });
      log(`send-invoice-email failed: ${e?.message || e}`);
      return json(503, { code: "unavailable", error: "Could not reach your invoice just now. Nothing was sent. Try again." });
    }
  };
}
