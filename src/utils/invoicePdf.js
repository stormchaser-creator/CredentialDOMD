import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { formatDate, mailtoHref } from "./helpers.js";
import {
  money, invoicePayment, invoiceSubject, invoiceCoverBlurb, invoiceCoverEmail,
  normalizeInvoiceText, invoiceTextOnlyShare, MAILTO_BODY_MAX,
} from "./invoiceCover.js";
import { invoiceLayout, sortInvoiceLines } from "./invoiceLayout.js";

// The wording lives in invoiceCover.js (pure, unit-tested); re-exported so
// every send site keeps importing from here.
export { invoiceSubject, invoiceCoverBlurb, invoiceCoverEmail, invoicePayment, normalizeInvoiceText, invoiceTextOnlyShare };
// The line order moved to invoiceLayout.js with the day layout; kept here
// for the screens that import it from this module.
export { sortInvoiceLines };

/**
 * Professional PDF invoice — clean table, brand header, ready for a
 * hospital AP department. Returns a File suitable for navigator.share.
 */

const NAVY = [10, 37, 64];      // #0A2540
const EMERALD = [16, 185, 129]; // #10b981
const DAY_FILL = [229, 237, 242];
const DAY_TEXT = [31, 56, 81];
const STRIPE = [245, 245, 245];
const TOTAL_FILL = [247, 250, 250];
const INCLUDED = [16, 150, 105];
const QUIET = [150, 150, 150];
const SUB_TEXT = [110, 110, 110];

// Page geometry for the line items (mm, A4 297 high). A page's table stops
// TABLE_BOTTOM above the edge; a continuation page starts at PAGE_TOP.
const PAGE_TOP = 16;
const TABLE_BOTTOM = 14;
// Slack between the planned page end and autoTable's own, so the planner
// below (not autoTable) decides every break.
const PLAN_SLACK = 0.5;
const HEAD = [["Item", "Time", "Hours", "Amount"]];

const dayHeaderText = (day) => (day.window ? `${day.title}   \u{b7}   ${day.window}` : day.title);

/**
 * The line items as day blocks (invoiceLayout.js): a header row per day,
 * its money rows with the work under them, and the day's total under a
 * rule. Columns Item | Time | Hours | Amount.
 *
 * Page breaks are planned here from each row's measured height, not left to
 * autoTable, so a day never loses its header or its total:
 *  - a day that does not fit in the room left may split only when its
 *    header and first two rows fit there and at least one of its rows
 *    goes over with its total; otherwise it starts on the next page;
 *  - its last row and its total always share a page, so a total never
 *    opens a page alone;
 *  - a page that carries on a day opens with the column head and
 *    "<day> (continued)".
 * A day is not moved whole just because it would fit on a fresh page: on
 * the owner's Northfield invoice that left half of page 1 blank. Each page's
 * rows are then drawn by one autoTable call.
 */
