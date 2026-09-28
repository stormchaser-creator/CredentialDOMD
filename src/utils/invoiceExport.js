import * as XLSX from "xlsx";
import { formatDate } from "./helpers.js";
import { shareInvoicePdf } from "./invoicePdf.js";
import { invoiceLayout } from "./invoiceLayout.js";
import { money, invoicePayment, invoiceCoverEmail, invoiceCoverBlurb } from "./invoiceCover.js";

/**
 * Invoice export in the physician's format of choice. All three formats
 * render the same content: header/parties, the line items as day blocks
 * (invoiceLayout.js: Item | Time | Hours | Amount, each day closed by its
 * total; Excel adds a Day total column, see invoiceXlsxFile), total, terms. PDF stays the polished AP-department artifact; Word
 * and Excel exist so billing offices that re-key or edit can work from a
 * native document. An invoice whose day totals cannot be shown adding up
 * keeps the old Date | Item | Details | Amount table in every format.
 */

/**
 * The table every non-PDF format prints. Each row: { kind, cells, row? }
 * where kind is "day" (a day's header, one cell across), "row" (row.detail
 * set: its words span Time and Hours), "total" (a day total) or "flat".
 * `total` rows also carry `amount`, the day total as a number.
 */
function tableModel(inv) {
  const layout = invoiceLayout(inv);
  if (layout.mode === "flat") {
    return { days: false, head: ["Date", "Item", "Details", "Amount"], rows: layout.rows.map((cells) => ({ kind: "flat", cells })) };
  }
  const rows = [];
  for (const day of layout.days) {
    rows.push({ kind: "day", cells: [day.window ? `${day.title} \u{b7} ${day.window}` : day.title, "", "", ""] });
    for (const r of day.rows) {
      rows.push({
        kind: "row", row: r,
        cells: r.detail != null
          ? [r.item, r.detail, "", r.amountText]
          : [r.item, [r.time, r.note].filter(Boolean).join(" \u{b7} "), r.hours, r.amountText],
      });
    }
    rows.push({ kind: "total", cells: ["", "", day.totalLabel, money(day.total)], amount: day.total });
  }
  return { days: true, head: ["Item", "Time", "Hours", "Amount"], rows };
}

