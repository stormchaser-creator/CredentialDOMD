import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { jsPDF } from "jspdf";
import { buildInvoicePdf, invoicePdfFile, invoiceTextPdfFile, pdfText } from "../../src/utils/invoicePdf.js";
import { invoiceXlsxFile, invoiceDocxFile } from "../../src/utils/invoiceExport.js";
import { invoiceLayout, invoiceColumns, invoicePlainText, invoiceSentenceText, roundingAdjustmentCents } from "../../src/utils/invoiceLayout.js";
import { invoiceDocumentArgs, physicianLabel } from "../../src/utils/invoiceArgs.js";
import { invoicePayment, expenseLineDetail, EXPENSE_INVOICE_TERMS, invoiceTextOnlyShare, invoiceCoverEmail } from "../../src/utils/invoiceCover.js";
import { dutyDayPay } from "../../src/utils/dutyPay.js";

// What the billing office receives from every invoice file (owner's iPhone,
// Oct 2026): a day-rate invoice printed empty Time and Hours columns beside a
// wrapped item, long names ran off the page, a page came loose with no
// invoice number, and a written-off invoice said PAID IN FULL. Synthetic
// people, hospitals and amounts only.

const H1 = "Synthetic Regional Medical Center of the Northern Plains (SRMC)";
const CONTRACT = { dayRate: 2400, callRateGrid: [{ hospital: H1, primary: 1500, backup: 600 }] };
function dutyInvoice(n = 1, extra = {}) {
  const lines = [];
  let total = 0;
  for (let i = 1; i <= n; i++) {
    const d = { date: `2026-08-${String(i).padStart(2, "0")}`, workedDay: i % 2 === 0, callPeriods: [{ hospital: H1, role: "primary" }] };
    const pay = dutyDayPay(CONTRACT, d);
    pay.lines.forEach((l) => lines.push({ date: d.date, label: l.label, detail: "", amount: l.amount }));
    total += pay.total;
  }
  return {
    number: "INV-20260901-3", physician: "Al Li, DO", npi: "9999999901", email: "al@example.test",
    facility: "Synthetic Regional Medical Center", agency: "Example Locum Partners", billTo: "ap@example-locums.test",
    periodStart: "2026-08-01", periodEnd: `2026-08-${String(n).padStart(2, "0")}`, terms: "Synthetic terms", lines, total, ...extra,
  };
}
const expenseInvoice = () => ({
  number: "EXP-20260815-4", kind: "expenses", physician: "Al Li, DO", email: "al@example.test", facility: "Example Locum Partners",
  periodStart: "2026-08-02", periodEnd: "2026-08-09", terms: EXPENSE_INVOICE_TERMS,
  lines: [
    { date: "2026-08-02", label: "Airfare: Example Air", detail: expenseLineDetail("Round trip", 1, true), amount: 412.4 },
    { date: "2026-08-09", label: "Lodging: Example Inn", detail: expenseLineDetail("7 nights", 0), amount: 1180 },
  ],
  total: 1592.4,
});

// The PDF's text runs, page by page, with font size and position (pt).
function pdfRuns(doc) {
  return Buffer.from(doc.output("arraybuffer")).toString("latin1").split("endstream").map((chunk) => {
    const runs = [];
    let font = "F1", size = 9, x = 0, y = 0;
    for (const line of chunk.split("\n")) {
      const tf = line.match(/^\/(F\d+) ([\d.]+) Tf$/);
      if (tf) { font = tf[1]; size = Number(tf[2]); }
      const td = line.match(/^([\d.-]+) ([\d.-]+) Td$/);
      if (td) { x = Number(td[1]); y = Number(td[2]); }
      const tj = line.match(/\((.*)\) Tj$/);
      if (tj) runs.push({ text: tj[1].replace(/\\([()\\])/g, "$1"), font, size, x, y });
    }
    return runs;
  }).filter((r) => r.length);
}
const probe = new jsPDF({ unit: "pt", format: "letter" });
const widthPt = (r) => {
  probe.setFont("helvetica", r.font === "F2" ? "bold" : "normal");
  return probe.getStringUnitWidth(r.text) * r.size;
};

