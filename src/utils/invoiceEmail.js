import { plainDashes, scrubSsn, withDegree, oneDegree } from "./outgoingText.js";

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
 * arrived as one run-on paragraph. Mail the server sends is multipart: a
 * text/plain part with real line breaks and an HTML part built from the very
 * same letter (invoiceEmailHtml), with real paragraphs, the money set apart
 * and a signature block. Nothing between here and the billing office
 * rewrites either one.
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
  // A name typed as "Jordan Rivera, DO" is not signed "Jordan Rivera, DO, DO".
  const displayName = who ? withDegree(who, deg) : replyTo;
  const fromName = who ? `${displayName} via CredentialDOMD` : "CredentialDOMD";
  return { ok: true, displayName, fromName, from: `"${fromName}" <${INVOICE_EMAIL_FROM_ADDRESS}>`, replyTo, cc: replyTo };
}

/** One line, no em dash, nothing SSN-shaped, at most 200 characters. */
export function invoiceEmailSubject(subject) {
  return scrubSsn(plainDashes(String(subject ?? "").replace(/[\r\n\u{2028}\u{2029}]+/gu, " ")))
    .replace(/\s+/g, " ").trim().slice(0, INVOICE_EMAIL_CAPS.maxSubject);
}

/**
 * The last line of every invoice email: who it is from and where a reply
 * goes. A name that already ends in a period ("Jordan Rivera, D.O.") ends the
 * sentence itself, so no second period is added after it.
 */
export function invoiceEmailFooter(displayName) {
  const stop = /\.$/.test(String(displayName ?? "")) ? "" : ".";
  return `Sent from CredentialDOMD on behalf of ${displayName}${stop} Reply to this email to reach ${displayName} directly.`;
}

/**
 * The letter's body as it is sent: every kind of line break becomes "\n"
 * (Resend sends text/plain with CRLF on the wire), trailing spaces and runs
 * of blank lines are tidied, no em dash, nothing SSN-shaped. The paragraph
 * structure the letter was written with is kept exactly.
 */
