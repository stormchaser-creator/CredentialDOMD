import * as XLSX from "xlsx";
import { formatDate } from "./helpers.js";
import { shareInvoicePdf, sortInvoiceLines } from "./invoicePdf.js";
import { money, invoicePayment, invoiceCoverEmail, invoiceCoverBlurb } from "./invoiceCover.js";

/**
 * Invoice export in the physician's format of choice. All three formats
 * render the same content: header/parties, the sorted line-item table
 * (Date | Item | Details | Amount), total, terms. PDF stays the polished
 * AP-department artifact; Word and Excel exist so billing offices that
 * re-key or edit can work from a native document.
 */

function tableRows(inv) {
  return sortInvoiceLines(inv.lines || []).map(l => [
    l.date ? formatDate(l.date) : "",
    l.label || "",
    l.detail || "",
    l.amount == null ? (l.flag || "") : money(l.amount),
  ]);
}

export function invoiceXlsxFile(inv) {
  const pay = invoicePayment(inv);
  const head = [
    [`INVOICE ${inv.number || ""}`],
    [`Issued ${formatDate(inv.issuedDate || new Date().toISOString().slice(0, 10))}`],
    inv.periodStart ? [`Service period ${formatDate(inv.periodStart)}${inv.periodEnd && inv.periodEnd !== inv.periodStart ? " – " + formatDate(inv.periodEnd) : ""}`] : [],
    [],
    ["FROM", "", "BILL TO"],
    [inv.physician || "Physician", "", inv.facility || "Facility"],
    [inv.npi ? `NPI ${inv.npi}` : "", "", inv.agency ? `via ${inv.agency}` : ""],
    [inv.email || "", "", [inv.location, inv.billTo].filter(Boolean).join(" — ")],
    [],
    ["Date", "Item", "Details", "Amount"],
    ...tableRows(inv),
    [],
    ["", "", "TOTAL", money(pay.total)],
    ...(pay.hasPayment
      ? [["", "", "Paid", money(pay.paid)], ["", "", pay.settled ? "PAID IN FULL" : "BALANCE DUE", money(pay.balance)]]
      : []),
    ...(inv.terms ? [[], [`Terms: ${inv.terms}`]] : []),
  ];
  const ws = XLSX.utils.aoa_to_sheet(head);
  ws["!cols"] = [{ wch: 14 }, { wch: 42 }, { wch: 60 }, { wch: 14 }];
  // Amounts as real currency numbers so Excel right-aligns and can sum them
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = 10; r <= range.e.r; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: 3 });
    const c = ws[addr];
    if (!c || typeof c.v !== "string") continue;
    const m = c.v.match(/^\+?\$([\d,]+\.\d{2})$/);
    if (m) { c.t = "n"; c.v = parseFloat(m[1].replace(/,/g, "")); c.z = '"$"#,##0.00'; }
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
  // Explicit DXA widths everywhere — percentage table widths render as a
  // collapsed sliver in Quick Look / Pages (the lib emits "100%" into a
  // numeric field). 9360 twips = 6.5" usable width on letter paper.
  const COLW = [1450, 2500, 3960, 1450];
  const cell = (text, { bold = false, right = false, header = false, col = 0 } = {}) => new TableCell({
    width: { size: COLW[col], type: WidthType.DXA },
    shading: header ? { fill: "0A2540" } : undefined,
    children: [new Paragraph({
      alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), bold: bold || header, color: header ? "FFFFFF" : undefined, size: 18 })],
    })],
  });
  const pay = invoicePayment(inv);
  const rows = [
    new TableRow({ children: ["Date", "Item", "Details", "Amount"].map((h, i) => cell(h, { header: true, col: i })) }),
    ...tableRows(inv).map(r => new TableRow({
      children: [cell(r[0], { col: 0 }), cell(r[1], { bold: true, col: 1 }), cell(r[2], { col: 2 }), cell(r[3], { right: true, bold: true, col: 3 })],
    })),
    new TableRow({ children: [cell("", { col: 0 }), cell("", { col: 1 }), cell("TOTAL", { bold: true, col: 2 }), cell(money(pay.total), { right: true, bold: true, col: 3 })] }),
    ...(pay.hasPayment ? [
      new TableRow({ children: [cell("", { col: 0 }), cell("", { col: 1 }), cell("Paid", { col: 2 }), cell(money(pay.paid), { right: true, col: 3 })] }),
      new TableRow({ children: [cell("", { col: 0 }), cell("", { col: 1 }), cell(pay.settled ? "PAID IN FULL" : "BALANCE DUE", { bold: true, col: 2 }), cell(money(pay.balance), { right: true, bold: true, col: 3 })] }),
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
