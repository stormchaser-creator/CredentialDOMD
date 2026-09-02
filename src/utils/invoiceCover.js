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
 *    break, CRLF included, so the blurb has to read as one paragraph.
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

const whereLine = (inv) => {
  const period = invoicePeriod(inv);
  return `physician services at ${inv.facility || "your facility"}${inv.agency ? ` (via ${inv.agency})` : ""}${period ? `, covering ${period}` : ""}`;
};

const signature = (inv) => [inv.physician || "", inv.npi ? `NPI ${inv.npi}` : "", inv.email || ""].filter(Boolean);

/**
 * Share-sheet text. First line is subject-worthy (iOS Mail may promote it),
 * then one flowing paragraph that still reads correctly with every line
 * break stripped. `attached` is false when the invoice text follows the
 * blurb in the same body instead of riding as a file.
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
  // Trailing space after the lead: if Mail strips the newlines the lead and
  // the paragraph still read as two sentences.
  return `${invoiceSubject(inv)}. \n\n`
    + `${attached ? "Attached" : "Below"} is invoice ${inv.number || ""} for ${whereLine(inv)}. ${moneyText} `
    + "The invoice itemizes each day of coverage and the work performed under the terms of our agreement. "
    + `Please reach out with any questions. ${thanks}`;
}

/**
 * The long-form cover letter: pasted from the clipboard, or used as a
 * mailto: body (mailtoHref converts the "\n" breaks to CRLF). Money lands on
 * its own lines so a partial payment reads at a glance.
 */
export function invoiceCoverEmail(inv = {}) {
  const pay = invoicePayment(inv);
  const moneyLines = pay.partial
    ? [`Invoice total: ${money(pay.total)}`, `Paid to date: ${money(pay.paid)}`, `Balance due: ${money(pay.balance)}`]
    : pay.settled
      ? [`Invoice total: ${money(pay.total)}`, "Paid in full. No balance is due."]
      : [`Total due: ${money(pay.total)}`];
  const paras = [
    "Hello,",
    `Attached is invoice ${inv.number || ""} for ${whereLine(inv)}.`,
    moneyLines.join("\n"),
    "The invoice itemizes each day of coverage and the work performed under the terms of our agreement. Please reach out with any questions.",
    ["Thank you,", ...signature(inv)].join("\n"),
  ];
  return paras.join("\n\n");
}