function dayTable(doc, days, startY, M) {
  const H = doc.internal.pageSize.getHeight();
  const blocks = days.map((day) => {
    const rows = [{ cells: [{ content: dayHeaderText(day), colSpan: 4 }], kind: { kind: "day" } }];
    day.rows.forEach((r, i) => {
      const time = [r.time, r.note].filter(Boolean).join("\n");
      rows.push({
        cells: r.detail != null ? [r.item, { content: r.detail, colSpan: 2 }, r.amountText] : [r.item, time, r.hours, r.amountText],
        kind: { kind: "row", row: r, stripe: i % 2 === 1 },
      });
    });
    rows.push({ cells: [{ content: day.totalLabel, colSpan: 3 }, money(day.total)], kind: { kind: "total" } });
    return { rows, cont: { cells: [{ content: `${day.title} (continued)`, colSpan: 4 }], kind: { kind: "day" } } };
  });
  const options = (rows, extra) => ({
    margin: { left: M, right: M, top: PAGE_TOP, bottom: TABLE_BOTTOM },
    head: HEAD,
    body: rows.map((r) => r.cells),
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2.4, textColor: [40, 40, 40], fillColor: [255, 255, 255] },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 66 },
      1: { cellWidth: 48 },
      2: { cellWidth: 38 },
      3: { cellWidth: "auto", halign: "right" },
    },
    // A row (a wrapped label, a two-line time) never splits across pages.
    rowPageBreak: "avoid",
    didParseCell: (h) => {
      if (h.section !== "body") return;
      const k = rows[h.row.index].kind;
      const s = h.cell.styles;
      if (k.kind === "day") {
        s.fillColor = DAY_FILL; s.textColor = DAY_TEXT;
        return;
      }
      if (k.kind === "total") {
        s.fillColor = TOTAL_FILL; s.fontStyle = "bold"; s.textColor = [30, 30, 30];
        s.lineColor = NAVY; s.lineWidth = { top: 0.35, right: 0, bottom: 0, left: 0 };
        if (h.column.index === 0) s.halign = "right";
        return;
      }
      const r = k.row;
      if (k.stripe) s.fillColor = STRIPE;
      if (r.level === 1) {
        s.fontSize = 8;
        s.textColor = SUB_TEXT;
        if (h.column.index === 0) s.cellPadding = { top: 2.4, bottom: 2.4, right: 2.4, left: 6 };
      }
      if (h.column.index === 3) {
        if (r.tone === "included") { s.textColor = INCLUDED; s.fontSize = 8; }
        else if (r.tone === "quiet") { s.textColor = QUIET; s.fontSize = 8; }
      }
    },
    ...extra,
  });

  // Measure every row (and each day's "continued" band) on a scratch page
  // of the same width and fonts.
  const all = blocks.flatMap((b) => [...b.rows, b.cont]);
  const probe = new jsPDF({ unit: "mm", format: "a4" });
  autoTable(probe, options(all, { startY: PAGE_TOP }));
  const heights = probe.lastAutoTable.body.map((r) => r.height);
  const headH = probe.lastAutoTable.head[0].height;
  all.forEach((r, i) => { r.h = heights[i]; });

  // Plan the pages.
  const limit = H - TABLE_BOTTOM - PLAN_SLACK;
  const pages = [[]];
  let y = startY + headH;
  const newPage = () => { pages.push([]); y = PAGE_TOP + headH; };
  const put = (r) => { pages[pages.length - 1].push(r); y += r.h; };
  const height = (rows) => rows.reduce((s, r) => s + r.h, 0);
  for (const { rows, cont } of blocks) {
    // rows: the day's header, its rows, its total.
    const room = limit - y;
    const splits = rows.length - 2 >= 3 && height(rows.slice(0, 3)) <= room;
    if (pages[pages.length - 1].length && height(rows) > room && !splits) newPage();
    rows.forEach((r, i) => {
      // The last data row travels with the total.
      const need = i > 0 && i === rows.length - 2 ? r.h + rows[i + 1].h : r.h;
      const page = pages[pages.length - 1];
      if (i > 0 && y + need > limit && !(page.length === 1 && page[0] === cont)) {
        newPage();
        put(cont);
      }
      put(r);
    });
  }

  pages.forEach((rows, p) => {
    if (p > 0) doc.addPage();
    autoTable(doc, options(rows, { startY: p === 0 ? startY : PAGE_TOP, showHead: "firstPage" }));
  });
}

/** The pre-day-block table: the fallback when day totals cannot be shown adding up. */
function flatTable(doc, rows, startY, M) {
  autoTable(doc, {
    startY,
    margin: { left: M, right: M },
    head: [["Date", "Item", "Details", "Amount"]],
    body: rows,
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

  // ── Line items: day blocks, or the flat table when they can't add up ──
  const layout = invoiceLayout(inv);
  if (layout.mode === "days") dayTable(doc, layout.days, y, M);
  else flatTable(doc, layout.rows, y, M);

  // ── Totals ──
  let ty = doc.lastAutoTable.finalY + 6;
  // A resend after a payment shows what's left (or that nothing is), not
  // the original total as if nothing had happened.
  const pay = invoicePayment(inv);
  // The payment line, the TOTAL DUE box, the terms and the remit line go
  // together, above the footer: when they do not fit under the table, they
  // start the next page.
  const H = doc.internal.pageSize.getHeight();
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const termLines = inv.terms ? doc.splitTextToSize(`Terms: ${inv.terms}`, W - 2 * M).length : 0;
  const needed = (pay.hasPayment ? 6 : 0) + 20 + (termLines ? termLines * 3.8 + 4 : 0) + (inv.billTo ? 2 : 0);
  if (ty + needed > H - 14) {
    doc.addPage();
    ty = 20;
  }
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
  window.open(mailtoHref("", title, invoiceCoverEmail(inv, { attached: false })), "_blank");
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
      // No PDF rides along here, so the message text IS the invoice: the
      // cover letter and the itemized invoice, multi-line. The newline strip
      // documented above was seen on shares that carry a file; whether a
      // text-only share keeps its breaks is one of the things the Help & FAQ
      // probe (src/utils/shareProbe.js) checks. It used to send a
      // one-paragraph blurb that promised an invoice "below" with nothing
      // below, plus a paste instruction meant for the sender but read by the
      // recipient (ticket 821d2f76).
      const body = invoiceTextOnlyShare(inv, fallbackText);
      try { await navigator.clipboard.writeText(body); coverCopied = true; } catch { /* clipboard unavailable */ }
      await navigator.share({ title: subject || `Invoice ${inv.number}`, text: body });
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
  // Tagged like shareOrDownload's Word/Excel download, so every send site
  // tells the physician the cover letter is on the clipboard.
  return coverCopied ? "download+cover" : "download";
}
