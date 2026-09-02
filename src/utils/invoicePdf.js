import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { formatDate, mailtoHref } from "./helpers.js";
import {
  money, invoicePayment, invoiceSubject, invoiceCoverBlurb, invoiceCoverEmail,
  normalizeInvoiceText, MAILTO_BODY_MAX,
} from "./invoiceCover.js";

// The wording lives in invoiceCover.js (pure, unit-tested); re-exported so
// every send site keeps importing from here.
export { invoiceSubject, invoiceCoverBlurb, invoiceCoverEmail, invoicePayment, normalizeInvoiceText };

/**
 * Professional PDF invoice — clean table, brand header, ready for a
 * hospital AP department. Returns a File suitable for navigator.share.
 */

const NAVY = [10, 37, 64];      // #0A2540
const EMERALD = [16, 185, 129]; // #10b981

/**
 * Chronological line order, even for invoices saved before lines carried
 * _sort keys: day by day → stipend → calls by clock time (pre-7am counts
 * as end of the call day) → other work → one-time orientation last.
 */
const parseDetailTime = (detail = "") => {
  const m = detail.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  let mins = h * 60 + parseInt(m[2], 10);
  if (mins < 7 * 60) mins += 24 * 60; // before 7am = tail of the call day
  return mins;
};
export function sortInvoiceLines(lines = []) {
  const rank = (l) =>
    !l.date ? 9
      : l.label?.startsWith("Call coverage") ? 0
        : l.label?.startsWith("Call") ? 1
          : 2;
  return [...lines].sort((a, b) => {
    if (a._sort && b._sort) return a._sort.localeCompare(b._sort);
    const d = (a.date || "9999").localeCompare(b.date || "9999");
    if (d) return d;
    const r = rank(a) - rank(b);
    if (r) return r;
    const ta = parseDetailTime(a.detail), tb = parseDetailTime(b.detail);
    if (ta != null && tb != null) return ta - tb;
    return 0;
  });
}

