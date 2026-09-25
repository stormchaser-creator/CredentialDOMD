import { plainDashes, scrubSsn } from "./outgoingText.js";

/**
 * The server-sent invoice email, as one pure module that BOTH sides run: the
 * app builds its preview with these functions and the send-invoice-email
 * edge function builds the message it hands to Resend with the very same
 * ones (scripts/sync-shared-app-modules.mjs copies this file, byte for byte,
 * to supabase/functions/_shared/app/utils/). The preview is therefore not a
 * description of the email; it is the email.
 *
 * Why this exists (tickets e8cc2a02, 821d2f76): iOS Mail and the share sheet
 * flatten line breaks in shared text, so an invoice sent from the phone
 * arrived as one run-on paragraph. Mail the server sends is text/plain with
 * real line breaks, which nothing between here and the billing office
 * rewrites.
 *
 * Rules kept here:
 *  - From "<Name>, <Degree> via CredentialDOMD" <docs@credentialdomd.com>,
 *    reply_to and cc the physician's own mailbox: the provider-verified
 *    address when there is one, otherwise the profile email.
 *  - The body is the app's own cover letter (invoiceCover.js), line breaks
 *    kept, no em dash, nothing shaped like an SSN, then one footer line.
 *  - The letter may claim only the receipts that actually ride in the
 *    message (receiptClaimProblem). An agency was once told receipts were
 *    attached that never were.
 *  - Attachment names are made safe and unique the way send-packet-email
 *    makes them, so the names the preview lists are the names that arrive.
 *
 * No DOM, no Deno, no network. Only relative imports with extensions, so the
 * copy resolves under Deno.
 */

export const INVOICE_EMAIL_FUNCTION = "send-invoice-email";
export const INVOICE_EMAIL_FROM_ADDRESS = "docs@credentialdomd.com";

// The caps send-packet-email already uses for a packet (10 files, 25 MB of
// base64, 200-character subject, 5,000-character note, 30 sends an hour per
// account through the shared public.send_reservations ledger), plus a bound
// on the one file the app uploads itself, the invoice PDF.
export const INVOICE_EMAIL_CAPS = Object.freeze({
  maxFiles: 10,
  maxTotalBase64: 25 * 1024 * 1024,
  maxPdfBytes: 5 * 1024 * 1024,
  maxSubject: 200,
  maxLetter: 5000,
  sendsPerHour: 30,
});

// send-packet-email's recipient shape, so the two send paths accept the same
// addresses.
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']{2,}$/;

export const normalizeAddress = (value) => String(value ?? "").trim().toLowerCase();
export const isEmailAddress = (value) => EMAIL_RE.test(normalizeAddress(value));

/** Why an address cannot receive the invoice, or null when it can. */
export function recipientProblem(to) {
  const address = normalizeAddress(to);
  if (!address) return "Enter the billing office's email address.";
  if (!EMAIL_RE.test(address)) return "Enter a valid recipient email address.";
  if (/@(?:[a-z0-9-]+\.)*credentialdomd\.com$/.test(address)) return "That is a CredentialDOMD address. Enter the billing office's email.";
  return null;
}

