import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { formatDate, mailtoHref, localDay } from "./helpers.js";
import { plainDashes } from "./outgoingText.js";
import {
  money, invoicePayment, invoiceSubject, invoiceCoverBlurb, invoiceCoverEmail, invoiceFileName,
  invoicePeriodRange, invoicePeriodLabel, senderName,
  normalizeInvoiceText, invoiceTextOnlyShare, MAILTO_BODY_MAX,
} from "./invoiceCover.js";
import { invoiceLayout, invoiceColumns, plainItem, invoiceSentenceText, sortInvoiceLines } from "./invoiceLayout.js";

// The wording lives in invoiceCover.js (pure, unit-tested); re-exported so
// every send site keeps importing from here.
export { invoiceSubject, invoiceCoverBlurb, invoiceCoverEmail, invoicePayment, normalizeInvoiceText, invoiceTextOnlyShare };
// The line order moved to invoiceLayout.js with the day layout; kept here
// for the screens that import it from this module.
export { sortInvoiceLines };

/**
 * Professional PDF invoice: clean table, brand header, ready for a hospital
 * AP department. US Letter, the paper a US billing office prints on. Returns
 * a File suitable for navigator.share.
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

export const PAGE_FORMAT = "letter";
// Page geometry for the line items (mm, Letter 279.4 high). A page's table
// stops TABLE_BOTTOM above the edge; a continuation page starts at PAGE_TOP.
const PAGE_TOP = 16;
const TABLE_BOTTOM = 14;
// Slack between the planned page end and autoTable's own, so the planner
// below (not autoTable) decides every break.
const PLAN_SLACK = 0.5;
const AMOUNT_W = 34;

// jsPDF's built-in Helvetica draws WinAnsi (Latin-1 and a few more) only;
// anything else came out as the wrong letters ("Łukasz" printed "Aukasz").
// Every string drawn goes through here: a letter outside WinAnsi becomes the
// nearest one inside it (its base letter, keeping an accent WinAnsi has),
// a few symbols become words or ASCII, and what has no Latin form (CJK)
// becomes "?" rather than wrong letters. No em dash (house rule).
const WIN_ANSI_EXTRA = new Set([..."\u{20ac}\u{201a}\u{192}\u{201e}\u{2026}\u{2020}\u{2021}\u{2c6}\u{2030}\u{160}\u{2039}\u{152}\u{17d}\u{2018}\u{2019}\u{201c}\u{201d}\u{2022}\u{2013}\u{2014}\u{2dc}\u{2122}\u{161}\u{203a}\u{153}\u{17e}\u{178}"]);
const SUBSTITUTE = {
  "\u{141}": "L", "\u{142}": "l", "\u{110}": "D", "\u{111}": "d", "\u{126}": "H", "\u{127}": "h", "\u{131}": "i", "\u{130}": "I",
  "\u{2192}": "to", "\u{2190}": "from", "\u{2265}": ">=", "\u{2264}": "<=", "\u{2260}": "!=", "\u{2212}": "-",
  "\u{2010}": "-", "\u{2011}": "-", "\u{2012}": "-", "\u{2015}": "-", "\u{2032}": "'", "\u{2033}": "\"",
  "\u{2009}": " ", "\u{200a}": " ", "\u{202f}": " ", "\u{2007}": " ", "\u{200b}": "", "\u{feff}": "",
};
const drawable = (ch) => {
  const c = ch.codePointAt(0);
  return c === 10 || (c >= 32 && c < 127) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.has(ch);
};
export function pdfText(value) {
  return Array.from(plainDashes(String(value ?? ""))).map((ch) => {
    if (drawable(ch)) return ch;
    if (SUBSTITUTE[ch] != null) return SUBSTITUTE[ch];
    const parts = Array.from(ch.normalize("NFD"));
    for (let k = parts.length; k > 0; k--) {
      const cand = parts.slice(0, k).join("").normalize("NFC");
      if (Array.from(cand).every(drawable)) return cand;
    }
    return "?";
  }).join("");
}

/**
 * Wrap one header value to `width` (mm) in the doc's current font. Words
 * wrap at spaces as usual. A value with no spaces that does not fit (a long
 * email or web address) breaks before "@", ".", "-", "_" or "/", never
 * mid-word, so the separator opens the next line: "accounts.payable@example"
 * / "-regional-health-system.test". Not "...health-syst" / "em.test", and
 * not a line ending in "-", which reads as the renderer's own wrap hyphen
 * and a clerk retyping it drops ("example-regionalhealth..."). Only a single
 * piece wider than the column is cut where it fills.
 */