export function buildInvoicePdf(inv) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 16;

  // ── Header band ──
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, W, 30, "F");
  doc.setFillColor(...EMERALD);
  doc.rect(0, 30, W, 1.6, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("INVOICE", M, 19);
  doc.setFontSize(11);
  doc.text(inv.number || "", W - M, 14, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Issued ${formatDate(inv.issuedDate || new Date().toISOString().slice(0, 10))}`, W - M, 20, { align: "right" });
  if (inv.periodStart) {
    doc.text(
      `Service period ${formatDate(inv.periodStart)}${inv.periodEnd && inv.periodEnd !== inv.periodStart ? " – " + formatDate(inv.periodEnd) : ""}`,
      W - M, 25, { align: "right" }
    );
  }

  // ── From / Bill To ──
  let y = 42;
  doc.setTextColor(...EMERALD);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.text("FROM", M, y);
  doc.text("BILL TO", W / 2 + 4, y);
  doc.setTextColor(30, 30, 30);
  doc.setFontSize(10.5);
  y += 5.5;
  doc.text(inv.physician || "Physician", M, y);
  doc.text(inv.facility || "Facility", W / 2 + 4, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  let yL = y + 4.8, yR = y + 4.8;
  for (const line of [inv.npi ? `NPI ${inv.npi}` : null, inv.email].filter(Boolean)) {
    doc.text(String(line), M, yL); yL += 4.4;
  }
  for (const line of [inv.agency ? `via ${inv.agency}` : null, inv.location, inv.billTo].filter(Boolean)) {
    doc.text(String(line), W / 2 + 4, yR); yR += 4.4;
  }
  y = Math.max(yL, yR) + 4;

  // ── Line items table ──
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [["Date", "Item", "Details", "Amount"]],
    body: sortInvoiceLines(inv.lines).map(l => [
      l.date ? formatDate(l.date) : "",
      l.label || "",
      l.detail || "",
      l.amount == null ? (l.flag || "") : money(l.amount),
    ]),
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2.6, textColor: [40, 40, 40] },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 9 },
    alternateRowStyles: { fillColor: [243, 247, 245] },
    columnStyles: {
      0: { cellWidth: 24 },
      1: { cellWidth: 52, fontStyle: "bold" },
      3: { cellWidth: 26, halign: "right", fontStyle: "bold" },
    },
    didParseCell: (h) => {
      // Zero-dollar (stipend-covered) amounts render muted
      if (h.section === "body" && h.column.index === 3 && h.cell.raw === "$0.00") {
        h.cell.styles.textColor = [150, 150, 150];
        h.cell.styles.fontStyle = "normal";
      }
      // Work items under a daily total render as quiet sub-rows; their
      // amount cell shows "included" (green) or the beyond-stipend value
      if (h.section === "body" && h.row.raw && typeof h.row.raw[1] === "string" && h.row.raw[1].startsWith("· ")) {
        if (h.column.index === 1) h.cell.styles.fontStyle = "normal";
        h.cell.styles.textColor = [110, 110, 110];
        if (h.column.index === 3) {
          h.cell.styles.fontSize = 7.5;
          h.cell.styles.fontStyle = "normal";
          if (h.cell.raw === "included") h.cell.styles.textColor = [16, 150, 105];
        }
      }
    },
  });

  // ── Totals ──
  let ty = doc.lastAutoTable.finalY + 6;
  // A resend after a payment shows what's left (or that nothing is), not
  // the original total as if nothing had happened.
  const pay = invoicePayment(inv);
  if (pay.hasPayment) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(90, 90, 90);
    doc.text(`Invoice total ${money(pay.total)}  ·  Paid ${money(pay.paid)}`, W - M, ty, { align: "right" });
    ty += 6;
  }
  doc.setFillColor(...EMERALD);
  doc.roundedRect(W - M - 70, ty - 2, 70, 12, 2, 2, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text(pay.partial ? "BALANCE DUE" : pay.settled ? "PAID IN FULL" : "TOTAL DUE", W - M - 65, ty + 5.6);
  doc.setFontSize(12);
  doc.text(money(pay.partial ? pay.balance : pay.total), W - M - 5, ty + 5.8, { align: "right" });

  // ── Terms + footer ──
  ty += 20;
  if (inv.terms) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(110, 110, 110);
    const wrapped = doc.splitTextToSize(`Terms: ${inv.terms}`, W - 2 * M);
    doc.text(wrapped, M, ty);
    ty += wrapped.length * 3.8 + 4;
  }
  if (inv.billTo) {
    doc.setFontSize(8.5);
    doc.setTextColor(110, 110, 110);
    doc.text(`Please remit or direct questions to: ${inv.billTo}`, M, ty);
  }
  doc.setFontSize(7.5);
  doc.setTextColor(160, 160, 160);
  doc.text(`Generated by CredentialDOMD · ${new Date().toLocaleDateString()}`, M, doc.internal.pageSize.getHeight() - 10);

  return doc;
}

export function invoicePdfFile(inv) {
  const doc = buildInvoicePdf(inv);
  const blob = doc.output("blob");
  return new File([blob], `${inv.number || "invoice"}.pdf`, { type: "application/pdf" });
}

/**
 * A legacy invoice (saved before line items were stored) only has its text
 * rendering. This types that text onto PDF pages so it can ride the same
 * share sheet as every other invoice instead of a mailto: link that iOS
 * Mail truncates.
 */
export function invoiceTextPdfFile(inv, text) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 16;
  const lineH = 4.6;
  doc.setFont("courier", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(30, 30, 30);
  const rows = normalizeInvoiceText(text).split("\n")
    .flatMap(l => (l.trim() === "" ? [""] : doc.splitTextToSize(l, W - 2 * M)));
  let y = M + 4;
  for (const row of rows) {
    if (y > H - M) { doc.addPage(); y = M + 4; }
    if (row) doc.text(row, M, y);
    y += lineH;
  }
  const blob = doc.output("blob");
  return new File([blob], `${inv.number || "invoice"}.pdf`, { type: "application/pdf" });
}

/**
 * Send a text-only (legacy) invoice. A short body opens Mail as a formatted
 * CRLF mailto: composer. A long one would be cut off by iOS Mail, so it goes
 * out as a PDF page through the share sheet; when files can't be shared the
 * composer opens with the cover letter and the full invoice waits on the
 * clipboard. The text is always on the clipboard first.
 */
export async function shareInvoiceText(inv, subject, text) {
  const body = normalizeInvoiceText(text);
  const title = subject || invoiceSubject(inv);
  try { await navigator.clipboard.writeText(body); } catch { /* clipboard unavailable */ }
  if (body.length <= MAILTO_BODY_MAX) {
    window.open(mailtoHref("", title, body), "_blank");
    return "mailto";
  }
  const file = invoiceTextPdfFile(inv, body);
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ title, text: invoiceCoverBlurb(inv), files: [file] });
      return "share";
    } catch (err) {
      if (err?.name === "AbortError") return null;
    }
  }
  window.open(mailtoHref("", title, invoiceCoverEmail(inv)), "_blank");
  return "mailto-cover";
}

/**
 * Share the PDF. Fallback order matters: in the installed app, "downloading"
 * navigates the whole app into the PDF with no way back — so when the share
 * sheet can't take files we share the text version instead, and only plain
 * browsers get the download.
 */
export async function shareInvoicePdf(inv, subject, fallbackText) {
  const file = invoicePdfFile(inv);
  const cover = invoiceCoverEmail(inv);
  // iOS Mail HTML-renders shared text, collapsing every line break (an
  // OS behavior — no format survives it). The clipboard copy DOES keep
  // formatting when pasted, so the cover letter always rides along there.
  let coverCopied = false;
  try { await navigator.clipboard.writeText(cover); coverCopied = true; } catch { /* clipboard unavailable */ }
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ title: subject || `Invoice ${inv.number}`, text: invoiceCoverBlurb(inv), files: [file] });
      return coverCopied ? "share+cover" : "share";
    } catch (err) {
      if (err?.name === "AbortError") return null;
    }
  }
  const standalone = window.navigator.standalone === true
    || window.matchMedia?.("(display-mode: standalone)")?.matches;
  if (standalone && navigator.share && fallbackText) {
    try {
      await navigator.share({
        title: subject || `Invoice ${inv.number}`,
        text: `${invoiceCoverBlurb(inv, { attached: false })}\n\n${normalizeInvoiceText(fallbackText)}`,
      });
      return coverCopied ? "share-text+cover" : "share-text";
    } catch (err) {
      if (err?.name === "AbortError") return null;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "download";
}