/** "$1,234.56" as the number 1234.56; null for anything else ("+$75.00", "in $3,000.00 stipend"). */
const moneyNumber = (text) => {
  const m = String(text ?? "").match(/^\$([\d,]+\.\d{2})$/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
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
export function invoiceXlsxFile(inv) {
  const pay = invoicePayment(inv);
  const model = tableModel(inv);
  const width = model.days ? 5 : 4;
  // A day-block row as the sheet writes it: Amount a number only when the
  // row is a charge, a piece of work's dollars as words naming the charge
  // they are part of, a total's figure in the Day total column.
  let charge = "";
  const sheetRow = (r) => {
    if (!model.days) return r.cells;
    if (r.kind === "total") return [r.cells[0], r.cells[1], r.cells[2], "", r.amount];
    if (r.kind !== "row") return r.cells;
    if (r.row.level === 0) charge = r.row.item.startsWith("Callback beyond") ? "callback" : r.row.item;
    const n = moneyNumber(r.cells[3]);
    if (n == null) return r.cells;
    return [r.cells[0], r.cells[1], r.cells[2], r.row.sums ? n : `${r.cells[3]} in ${charge || "the line above"}`];
  };
  const top = [
    [`INVOICE ${inv.number || ""}`],
    [`Issued ${formatDate(inv.issuedDate || new Date().toISOString().slice(0, 10))}`],
    inv.periodStart ? [`Service period ${formatDate(inv.periodStart)}${inv.periodEnd && inv.periodEnd !== inv.periodStart ? " – " + formatDate(inv.periodEnd) : ""}`] : [],
    [],
    ["FROM", "", "BILL TO"],
    [inv.physician || "Physician", "", inv.facility || "Facility"],
    [inv.npi ? `NPI ${inv.npi}` : "", "", inv.agency ? `via ${inv.agency}` : ""],
    [inv.email || "", "", [inv.location, inv.billTo].filter(Boolean).join(" · ")],
    [],
  ];
  const headAt = top.length;
  const head = [
    ...top,
    model.days ? [...model.head, "Day total"] : model.head,
    ...model.rows.map(sheetRow),
    [],
    ["", "", "TOTAL", pay.total],
    ...(pay.hasPayment
      ? [["", "", "Paid", pay.paid], ["", "", pay.settled ? "PAID IN FULL" : "BALANCE DUE", pay.balance]]
      : []),
    ...(inv.terms ? [[], [`Terms: ${inv.terms}`]] : []),
  ];
  const ws = XLSX.utils.aoa_to_sheet(head);
  ws["!cols"] = model.days
    ? [{ wch: 46 }, { wch: 34 }, { wch: 34 }, { wch: 22 }, { wch: 14 }]
    : [{ wch: 14 }, { wch: 42 }, { wch: 60 }, { wch: 14 }];
  // A day's header runs across the table; a row's detail across Time and Hours.
  ws["!merges"] = model.rows.flatMap((r, i) => {
    const at = headAt + 1 + i;
    if (r.kind === "day") return [{ s: { r: at, c: 0 }, e: { r: at, c: width - 1 } }];
    if (r.kind === "row" && r.row.detail != null) return [{ s: { r: at, c: 1 }, e: { r: at, c: 2 } }];
    return [];
  });
  // Charges as real currency numbers so Excel right-aligns and sums them. In
  // the flat table that is every "$x.xx" amount; a work item's flag
  // ("+$75.00", already inside its day's line) stays words.
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = headAt + 1; r <= range.e.r; r++) {
    for (let c = 3; c < width; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      if (cell.t === "s" && !model.days) {
        const n = moneyNumber(cell.v);
        if (n != null) { cell.t = "n"; cell.v = n; }
      }
      if (cell.t === "n") cell.z = '"$"#,##0.00';
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Invoice");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new File([out], `${inv.number || "invoice"}.xlsx`, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// The Word generator loads on demand — most sends are PDF, and the docx
// package shouldn't ride in anyone's bundle until the first Word export.
export async function invoiceDocxFile(inv) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } = await import("docx");
  const model = tableModel(inv);
  // Explicit DXA widths everywhere — percentage table widths render as a
  // collapsed sliver in Quick Look / Pages (the lib emits "100%" into a
  // numeric field). 9360 twips = 6.5" usable width on letter paper.
  const COLW = model.days ? [3300, 2450, 2250, 1360] : [1450, 2500, 3960, 1450];
  const cell = (text, { bold = false, right = false, header = false, col = 0, span = 1, fill, color, size = 18, indent = 0, rule = false, keepNext = false } = {}) => new TableCell({
    width: { size: COLW.slice(col, col + span).reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnSpan: span > 1 ? span : undefined,
    shading: header ? { fill: "0A2540" } : fill ? { fill } : undefined,
    borders: rule ? { top: { style: BorderStyle.SINGLE, size: 8, color: "0A2540" } } : undefined,
    children: [new Paragraph({
      alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT,
      indent: indent ? { left: indent } : undefined,
      keepNext: keepNext || undefined,
      children: [new TextRun({ text: String(text), bold: bold || header, color: header ? "FFFFFF" : color, size })],
    })],
  });
  // Page breaks: a day's header stays with its first row and a day's total
  // with the row above it (keepNext on that row's paragraphs); no row splits
  // across pages; the column head repeats at the top of every page.
  const keepWithNext = model.rows.map((m, i) => m.kind === "day"
    || (m.kind === "row" && (model.rows[i - 1]?.kind === "day" || model.rows[i + 1]?.kind === "total")));
  // How a day-block row reads: a piece of work is small and grey, its
  // amount green inside the stipend and grey when it bills nothing.
  const dayRow = (m, keepNext) => {
    if (m.kind === "day") return [cell(m.cells[0], { span: 4, fill: "E5EDF2", color: "1F3851", keepNext })];
    if (m.kind === "total") {
      return [
        cell(m.cells[2], { span: 3, right: true, bold: true, fill: "F7FAFA", rule: true }),
        cell(m.cells[3], { col: 3, right: true, bold: true, fill: "F7FAFA", rule: true }),
      ];
    }
    const r = m.row;
    const sub = r.level === 1 ? { color: "6E6E6E", size: 16, keepNext } : { keepNext };
    const amountColor = r.tone === "included" ? "109669" : r.tone === "quiet" ? "969696" : sub.color;
    const amount = cell(m.cells[3], { col: 3, right: true, ...sub, color: amountColor });
    const item = cell(m.cells[0], { col: 0, ...sub, indent: r.level === 1 ? 240 : 0 });
    return r.detail != null
      ? [item, cell(m.cells[1], { col: 1, span: 2, ...sub }), amount]
      : [item, cell(m.cells[1], { col: 1, ...sub }), cell(m.cells[2], { col: 2, ...sub }), amount];
  };
  const pay = invoicePayment(inv);
  const rows = [
    new TableRow({ tableHeader: true, cantSplit: true, children: model.head.map((h, i) => cell(h, { header: true, col: i })) }),
    ...model.rows.map((m, i) => new TableRow({
      cantSplit: true,
      children: m.kind === "flat"
        ? [cell(m.cells[0], { col: 0 }), cell(m.cells[1], { bold: true, col: 1 }), cell(m.cells[2], { col: 2 }), cell(m.cells[3], { right: true, bold: true, col: 3 })]
        : dayRow(m, keepWithNext[i]),
    })),
    new TableRow({ cantSplit: true, children: [cell("", { col: 0 }), cell("", { col: 1 }), cell("TOTAL", { bold: true, col: 2 }), cell(money(pay.total), { right: true, bold: true, col: 3 })] }),
    ...(pay.hasPayment ? [
      new TableRow({ cantSplit: true, children: [cell("", { col: 0 }), cell("", { col: 1 }), cell("Paid", { col: 2 }), cell(money(pay.paid), { right: true, col: 3 })] }),
      new TableRow({ cantSplit: true, children: [cell("", { col: 0 }), cell("", { col: 1 }), cell(pay.settled ? "PAID IN FULL" : "BALANCE DUE", { bold: true, col: 2 }), cell(money(pay.balance), { right: true, bold: true, col: 3 })] }),
    ] : []),
  ];
  const p = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, ...opts })] });
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun({ text: `INVOICE ${inv.number || ""}`, bold: true, size: 40, color: "0A2540" })] }),
        p(`Issued ${formatDate(inv.issuedDate || new Date().toISOString().slice(0, 10))}`, { size: 18, color: "666666" }),
        ...(inv.periodStart ? [p(`Service period ${formatDate(inv.periodStart)}${inv.periodEnd && inv.periodEnd !== inv.periodStart ? " – " + formatDate(inv.periodEnd) : ""}`, { size: 18, color: "666666" })] : []),
        p(""),
        p("FROM", { bold: true, size: 16, color: "10B981" }),
        p(inv.physician || "Physician", { bold: true, size: 20 }),
        ...(inv.npi ? [p(`NPI ${inv.npi}`, { size: 18, color: "666666" })] : []),
        ...(inv.email ? [p(inv.email, { size: 18, color: "666666" })] : []),
        p(""),
        p("BILL TO", { bold: true, size: 16, color: "10B981" }),
        p(inv.facility || "Facility", { bold: true, size: 20 }),
        ...(inv.agency ? [p(`via ${inv.agency}`, { size: 18, color: "666666" })] : []),
        ...([inv.location, inv.billTo].filter(Boolean).map(t => p(String(t), { size: 18, color: "666666" }))),
        p(""),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: COLW,
          borders: { insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "DDDDDD" } },
          rows,
        }),
        p(""),
        ...(inv.terms ? [p(`Terms: ${inv.terms}`, { size: 18, color: "666666" })] : []),
      ],
    }],
  });
  const blob = await Packer.toBlob(doc);
  return new File([blob], `${inv.number || "invoice"}.docx`, {
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
