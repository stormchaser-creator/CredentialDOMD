import { formatDate } from "./helpers.js";
import { invoiceFileName } from "./invoiceEmail.js";
import { oneDegree } from "./outgoingText.js";

// The one file name every invoice file carries ("Invoice INV-1 from Al Li,
// DO.pdf"): Gmail on the iPhone takes it as the subject.
export { invoiceFileName };

/**
 * Everything an invoice SAYS, in one pure module: the subject line, the
 * flowing share-sheet blurb, the multi-paragraph cover letter, the money
 * and period wording, and the text-invoice rule. No DOM, no jsPDF, so the
 * wording is unit-testable (scripts/invoice-cover.test.mjs) and every send
 * site reads the same numbers the same way.
 *
 * Channel facts this module is shaped by (verified on Eric's iPhone):
 *  - iOS Mail and the Gmail app HTML-render text shared with a file into one
 *    <div> and drop every line break, CRLF included, so the blurb has to
 *    read as a short email both as one paragraph and with its breaks kept.
 *    It is kept short for that reason (four sentences, signed with the name
 *    alone); the paragraphs themselves only arrive through the server-sent
 *    email (invoiceEmail.js, Send by email on the Invoices tab).
 *    U+2028 draws a line break in WebKit but a space in Chromium (Gmail on
 *    the web, Outlook on the web), and a text/plain part carries it raw, so
 *    the blurb keeps plain "\n" (BLURB_BREAK) until the in-app probe
 *    (src/utils/shareProbe.js, Help & FAQ for admins) has been run.
 *  - Gmail on the iPhone takes the subject from the first file's name and
 *    ignores the share title, so every invoice file is named like a subject
 *    (invoiceFileName).
 *  - A mailto: body keeps its breaks only as CRLF (RFC 6068). mailtoHref does
 *    that conversion; builders here emit plain "\n" so the clipboard copy
 *    pastes cleanly everywhere.
 *  - iOS Mail silently cuts a mailto: body off around 2,000 characters.
 */