export function wrapHeaderValue(doc, value, width) {
  const t = pdfText(value);
  if (/\s/.test(t.trim()) || doc.getTextWidth(t) <= width) return doc.splitTextToSize(t, width);
  const pieces = t.match(/[@.\-_/]?[^@.\-_/]*/g).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const piece of pieces) {
    if (!cur || doc.getTextWidth(cur + piece) <= width) { cur += piece; continue; }
    lines.push(cur);
    cur = piece;
  }
  if (cur) lines.push(cur);
  return lines.flatMap((line) => (doc.getTextWidth(line) <= width ? [line] : doc.splitTextToSize(line, width)));
}

const dayHeaderText = (day) => (day.window ? `${day.title}   \u{b7}   ${day.window}` : day.title);

/**
 * The column set for the day table (invoiceLayout.js invoiceColumns): a
 * column that would be empty on every row is not printed, and its width
 * goes to Item, so "On call (primary): <hospital>" stays on one line.
 */
function tableColumns(kind, expenses, W, M) {
  const width = W - 2 * M;
  if (kind === "timed") {
    return {
      n: 4, head: [["Item", "Time", "Hours", "Amount"]],
      styles: { 0: { cellWidth: width - AMOUNT_W - 46 - 38 }, 1: { cellWidth: 46 }, 2: { cellWidth: 38 }, 3: { cellWidth: AMOUNT_W, halign: "right" } },
      cells: (r) => (r.detail != null
        ? [r.item, { content: r.detail, colSpan: 2 }, r.amountText]
        : [r.item, [r.time, r.note].filter(Boolean).join("\n"), r.hours, r.amountText]),
    };
  }
  if (kind === "detail") {
    return {
      n: 3, head: [[expenses ? "Expense" : "Item", "Details", "Amount"]],
      styles: { 0: { cellWidth: 74 }, 1: { cellWidth: width - AMOUNT_W - 74 }, 2: { cellWidth: AMOUNT_W, halign: "right" } },
      cells: (r) => [r.item, r.detail ?? [r.time, r.note, r.hours].filter(Boolean).join(" \u{b7} "), r.amountText],
    };
  }
  return {
    n: 2, head: [[expenses ? "Expense" : "Item", "Amount"]],
    styles: { 0: { cellWidth: width - AMOUNT_W }, 1: { cellWidth: AMOUNT_W, halign: "right" } },
    cells: (r) => [plainItem(r), r.amountText],
  };
}

const safeCell = (c) => (c && typeof c === "object" ? { ...c, content: pdfText(c.content) } : pdfText(c));

/**
 * The line items as day blocks (invoiceLayout.js): a header row per day,
 * its money rows with the work under them, and the day's total under a
 * rule. Columns from tableColumns.
 *
 * Page breaks are planned here from each row's measured height, not left to
 * autoTable, so a day never loses its header or its total:
 *  - a day that does not fit in the room left may split only when its
 *    header and first two rows fit there and at least one of its rows
 *    goes over with its total; otherwise it starts on the next page;
 *  - its last row and its total always share a page, so a total never
 *    opens a page alone;
 *  - the last day's last row and total keep `reserve` mm free under them
 *    for the invoice's totals block, so the TOTAL DUE box never opens a
 *    page alone either;
 *  - a page that carries on a day opens with the column head and
 *    "<day> (continued)".
 * A day is not moved whole just because it would fit on a fresh page: on
 * a four-day stipend invoice that left half of page 1 blank. Each page's
 * rows are then drawn by one autoTable call.
 */