test("a day-rate invoice prints Item | Amount only: no Time or Hours column, and the call line on one line", async () => {
  const inv = dutyInvoice(3);
  const layout = invoiceLayout(inv);
  assert.equal(invoiceColumns(layout.days), "plain");
  const runs = pdfRuns(buildInvoicePdf(inv)).flat().map((r) => r.text);
  assert.ok(runs.includes("Item") && runs.includes("Amount"));
  assert.ok(!runs.includes("Time") && !runs.includes("Hours"), "no empty columns");
  assert.ok(runs.includes(`On call (primary): ${H1}`), "the whole call label on one line");
  const { rows } = await xlsx(inv);
  assert.ok(rows.some((r) => r.join("|") === "Item|Amount|Day total"), "Excel has the same column set");
  const xml = await docxXml(inv);
  assert.match(xml, /<w:tblLayout w:type="fixed"\/>/, "Word: a fixed layout, not collapsed slivers");
  assert.deepEqual([...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1])), [8000, 1360]);
  assert.ok(!docxTexts(xml).includes("Time") && !docxTexts(xml).includes("Hours"));
});

test("a day's note on a day-rate invoice prints under its item, not under a Time heading", () => {
  const inv = dutyInvoice(3);
  inv.lines[0] = { ...inv.lines[0], detail: "Covered for partner" };
  assert.equal(invoiceColumns(invoiceLayout(inv).days), "plain", "one note does not add a column");
  const runs = pdfRuns(buildInvoicePdf(inv)).flat().map((r) => r.text);
  assert.ok(runs.includes("Covered for partner") && !runs.includes("Time"));
});

test("an expense invoice: Expense | Details | Amount, and its dates are Expense dates", async () => {
  const inv = expenseInvoice();
  const runs = pdfRuns(buildInvoicePdf(inv)).flat().map((r) => r.text);
  // jsPDF writes WinAnsi: the en dash is byte 0x96 in a text run.
  for (const t of ["Expense", "Details", "Amount", "Expense dates Aug 2, 2026 \x96 Aug 9, 2026"]) assert.ok(runs.includes(t), t);
  assert.ok(!runs.includes("Time") && !runs.includes("Hours") && !runs.some((r) => r.startsWith("Service period")));
  const { rows } = await xlsx(inv);
  assert.ok(rows.some((r) => r.join("|") === "Expense|Details|Amount|Day total"));
  assert.ok(rows.some((r) => r[0] === "Expense dates Aug 2, 2026 \u{2013} Aug 9, 2026"));
  const words = docxTexts(await docxXml(inv));
  assert.ok(words.includes("Expense dates Aug 2, 2026 \u{2013} Aug 9, 2026") && words.includes("Details"));
  assert.match(invoicePlainText(inv), /\nExpense dates: Aug 2, 2026 \u{2013} Aug 9, 2026\n/u);
});

test("every header line stays inside the right margin, however long the names", () => {
  const inv = dutyInvoice(1, {
    physician: "Alexandra Catherine Montgomery-Vanderbilt-Ashworth, DO",
    email: "alexandra.montgomery-vanderbilt@example-physician-group.test",
    facility: "Saint Example Regional Medical Center and Children Hospital of the Northern Plains",
    agency: "Example Nationwide Locum Tenens Staffing Partners Incorporated",
    location: "1234 Example Parkway Suite 500, Example Springs, SD 57000",
    billTo: "accounts.payable.department@example-regional-health-system.test",
  });
  const doc = buildInvoicePdf(inv);
  const W = doc.internal.pageSize.getWidth() * 72 / 25.4;
  const right = W - 16 * 72 / 25.4;
  const mid = W / 2;
  for (const [p, runs] of pdfRuns(doc).entries()) {
    for (const r of runs) {
      const end = r.x + widthPt(r);
      assert.ok(end <= right + 0.5, `page ${p + 1}: "${r.text}" ends at ${end.toFixed(1)} pt, past ${right.toFixed(1)}`);
      // A left-column header line never runs into the Bill To column.
      if (p === 0 && r.y > 600 && r.x < mid) assert.ok(end < mid + 4, `"${r.text}" runs into Bill To`);
    }
  }
});

