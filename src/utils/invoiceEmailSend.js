import { invoiceCoverEmail, invoiceSubject, expenseReceiptLines } from "./invoiceCover.js";
import { composeInvoiceEmail, invoicePdfName, safeAttachmentName, INVOICE_EMAIL_FUNCTION } from "./invoiceEmail.js";
import { attachedExpenseIds, missingReceiptMessage } from "./receiptFiles.js";
import { formatDate } from "./helpers.js";

/**
 * The app's half of the server-sent invoice email: turn the server's check
 * (who it is from, which receipts can ride) into the exact draft the
 * physician previews, and call send-invoice-email. The rules both halves
 * share are in invoiceEmail.js; this module adds what only the app has, the
 * cover letter and the invoice PDF.
 *
 * Browser objects are passed in (`invoke`, `pdfFor`) so node tests drive it
 * with fakes, including the real edge handler behind `invoke`.
 */

/** Base64 of a Blob or File, in chunks so a large PDF does not overflow the call stack. */
export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * The documents for one invoice email, built once per server check: the
 * letter, the subject, the invoice PDF and the attachment list. `args` come
 * from invoiceDocumentArgs (the same ones a share-sheet resend uses, so no
 * amount or term can differ), `check` is the server's answer, `pdfFor(args)`
 * builds the invoice PDF as a File.
 *
 * What the letter and PDF may claim follows the check, never the device:
 *  - the letter counts only the receipts the server can attach;
 *  - an expense line says "receipt attached" only when every receipt of that
 *    expense rides in this email, "on file" otherwise.
 *
 * `localReceipts` are the receipts THIS DEVICE says the invoice bills
 * (billedReceiptDocs over the local expenses and documents). The server sees
 * only the account's cloud rows, so a receipt whose upload is still queued, or
 * whose expense's link to this invoice has not synced, is in neither of its
 * lists. Such a receipt is named here as not_synced, so the physician is told
 * before Send and its line says "on file", instead of it silently vanishing.
 */
export function invoiceEmailDocuments({ args, check, pdfFor, localReceipts = [] }) {
  const attachable = check?.receipts?.attachable || [];
  const known = new Set([...attachable, ...(check?.receipts?.missing || [])].map((r) => r.id));
  const unsynced = (localReceipts || [])
    .filter((d) => d?.id && !known.has(d.id))
    .map((d) => ({ id: d.id, name: safeAttachmentName(d.name, "receipt"), linkedTo: d.linkedTo || "", reason: "not_synced" }));
  const missing = [...(check?.receipts?.missing || []), ...unsynced];
  const docs = [...attachable, ...missing].map((r) => ({ id: r.id, linkedTo: r.linkedTo }));
  const complete = attachedExpenseIds(docs, missing);
  const docArgs = args.kind === "expenses" && Array.isArray(args.lines)
    ? { ...args, lines: expenseReceiptLines(args.lines, complete, { allAttached: attachable.length > 0 && missing.length === 0 }) }
    : args;
  const letter = invoiceCoverEmail({ ...args, receipts: attachable.length }, { attached: true });
  const subject = invoiceSubject(args);
  const pdf = pdfFor(docArgs);
  const pdfName = invoicePdfName(args.number);
  return {
    letter, subject, pdf, pdfName, missing,
    attachments: [
      { name: pdfName, size: pdf?.size || 0, kind: "invoice" },
      ...attachable.map((r) => ({ name: r.name, size: r.size || 0, kind: "receipt", id: r.id })),
    ],
    missingText: missingReceiptMessage(missing),
    receiptIds: attachable.map((r) => r.id),
  };
}

/** The message as it will arrive, for the recipient typed now. Cheap: runs on every keystroke. */
export function invoiceEmailDraft({ documents, sender, to }) {
  return {
    ...documents,
    email: composeInvoiceEmail({ sender, to, subject: documents.subject, letter: documents.letter, attachments: documents.attachments }),
  };
}