// Locale pinned: a phone set to another region must not turn $1,250.00 into
// "1.250,00" on a US hospital's invoice.
export const money = (n) => {
  const v = parseFloat(n) || 0;
  const abs = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${abs}` : `$${abs}`;
};

// Raw-body ceiling for a mailto: link. iOS Mail truncates somewhere near
// 2,000 characters of body; percent-encoding grows the URL further, so the
// guard sits under that with margin.
export const MAILTO_BODY_MAX = 1800;

// Rule line for the plain-text invoice. ASCII hyphens: box-drawing glyphs
// fall back to a wide symbol font in Mail and a 40-wide run wrapped onto a
// second line on an iPhone. 30 hyphens fit every phone width.
export const TEXT_RULE = "-".repeat(30);

/** Text invoices saved with the old wide box-drawing rule get the safe one on resend. */
export function normalizeInvoiceText(text) {
  return String(text || "").replace(/[─━┄┅┈┉═]{2,}/g, TEXT_RULE).replace(/\r\n?/g, "\n");
}

/**
 * Where the money stands, read the same way by every document and cover.
 * Paid in full means the payments reached the total: a balance of 0 that
 * came from anything else (an invoice written off after a partial payment)
 * still owes total - paid on paper, and never prints PAID IN FULL.
 */
export function invoicePayment(inv = {}) {
  const total = parseFloat(inv.total) || 0;
  const paid = Math.max(0, parseFloat(inv.paid) || 0);
  const hasPayment = paid > 0.005;
  const settled = hasPayment && paid >= total - 0.005;
  const stated = inv.balance != null && inv.balance !== ""
    ? Math.max(0, parseFloat(inv.balance) || 0)
    : Math.max(0, total - paid);
  const balance = settled ? 0 : stated > 0.005 ? stated : Math.max(0, total - paid);
  return {
    total, paid, balance, hasPayment,
    partial: hasPayment && !settled,
    settled,
  };
}

/** "Aug 1, 2026 through Aug 15, 2026", "Aug 1, 2026" for a single day, "" when unknown. */
export function invoicePeriod(inv = {}) {
  if (!inv.periodStart) return "";
  const a = formatDate(inv.periodStart);
  const b = inv.periodEnd && inv.periodEnd !== inv.periodStart ? formatDate(inv.periodEnd) : "";
  return b ? `${a} through ${b}` : a;
}

/**
 * The dates as a document prints them: "Aug 1, 2026 – Aug 31, 2026", one
 * date for a one-day invoice, "" when unknown. The PDF header, Word, Excel
 * and the text invoice all print this; prose (the covers) says "through".
 */
export function invoicePeriodRange(inv = {}) {
  if (!inv.periodStart) return "";
  const a = formatDate(inv.periodStart);
  return inv.periodEnd && inv.periodEnd !== inv.periodStart ? `${a} \u{2013} ${formatDate(inv.periodEnd)}` : a;
}

/** What a document calls its dates: an expense invoice bills no services. */
export const invoicePeriodLabel = (inv = {}) => (inv.kind === "expenses" ? "Expense dates" : "Service period");

/**
 * The physician's name, or "" for the "Physician" placeholder a profile with
 * no name gets. A degree printed twice by a send site ("Jordan Rivera, DO,
 * DO") reads once: the subject, file name, covers and documents all go
 * through here.
 */
export const senderName = (inv = {}) => {
  const n = oneDegree(inv.physician);
  return n === "Physician" ? "" : n;
};

/** One subject line for every channel: share title, mailto subject. */
export function invoiceSubject(inv = {}) {
  const name = senderName(inv);
  const who = name ? ` from ${name}` : "";
  const to = inv.facility ? ` for ${inv.facility}` : "";
  return `Invoice ${inv.number || ""}${who}${to}`.replace(/\s+/g, " ").trim();
}

// Expense invoices (kind "expenses", billed to the agency) are not physician
// services and have no days of coverage; they say what they are.
const isExpenses = (inv) => inv.kind === "expenses";

const whereLine = (inv) => {
  const period = invoicePeriod(inv);
  if (isExpenses(inv)) return `reimbursable travel expenses${period ? ` incurred ${period}` : ""}`;
  return `physician services at ${inv.facility || "your facility"}${inv.agency ? ` (via ${inv.agency})` : ""}${period ? `, covering ${period}` : ""}`;
};

const itemizes = (inv, lead) => (isExpenses(inv)
  ? `${lead} lists each expense by date.`
  : `${lead} itemizes each day of coverage and the work performed under the terms of our agreement.`);

// Only a count of receipts that actually ride in this send may claim an
// attachment; an agency was once told receipts were attached that never were.
const receiptsLine = (inv) => {
  const n = Math.max(0, Math.floor(Number(inv.receipts) || 0));
  if (!isExpenses(inv) || !n) return "";
  return n === 1 ? "The receipt is attached." : `${n} receipts are attached.`;
};

// The signature: name with degree, NPI, email, phone (whatever the profile
// has), in the PDF's FROM order. With no name the email signs, ahead of the
// NPI, so the NPI never stands where the sender's name belongs.
const signature = (inv) => {
  const name = senderName(inv);
  const email = String(inv.email || "").trim();
  return [name || email, inv.npi ? `NPI ${inv.npi}` : "", name ? email : "", inv.phone || ""]
    .map((s) => String(s).trim()).filter(Boolean);
};

// Between the blurb's paragraphs. Plain "\n" until the share probe has been
// run on the owner's iPhone (see the header): every paragraph is written to
// read as a sentence when a mail app collapses the breaks into spaces.
export const BLURB_BREAK = "\n";

const blurbMoney = (pay) => (pay.partial
  ? `Balance due: ${money(pay.balance)} (invoice total ${money(pay.total)}, paid to date ${money(pay.paid)}).`
  : pay.settled
    ? `Invoice total: ${money(pay.total)}, paid in full.`
    : `Total due: ${money(pay.total)}.`);

/**
 * Share-sheet text: the short email a mail app puts above the attached
 * invoice. It has to read as a professional email twice over: with its line
 * breaks (greeting, the one sentence that says what is attached, the money
 * on its own line, an offer to answer questions, the sign-off and a one-line
 * signature) and with every break collapsed into a space, as the Gmail app
 * and iOS Mail render it (then it reads "Hello, attached is invoice ... Total
 * due: $1,500.00. Please reach out with any questions. Thank you, Al Li,
 * DO"). It does not restate the subject: the file name and the share title
 * carry that. It signs with the name alone: the NPI, email and phone ran
 * inline after it in the collapsed form ("Thank you, Al Li, DO · NPI ... ·
 * email · phone", wrapping mid-address on a phone), and the attached
 * invoice already prints them under FROM and on its questions line. The
 * clipboard letter and the server email keep the full signature. `attached`
 * is false when the invoice text follows the blurb in the same body instead
 * of riding as a file.
 */
export function invoiceCoverBlurb(inv = {}, { attached = true } = {}) {
  const pay = invoicePayment(inv);
  const receipts = receiptsLine(inv);
  return [
    blurbLead(inv, attached),
    [blurbMoney(pay), receipts].filter(Boolean).join(" "),
    ...blurbClose(inv, { short: true }),
  ].join(BLURB_BREAK + BLURB_BREAK);
}

const blurbLead = (inv, attached) => `Hello, ${attached ? "attached" : "below"} is invoice ${inv.number || ""} for ${whereLine(inv)}.`.replace(/\s+/g, " ");
// The sign-off. `short` (a file rides along and carries the contact lines)
// signs with the name, or the email when the profile has no name; otherwise
// the whole signature, the only place the recipient finds the NPI, email
// and phone.
const blurbClose = (inv, { short = false } = {}) => {
  const sig = short ? [senderName(inv) || String(inv.email || "").trim()].filter(Boolean) : signature(inv);
  return ["Please reach out with any questions.", sig.length ? `Thank you,${BLURB_BREAK}${sig.join(" \u{b7} ")}` : "Thank you."];
};

/**
 * The long-form cover letter: pasted from the clipboard, used as a mailto:
 * body (mailtoHref converts the "\n" breaks to CRLF), and the letter the
 * server-sent email is built from (text and HTML parts). Money lands on its
 * own lines, each a sentence, so a partial payment reads at a glance and a
 * collapsed body still reads as sentences. `attached` is false when the
 * invoice text is pasted under the letter instead of riding as a file.
 */
export function invoiceCoverEmail(inv = {}, { attached = true } = {}) {
  const pay = invoicePayment(inv);
  const moneyLines = pay.partial
    ? [`Invoice total: ${money(pay.total)}`, `Paid to date: ${money(pay.paid)}`, `Balance due: ${money(pay.balance)}`]
    : pay.settled
      ? [`Invoice total: ${money(pay.total)}`, "Paid in full. No balance is due."]
      : [`Total due: ${money(pay.total)}`];
  const receipts = receiptsLine(inv);
  const sig = signature(inv);
  const paras = [
    "Hello,",
    `${attached ? "Attached" : "Below"} is invoice ${inv.number || ""} for ${whereLine(inv)}.`,
    moneyLines.map((l) => (/[.]$/.test(l) ? l : `${l}.`)).join("\n"),
    `${itemizes(inv, "The invoice")} ${receipts ? `${receipts} ` : ""}Please reach out with any questions.`,
    sig.length ? ["Thank you,", ...sig].join("\n") : "Thank you.",
  ];
  return paras.join("\n\n");
}

/**
 * The share body when NO file can ride along (the installed app on a device
 * whose share sheet refuses files), and the short mailto: body of a legacy
 * text invoice. Nothing is attached, so the recipient gets the invoice in the
 * message itself: a greeting that says it follows, the itemized invoice, an
 * offer to answer questions and the sign-off last (never a one-paragraph
 * blurb that promises an invoice "below" with nothing below, ticket 821d2f76).
 * `text` is the itemized invoice; callers that hold the lines pass it as
 * sentences, one line per day (invoiceSentenceText), so a mail app that
 * collapses the breaks still shows readable sentences.
 */
export function invoiceTextOnlyShare(inv = {}, text = "") {
  const invoice = normalizeInvoiceText(text).trim();
  return [blurbLead(inv, false), invoice, ...blurbClose(inv)].filter(Boolean).join("\n\n");
}

/**
 * What the SENDER is told after an invoice send, from the method string the
 * send helpers return ("share+cover", "download+cover", "share-text", ...).
 * The long cover letter only reaches the recipient if it is pasted, so every
 * send site says where it is. null when there is nothing to say.
 */
export const INVOICE_COVER_ON_CLIPBOARD = "The full cover letter is on your clipboard: paste it over Mail's short intro if you want the long form.";
export const INVOICE_COVER_FOR_EMAIL = "The cover letter is on your clipboard, ready to paste into your email.";
export function invoiceCoverNotice(how) {
  const h = String(how || "");
  if (!h.includes("+cover") || h.startsWith("share-text")) return null;
  if (h.startsWith("share")) return `Sent with a short intro that reads correctly in Mail. ${INVOICE_COVER_ON_CLIPBOARD}`;
  if (h.startsWith("download")) return `The invoice file downloaded. ${INVOICE_COVER_FOR_EMAIL}`;
  return null;
}

// ── Expense invoices: what the document says about receipts ──
//
// The invoice PDF itself used to print "receipts attached" in its terms and
// "receipt attached" on every line whose expense had a receipt on file,
// whether or not the file rode in the message. When the OS refused the
// bundle, a receipt could not be read, or the invoice was resent as Word or
// Excel, the agency got a bill claiming proof it never received (the same
// failure as the earlier incident). The terms no longer mention receipts,
// and each line says "attached" only for an expense whose receipts are all
// in this send, "on file" otherwise.

export const EXPENSE_INVOICE_TERMS = "Reimbursable travel expenses per agreement.";

const RECEIPT_STATUS = /^receipts? (?:attached|on file)$/;
const DETAIL_SEP = ` ${String.fromCodePoint(0xb7)} `;

/** A new expense line's detail: the physician's note, then its receipt status. */
export function expenseLineDetail(notes, receiptCount, attached = false) {
  const n = Math.max(0, Math.floor(Number(receiptCount) || 0));
  const status = n ? `${n > 1 ? "receipts" : "receipt"} ${attached ? "attached" : "on file"}` : "no receipt";
  return [String(notes || "").trim(), status].filter(Boolean).join(DETAIL_SEP);
}

/**
 * Rewrite expense lines for the files this send actually carries. A line
 * with an expenseId says "attached" only when that id is in
 * attachedExpenseIds. A line saved before lines carried expenseId says
 * "attached" only when `allAttached` (every receipt of the invoice is in
 * this send). Only the trailing receipt status is touched, never the note.
 */
export function expenseReceiptLines(lines = [], attachedExpenseIds = new Set(), { allAttached = false } = {}) {
  return (lines || []).map((line) => {
    const parts = String(line?.detail || "").split(DETAIL_SEP);
    const last = parts[parts.length - 1];
    if (!RECEIPT_STATUS.test(last)) return line;
    const attached = line.expenseId ? attachedExpenseIds.has(line.expenseId) : allAttached;
    parts[parts.length - 1] = `${last.startsWith("receipts") ? "receipts" : "receipt"} ${attached ? "attached" : "on file"}`;
    return { ...line, detail: parts.join(DETAIL_SEP) };
  });
}