test("US Letter, every page names its invoice and its page, and the totals never open a page alone", () => {
  for (const n of [1, 8, 14, 17, 18, 27, 31]) {
    const inv = dutyInvoice(n);
    const doc = buildInvoicePdf(inv);
    assert.equal(Math.round(doc.internal.pageSize.getHeight() * 10), 2794, "Letter, 279.4 mm");
    const pages = pdfRuns(doc);
    pages.forEach((runs, i) => {
      assert.ok(runs.some((r) => r.text === `Invoice INV-20260901-3 \u{b7} Al Li, DO \u{b7} Page ${i + 1} of ${pages.length}`), `${n} days, page ${i + 1}`);
      assert.ok(runs.some((r) => r.text.startsWith("Generated by CredentialDOMD \u{b7} ") && /\w{3} \d{1,2}, \d{4}$/.test(r.text)), "an en-US date");
    });
    const last = pages.at(-1).map((r) => r.text);
    assert.ok(last.includes("TOTAL DUE"));
    assert.ok(last.some((t) => t.startsWith("Total for ")), `${n} days: the last day's total shares the page with TOTAL DUE`);
  }
});

test("the questions line points at the physician, never at the payer's own inbox", () => {
  const texts = pdfRuns(buildInvoicePdf(dutyInvoice(1))).flat().map((r) => r.text);
  // "Al Li, DO, al@example.test" read as a list of three; the email is set apart.
  assert.ok(texts.includes("Questions about this invoice: Al Li, DO (al@example.test)"));
  assert.ok(!texts.some((t) => /remit/i.test(t)));
  const paid = pdfRuns(buildInvoicePdf(dutyInvoice(1, { paid: 1500, balance: 0 }))).flat().map((r) => r.text);
  assert.ok(paid.includes("PAID IN FULL") && !paid.some((t) => /remit/i.test(t)));
});

test("letters outside the PDF font print as their nearest Latin letter, never as wrong ones", () => {
  assert.equal(pdfText("\u{141}ukasz W\u{f3}jcik-Nguy\u{1ec5}n, DO"), "Lukasz W\u{f3}jcik-Nguy\u{ea}n, DO");
  assert.equal(pdfText("Ay\u{15f}e \u{15e}ahin, \u{130}stanbul"), "Ayse Sahin, Istanbul");
  assert.equal(pdfText("Net 30 \u{2192} payable \u{2265} 2 days"), "Net 30 to payable >= 2 days");
  assert.equal(pdfText("Saint\u{2011}J\u{e9}r\u{f4}me \u{2014} note"), "Saint-J\u{e9}r\u{f4}me, note", "no em dash, no dropped hyphen");
  assert.equal(pdfText("\u{738b}\u{4f1f}"), "??", "no Latin form: a placeholder, not wrong letters");
  const texts = pdfRuns(buildInvoicePdf(dutyInvoice(1, { physician: "\u{141}ukasz Nguy\u{1ec5}n, DO" }))).flat().map((r) => r.text);
  assert.ok(texts.includes("Lukasz Nguy\u{ea}n, DO"));
});

test("invoice files are named like a subject in every format", async () => {
  const inv = dutyInvoice(1);
  assert.equal(invoicePdfFile(inv).name, "Invoice INV-20260901-3 from Al Li, DO.pdf");
  assert.equal(invoiceTextPdfFile(inv, "INVOICE").name, "Invoice INV-20260901-3 from Al Li, DO.pdf");
  assert.equal(invoiceXlsxFile(inv).name, "Invoice INV-20260901-3 from Al Li, DO.xlsx");
  assert.equal((await invoiceDocxFile(inv)).name, "Invoice INV-20260901-3 from Al Li, DO.docx");
});

test("Word: US Letter with 1 inch margins, light rules instead of a black grid, one font, page numbers", async () => {
  const xml = await docxXml(dutyInvoice(3));
  assert.match(xml, /<w:pgSz w:w="12240" w:h="15840"/);
  assert.match(xml, /<w:insideV w:val="none"/);
  assert.match(xml, /<w:insideH w:val="single" w:color="DDDDDD"/);
  const zip = await docxZip(dutyInvoice(3));
  assert.match(await zip.file("word/styles.xml").async("string"), /w:ascii="Arial"/);
  const footer = Object.keys(zip.files).find((f) => /word\/footer\d*\.xml/.test(f));
  assert.ok(footer, "a footer");
  assert.match(await zip.file(footer).async("string"), /PAGE[\s\S]*NUMPAGES/);
});