function dayTable(doc, days, startY, M, { kind, expenses, reserve = 0 }) {
  const H = doc.internal.pageSize.getHeight();
  const W = doc.internal.pageSize.getWidth();
  const cols = tableColumns(kind, expenses, W, M);
  const amountCol = cols.n - 1;
  const blocks = days.map((day) => {
    const rows = [{ cells: [{ content: dayHeaderText(day), colSpan: cols.n }], kind: { kind: "day" } }];
    day.rows.forEach((r, i) => {
      rows.push({ cells: cols.cells(r), kind: { kind: "row", row: r, stripe: i % 2 === 1 } });
    });
    rows.push({ cells: [...(cols.n > 2 ? [{ content: day.totalLabel, colSpan: cols.n - 1 }] : [day.totalLabel]), money(day.total)], kind: { kind: "total" } });
    rows.forEach((r) => { r.cells = r.cells.map(safeCell); });
    return { rows, cont: { cells: [{ content: pdfText(`${day.title} (continued)`), colSpan: cols.n }], kind: { kind: "day" } } };
  });
  const options = (rows, extra) => ({
    margin: { left: M, right: M, top: PAGE_TOP, bottom: TABLE_BOTTOM },
    head: cols.head,
    body: rows.map((r) => r.cells),
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2.4, textColor: [40, 40, 40], fillColor: [255, 255, 255] },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 9 },
    columnStyles: cols.styles,
    // A row (a wrapped label, a two-line time) never splits across pages.
    rowPageBreak: "avoid",
    didParseCell: (h) => {
      // The Amount heading sits over the right-aligned figures.
      if (h.section === "head") { if (h.column.index === amountCol) h.cell.styles.halign = "right"; return; }
      if (h.section !== "body") return;
      const k = rows[h.row.index].kind;
      const s = h.cell.styles;
      if (k.kind === "day") {
        s.fillColor = DAY_FILL; s.textColor = DAY_TEXT; s.halign = "left";
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
      if (h.column.index === amountCol) {
        if (r.tone === "included") { s.textColor = INCLUDED; s.fontSize = 8; }
        else if (r.tone === "quiet") { s.textColor = QUIET; s.fontSize = 8; }
      }
    },
    ...extra,
  });

  // Measure every row (and each day's "continued" band) on a scratch page
  // of the same width and fonts.
  const all = blocks.flatMap((b) => [...b.rows, b.cont]);
  const probe = new jsPDF({ unit: "mm", format: PAGE_FORMAT });
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
  blocks.forEach(({ rows, cont }, b) => {
    // rows: the day's header, its rows, its total. The last day carries the
    // totals block's room under it.
    const tail = b === blocks.length - 1 ? reserve : 0;
    const room = limit - y;
    const splits = rows.length - 2 >= 3 && height(rows.slice(0, 3)) <= room;
    if (pages[pages.length - 1].length && height(rows) + tail > room && !splits) newPage();
    rows.forEach((r, i) => {
      // The last data row travels with the total (and, on the last day, with
      // the room the totals block needs).
      const lastRow = i > 0 && i === rows.length - 2;
      const need = lastRow ? r.h + rows[i + 1].h + tail : r.h;
      const page = pages[pages.length - 1];
      if (i > 0 && y + need > limit && !(page.length === 1 && page[0] === cont)) {
        newPage();
        put(cont);
      }
      put(r);
    });
  });

  pages.forEach((rows, p) => {
    if (p > 0) doc.addPage();
    autoTable(doc, options(rows, { startY: p === 0 ? startY : PAGE_TOP, showHead: "firstPage" }));
  });
}

/**
 * The pre-day-block table: the fallback when day totals cannot be shown
 * adding up. When the totals block would land alone on a new page, the last
 * two rows go over with it.
 */
function flatTable(doc, rows, startY, M, { reserve = 0 } = {}) {
  const H = doc.internal.pageSize.getHeight();
  const safe = rows.map((cells) => cells.map(safeCell));
  const options = (body, y, extra = {}) => ({
    startY: y,
    margin: { left: M, right: M, top: PAGE_TOP, bottom: TABLE_BOTTOM },
    head: [["Date", "Item", "Details", "Amount"]],
    body,
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2.6, textColor: [40, 40, 40] },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 9 },
    alternateRowStyles: { fillColor: [243, 247, 245] },
    columnStyles: {
      0: { cellWidth: 24 },
      1: { cellWidth: 52, fontStyle: "bold" },
      3: { cellWidth: 28, halign: "right", fontStyle: "bold" },
    },
    rowPageBreak: "avoid",
    didParseCell: (h) => {
      if (h.section === "head") { if (h.column.index === 3) h.cell.styles.halign = "right"; return; }
      // Zero-dollar (stipend-covered) amounts render muted
      if (h.section === "body" && h.column.index === 3 && h.cell.raw === "$0.00") {
        h.cell.styles.textColor = [150, 150, 150];
        h.cell.styles.fontStyle = "normal";
      }
      // Work items under a daily total render as quiet sub-rows; their
      // amount cell shows "included" (green) or the beyond-stipend value
      if (h.section === "body" && h.row.raw && typeof h.row.raw[1] === "string" && h.row.raw[1].startsWith("\u{b7} ")) {
        if (h.column.index === 1) h.cell.styles.fontStyle = "normal";
        h.cell.styles.textColor = [110, 110, 110];
        if (h.column.index === 3) {
          h.cell.styles.fontSize = 7.5;
          h.cell.styles.fontStyle = "normal";
          if (h.cell.raw === "included") h.cell.styles.textColor = [16, 150, 105];
        }
      }
    },
    ...extra,
  });
  const probe = new jsPDF({ unit: "mm", format: PAGE_FORMAT });
  autoTable(probe, options(safe, startY));
  const lastPageY = probe.lastAutoTable.finalY;
  const orphan = lastPageY + 6 + reserve > H - TABLE_BOTTOM && safe.length >= 3;
  if (!orphan) { autoTable(doc, options(safe, startY)); return; }
  autoTable(doc, options(safe.slice(0, -2), startY));
  doc.addPage();
  autoTable(doc, options(safe.slice(-2), PAGE_TOP));
}

