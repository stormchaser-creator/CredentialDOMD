import * as XLSX from "xlsx";
import { formatDate, localDay } from "./helpers.js";
import { shareInvoicePdf } from "./invoicePdf.js";
import { invoiceLayout, invoiceColumns, plainItem } from "./invoiceLayout.js";
import {
  money, invoicePayment, invoiceCoverEmail, invoiceCoverBlurb, invoiceFileName, invoicePeriodRange, invoicePeriodLabel, senderName,
} from "./invoiceCover.js";

/**
 * Invoice export in the physician's format of choice. All three formats
 * render the same content: header/parties, the line items as day blocks
 * (invoiceLayout.js, each day closed by its total; Excel adds a Day total
 * column, see invoiceXlsxFile), total, terms. The columns are the PDF's
 * (invoiceColumns): Item | Time | Hours | Amount only when a row has a time
 * or hours, Item | Details | Amount when rows carry words (an expense's
 * note), otherwise Item | Amount. PDF stays the polished AP-department artifact; Word
 * and Excel exist so billing offices that re-key or edit can work from a
 * native document. An invoice whose day totals cannot be shown adding up
 * keeps the old Date | Item | Details | Amount table in every format.
 */

/**
 * The table every non-PDF format prints. Each row: { kind, cells, row? }
 * where kind is "day" (a day's header, one cell across), "row" (row.detail
 * set: on a timed table its words span Time and Hours), "total" (a day
 * total: its label in the column before Amount) or "flat". `total` rows also
 * carry `amount`, the day total as a number. `n` is the column count and
 * `cols` which set (invoiceColumns, or "flat").
 */
function tableModel(inv) {
  const layout = invoiceLayout(inv);
  if (layout.mode === "flat") {
    return { days: false, cols: "flat", n: 4, head: ["Date", "Item", "Details", "Amount"], rows: layout.rows.map((cells) => ({ kind: "flat", cells })) };
  }
  const cols = invoiceColumns(layout.days);
  const first = inv.kind === "expenses" ? "Expense" : "Item";
  const head = cols === "timed" ? ["Item", "Time", "Hours", "Amount"] : cols === "detail" ? [first, "Details", "Amount"] : [first, "Amount"];
  const n = head.length;
  const blank = (k) => Array(Math.max(0, k)).fill("");
  const cellsOf = (r) => {
    if (cols === "timed") {
      return r.detail != null
        ? [r.item, r.detail, "", r.amountText]
        : [r.item, [r.time, r.note].filter(Boolean).join(" \u{b7} "), r.hours, r.amountText];
    }
    if (cols === "detail") return [r.item, r.detail ?? [r.time, r.note, r.hours].filter(Boolean).join(" \u{b7} "), r.amountText];
    return [plainItem(r, " \u{b7} "), r.amountText];
  };
  const rows = [];
  for (const day of layout.days) {
    rows.push({ kind: "day", cells: [day.window ? `${day.title} \u{b7} ${day.window}` : day.title, ...blank(n - 1)] });
    for (const r of day.rows) rows.push({ kind: "row", row: r, cells: cellsOf(r) });
    rows.push({ kind: "total", cells: [...blank(n - 2), day.totalLabel, money(day.total)], amount: day.total });
  }
  return { days: true, cols, n, head, rows };
}

/**
 * The FROM block every format prints, the PDF's order: the sender in bold,
 * then NPI, email and phone. The sender is the name; with no name in
 * Settings it is the email (never the "Physician" placeholder, which read as
 * an invoice signed by a generic word).
 */
export function fromBlock(inv = {}) {
  const name = senderName(inv);
  const email = String(inv.email || "").trim();
  return {
    sender: name || email,
    details: [inv.npi ? `NPI ${inv.npi}` : "", name ? email : "", String(inv.phone || "").trim()].filter(Boolean),
  };
}

/** "$1,234.56" as the number 1234.56; null for anything else ("+$75.00", "in $3,000.00 stipend"). */
const moneyNumber = (text) => {
  // A negative amount is the flat table's rounding adjustment ("-$0.01").
  const m = String(text ?? "").match(/^(-?)\$([\d,]+\.\d{2})$/);
  return m ? (m[1] ? -1 : 1) * parseFloat(m[2].replace(/,/g, "")) : null;
};