/**
 * The request body for the Send tap: the draft exactly as previewed, and the
 * key that makes a retried tap safe. `confirmResend` is sent only when the
 * physician ticked "send it again anyway" over an unconfirmed earlier attempt.
 */
export function invoiceEmailSendBody({ invoiceId, requestId, draft, pdfBase64, confirmResend = false }) {
  return {
    action: "send",
    invoiceId,
    requestId,
    to: draft.email.to,
    subject: draft.subject,
    letter: draft.letter,
    receiptIds: draft.receiptIds,
    pdf: { name: draft.pdfName, base64: pdfBase64 },
    preview: draft.email,
    ...(confirmResend ? { confirmResend: true } : {}),
  };
}

/**
 * The check's lastAttempt when it may already have reached the billing office
 * without being confirmed (unknown, or still sending), else null. Sending
 * again over it needs the physician's explicit confirmation.
 */
export function unconfirmedAttempt(check) {
  const a = check?.lastAttempt;
  return a && (a.status === "unknown" || a.status === "sending") ? a : null;
}

/** The warning shown above Send for an unconfirmed earlier attempt. */
export function unconfirmedAttemptText(attempt) {
  if (!attempt) return "";
  const when = sentWhen(attempt.at);
  const copy = `Check your copy${attempt.cc ? ` at ${attempt.cc}` : ""} before sending it again.`;
  return attempt.status === "sending"
    ? `A send of this invoice to ${attempt.to}${when ? ` started on ${when} and` : ""} has not finished, so it may be on its way. ${copy}`
    : `A send of this invoice to ${attempt.to}${when ? ` on ${when}` : ""} could not be confirmed, so it may already have arrived. ${copy}`;
}

/**
 * Call the function and read its answer. Never throws. `invoke(name, { body })`
 * resolves to { ok, status, data, message } (src/utils/edgeError.js invokeFn).
 */
export async function callInvoiceEmail(invoke, body) {
  try {
    const r = await invoke(INVOICE_EMAIL_FUNCTION, { body });
    const data = r?.data || {};
    if (r?.ok && data.ok) return { ok: true, status: 200, code: data.replay ? "replay" : "ok", data, message: "" };
    return {
      ok: false,
      status: r?.status || 0,
      code: data.code || (r?.status ? `http_${r.status}` : "network"),
      data,
      message: data.error || r?.message || "The email could not be sent. Try again.",
    };
  } catch {
    return { ok: false, status: 0, code: "network", data: {}, message: "The connection dropped. Try again." };
  }
}

/**
 * What the Send button should do after a refusal. `retry` keeps the same
 * request id (the server said nothing went out, or the same id will answer
 * with what did); `recheck` means the preview is out of date and must be
 * rebuilt before anything else is sent; `stop` means the outcome is unknown
 * and a second send has to be a deliberate new one. An unconfirmed attempt
 * the screen did not know about (made on another device after the check) is
 * a recheck too: the check then shows it and asks before sending again.
 */
export function afterRefusal(code) {
  if (code === "receipts_changed" || code === "preview_stale" || code === "recent_attempt_unconfirmed") return "recheck";
  if (code === "send_unconfirmed") return "stop";
  return "retry";
}

/** "Sep 25, 2026 at 2:05 PM" for a stored ISO time, "" when there is none. */
export function sentWhen(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  // A full ISO time, so formatDate reads it in the device's zone, like the clock time.
  return `${formatDate(d.toISOString())} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** What the physician is told after Send: where it went, or that it had already gone. */
export function invoiceEmailedNotice({ number, to, cc, at, replay }) {
  const what = `Invoice ${number || ""}`.replace(/\s+/g, " ").trim();
  if (replay) return `${what} was already emailed to ${to}${at ? ` on ${sentWhen(at)}` : ""}, so it was not sent again.`;
  return `${what} was emailed to ${to}.${cc ? ` A copy went to ${cc}.` : ""} Replies come to you.`;
}