export function buildInvoicePdf(inv) {
  const doc = new jsPDF({ unit: "mm", format: PAGE_FORMAT });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 16;
  const text = (value, x, y, opts) => doc.text(pdfText(value), x, y, opts);
  // The sender: the name, or with no name in Settings the email (never the
  // "Physician" placeholder printed as if it were someone).
  const name = senderName(inv);
  const fromName = name || inv.email || "";

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
  text(inv.number || "", W - M, 14, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Issued ${formatDate(inv.issuedDate || localDay())}`, W - M, 20, { align: "right" });
  if (inv.periodStart) {
    // The same date range every format prints; an expense invoice's dates
    // are its expense dates, not a service period.
    text(`${invoicePeriodLabel(inv)} ${invoicePeriodRange(inv)}`, W - M, 25, { align: "right" });
  }

  // ── From / Bill To ──
  // Each column wraps to its own width, so a long hospital name, agency,
  // address or email breaks onto a second line instead of running off the
  // page or into the other column. An email (no spaces) breaks before "@"
  // and at dots and hyphens (wrapHeaderValue), never mid-word.
  let y = 42;
  const colW = W / 2 - M - 6;
  const xR = W / 2 + 4;
  doc.setTextColor(...EMERALD);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.text("FROM", M, y);
  doc.text("BILL TO", xR, y);
  doc.setTextColor(30, 30, 30);
  doc.setFontSize(10.5);
  y += 5.5;
  const block = (value, x, yy, lineH) => {
    const wrapped = wrapHeaderValue(doc, value, colW);
    doc.text(wrapped, x, yy);
    return yy + wrapped.length * lineH;
  };
  let yL = fromName ? block(fromName, M, y, 5) - 0.2 : y;
  let yR = block(inv.facility || "Facility", xR, y, 5) - 0.2;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  for (const line of [inv.npi ? `NPI ${inv.npi}` : null, name ? inv.email : null, inv.phone].filter(Boolean)) yL = block(line, M, yL, 4.4);
  for (const line of [inv.agency ? `via ${inv.agency}` : null, inv.location, inv.billTo].filter(Boolean)) yR = block(line, xR, yR, 4.4);
  y = Math.max(yL, yR) + 4;

  // ── What the totals block needs under the table ──
  // The payment line, the TOTAL DUE box, the terms and the questions line go
  // together, above the footer.
  const pay = invoicePayment(inv);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const termsWrapped = inv.terms ? doc.splitTextToSize(pdfText(`Terms: ${inv.terms}`), W - 2 * M) : [];
  // Questions go to the physician who sent the invoice. (This line used to
  // send the billing office to inv.billTo, its own inbox.)
  // "Al Li, DO (al@example.test)": a comma would read as a third item.
  const contact = name ? `${name} (${inv.email})` : inv.email;
  const questionsWrapped = inv.email ? doc.splitTextToSize(pdfText(`Questions about this invoice: ${contact}`), W - 2 * M) : [];
  const needed = (pay.hasPayment ? 6 : 0) + 20
    + (termsWrapped.length ? termsWrapped.length * 3.8 + 4 : 0)
    + (questionsWrapped.length ? questionsWrapped.length * 3.8 : 0);

  // ── Line items: day blocks, or the flat table when they can't add up ──
  const layout = invoiceLayout(inv);
  if (layout.mode === "days") {
    dayTable(doc, layout.days, y, M, { kind: invoiceColumns(layout.days), expenses: inv.kind === "expenses", reserve: needed + 6 });
  } else {
    flatTable(doc, layout.rows, y, M, { reserve: needed });
  }

  // ── Totals ──
  let ty = doc.lastAutoTable.finalY + 6;
  if (ty + needed > H - 14) {
    // Only when the totals alone are taller than the room the planner kept
    // (it keeps the last day's rows with them, so this page is never blank).
    doc.addPage();
    ty = 20;
  }
  if (pay.hasPayment) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(90, 90, 90);
    doc.text(`Invoice total ${money(pay.total)}  \u{b7}  Paid ${money(pay.paid)}`, W - M, ty, { align: "right" });
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

  // ── Terms + questions ──
  ty += 20;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(110, 110, 110);
  if (termsWrapped.length) {
    doc.text(termsWrapped, M, ty);
    ty += termsWrapped.length * 3.8 + 4;
  }
  if (questionsWrapped.length) doc.text(questionsWrapped, M, ty);

  // ── Footer on every page: what the page belongs to, and where it sits ──
  // A page that comes loose from the stack still names its invoice.
  const n = doc.getNumberOfPages();
  const generated = `Generated by CredentialDOMD \u{b7} ${formatDate(localDay())}`;
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(160, 160, 160);
    doc.text(generated, M, H - 10);
    const page = `Page ${p} of ${n}`;
    const room = W - 2 * M - doc.getTextWidth(generated) - doc.getTextWidth(` \u{b7} ${page}`) - 8;
    const who = doc.splitTextToSize(pdfText(`Invoice ${inv.number || ""}${name ? ` \u{b7} ${name}` : ""}`), room)[0] || "";
    doc.text(`${who} \u{b7} ${page}`, W - M, H - 10, { align: "right" });
  }
  doc.setPage(n);

  return doc;
}

export function invoicePdfFile(inv) {
  const doc = buildInvoicePdf(inv);
  const blob = doc.output("blob");
  return new File([blob], invoiceFileName(inv, "pdf"), { type: "application/pdf" });
}

/**
 * A legacy invoice (saved before line items were stored) only has its text
 * rendering. This types that text onto PDF pages so it can ride the same
 * share sheet as every other invoice instead of a mailto: link that iOS
 * Mail truncates.
 */
export function invoiceTextPdfFile(inv, text) {
  const doc = new jsPDF({ unit: "mm", format: PAGE_FORMAT });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 16;
  const lineH = 4.6;
  doc.setFont("courier", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(30, 30, 30);
  const rows = pdfText(normalizeInvoiceText(text)).split("\n")
    .flatMap(l => (l.trim() === "" ? [""] : doc.splitTextToSize(l, W - 2 * M)));
  let y = M + 4;
  for (const row of rows) {
    if (y > H - M) { doc.addPage(); y = M + 4; }
    if (row) doc.text(row, M, y);
    y += lineH;
  }
  const blob = doc.output("blob");
  return new File([blob], invoiceFileName(inv, "pdf"), { type: "application/pdf" });
}

/**
 * Send a text-only (legacy) invoice. A short one opens Mail as a formatted
 * CRLF mailto: composer holding a letter and the invoice under it (never the
 * bare invoice text with no greeting). A long one would be cut off by iOS
 * Mail, so it goes out as a PDF page through the share sheet. When files
 * can't be shared, a browser downloads that PDF and the composer opens with a
 * cover letter for an attached invoice ("download-cover"); the installed app
 * (where a download navigates the whole app away) opens the composer with
 * the letter that says the invoice follows and leaves the invoice on the
 * clipboard to paste ("mailto-cover"). The text is always on the clipboard.
 */
export async function shareInvoiceText(inv, subject, text) {
  const body = normalizeInvoiceText(text);
  const title = subject || invoiceSubject(inv);
  try { await navigator.clipboard.writeText(body); } catch { /* clipboard unavailable */ }
  const letter = invoiceTextOnlyShare(inv, body);
  if (letter.length <= MAILTO_BODY_MAX) {
    window.open(mailtoHref("", title, letter), "_blank");
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
  const standalone = window.navigator.standalone === true
    || window.matchMedia?.("(display-mode: standalone)")?.matches;
  if (!standalone) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    window.open(mailtoHref("", title, invoiceCoverEmail(inv, { attached: true })), "_blank");
    return "download-cover";
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
      // The invoice as sentences, one line per day (invoiceSentenceText), so
      // a mail app that collapses the breaks still shows readable sentences;
      // the text invoice the caller holds only when there are no lines.
      const body = invoiceTextOnlyShare(inv, invoiceSentenceText(inv) || fallbackText);
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