test("a written-off invoice resent after a partial payment never says PAID IN FULL", async () => {
  const stored = { number: "INV-1", totalAmount: 6400, payments: [{ amount: 1000 }], writeOffAt: "2026-09-30T12:00:00Z", lines: dutyInvoice(1).lines.map((l) => ({ ...l, amount: 6400 })) };
  const args = invoiceDocumentArgs(stored, null, { name: "Al Li", degreeType: "DO" });
  assert.equal(args.balance, 5400);
  const pay = invoicePayment(args);
  assert.deepEqual([pay.settled, pay.partial, pay.balance], [false, true, 5400]);
  const texts = pdfRuns(buildInvoicePdf(args)).flat().map((r) => r.text);
  assert.ok(!texts.includes("PAID IN FULL") && texts.includes("BALANCE DUE"));
  assert.ok(!invoicePlainText(args).includes("PAID IN FULL"));
  const { rows } = await xlsx(args);
  assert.ok(!rows.flat().includes("PAID IN FULL"));
});

test("the degree is never printed twice", () => {
  assert.equal(physicianLabel({ name: "Jordan Rivera, DO", degreeType: "DO" }), "Jordan Rivera, DO");
  assert.equal(physicianLabel({ name: "Jordan Rivera D.O.", degreeType: "DO" }), "Jordan Rivera D.O.");
  assert.equal(physicianLabel({ name: "Jordan Rivera", degreeType: "DO" }), "Jordan Rivera, DO");
});

// withDegree compared the last word of the name with the degree whatever its
// case, so the surname Do swallowed the DO credential on every resend.
test("a surname that spells the degree still gets the degree on the invoice", () => {
  assert.equal(physicianLabel({ name: "Ann Do", degreeType: "DO" }), "Ann Do, DO");
  const args = invoiceDocumentArgs({ number: "INV-1", lines: [] }, { facility: "Example Hospital" }, { name: "Ann Do", degreeType: "DO" });
  assert.equal(args.physician, "Ann Do, DO");
});

test("a flat table whose lines carry fractions of a cent foots to TOTAL DUE with a rounding row", async () => {
  const lines = [0, 1, 2].map((i) => ({ date: "2026-06-02", label: `Call ${i}`, detail: "15 min @ $262.50/hr", amount: 65.625 }));
  const inv = { number: "INV-1", lines, total: 196.875 };
  const layout = invoiceLayout(inv);
  assert.equal(layout.mode, "flat");
  assert.equal(roundingAdjustmentCents(inv), -1);
  const amounts = layout.rows.map((r) => Math.round(Number(r[3].replace(/[$,]/g, "")) * 100));
  assert.equal(amounts.reduce((a, b) => a + b, 0), 19688, "the column adds to the $196.88 printed as TOTAL DUE");
  assert.deepEqual(layout.rows.at(-1), ["", "Rounding adjustment", "lines rounded to the cent", "-$0.01"]);
  assert.match(invoicePlainText(inv), /Rounding adjustment \u{b7} -\$0\.01/u);
  const { rows } = await xlsx(inv);
  const sheetAmounts = rows.filter((r) => typeof r[3] === "number" && r[2] !== "TOTAL").map((r) => Math.round(r[3] * 100));
  assert.equal(sheetAmounts.reduce((a, b) => a + b, 0), 19688);
  // A gap rounding cannot explain is not papered over.
  assert.equal(roundingAdjustmentCents({ lines, total: 150 }), 0);
});

test("the text invoice: one date for one day, no empty To line, no amounts written as equations", () => {
  const one = invoicePlainText({ ...dutyInvoice(1), periodEnd: "2026-08-01", facility: "", agency: "" });
  assert.match(one, /\nPeriod: Aug 1, 2026\n/);
  assert.doesNotMatch(one, /\nTo:/);
  assert.doesNotMatch(one, / = /);
  assert.match(invoicePlainText({ ...dutyInvoice(1), facility: "" }), /\nTo: Example Locum Partners\n/);
});

test("the no-file share body: one sentence per day, every line ending a sentence", () => {
  const text = invoiceSentenceText(dutyInvoice(2));
  assert.deepEqual(text.split("\n"), [
    `Sat, Aug 1, 2026: On call (primary): ${H1}, $1,500.00.`,
    `Sun, Aug 2, 2026: Day worked, $2,400.00; On call (primary): ${H1}, $1,500.00. Day total $3,900.00.`,
    "Total due $5,400.00.",
  ]);
});