/** Header-safe display text: no line breaks, quotes or angle brackets. */
function cleanHeaderText(value, max = 80) {
  return String(value ?? "").replace(/[\r\n"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Who the email is from and where answers go, from the physician's profile
 * row. `verifiedEmail` is profiles.verified_email (the mailbox the sign-in
 * provider proved); `email` is profiles.email (typed in Settings). The
 * verified one wins because it is the address the physician is known to
 * read. { ok: false, problem } when neither is a usable address.
 */
export function invoiceEmailSender({ name, degree, email, verifiedEmail } = {}) {
  const who = cleanHeaderText(name);
  const deg = cleanHeaderText(degree, 20);
  const verified = normalizeAddress(verifiedEmail);
  const typed = normalizeAddress(email);
  const replyTo = EMAIL_RE.test(verified) ? verified : EMAIL_RE.test(typed) ? typed : "";
  if (!replyTo) return { ok: false, problem: "Add your email in Settings first: replies and your copy need somewhere to land." };
  const displayName = who ? `${who}${deg ? `, ${deg}` : ""}` : replyTo;
  const fromName = who ? `${displayName} via CredentialDOMD` : "CredentialDOMD";
  return { ok: true, displayName, fromName, from: `"${fromName}" <${INVOICE_EMAIL_FROM_ADDRESS}>`, replyTo, cc: replyTo };
}

/** One line, no em dash, nothing SSN-shaped, at most 200 characters. */
export function invoiceEmailSubject(subject) {
  return scrubSsn(plainDashes(String(subject ?? "").replace(/[\r\n\u{2028}\u{2029}]+/gu, " ")))
    .replace(/\s+/g, " ").trim().slice(0, INVOICE_EMAIL_CAPS.maxSubject);
}

/** The last line of every invoice email: who it is from and where a reply goes. */
export function invoiceEmailFooter(displayName) {
  return `Sent from CredentialDOMD on behalf of ${displayName}. Reply to this email to reach ${displayName} directly.`;
}

/**
 * The letter as it is sent: every kind of line break becomes "\n" (Resend
 * sends text/plain with CRLF on the wire), trailing spaces and runs of blank
 * lines are tidied, no em dash, nothing SSN-shaped, then the footer. The
 * paragraph structure the letter was written with is kept exactly.
 */
export function invoiceEmailText(letter, displayName) {
  const body = scrubSsn(plainDashes(String(letter ?? "").replace(/\r\n?|[\u{2028}\u{2029}]/gu, "\n")))
    .split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${body}\n\n${invoiceEmailFooter(displayName)}`;
}

// The two sentences invoiceCover.js writes when receipts ride in a message
// ("The receipt is attached." / "3 receipts are attached."). Any other wording
// that pairs a receipt with "attached" is a claim this module cannot count,
// and is refused rather than guessed at.
const ONE_RECEIPT = /\bThe receipt is attached\./g;
const MANY_RECEIPTS = /\b(\d+) receipts are attached\./g;
const ANY_RECEIPT_CLAIM = /\breceipts?\b[^.\n]{0,60}\battached\b/gi;

/**
 * How many receipts the text says are attached: 0 when it claims none, the
 * number when it uses the app's own wording once, null when it makes a claim
 * in some other form (or more than once) that cannot be checked.
 */
export function receiptsClaimed(text) {
  const s = String(text ?? "");
  const ones = s.match(ONE_RECEIPT) || [];
  const manys = [...s.matchAll(MANY_RECEIPTS)];
  const any = s.match(ANY_RECEIPT_CLAIM) || [];
  if (any.length === 0) return 0;
  if (ones.length + manys.length !== 1 || any.length !== 1) return null;
  return ones.length ? 1 : Number(manys[0][1]);
}

/** Why the letter cannot go with `attached` receipts, or null when its claim is exact. */
export function receiptClaimProblem(text, attached) {
  const claimed = receiptsClaimed(text);
  const n = Math.max(0, Math.floor(Number(attached) || 0));
  if (claimed === null) return "The letter describes attached receipts in a form the app did not write. Open the invoice and try again.";
  if (claimed === n) return null;
  if (claimed > n) return `The letter says ${claimed === 1 ? "a receipt is" : `${claimed} receipts are`} attached, but ${n === 0 ? "none is" : `only ${n} ${n === 1 ? "is" : "are"}`}. Nothing was sent.`;
  return `${n} ${n === 1 ? "receipt rides" : "receipts ride"} with the invoice, but the letter does not say so. Nothing was sent.`;
}

/** A filename a mail client will open: no path characters, at most 180 characters. */
export function safeAttachmentName(name, fallback = "attachment") {
  // eslint-disable-next-line no-control-regex
  const n = String(name ?? "").trim().replace(/[\\/:*?"<>|\u{0}-\u{1f}]/gu, "_").slice(0, 180);
  return n || fallback;
}

/** The invoice PDF's filename, from its number. */
export function invoicePdfName(number) {
  const base = safeAttachmentName(`${String(number ?? "").trim() || "invoice"}.pdf`, "invoice.pdf");
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

/** Give a second "receipt.jpg" the name "receipt (2).jpg" so the recipient can tell them apart. */
export function uniqueAttachmentNames(names) {
  const taken = new Set();
  return (names || []).map((raw, i) => {
    const name = safeAttachmentName(raw, `attachment-${i + 1}`);
    if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let k = 2; ; k++) {
      const candidate = `${base} (${k})${ext}`;
      if (!taken.has(candidate.toLowerCase())) { taken.add(candidate.toLowerCase()); return candidate; }
    }
  });
}

/** Base64 length of `bytes` bytes: what counts against the 25 MB cap. */
export const base64Length = (bytes) => Math.ceil(Math.max(0, Number(bytes) || 0) / 3) * 4;

/**
 * The whole message as the recipient will see it. The app shows this as the
 * preview; the edge function sends exactly this (plus the file bytes).
 * `attachments` is the ordered list of { name }: the invoice PDF first, then
 * the receipts.
 */
export function composeInvoiceEmail({ sender, to, subject, letter, attachments = [] }) {
  const recipient = normalizeAddress(to);
  return {
    from: sender.from,
    fromName: sender.fromName,
    to: recipient,
    // The physician's copy. Dropped when the physician IS the recipient (a
    // test send to themselves), so the same inbox does not get it twice.
    cc: recipient === sender.cc ? "" : sender.cc,
    replyTo: sender.replyTo,
    subject: invoiceEmailSubject(subject),
    text: invoiceEmailText(letter, sender.displayName),
    attachments: uniqueAttachmentNames(attachments.map((a) => a?.name)),
  };
}