/**
 * The spreadsheet is where a billing office sums the Amount column, so only
 * charges are numbers there: every row that makes a day's total (stipend,
 * callback, orientation, an hourly or day-rate line, an expense) and, under
 * the table, TOTAL, Paid and Balance. A piece of work under the callback
 * prints its share as words, the way work inside the stipend already does
 * ("$75.00 in callback" beside "in $3,000.00 stipend"), and each day's total
 * sits in its own column, Day total. Summed, the Amount cells above TOTAL
 * come to the invoice total, and so do the Day total cells.
 */
// The widest the Item column grows to fit a long item (Excel allows 255).
const ITEM_COL_MAX = 120;

export function invoiceXlsxFile(inv) {
  const pay = invoicePayment(inv);
  const model = tableModel(inv);
  const n = model.n;
  const amountCol = n - 1;
  const width = model.days ? n + 1 : n;
  // A day-block row as the sheet writes it: Amount a number only when the
  // row is a charge, a piece of work's dollars as words naming the charge
  // they are part of, a total's figure in the Day total column.
  let charge = "";
  const sheetRow = (r) => {
    if (!model.days) return r.cells;
    if (r.kind === "total") return [...r.cells.slice(0, amountCol), "", r.amount];
    if (r.kind !== "row") return r.cells;
    if (r.row.level === 0) charge = r.row.item.startsWith("Callback beyond") ? "callback" : r.row.item;
    const v = moneyNumber(r.cells[amountCol]);
    if (v == null) return r.cells;
    return [...r.cells.slice(0, amountCol), r.row.sums ? v : `${r.cells[amountCol]} in ${charge || "the line above"}`];
  };
  // The summary rows put their label in the column before Amount.
  const sumRow = (label, value) => [...Array(Math.max(0, amountCol - 1)).fill(""), label, value];
  const period = invoicePeriodRange(inv);
  // FROM and BILL TO side by side, as many rows as the longer of the two.
  const from = fromBlock(inv);
  const left = [from.sender, ...from.details];
  const right = [inv.facility || "Facility", inv.agency ? `via ${inv.agency}` : "", [inv.location, inv.billTo].filter(Boolean).join(" \u{b7} ")];
  const parties = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => [left[i] || "", "", right[i] || ""]);
  const top = [
    [`INVOICE ${inv.number || ""}`],
    [`Issued ${formatDate(inv.issuedDate || localDay())}`],
    period ? [`${invoicePeriodLabel(inv)} ${period}`] : [],
    [],
    ["FROM", "", "BILL TO"],
    ...parties,
    [],
  ];
  const headAt = top.length;
  const head = [
    ...top,
    model.days ? [...model.head, "Day total"] : model.head,
    ...model.rows.map(sheetRow),
    [],
    sumRow("TOTAL", pay.total),
    ...(pay.hasPayment
      ? [sumRow("Paid", pay.paid), sumRow(pay.settled ? "PAID IN FULL" : "BALANCE DUE", pay.balance)]
      : []),
    ...(inv.terms ? [[], [`Terms: ${inv.terms}`]] : []),
  ];
  const ws = XLSX.utils.aoa_to_sheet(head);
  const COLS = {
    timed: [46, 34, 34, 22, 14],
    detail: [46, 56, 22, 14],
    plain: [72, 22, 14],
    flat: [14, 42, 60, 14],
  };
  // Excel shows a long label only up to the next filled cell, and the Amount
  // beside a charge is always filled: column A widens to its longest item
  // (a 110 character "On call (primary): <long hospital name> (ABBR)" was cut
  // off at Amount), up to a width that still prints.
  const widths = [...COLS[model.cols]];
  if (model.days) {
    const longest = model.rows.reduce((m, r) => (r.kind === "row" ? Math.max(m, String(r.cells[0] || "").length) : m), 0);
    widths[0] = Math.max(widths[0], Math.min(ITEM_COL_MAX, longest + 2));
  }
  ws["!cols"] = widths.map((wch) => ({ wch }));
  // A day's header runs across the table; on a timed table a row's detail
  // runs across Time and Hours.
  ws["!merges"] = model.rows.flatMap((r, i) => {
    const at = headAt + 1 + i;
    if (r.kind === "day" && width > 1) return [{ s: { r: at, c: 0 }, e: { r: at, c: width - 1 } }];
    if (r.kind === "row" && model.cols === "timed" && r.row.detail != null) return [{ s: { r: at, c: 1 }, e: { r: at, c: 2 } }];
    return [];
  });
  // Charges as real currency numbers so Excel right-aligns and sums them. In
  // the flat table that is every "$x.xx" amount; a work item's flag
  // ("+$75.00", already inside its day's line) stays words.
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = headAt + 1; r <= range.e.r; r++) {
    for (let c = amountCol; c < width; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      if (cell.t === "s" && !model.days) {
        const v = moneyNumber(cell.v);
        if (v != null) { cell.t = "n"; cell.v = v; }
      }
      if (cell.t === "n") cell.z = '"$"#,##0.00';
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Invoice");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new File([out], invoiceFileName(inv, "xlsx"), {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// The Word generator loads on demand — most sends are PDF, and the docx
// package shouldn't ride in anyone's bundle until the first Word export.
export async function invoiceDocxFile(inv) {
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
    TableLayoutType, Footer, PageNumber,
  } = await import("docx");
  const model = tableModel(inv);
  const n = model.n;
  // Explicit DXA widths everywhere, and a FIXED table layout: percentage
  // widths and autofit both collapse in Quick Look / iPhone Mail (empty
  // columns became slivers). 9360 twips = 6.5" of text width on US Letter
  // with 1" margins (the section below sets that page).
  const COLW = {
    timed: [3300, 2450, 2250, 1360],
    detail: [3500, 4500, 1360],
    plain: [8000, 1360],
    flat: [1450, 2500, 3960, 1450],
  }[model.cols];
  const cell = (text, { bold = false, right = false, header = false, col = 0, span = 1, fill, color, size = 18, indent = 0, rule = false, keepNext = false } = {}) => new TableCell({
    width: { size: COLW.slice(col, col + span).reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnSpan: span > 1 ? span : undefined,
    shading: header ? { fill: "0A2540" } : fill ? { fill } : undefined,
    borders: rule ? { top: { style: BorderStyle.SINGLE, size: 8, color: "0A2540" } } : undefined,
    children: [new Paragraph({
      alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT,
      indent: indent ? { left: indent } : undefined,
      keepNext: keepNext || undefined,
      children: [new TextRun({ text: String(text), bold: bold || header, color: header ? "FFFFFF" : color, size, font: "Arial" })],
    })],
  });
  // Page breaks: a day's header stays with its first row and a day's total
  // with the row above it (keepNext on that row's paragraphs); no row splits
  // across pages; the column head repeats at the top of every page.
  const keepWithNext = model.rows.map((m, i) => m.kind === "day"
    || (m.kind === "row" && (model.rows[i - 1]?.kind === "day" || model.rows[i + 1]?.kind === "total")));
  const amountCol = n - 1;
  // How a day-block row reads: a piece of work is small and grey, its
  // amount green inside the stipend and grey when it bills nothing.
  const dayRow = (m, keepNext) => {
    if (m.kind === "day") return [cell(m.cells[0], { span: n, fill: "E5EDF2", color: "1F3851", keepNext })];
    if (m.kind === "total") {
      return [
        cell(m.cells[amountCol - 1], { span: n - 1, right: true, bold: true, fill: "F7FAFA", rule: true }),
        cell(m.cells[amountCol], { col: amountCol, right: true, bold: true, fill: "F7FAFA", rule: true }),
      ];
    }
    const r = m.row;
    const sub = r.level === 1 ? { color: "6E6E6E", size: 16, keepNext } : { keepNext };
    const amountColor = r.tone === "included" ? "109669" : r.tone === "quiet" ? "969696" : sub.color;
    const amount = cell(m.cells[amountCol], { col: amountCol, right: true, ...sub, color: amountColor });
    const item = cell(m.cells[0], { col: 0, ...sub, indent: r.level === 1 ? 240 : 0 });
    if (model.cols === "plain") return [item, amount];
    if (model.cols === "detail") return [item, cell(m.cells[1], { col: 1, ...sub }), amount];
    return r.detail != null
      ? [item, cell(m.cells[1], { col: 1, span: 2, ...sub }), amount]
      : [item, cell(m.cells[1], { col: 1, ...sub }), cell(m.cells[2], { col: 2, ...sub }), amount];
  };
  // A summary row under the table: its label in the column before Amount.
  const sumRow = (label, value, bold) => new TableRow({
    cantSplit: true,
    children: [
      ...(amountCol > 1 ? [cell("", { col: 0, span: amountCol - 1 })] : []),
      cell(label, { bold, col: amountCol - 1 }),
      cell(value, { right: true, bold, col: amountCol }),
    ],
  });
  const pay = invoicePayment(inv);
  const rows = [
    new TableRow({ tableHeader: true, cantSplit: true, children: model.head.map((h, i) => cell(h, { header: true, col: i, right: i === amountCol })) }),
    ...model.rows.map((m, i) => new TableRow({
      cantSplit: true,
      children: m.kind === "flat"
        ? [cell(m.cells[0], { col: 0 }), cell(m.cells[1], { bold: true, col: 1 }), cell(m.cells[2], { col: 2 }), cell(m.cells[3], { right: true, bold: true, col: 3 })]
        : dayRow(m, keepWithNext[i]),
    })),
    sumRow("TOTAL", money(pay.total), true),
    ...(pay.hasPayment ? [
      sumRow("Paid", money(pay.paid), false),
      sumRow(pay.settled ? "PAID IN FULL" : "BALANCE DUE", money(pay.balance), true),
    ] : []),
  ];
  // The font on every run too: Quick Look and iPhone Mail ignore the document default.
  const p = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, font: "Arial", ...opts })] });
  const period = invoicePeriodRange(inv);
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const doc = new Document({
    // One readable font everywhere (it fell back to Times New Roman).
    styles: { default: { document: { run: { font: "Arial", size: 20 } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: `Invoice ${inv.number || ""}${senderName(inv) ? ` \u{b7} ${senderName(inv)}` : ""} \u{b7} Page `, size: 15, color: "999999" }),
              new TextRun({ children: [PageNumber.CURRENT], size: 15, color: "999999" }),
              new TextRun({ text: " of ", size: 15, color: "999999" }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 15, color: "999999" }),
            ],
          })],
        }),
      },
      children: [
        new Paragraph({ children: [new TextRun({ text: `INVOICE ${inv.number || ""}`, bold: true, size: 40, color: "0A2540", font: "Arial" })] }),
        p(`Issued ${formatDate(inv.issuedDate || localDay())}`, { size: 18, color: "666666" }),
        ...(period ? [p(`${invoicePeriodLabel(inv)} ${period}`, { size: 18, color: "666666" })] : []),
        p(""),
        p("FROM", { bold: true, size: 16, color: "10B981" }),
        ...(fromBlock(inv).sender ? [p(fromBlock(inv).sender, { bold: true, size: 20 })] : []),
        ...fromBlock(inv).details.map((t) => p(t, { size: 18, color: "666666" })),
        p(""),
        p("BILL TO", { bold: true, size: 16, color: "10B981" }),
        p(inv.facility || "Facility", { bold: true, size: 20 }),
        ...(inv.agency ? [p(`via ${inv.agency}`, { size: 18, color: "666666" })] : []),
        ...([inv.location, inv.billTo].filter(Boolean).map(t => p(String(t), { size: 18, color: "666666" }))),
        p(""),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: COLW,
          layout: TableLayoutType.FIXED,
          // Light horizontal rules only: the library's default draws a heavy
          // black box around every cell.
          borders: {
            top: none, left: none, right: none, insideVertical: none,
            bottom: { style: BorderStyle.SINGLE, size: 4, color: "0A2540" },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "DDDDDD" },
          },
          rows,
        }),
        p(""),
        ...(inv.terms ? [p(`Terms: ${inv.terms}`, { size: 18, color: "666666" })] : []),
      ],
    }],
  });
  const blob = await Packer.toBlob(doc);
  return new File([blob], invoiceFileName(inv, "docx"), {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

/**
 * Share-sheet first (Save to Files / AirDrop / Mail), download fallback.
 * The cover letter rides along exactly like the PDF path: as share text
 * (Mail may flatten it) AND on the clipboard (paste keeps the formatting) —
 * so a Word/Excel send never produces an attachment with an empty email.
 */
async function shareOrDownload(file, title, { letter, blurb } = {}) {
  let coverCopied = false;
  if (letter) {
    try { await navigator.clipboard.writeText(letter); coverCopied = true; } catch { /* clipboard unavailable */ }
  }
  const tag = coverCopied ? "+cover" : "";
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ title, text: blurb || undefined, files: [file] });
      return "share" + tag;
    } catch (err) {
      if (err?.name === "AbortError") return null;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "download" + tag;
}

/**
 * One entry point for every send site. format: "pdf" | "docx" | "xlsx".
 * Returns "share*" / "download" like shareInvoicePdf, or null on cancel.
 */
export async function exportInvoice(inv, format, subject, fallbackText) {
  const covers = { letter: invoiceCoverEmail(inv), blurb: invoiceCoverBlurb(inv) };
  if (format === "xlsx") return shareOrDownload(invoiceXlsxFile(inv), subject, covers);
  if (format === "docx") return shareOrDownload(await invoiceDocxFile(inv), subject, covers);
  return shareInvoicePdf(inv, subject, fallbackText);
}