// An email has no spaces, so the column wrap cut it wherever the column
// filled ("...example-regional-health-syst" / "em.test"); a clerk retyping it
// got it wrong. Then it broke AFTER a hyphen ("...@example-physician-" /
// "group.test"), and a line-end hyphen reads as a wrap hyphen to drop.
test("a long email in the PDF header breaks before @, a dot or a hyphen, never mid-word or after one", () => {
  const from = "alexandra.montgomery-vanderbilt@example-physician-group.test";
  const billTo = "accounts.payable.department@example-regional-health-system.test";
  const runs = pdfRuns(buildInvoicePdf(dutyInvoice(1, { email: from, billTo }))).flat().map((r) => r.text);
  for (const address of [from, billTo]) {
    const i = runs.findIndex((t) => address.startsWith(t) && t.length > 8);
    assert.ok(i >= 0, address);
    let joined = "";
    const parts = [];
    for (let k = i; joined.length < address.length; k++) { parts.push(runs[k]); joined += runs[k]; }
    assert.equal(joined, address, "the address is whole, in order");
    assert.ok(parts.length > 1, "it does wrap in the column");
    for (const part of parts.slice(0, -1)) assert.doesNotMatch(part, /[@.\-_/]$/, `"${part}" ends a line on a separator`);
    for (let k = 1; k < parts.length; k++) {
      assert.match(parts[k], /^[@.\-_/]/, `breaks between "${parts[k - 1]}" and "${parts[k]}"`);
    }
  }
  assert.ok(!runs.includes("em.test") && !runs.some((t) => t.endsWith("-syst")), "never mid-word");
  assert.ok(!runs.some((t) => t.endsWith("@example-physician-") || t.endsWith("-health-")), "never a line-end hyphen");
});

// A profile with no name sent documents signed FROM "Physician", and the
// Word footer said "Invoice INV-1 · Physician · Page 1 of 1".
test("with no name in Settings no document is signed 'Physician': the email stands as the sender", async () => {
  const inv = dutyInvoice(1, { physician: "Physician", phone: "(555) 010-0199" });
  const pdf = pdfRuns(buildInvoicePdf(inv));
  const texts = pdf.flat().map((r) => r.text);
  assert.ok(!texts.includes("Physician"), "PDF FROM");
  const sender = pdf[0].find((r) => r.text === "al@example.test");
  assert.equal(sender.font, "F2", "the email is the bold sender line");
  assert.ok(texts.includes("Questions about this invoice: al@example.test"));
  assert.ok(texts.some((t) => t.startsWith("Invoice INV-20260901-3 \u{b7} Page 1 of")), "no name in the footer");
  const { rows } = await xlsx(inv);
  assert.ok(!rows.flat().includes("Physician"), "Excel FROM");
  assert.equal(rows[rows.findIndex((r) => r[0] === "FROM") + 1][0], "al@example.test", "Excel: the email is the sender");
  const zip = await docxZip(inv);
  const words = docxTexts(await zip.file("word/document.xml").async("string"));
  assert.ok(!words.includes("Physician") && words.includes("al@example.test"), "Word FROM");
  const footer = Object.keys(zip.files).find((f) => /word\/footer\d*\.xml/.test(f));
  const footerText = docxTexts(await zip.file(footer).async("string")).join("");
  assert.doesNotMatch(footerText, /Physician/);
  assert.match(footerText, /^Invoice INV-20260901-3 \u{b7} Page /u);
  assert.doesNotMatch(invoicePlainText(inv), /Physician/, "text invoice");
});

// The text invoice with no name opened "From: NPI 9999999901" and then
// "Email: ...", so the NPI read as the sender while the PDF, Word and Excel
// named the email. The text-only share signed "Thank you, NPI ... · email".
test("with no name the text invoice and the text-only share name the email as the sender, ahead of the NPI", () => {
  const inv = dutyInvoice(1, { physician: "Physician", phone: "(555) 010-0199" });
  const text = invoicePlainText(inv);
  assert.match(text, /\nFrom: al@example\.test \u{b7} NPI 9999999901\nPhone: \(555\) 010-0199\n/u);
  assert.doesNotMatch(text, /^Email:/m, "the email is not printed twice");
  assert.match(invoicePlainText({ ...inv, npi: "" }), /\nFrom: al@example\.test\nPhone: /, "no NPI: the email alone");
  assert.match(invoicePlainText(dutyInvoice(1)), /\nFrom: Al Li, DO \u{b7} NPI 9999999901\nEmail: al@example\.test\n/u, "a name still leads, the email on its own line");
  assert.match(invoiceTextOnlyShare(inv, text), /Thank you,\nal@example\.test \u{b7} NPI 9999999901 \u{b7} \(555\) 010-0199$/u);
  assert.match(invoiceCoverEmail(inv), /Thank you,\nal@example\.test\nNPI 9999999901\n\(555\) 010-0199$/);
});