function letterBody(letter) {
  return scrubSsn(plainDashes(String(letter ?? "").replace(/\r\n?|[\u{2028}\u{2029}]/gu, "\n")))
    .split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text/plain part: the letter's body, then the footer. */
export function invoiceEmailText(letter, displayName) {
  return `${letterBody(letter)}\n\n${invoiceEmailFooter(displayName)}`;
}

// ── The HTML part ──
//
// Built from the same letter as the text part, so the two can never say
// different things. Inline styles only (mail clients drop <style> blocks and
// never load external CSS), no images, no fixed text colours apart from the
// grey of quiet lines, so a client in dark mode keeps its own light-on-dark
// text. One column at most 560 px wide, readable at 375 px. Every character
// of the letter is HTML-escaped: the letter carries names, facilities and
// agencies the member typed.

const escapeHtml = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// "Balance due: $1,525.00" (a money line the cover letter writes on its own
// line). The trailing period is optional so a sentence-style line counts too.
const MONEY_LINE = /^([A-Za-z][A-Za-z ]{0,38}):\s+(-?\$[\d,]+\.\d{2,4})\.?$/;
const SIGN_OFF = /^(?:thank you|thanks|regards|best regards|kind regards|sincerely|best),?$/i;
const QUIET = "#6b7280";
const RULE = "#d1d5db";
const P = "margin:0 0 14px 0;";

function moneyBlock(lines) {
  const rows = lines.map((line, i) => {
    const m = line.match(MONEY_LINE);
    const last = i === lines.length - 1;
    const strong = last ? "font-weight:700;" : "";
    const rule = last && lines.length > 1 ? `border-top:1px solid ${RULE};` : "";
    if (!m) return `<tr><td colspan="2" style="padding:4px 0;${rule}${strong}">${escapeHtml(line)}</td></tr>`;
    return `<tr><td style="padding:4px 16px 4px 0;${rule}${strong}">${escapeHtml(m[1])}</td>`
      + `<td style="padding:4px 0;text-align:right;white-space:nowrap;${rule}${strong}">${escapeHtml(m[2])}</td></tr>`;
  }).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px 0;width:100%;max-width:340px;font-size:15px;">${rows}</table>`;
}

// A signature line that is a contact detail, not a name: "NPI 1234567890",
// an email address, a phone number. With no name in Settings the letter's
// signature starts with one of these, and it is never set in bold as if it
// were the physician's name.
const CONTACT_LINE = /^NPI\b|@|^\+?[\d(][\d\s().-]*$/;

function signatureBlock(lines) {
  const [closing, ...after] = lines;
  const named = after.length && !CONTACT_LINE.test(after[0]);
  const name = named ? after[0] : "";
  const rest = named ? after.slice(1) : after;
  const quiet = (l) => `<span style="color:${QUIET};font-size:14px;">${escapeHtml(l)}</span>`;
  const body = [...(name ? [`<strong>${escapeHtml(name)}</strong>`] : []), ...rest.map(quiet)].join("<br>");
  return `<p style="margin:20px 0 0 0;">${escapeHtml(closing)}</p>`
    + (body ? `<p style="margin:4px 0 0 0;">${body}</p>` : "");
}

/**
 * The HTML body (the part inside <body>), from the same letter as the text
 * part: a paragraph per paragraph, a paragraph that is all money lines as a
 * two-column block, the closing paragraph ("Thank you," then the name and
 * contact lines) as a signature block, then the footer in small grey type.
 * No raw line break is left inside a text node: a line break in the letter
 * becomes <br>, so nothing depends on how a client treats whitespace.
 */
export function invoiceEmailHtmlBody(letter, displayName) {
  const paras = letterBody(letter).split("\n\n").map((p) => p.split("\n").map((l) => l.trim()).filter(Boolean)).filter((p) => p.length);
  const blocks = paras.map((lines, i) => {
    if (MONEY_LINE.test(lines[0]) && lines.every((l) => MONEY_LINE.test(l) || /^[A-Z][^:]*\.$/.test(l))) return moneyBlock(lines);
    if (i === paras.length - 1 && SIGN_OFF.test(lines[0])) return signatureBlock(lines);
    return `<p style="${P}">${lines.map(escapeHtml).join("<br>")}</p>`;
  });
  const footer = `<p style="margin:28px 0 0 0;padding-top:12px;border-top:1px solid ${RULE};color:${QUIET};font-size:12px;line-height:1.5;">${escapeHtml(invoiceEmailFooter(displayName))}</p>`;
  return `<div style="max-width:560px;margin:0 auto;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;overflow-wrap:break-word;">${blocks.join("")}${footer}</div>`;
}

/** The HTML part: a whole document around invoiceEmailHtmlBody, light and dark. */
export function invoiceEmailHtml(letter, displayName) {
  return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    + "<meta name=\"color-scheme\" content=\"light dark\"><meta name=\"supported-color-schemes\" content=\"light dark\">"
    + `</head><body style="margin:0;padding:0;">${invoiceEmailHtmlBody(letter, displayName)}</body></html>`;
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

/**
 * text cut to at most max characters at the end of a whole word, with a ","
 * the cut leaves behind dropped. A single word too long to keep whole (a
 * name with no spaces) is cut inside it instead of dropping the name.
 */
function cutAtWord(text, max) {
  // Up to max characters plus the next one: when that one is a space, the
  // last word inside the limit is whole and stays.
  const cut = text.slice(0, max + 1).replace(/\s+\S*$/, "").replace(/[,\s]+$/, "");
  if (!/\sfrom$/.test(cut)) return cut;
  return text.slice(0, max).replace(/[.,\s]+$/, "");
}

/**
 * An invoice file's name: "Invoice INV-20260915-1 from Al Li, DO.pdf". Gmail
 * on the iPhone takes a shared file's name (without its extension) as the
 * subject and ignores the share title, so the name has to read as a subject:
 * the word Invoice, the number and who it is from. The facility is left out
 * (long hospital names made 130-character names). Filesystem safe, no em
 * dash, at most 100 characters before the extension. The "Physician"
 * placeholder (no name in Settings) is not a sender.
 */
export function invoiceFileName(inv = {}, ext = "pdf") {
  const who = oneDegree(inv?.physician);
  const from = who && who !== "Physician" ? ` from ${who}` : "";
  const whole = plainDashes(`Invoice ${String(inv?.number ?? "").trim()}${from}`)
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u{0}-\u{1f}]/gu, " ")
    .replace(/\s+/g, " ").trim();
  // A name that ends "D.O." keeps its period: "...Rivera, D.O..pdf" is a
  // valid file name everywhere (the dot is not the last character), and the
  // Gmail subject, the name less ".pdf", reads "...Rivera, D.O." whole. A
  // name over 100 characters is cut back to the last whole word, so neither
  // a partial word ("Montenegr") nor a partial degree ("D" of "D.O.") is
  // left, and a "," the cut leaves behind is dropped too.
  const base = whole.length > 100 ? cutAtWord(whole, 100) : whole;
  return `${base || "Invoice"}.${ext}`;
}

/**
 * The invoice PDF's attachment name on the email the server sends. That
 * email sets its own subject, so the period a dotted degree keeps for the
 * Gmail share (invoiceFileName) only shows here as "D.O..pdf": it is dropped
 * ("...Rivera, D.O.pdf").
 */
export function invoicePdfName(number, physician = "") {
  const base = safeAttachmentName(invoiceFileName({ number, physician }, "pdf"), "Invoice.pdf")
    .replace(/\.pdf$/i, "").replace(/[.\s]+$/, "");
  return `${base || "Invoice"}.pdf`;
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
    html: invoiceEmailHtml(letter, sender.displayName),
    attachments: uniqueAttachmentNames(attachments.map((a) => a?.name)),
  };
}
