import { formatDate } from "./helpers.js";

/**
 * Everything an invoice SAYS, in one pure module: the subject line, the
 * flowing share-sheet blurb, the multi-paragraph cover letter, the money
 * and period wording, and the text-invoice rule. No DOM, no jsPDF, so the
 * wording is unit-testable (scripts/invoice-cover.test.mjs) and every send
 * site reads the same numbers the same way.
 *
 * Channel facts this module is shaped by (verified on Eric's iPhone):
 *  - iOS Mail HTML-renders text shared with a file and drops every line
 *    break, CRLF included, so the blurb has to read as one paragraph. Only
 *    "\n" and CRLF were ever tried; U+2028, U+2029 and <br> were not. The
 *    in-app probe (src/utils/shareProbe.js, Help & FAQ for admins) settles
 *    that; the blurb separator does not change until it has been run.
 *  - iOS Mail can promote the first line of shared text to the subject, so
 *    the blurb leads with a short subject-worthy line.
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

/** Where the money stands, read the same way by every document and cover. */
export function invoicePayment(inv = {}) {
  const total = parseFloat(inv.total) || 0;
  const paid = Math.max(0, parseFloat(inv.paid) || 0);
  const balance = inv.balance != null && inv.balance !== ""
    ? Math.max(0, parseFloat(inv.balance) || 0)
    : Math.max(0, total - paid);
  const hasPayment = paid > 0.005;
  return {
    total, paid, balance, hasPayment,
    partial: hasPayment && balance > 0.005,
    settled: hasPayment && balance <= 0.005,
  };
}

/** "Aug 1, 2026 through Aug 15, 2026", "Aug 1, 2026" for a single day, "" when unknown. */
export function invoicePeriod(inv = {}) {
  if (!inv.periodStart) return "";
  const a = formatDate(inv.periodStart);
  const b = inv.periodEnd && inv.periodEnd !== inv.periodStart ? formatDate(inv.periodEnd) : "";
  return b ? `${a} through ${b}` : a;
}

/** One subject line for every channel: share title, mailto subject, blurb lead. */
export function invoiceSubject(inv = {}) {
  const who = inv.physician ? ` from ${inv.physician}` : "";
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

const signature = (inv) => [inv.physician || "", inv.npi ? `NPI ${inv.npi}` : "", inv.email || ""].filter(Boolean);

/**
 * Share-sheet text. First line is subject-worthy (iOS Mail may promote it),
 * then one flowing paragraph that still reads correctly with every line
 * break stripped. `attached` is false when the invoice text follows the
 * blurb in the same body instead of riding as a file.
 *
 * Every navigator.share() caller passes this alongside its own `title`
 * (which the OS uses as the Subject), so the lead sentence already names
 * the invoice number, physician, and facility once. The paragraph below it
 * doesn't repeat them -- restating all three again read as a wall of text.
 */
export function invoiceCoverBlurb(inv = {}, { attached = true } = {}) {
  const pay = invoicePayment(inv);
  const moneyText = pay.partial
    ? `Invoice total: ${money(pay.total)}. Paid to date: ${money(pay.paid)}. Balance due: ${money(pay.balance)}.`
    : pay.settled
      ? `Invoice total: ${money(pay.total)}, paid in full.`
      : `Total due: ${money(pay.total)}.`;
  const sig = signature(inv);
  const contact = sig.slice(1).join(", ");
  const thanks = `Thank you, ${sig[0] || "the physician"}${contact ? ` (${contact})` : ""}.`;
  const period = invoicePeriod(inv);
  const which = attached ? "The attached invoice" : "The invoice below";
  const coverageSentence = isExpenses(inv)
    ? `${which} covers ${whereLine(inv)}.`
    : period
      ? `${which} covers ${period}.`
      : `${attached ? "The attached invoice is ready for review." : "The invoice is below."}`;
  const receipts = receiptsLine(inv);
  // Trailing space after the lead: if Mail strips the newlines the lead and
  // the paragraph still read as two sentences.
  return `${invoiceSubject(inv)}. \n\n`
    + `${coverageSentence} ${moneyText} `
    + `${itemizes(inv, "It")} ${receipts ? `${receipts} ` : ""}`
    + `Please reach out with any questions. ${thanks}`;
}

/**
 * The long-form cover letter: pasted from the clipboard, or used as a
 * mailto: body (mailtoHref converts the "\n" breaks to CRLF). Money lands on
 * its own lines so a partial payment reads at a glance. `attached` is false
 * when the invoice text is pasted under the letter instead of riding as a
 * file (the long legacy-text resend with no file share available).
 */
export function invoiceCoverEmail(inv = {}, { attached = true } = {}) {
  const pay = invoicePayment(inv);
  const moneyLines = pay.partial
    ? [`Invoice total: ${money(pay.total)}`, `Paid to date: ${money(pay.paid)}`, `Balance due: ${money(pay.balance)}`]
    : pay.settled
      ? [`Invoice total: ${money(pay.total)}`, "Paid in full. No balance is due."]
      : [`Total due: ${money(pay.total)}`];
  const receipts = receiptsLine(inv);
  const paras = [
    "Hello,",
    `${attached ? "Attached" : "Below"} is invoice ${inv.number || ""} for ${whereLine(inv)}.`,
    moneyLines.join("\n"),
    `${itemizes(inv, "The invoice")} ${receipts ? `${receipts} ` : ""}Please reach out with any questions.`,
    ["Thank you,", ...signature(inv)].join("\n"),
  ];
  return paras.join("\n\n");
}

/**
 * The share body when NO file can ride along (the installed app on a device
 * whose share sheet refuses files). Nothing is attached, so the recipient
 * gets the cover letter and the itemized invoice itself, multi-line, instead
 * of a one-paragraph blurb that promises an invoice "below" and a paste
 * instruction meant for the sender (ticket 821d2f76).
 * Callers only take this path when they hold the invoice text.
 */
export function invoiceTextOnlyShare(inv = {}, text = "") {
  const invoice = normalizeInvoiceText(text).trim();
  return [invoiceCoverEmail(inv, { attached: false }), invoice].filter(Boolean).join("\n\n");
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