// The PDF printed the phone under FROM; Word and Excel stopped at the email.
test("the phone prints under FROM in the PDF, Word, Excel and the text invoice alike", async () => {
  const inv = dutyInvoice(1, { phone: "(555) 010-0199" });
  const pdf = pdfRuns(buildInvoicePdf(inv)).flat().map((r) => r.text);
  const pdfFrom = pdf.slice(pdf.indexOf("Al Li, DO"));
  assert.deepEqual(["NPI 9999999901", "al@example.test", "(555) 010-0199"].map((t) => pdfFrom.includes(t)), [true, true, true]);
  const { rows } = await xlsx(inv);
  const at = rows.findIndex((r) => r[0] === "FROM");
  assert.deepEqual(rows.slice(at + 1, at + 5).map((r) => r[0]), ["Al Li, DO", "NPI 9999999901", "al@example.test", "(555) 010-0199"]);
  assert.equal(rows[at + 1][2], "Synthetic Regional Medical Center", "BILL TO still beside FROM");
  assert.ok(rows.some((r) => r.join("|") === "Item|Amount|Day total"), "the table still follows the header");
  const words = docxTexts(await docxXml(inv));
  const w = words.indexOf("Al Li, DO");
  assert.deepEqual(words.slice(w, w + 4), ["Al Li, DO", "NPI 9999999901", "al@example.test", "(555) 010-0199"]);
  assert.match(invoicePlainText(inv), /\nEmail: al@example\.test\nPhone: \(555\) 010-0199\n/);
});

// A send site that appends the degree to a name typed with it ("Jordan
// Rivera, DO" + ", DO") printed "DO, DO" in every document.
test("a degree printed twice by a send site reads once on every document", async () => {
  const inv = dutyInvoice(1, { physician: "Jordan Rivera, DO, DO" });
  const pdf = pdfRuns(buildInvoicePdf(inv)).flat().map((r) => r.text);
  assert.ok(pdf.includes("Jordan Rivera, DO") && !pdf.some((t) => /DO, DO/.test(t)));
  assert.equal(invoicePdfFile(inv).name, "Invoice INV-20260901-3 from Jordan Rivera, DO.pdf");
  const { rows } = await xlsx(inv);
  assert.ok(!rows.flat().some((t) => /DO, DO/.test(String(t))));
  assert.ok(!docxTexts(await docxXml(inv)).some((t) => /DO, DO/.test(t)));
  assert.doesNotMatch(invoicePlainText(inv), /DO, DO/);
});

// Excel shows a label only up to the next filled cell, and Amount beside a
// charge is always filled: a 110 character call label was cut off.
test("Excel's Item column is wide enough for its longest item", async () => {
  const long = "Saint Example Regional Medical Center and Children's Hospital of the Northern Plains (SERMC)";
  const inv = { ...dutyInvoice(1), lines: [{ date: "2026-08-01", label: `On call: ${long} (primary)`, detail: "", amount: 1500 }], total: 1500 };
  const wb = XLSX.read(new Uint8Array(await invoiceXlsxFile(inv).arrayBuffer()), { type: "array", cellStyles: true });
  const width = wb.Sheets.Invoice["!cols"][0].wch;
  const label = `On call (primary): ${long}`;
  assert.ok(width >= label.length, `${width} < ${label.length}`);
  const brief = { ...dutyInvoice(1), lines: [{ date: "2026-08-01", label: "On call: Example Hospital (EH) (primary)", detail: "", amount: 1500 }], total: 1500 };
  const short = XLSX.read(new Uint8Array(await invoiceXlsxFile(brief).arrayBuffer()), { type: "array", cellStyles: true });
  assert.equal(short.Sheets.Invoice["!cols"][0].wch, 72, "a short item keeps the usual width");
});

// ── helpers ──
async function xlsx(inv) {
  const wb = XLSX.read(new Uint8Array(await invoiceXlsxFile(inv).arrayBuffer()), { type: "array" });
  return { rows: XLSX.utils.sheet_to_json(wb.Sheets.Invoice, { header: 1, defval: "" }) };
}
async function docxZip(inv) { return JSZip.loadAsync(await (await invoiceDocxFile(inv)).arrayBuffer()); }
async function docxXml(inv) { return (await docxZip(inv)).file("word/document.xml").async("string"); }
function docxTexts(xml) { return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]); }
