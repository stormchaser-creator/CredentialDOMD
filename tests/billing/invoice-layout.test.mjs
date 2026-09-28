import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import * as live from "../../src/utils/billing.js";
import * as frozen from "./legacy-billing-d46679ac.mjs";
import { invoiceLayout, invoiceDays, invoicePlainText } from "../../src/utils/invoiceLayout.js";
import { buildInvoicePdf } from "../../src/utils/invoicePdf.js";
import { invoiceXlsxFile, invoiceDocxFile } from "../../src/utils/invoiceExport.js";
import { invoiceDocumentArgs } from "../../src/utils/invoiceArgs.js";
import { dutyDayPay } from "../../src/utils/dutyPay.js";
import { expenseLineDetail, EXPENSE_INVOICE_TERMS, TEXT_RULE } from "../../src/utils/invoiceCover.js";
import { NORTHFIELD, NORTHFIELD_CONTRACT, northfieldEntries } from "./fixtures/northfield.mjs";

// The invoice day layout (src/utils/invoiceLayout.js): every day a block
// with its own total, "included" work saying which stipend it sits in, and
// the day totals adding to the invoice total or the old flat table instead.
// The owner's real Northfield invoice is the fixture; everything else is
// synthetic. The fixture runs on Central time, so this file does too.
const originalTimezone = process.env.TZ;
process.env.TZ = "America/Chicago";
const RealDate = globalThis.Date;
const NOW = "2026-09-28T12:00:00-05:00";
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return new RealDate(NOW).getTime(); }
};
test.after(() => {
  globalThis.Date = RealDate;
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

const EM_DASH = String.fromCodePoint(0x2014);
const { computeBilling, LAYOUT_LINE_FIELDS } = live;
const strip = (line) => Object.fromEntries(Object.entries(line).filter(([k]) => !LAYOUT_LINE_FIELDS.includes(k)));
const stripAll = (lines) => lines.map(strip);
const northfield = () => ({ lines: NORTHFIELD.lines, total: NORTHFIELD.total });
const table = (day) => day.rows.map((r) => [r.item, r.detail ?? r.time, r.hours, r.amountText]);
const cents = (n) => Math.round(n * 100);
const sumCents = (xs) => xs.reduce((s, x) => s + cents(x), 0);

// Every format, as text a reader would see.
const DOC = { number: "INV-SYN-1", physician: "Synthetic Physician, DO", npi: "9999999999", email: "doc@example.test", facility: "Synthetic Medical Center", agency: "Synthetic Locums", location: "Plainsview, ND", periodStart: "2026-09-25", periodEnd: "2026-09-28", terms: "Synthetic terms" };
const pdfRuns = (inv) => [...Buffer.from(buildInvoicePdf({ ...DOC, ...inv }).output("arraybuffer")).toString("latin1").matchAll(/\((.*)\) Tj/g)].map((m) => m[1]);
const xlsxRows = async (inv) => {
  const file = invoiceXlsxFile({ ...DOC, ...inv });
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
  return { ws: wb.Sheets.Invoice, rows: XLSX.utils.sheet_to_json(wb.Sheets.Invoice, { header: 1, defval: "" }) };
};
const docxXml = async (inv) => {
  const file = await invoiceDocxFile({ ...DOC, ...inv });
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  return zip.file("word/document.xml").async("string");
};
const docxTexts = (xml) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
// A PDF's text, page by page, each run with its baseline in mm from the top
// of the page (jsPDF writes one content stream per page, in order).
const PT = 72 / 25.4;
const pdfPages = (inv) => {
  const doc = buildInvoicePdf({ ...DOC, ...inv });
  const H = doc.internal.pageSize.getHeight();
  const pages = Buffer.from(doc.output("arraybuffer")).toString("latin1").split("endstream").map((chunk) => {
    const runs = [];
    let y = null;
    for (const line of chunk.split("\n")) {
      const td = line.match(/^([\d.-]+) ([\d.-]+) Td$/);
      if (td) y = H - Number(td[2]) / PT;
      const tj = line.match(/\((.*)\) Tj$/);
      if (tj) runs.push({ text: tj[1].replace(/\\([()\\])/g, "$1"), y });
    }
    return runs;
  }).filter((runs) => runs.length);
  return { doc, H, pages };
};
// A day's header band as the PDF prints it.
const bandOf = (day) => (day.window ? `${day.title}   \u{b7}   ${day.window}` : day.title);

async function assertNoEmDash(inv, what) {
  const layout = invoiceLayout(inv);
  assert.ok(!JSON.stringify(layout).includes(EM_DASH), `${what}: layout`);
  assert.ok(!invoicePlainText({ ...DOC, ...inv }).includes(EM_DASH), `${what}: text`);
  // jsPDF writes WinAnsi: an em dash is byte 0x97 in a text run.
  for (const run of pdfRuns(inv)) assert.ok(!run.includes("\x97") && !run.includes(EM_DASH), `${what}: PDF run ${run}`);
  const { rows } = await xlsxRows(inv);
  assert.ok(!JSON.stringify(rows).includes(EM_DASH), `${what}: Excel`);
  assert.ok(!(await docxXml(inv)).includes(EM_DASH), `${what}: Word`);
}

// Synthetic entries, built the way the Work Log saves them.
let seq = 0;
const at = (s) => { const [d, t] = s.split(" "); const [y, m, dd] = d.split("-").map(Number); const [hh, mi] = t.split(":").map(Number); return new Date(y, m - 1, dd, hh, mi).toISOString(); };
const roundUp = (raw, inc, min) => Math.max(min || 0, Math.ceil(raw / inc) * inc || inc);
function entry(contract, type, from, to, extra = {}) {
  const s = at(from), e = at(to);
  const raw = Math.max(1, Math.round((new RealDate(e) - new RealDate(s)) / 60000));
  const inc = contract.incrementMinutes || 15;
  const billed = roundUp(raw, inc, type === "Call" || type === "Transfer call" ? (contract.minCallMinutes || 15) : 0);
  seq += 1;
  return {
    id: `e${String(seq).padStart(3, "0")}`, createdAt: `2026-09-01T00:00:${String(seq % 60).padStart(2, "0")}Z`, contractId: contract.id, type,
    date: live.localDate(s), callDay: live.deriveCallDay(s, live.callDayStartHour(contract)), startTime: s, endTime: e,
    durationMin: raw, billedMin: billed, description: "", privateNote: "", invoiceId: null, ...extra,
  };
}
const STIPEND = { id: "c-stipend", callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: "2026-07-28", end: "2026-08-09" }] };
const FLAT = { id: "c-flat", callStipend: 0, hourlyRate: 250, callHourlyRate: 150, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [] };
const days = (...d) => new Set(d);

// ── The owner's invoice ─────────────────────────────────────────

test("Northfield: four day blocks totalling $5,250, $6,450, $6,525 and $3,000, which add to the $21,225 invoice", () => {
  const layout = invoiceLayout(northfield());
  assert.equal(layout.mode, "days", layout.reason);
  assert.deepEqual(layout.days.map((d) => d.title), ["Fri, Sep 25, 2026", "Sat, Sep 26, 2026", "Sun, Sep 27, 2026", "Mon, Sep 28, 2026"]);
  assert.deepEqual(layout.days.map((d) => d.total), [5250, 6450, 6525, 3000]);
  assert.deepEqual(layout.days.map((d) => d.totalLabel), ["Total for Fri, Sep 25, 2026", "Total for Sat, Sep 26, 2026", "Total for Sun, Sep 27, 2026", "Total for Mon, Sep 28, 2026"]);
  assert.equal(sumCents(layout.days.map((d) => d.total)), cents(21225));
  assert.equal(NORTHFIELD.total, 21225);
  assert.deepEqual(layout.days.map((d) => d.window), [
    "call day 7:00 AM Sep 25 to 7:00 AM Sep 26", "call day 7:00 AM Sep 26 to 7:00 AM Sep 27",
    "call day 7:00 AM Sep 27 to 7:00 AM Sep 28", "call day 7:00 AM Sep 28 to 7:00 AM Sep 29",
  ]);
});

test("Northfield: a day reads orientation, the stipend, the work inside it, then the callback beyond it, each with its own dollars", () => {
  const [fri, sat, sun, mon] = invoiceDays(northfield());
  assert.deepEqual(table(fri), [
    ["Orientation", "8:30 AM–11:00 AM", "2.50 h @ $300.00/hr", "$750.00"],
    ["Orientation", "11:30 AM–3:30 PM", "4.00 h @ $300.00/hr", "$1,200.00"],
    ["24-hour call stipend", "covers the first 4.00 h of work", "4.00 h used of 4.00 h", "$3,000.00"],
    ["Rounding: Consults and family meetings. OR planning", "3:30 PM–7:30 PM", "4.00 h", "in $3,000.00 stipend"],
    ["Callback beyond 4 h", "", "1.00 h @ $300.00/hr", "$300.00"],
    ["Call: Consult C", "10:45 PM–11:00 PM", "0.25 h", "$75.00"],
    ["Call: Phone consult J", "1:00 AM–1:15 AM", "0.25 h", "$75.00"],
    ["Call: Phone call E", "1:45 AM–2:00 AM", "0.25 h", "$75.00"],
    ["Call: ED call K", "2:00 AM–2:15 AM", "0.25 h", "$75.00"],
  ]);
  assert.deepEqual(table(mon), [["24-hour call stipend", "covers the first 4.00 h of work", "no work logged", "$3,000.00"]]);
  assert.deepEqual(table(sat).slice(0, 4), [
    ["24-hour call stipend", "covers the first 4.00 h of work", "4.00 h used of 4.00 h", "$3,000.00"],
    ["Rounding: Rounds. Notes. Family meetings", "7:30 AM–9:30 AM", "2.00 h", "in $3,000.00 stipend"],
    ["Procedure: Case R", "9:30 AM–11:30 AM", "2.00 h", "in $3,000.00 stipend"],
    ["Callback beyond 4 h", "", "11.50 h @ $300.00/hr", "$3,450.00"],
  ]);
  assert.deepEqual(table(sun)[2], ["Callback beyond 4 h", "", "11.75 h @ $300.00/hr", "$3,525.00"]);
  // "included" always says which stipend, in dollars; every item beyond it carries its own amount.
  const all = [fri, sat, sun, mon].flatMap((d) => d.rows);
  const inside = all.filter((r) => r.tone === "included");
  assert.equal(inside.length, 4);
  assert.ok(inside.every((r) => r.amountText === "in $3,000.00 stipend" && r.amount == null && !r.sums));
  const beyond = Object.fromEntries(all.filter((r) => r.level === 1 && r.amount != null).map((r) => [r.item, r.amountText]));
  assert.equal(beyond["Procedure: Case T"], "$1,650.00");
  assert.equal(beyond["Procedure: Case P. Notes and consults"], "$1,050.00");
  assert.equal(beyond["Sign-out: Consults and sign out"], "$675.00");
  // Under each callback, the items' own dollars are the callback, exactly.
  for (const day of [fri, sat, sun]) {
    const i = day.rows.findIndex((r) => r.item.startsWith("Callback beyond"));
    assert.equal(sumCents(day.rows.slice(i + 1).map((r) => r.amount)), cents(day.rows[i].amount), day.title);
  }
  // Only the stipend, callback and orientation rows make the day total.
  assert.deepEqual(fri.rows.filter((r) => r.sums).map((r) => r.amount), [750, 1200, 3000, 300]);
});

test("Northfield priced again by the live engine: the stored lines come back byte-identical, with the numbers they were written from", () => {
  const entries = northfieldEntries();
  const priced = computeBilling(NORTHFIELD_CONTRACT, entries, true, entries, [], null);
  assert.equal(JSON.stringify(stripAll(priced.lines)), JSON.stringify(NORTHFIELD.lines), "the real invoice, line for line");
  assert.equal(priced.total, NORTHFIELD.total);
  assert.deepEqual(priced.dayOverMin, NORTHFIELD.dayOverMin);
  const [day, orientation] = priced.lines;
  assert.deepEqual(
    Object.fromEntries(Object.entries(day).filter(([k]) => LAYOUT_LINE_FIELDS.includes(k))),
    { kind: "stipendDay", stipend: 3000, allowanceMin: 240, priorMin: 0, loggedMin: 300, usedMin: 240, overMin: 60, overAmount: 300, rate: 300, dayStartHour: 7 },
  );
  assert.deepEqual([orientation.kind, orientation.minutes, orientation.rate, orientation.timeText], ["orientation", 150, 300, "8:30 AM–11:00 AM"]);
  const work = priced.lines.find((l) => l.label === "\u{b7} Procedure: Case T");
  assert.deepEqual([work.kind, work.minutes, work.includedMin, work.overMin, work.overAmount, work.timeText], ["work", 330, 0, 330, 1650, "12:30 PM–6:00 PM"]);
  // New lines and the stored ones print the same invoice.
  assert.deepEqual(invoiceLayout({ lines: priced.lines, total: priced.total }), invoiceLayout(northfield()));
});

test("entry labels print verbatim, as logged: \"<Type>: <billing note>\", trailing space and all", async () => {
  const logged = NORTHFIELD.lines.filter((l) => !l.date).map((l) => l.label.slice(2));
  assert.ok(logged.includes("Call: Phone call I. "), "the fixture keeps a note's trailing space");
  const items = invoiceDays(northfield()).flatMap((d) => d.rows).filter((r) => r.level === 1).map((r) => r.item);
  assert.deepEqual(items, logged);
  const entries = northfieldEntries();
  const priced = computeBilling(NORTHFIELD_CONTRACT, entries, true, entries, [], null);
  const fromNew = invoiceDays({ lines: priced.lines, total: priced.total }).flatMap((d) => d.rows).filter((r) => r.level === 1).map((r) => r.item);
  assert.deepEqual(fromNew, entries.filter((e) => e.type !== "Orientation").map((e) => `${e.type}: ${e.description}`));
  const { rows } = await xlsxRows(northfield());
  for (const label of logged) assert.ok(rows.some((r) => r[0] === label), `Excel: ${label}`);
  const words = docxTexts(await docxXml(northfield()));
  for (const label of logged) assert.ok(words.includes(label), `Word: ${label}`);
  const text = invoicePlainText({ ...DOC, ...northfield() });
  for (const label of logged) assert.ok(text.includes(`     ${label} \u{b7} `), `text: ${label}`);
});

// ── Other contracts and days ────────────────────────────────────

test("an hourly contract: each day its work at its own rate, a covered call at no charge, a total per day", () => {
  const c = FLAT;
  const list = [
    entry(c, "Procedure", "2026-08-04 08:00", "2026-08-04 12:00", { description: "Lumbar fusion" }),
    entry(c, "Call", "2026-08-04 09:00", "2026-08-04 09:05", { description: "Floor question" }),
    entry(c, "Consult", "2026-08-04 13:00", "2026-08-04 14:00"),
    entry(c, "Call", "2026-08-05 02:10", "2026-08-05 02:40", { description: "ED" }),
    entry(c, "Call", "2026-08-05 20:00", "2026-08-05 20:30"),
  ];
  const priced = computeBilling(c, list, true, list, [], null);
  assert.equal(priced.total, 1000 + 250 + 75 + 75);
  const inv = { lines: priced.lines, total: priced.total };
  const [aug4, aug5] = invoiceDays(inv);
  assert.deepEqual([aug4.total, aug5.total], [1250 + 75, 75]);
  // The 2:00 AM call is the morning of Aug 5, filed under Aug 4's day: that
  // day says its 24 hours. A day of daytime work needs no window.
  assert.equal(aug4.window, "call day 7:00 AM Aug 4 to 7:00 AM Aug 5");
  assert.equal(aug5.window, "");
  assert.deepEqual(table(aug4), [
    ["Procedure: Lumbar fusion", "8:00 AM–12:00 PM", "4.00 h @ $250.00/hr", "$1,000.00"],
    ["Call: Floor question", "9:00 AM–9:15 AM", "during Procedure 8:00 AM–12:00 PM", "no charge"],
    ["Consult", "1:00 PM–2:00 PM", "1.00 h @ $250.00/hr", "$250.00"],
    ["Call: ED", "2:00 AM–2:30 AM", "0.50 h @ $150.00/hr", "$75.00"],
  ]);
  assert.deepEqual(table(aug5), [["Call", "8:00 PM–8:30 PM", "0.50 h @ $150.00/hr", "$75.00"]]);
  // The same invoice resent from lines saved before the layout fields.
  assert.deepEqual(invoiceLayout({ lines: stripAll(priced.lines), total: priced.total }), invoiceLayout(inv));
});

test("a stipend day: work split across the allowance shows both parts, a call inside a procedure is no charge", () => {
  const c = STIPEND;
  const list = [
    entry(c, "Rounding", "2026-08-06 07:00", "2026-08-06 10:00"),
    entry(c, "Procedure", "2026-08-06 13:00", "2026-08-06 15:00", { description: "Crani" }),
    entry(c, "Call", "2026-08-06 13:30", "2026-08-06 13:40", { description: "Floor" }),
    entry(c, "Call", "2026-08-06 23:00", "2026-08-06 23:10", { description: "ED" }),
  ];
  const priced = computeBilling(c, list, true, list, [], days("2026-08-06"));
  assert.equal(priced.total, 3000 + 300 + 75);
  const inv = { lines: priced.lines, total: priced.total };
  const [day] = invoiceDays(inv);
  assert.equal(day.total, 3375);
  assert.deepEqual(table(day), [
    ["24-hour call stipend", "covers the first 4.00 h of work", "4.00 h used of 4.00 h", "$3,000.00"],
    ["Rounding", "7:00 AM–10:00 AM", "3.00 h", "in $3,000.00 stipend"],
    ["Callback beyond 4 h", "", "1.25 h @ $300.00/hr", "$375.00"],
    ["Procedure: Crani", "1:00 PM–3:00 PM", "2.00 h (1.00 h in stipend, 1.00 h beyond)", "$300.00"],
    ["Call: Floor", "1:30 PM–1:45 PM", "during Procedure 1:00 PM–3:00 PM", "no charge"],
    ["Call: ED", "11:00 PM–11:15 PM", "0.25 h", "$75.00"],
  ]);
  assert.equal(day.window, "call day 7:00 AM Aug 6 to 7:00 AM Aug 7");
  assert.deepEqual(invoiceLayout({ lines: stripAll(priced.lines), total: priced.total }), invoiceLayout(inv));
});

test("an \"Additional work\" day: the stipend went out on an earlier invoice, so only the callback bills, and the day says so", () => {
  const c = STIPEND;
  const earlier = entry(c, "Rounding", "2026-08-05 07:00", "2026-08-05 10:00", { invoiceId: "inv-old" });
  const late = [
    entry(c, "Procedure", "2026-08-05 18:00", "2026-08-05 20:00", { description: "Shunt" }),
    entry(c, "Call", "2026-08-05 22:00", "2026-08-05 22:10", { description: "ICU" }),
  ];
  const all = [earlier, ...late];
  const invoices = [{ id: "inv-old", contractId: c.id, entryIds: [earlier.id], dayOverMin: { "2026-08-05": 0 }, lines: [{ date: "2026-08-05", label: "On-call coverage (daily total)", amount: 3000 }] }];
  const priced = computeBilling(c, late, true, all, invoices, days("2026-08-05"));
  assert.equal(priced.lines[0].label, "Additional work (daily total)");
  assert.equal(priced.total, 375);
  const inv = { lines: priced.lines, total: priced.total };
  const [day] = invoiceDays(inv);
  assert.equal(day.total, 375);
  assert.deepEqual(table(day), [
    ["24-hour call stipend", "billed on an earlier invoice", "4.00 h used of 4.00 h", ""],
    ["Callback beyond 4 h", "", "1.25 h @ $300.00/hr", "$375.00"],
    ["Procedure: Shunt", "6:00 PM–8:00 PM", "2.00 h (1.00 h in stipend, 1.00 h beyond)", "$300.00"],
    ["Call: ICU", "10:00 PM–10:15 PM", "0.25 h", "$75.00"],
  ]);
  // Saved before the layout fields, the line does not say the allowance; the day still adds up.
  const legacy = invoiceDays({ lines: stripAll(priced.lines), total: priced.total });
  assert.equal(legacy[0].total, 375);
  assert.deepEqual(table(legacy[0]).map((r) => r[3]), ["", "$375.00", "$300.00", "$75.00"]);
  assert.equal(table(legacy[0])[1][0], "Callback beyond stipend hours");
  // Late work that stayed inside the stipend bills $0, and the day says $0.
  const small = [entry(c, "Call", "2026-08-05 21:00", "2026-08-05 21:10")];
  const within = computeBilling(c, small, true, [earlier, ...small], invoices, days("2026-08-05"));
  const [zero] = invoiceDays({ lines: within.lines, total: within.total });
  assert.equal(zero.total, 0);
  assert.deepEqual(table(zero)[1], ["Call", "9:00 PM–9:15 PM", "0.25 h", "in $3,000.00 stipend"]);
});

test("a day-rate contract: each day's worked day and call periods, and a total for the day", () => {
  const contract = { id: "c-day", payModel: "daily", dayRate: 2060.09, callRateGrid: [{ hospital: "Synthetic Regional (SR)", primary: 1000, backup: 400 }] };
  const duties = [
    { date: "2026-08-03", workedDay: true, callPeriods: [{ hospital: "Synthetic Regional (SR)", role: "primary" }], notes: "Clinic and OR" },
    { date: "2026-08-04", workedDay: false, callPeriods: [{ hospital: "Synthetic Regional (SR)", role: "backup" }] },
    { date: "2026-08-05", workedDay: true },
  ];
  // As DutyLog builds them.
  const lines = [];
  let total = 0;
  for (const d of duties) {
    const pay = dutyDayPay(contract, d);
    pay.lines.forEach((l, i) => lines.push({ date: d.date, label: l.label, detail: i === 0 && d.notes ? d.notes : "", amount: l.amount }));
    total += pay.total;
  }
  total = Math.round(total * 100) / 100;
  const inv = { lines, total };
  const layout = invoiceDays(inv);
  assert.deepEqual(layout.map((d) => d.total), [3060.09, 400, 2060.09]);
  assert.equal(sumCents(layout.map((d) => d.total)), cents(total));
  assert.ok(layout.every((d) => d.window === ""), "the time engine's call day does not apply");
  assert.deepEqual(table(layout[0]), [["Day worked", "Clinic and OR", "", "$2,060.09"], ["On call: Synthetic Regional (SR) (primary)", "", "", "$1,000.00"]]);
  assert.match(invoicePlainText({ ...DOC, ...inv }), /Total for Mon, Aug 3, 2026: \$3,060\.09/);
});

test("an expense invoice: expenses grouped by the day they were incurred, each day totalled", async () => {
  const lines = [
    { date: "2026-08-01", label: "Airfare: Example Air", detail: expenseLineDetail("", 1, true), amount: 400, expenseId: "e1" },
    { date: "2026-08-01", label: "Parking", detail: expenseLineDetail("", 0), amount: 40, expenseId: "e3" },
    { date: "2026-08-02", label: "Lodging: Example Inn", detail: expenseLineDetail("late checkout", 2), amount: 300, expenseId: "e2" },
  ];
  const inv = { kind: "expenses", lines, total: 740, terms: EXPENSE_INVOICE_TERMS };
  const layout = invoiceDays(inv);
  assert.deepEqual(layout.map((d) => d.total), [440, 300]);
  assert.deepEqual(table(layout[0]), [["Airfare: Example Air", "receipt attached", "", "$400.00"], ["Parking", "no receipt", "", "$40.00"]]);
  assert.deepEqual(table(layout[1]), [["Lodging: Example Inn", "late checkout \u{b7} receipts on file", "", "$300.00"]]);
  const runs = pdfRuns(inv);
  assert.ok(runs.includes("receipt attached"), "the receipt status is its own cell");
  assert.ok(runs.includes("Total for Sat, Aug 1, 2026"));
});

// ── The invariant ───────────────────────────────────────────────

test("day totals that would not add up to the invoice total print the old flat table instead of a wrong number", async () => {
  const off = { lines: NORTHFIELD.lines, total: 21000 };
  const layout = invoiceLayout(off);
  assert.equal(layout.mode, "flat");
  assert.match(layout.reason, /day totals add to 2122500, the invoice to 2100000/);
  assert.deepEqual(layout.rows[0], ["Sep 25, 2026", "On-call coverage (daily total)", NORTHFIELD.lines[0].detail, "$3,300.00"]);
  const runs = pdfRuns(off);
  assert.ok(runs.includes("Date") && runs.includes("Details"), "the flat table's head");
  assert.ok(!runs.some((r) => r.startsWith("Total for")), "no day total printed");
  const { rows } = await xlsxRows(off);
  assert.ok(rows.some((r) => r.join("|") === "Date|Item|Details|Amount"));
  const text = invoicePlainText({ ...DOC, ...off });
  assert.ok(!text.includes("Total for"));
  assert.ok(text.includes("Sep 25, 2026  On-call coverage (daily total)\n   5h 00m logged"), "the old text layout");
  // An amount that is not a number, or no total at all, never lays out as days.
  assert.equal(invoiceLayout({ lines: [{ date: "2026-08-01", label: "X", amount: "abc" }], total: 0 }).mode, "flat");
  assert.equal(invoiceLayout({ lines: NORTHFIELD.lines }).mode, "flat");
  assert.equal(invoiceLayout({ lines: [], total: 0 }).mode, "flat");
});

test("a daily total whose parts do not reproduce it prints as written, and the day still adds up", () => {
  const lines = structuredClone(NORTHFIELD.lines);
  lines[0].amount = 3400; // the detail says $3,000 + $300
  const layout = invoiceLayout({ lines, total: NORTHFIELD.total + 100 });
  assert.equal(layout.mode, "days", layout.reason);
  const [fri] = layout.days;
  assert.equal(fri.total, 5350);
  const row = fri.rows.find((r) => r.item === "On-call coverage (daily total)");
  assert.deepEqual([row.detail, row.amountText], [lines[0].detail, "$3,400.00"]);
  assert.ok(!fri.rows.some((r) => r.item.startsWith("Callback beyond")));
});

test("every priced invoice lays out in days whose totals add to the invoice total, new lines and stored ones alike", () => {
  const ORIENT_FEE = { ...STIPEND, id: "c-fee", orientationFee: 500 };
  const ORIENT_HOURLY = { ...STIPEND, id: "c-orient", orientationHourlyRate: 200 };
  const NO_RATE = { ...STIPEND, id: "c-norate", overageHourlyRate: 0 };
  const SPLIT = { ...STIPEND, id: "c-split", splitAtDayStart: true };
  const EIGHT = { ...STIPEND, id: "c-eight", dayStartHour: 8 };
  let checked = 0;
  for (const c of [STIPEND, SPLIT, EIGHT, FLAT, ORIENT_FEE, ORIENT_HOURLY, NO_RATE]) {
    const list = representative(c);
    const invoiced = list.map((e, i) => (i % 3 === 0 ? { ...e, invoiceId: "inv-old" } : e));
    const invoices = [{ id: "inv-old", contractId: c.id, entryIds: invoiced.filter((e) => e.invoiceId).map((e) => e.id), dayOverMin: { "2026-08-05": 0, "2026-08-06": 15 }, lines: [{ date: "2026-08-05", label: "On-call coverage (daily total)", amount: 3000 }] }];
    const unbilled = invoiced.filter((e) => !e.invoiceId);
    for (const filter of [null, days("2026-08-04", "2026-08-05", "2026-08-06"), days("2026-07-27", "2026-07-28", "2026-08-10", "2026-08-11")]) {
      for (const [l, all, inv] of [[list, list, []], [unbilled, invoiced, invoices]]) {
        const priced = computeBilling(c, l, true, all, inv, filter);
        if (!priced.lines.length) continue;
        for (const lines of [priced.lines, stripAll(priced.lines)]) {
          const layout = invoiceLayout({ lines, total: priced.total });
          const what = `${c.id} ${filter ? [...filter].join(",") : "all days"}`;
          assert.equal(layout.mode, "days", `${what}: ${layout.reason}`);
          assert.equal(sumCents(layout.days.map((d) => d.total)), cents(priced.total), what);
          for (const day of layout.days) assert.equal(sumCents(day.rows.filter((r) => r.sums).map((r) => r.amount)), cents(day.total), `${what} ${day.date}`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked >= 60, `${checked} layouts checked`);
});

// ── computeBilling: the new fields are additive ────────────────

function representative(c) {
  const rows = (e) => live.splitRows(e, c, (() => { let n = 0; return () => `${e.id}-g${++n}`; })());
  const mk = (type, a, b, extra) => rows(entry(c, type, a, b, extra));
  return [
    ...mk("Call", "2026-08-05 06:45", "2026-08-05 07:15"),
    ...mk("Call", "2026-08-05 06:50", "2026-08-05 07:05", { description: "Nested" }),
    ...mk("Call", "2026-08-05 02:10", "2026-08-05 02:40"),
    ...mk("Transfer call", "2026-08-05 23:50", "2026-08-06 00:20"),
    ...mk("Procedure", "2026-08-04 08:00", "2026-08-04 12:00", { description: "Fusion" }),
    ...mk("Procedure", "2026-08-06 05:00", "2026-08-06 09:00"),
    ...mk("Call", "2026-08-06 07:15", "2026-08-06 07:30"),
    ...mk("Call", "2026-08-06 06:50", "2026-08-06 07:10"),
    ...mk("Rounding", "2026-08-08 07:00", "2026-08-08 11:00"),
    ...mk("Call", "2026-08-09 06:40", "2026-08-09 06:41"),
    ...mk("Call", "2026-08-10 06:45", "2026-08-10 07:15"),
    ...mk("Call", "2026-07-28 06:45", "2026-07-28 07:15"),
    ...mk("Consult", "2026-08-07 13:00", "2026-08-07 14:00"),
    ...mk("Orientation", "2026-07-28 06:10", "2026-07-28 09:50", { description: "Unit tour" }),
    ...mk("Orientation", "2026-08-04 13:00", "2026-08-04 15:00"),
    { ...entry(c, "Call", "2026-08-03 20:00", "2026-08-03 20:30"), callDay: undefined },
    { ...entry(c, "Call", "2026-08-03 06:20", "2026-08-03 06:35"), callDay: undefined },
    { ...entry(c, "Call", "2026-08-02 10:00", "2026-08-02 10:00") },
    { id: "dur-only", contractId: c.id, type: "Consult", date: "2026-08-01", durationMin: 60, billedMin: 60, invoiceId: null },
    { id: "marker", contractId: c.id, type: "CallDay", date: "2026-08-11", callDay: "2026-08-11", durationMin: 0, billedMin: 0, invoiceId: null },
  ];
}

test("computeBilling: with the layout fields removed, every line, amount and total is byte-identical to the frozen d46679ac engine", () => {
  const contracts = [
    STIPEND, { ...STIPEND, id: "c-split", splitAtDayStart: true }, { ...STIPEND, id: "c-eight", dayStartHour: 8 },
    FLAT, { ...STIPEND, id: "c-fee", orientationFee: 500 }, { ...STIPEND, id: "c-orient", orientationHourlyRate: 200 },
    { ...STIPEND, id: "c-norate", overageHourlyRate: 0 }, { ...FLAT, id: "c-flat-fee", orientationFee: 750 },
  ];
  let compared = 0;
  for (const c of contracts) {
    const list = representative(c);
    const invoiced = list.map((e, i) => (i % 3 === 0 ? { ...e, invoiceId: "inv-old" } : e));
    const invoices = [{ id: "inv-old", contractId: c.id, entryIds: invoiced.filter((e) => e.invoiceId).map((e) => e.id), dayOverMin: { "2026-08-05": 0, "2026-08-06": 15 }, lines: [{ date: "2026-08-05", label: "On-call coverage (daily total)", amount: 3000 }] }];
    const unbilled = invoiced.filter((e) => !e.invoiceId);
    for (const filter of [null, days("2026-08-04", "2026-08-05", "2026-08-06"), days("2026-07-27", "2026-07-28", "2026-08-10", "2026-08-11")]) {
      for (const [l, all, inv] of [[list, list, []], [unbilled, invoiced, invoices]]) {
        const a = computeBilling(c, l, true, all, inv, filter);
        const b = frozen.computeBilling(c, l, true, all, inv, filter);
        const what = `${c.id} ${filter ? [...filter].join(",") : "all days"}`;
        assert.equal(JSON.stringify({ ...a, lines: stripAll(a.lines) }), JSON.stringify(b), `${what}: byte-identical, key order included`);
        assert.equal(a.total, b.total, what);
        assert.deepEqual(a.lines.map((x) => x.amount), b.lines.map((x) => x.amount), what);
        // Only the declared fields were added, each after the fields a line always had.
        for (const [i, line] of a.lines.entries()) {
          const keys = Object.keys(line);
          assert.deepEqual(keys.slice(0, Object.keys(b.lines[i]).length), Object.keys(b.lines[i]), what);
          assert.ok(keys.slice(Object.keys(b.lines[i]).length).every((k) => LAYOUT_LINE_FIELDS.includes(k)), `${what}: ${keys}`);
        }
        compared += 1;
      }
    }
  }
  // The owner's invoice too.
  const entries = northfieldEntries();
  const a = computeBilling(NORTHFIELD_CONTRACT, entries, true, entries, [], null);
  const b = frozen.computeBilling(NORTHFIELD_CONTRACT, entries, true, entries, [], null);
  assert.equal(JSON.stringify({ ...a, lines: stripAll(a.lines) }), JSON.stringify(b));
  assert.ok(compared >= 48, `${compared} pricings compared`);
});

// ── Every format ────────────────────────────────────────────────

test("the PDF prints Item | Time | Hours | Amount day blocks, each closed by its total, then the total due", () => {
  const runs = pdfRuns(northfield());
  for (const want of ["Item", "Time", "Hours", "Amount", "24-hour call stipend", "covers the first 4.00 h of work", "4.00 h used of 4.00 h",
    "Callback beyond 4 h", "1.00 h @ $300.00/hr", "Total for Fri, Sep 25, 2026", "$5,250.00", "Total for Sat, Sep 26, 2026", "$6,450.00",
    "Total for Sun, Sep 27, 2026", "$6,525.00", "Total for Mon, Sep 28, 2026", "$3,000.00", "TOTAL DUE", "$21,225.00", "no work logged"]) {
    assert.ok(runs.includes(want), `PDF: ${want}`);
  }
  assert.ok(runs.includes("in $3,000.00"), "the included amount, wrapped under its stipend");
  assert.ok(runs.some((r) => r.startsWith("Fri, Sep 25, 2026") && r.includes("call day 7:00 AM Sep 25 to 7:00 AM Sep 26")));
  assert.ok(!runs.includes("Date") && !runs.includes("included") && !runs.some((r) => r.startsWith("+$")), "no old flag or column");
});

test("Excel and Word carry the same day blocks and day totals", async () => {
  const { ws, rows } = await xlsxRows(northfield());
  const head = rows.findIndex((r) => r.join("|") === "Item|Time|Hours|Amount|Day total");
  assert.ok(head > 0);
  assert.equal(rows[head + 1][0], "Fri, Sep 25, 2026 \u{b7} call day 7:00 AM Sep 25 to 7:00 AM Sep 26");
  assert.ok(ws["!merges"].some((m) => m.s.r === head + 1 && m.s.c === 0 && m.e.c === 4), "the day header spans the table");
  const totals = rows.filter((r) => String(r[2]).startsWith("Total for"));
  assert.deepEqual(totals.map((r) => [r[2], r[3], r[4]]), [
    ["Total for Fri, Sep 25, 2026", "", 5250], ["Total for Sat, Sep 26, 2026", "", 6450], ["Total for Sun, Sep 27, 2026", "", 6525], ["Total for Mon, Sep 28, 2026", "", 3000],
  ]);
  assert.deepEqual(rows.find((r) => r[2] === "TOTAL").slice(2, 4), ["TOTAL", 21225]);
  assert.ok(rows.some((r) => r[0].startsWith("Rounding: Consults") && r[3] === "in $3,000.00 stipend"));
  const words = docxTexts(await docxXml(northfield()));
  for (const want of ["Item", "Hours", "Total for Fri, Sep 25, 2026", "$5,250.00", "in $3,000.00 stipend", "Callback beyond 4 h", "Total for Mon, Sep 28, 2026"]) {
    assert.ok(words.includes(want), `Word: ${want}`);
  }
  assert.match(await docxXml(northfield()), /<w:gridSpan w:val="4"\/>/);
});

test("the plain-text invoice (Work Log and Days & call) reads the same day blocks, under the header it always had", () => {
  const text = invoicePlainText({ ...DOC, ...northfield() }, { generatedOn: new Date("2026-09-28T12:00:00-05:00") });
  const lines = text.split("\n");
  assert.deepEqual(lines.slice(0, 8), [
    "INVOICE INV-SYN-1", TEXT_RULE, "From: Synthetic Physician, DO \u{b7} NPI 9999999999", "Email: doc@example.test",
    "To: Synthetic Medical Center (via Synthetic Locums)", "Period: Sep 25, 2026 \u{2013} Sep 28, 2026", "Terms: Synthetic terms", TEXT_RULE,
  ]);
  assert.deepEqual(lines.slice(8, 20), [
    "Fri, Sep 25, 2026 \u{b7} call day 7:00 AM Sep 25 to 7:00 AM Sep 26",
    "Orientation",
    "   8:30 AM\u{2013}11:00 AM \u{b7} 2.50 h @ $300.00/hr = $750.00",
    "Orientation",
    "   11:30 AM\u{2013}3:30 PM \u{b7} 4.00 h @ $300.00/hr = $1,200.00",
    "24-hour call stipend",
    "   covers the first 4.00 h of work \u{b7} 4.00 h used of 4.00 h = $3,000.00",
    "     Rounding: Consults and family meetings. OR planning \u{b7} 3:30 PM\u{2013}7:30 PM \u{b7} 4.00 h \u{b7} in $3,000.00 stipend",
    "Callback beyond 4 h",
    "   1.00 h @ $300.00/hr = $300.00",
    "     Call: Consult C \u{b7} 10:45 PM\u{2013}11:00 PM \u{b7} 0.25 h \u{b7} $75.00",
    "     Call: Phone consult J \u{b7} 1:00 AM\u{2013}1:15 AM \u{b7} 0.25 h \u{b7} $75.00",
  ]);
  for (const t of ["Total for Fri, Sep 25, 2026: $5,250.00", "Total for Sat, Sep 26, 2026: $6,450.00", "Total for Sun, Sep 27, 2026: $6,525.00", "Total for Mon, Sep 28, 2026: $3,000.00"]) {
    assert.ok(lines.includes(t), t);
  }
  assert.deepEqual(lines.slice(-4), [TEXT_RULE, "TOTAL DUE: $21,225.00", "", `Generated by CredentialDOMD \u{b7} ${new Date("2026-09-28T12:00:00-05:00").toLocaleDateString()}`]);
  assert.ok(lines.every((l) => l.length <= 140 || l.startsWith("     ")), "phone-width money lines");
  // A resend after a payment says what is left.
  const paid = invoicePlainText({ ...DOC, ...northfield(), paid: 1225, balance: 20000 });
  assert.match(paid, /Invoice total: \$21,225\.00\nPaid: \$1,225\.00\nBALANCE DUE: \$20,000\.00/);
});

test("a resend of a stored invoice reads the agreement's call-day start hour when its lines do not carry one", () => {
  const args = invoiceDocumentArgs({ number: "INV-1", lines: NORTHFIELD.lines, totalAmount: NORTHFIELD.total }, { ...NORTHFIELD_CONTRACT, dayStartHour: 8 }, {});
  assert.equal(args.dayStartHour, 8);
  assert.equal(invoiceDays(args)[0].window, "call day 8:00 AM Sep 25 to 8:00 AM Sep 26");
  assert.equal(invoiceDocumentArgs({ number: "INV-1" }, null, {}).dayStartHour, undefined, "no agreement, no key");
  // New lines say their own hour.
  const entries = northfieldEntries();
  const priced = computeBilling({ ...NORTHFIELD_CONTRACT, dayStartHour: 7 }, entries, true, entries, [], null);
  assert.equal(invoiceDays({ lines: priced.lines, total: priced.total, dayStartHour: 9 })[0].window, "call day 7:00 AM Sep 25 to 7:00 AM Sep 26");
});

test("no em dash in any format: an August invoice stored with the old dashed wording prints without one", async () => {
  const august = {
    lines: [
      { date: "2026-08-05", label: "On-call coverage \u{2014} daily total", detail: "5h 00m logged \u{2014} first 4h covered by the $3,000.00 stipend, 1h 00m beyond @ $300.00/hr (+$300.00)", amount: 3300, _sort: "2026-08-05~0" },
      { date: null, label: "\u{b7} Rounding \u{2014} Morning list", detail: "7:00 AM\u{2013}11:00 AM \u{b7} 240 min", amount: null, flag: "included", _sort: "2026-08-05~1~a" },
      { date: null, label: "\u{b7} Procedure \u{2014} Burr hole", detail: "1:00 PM\u{2013}2:00 PM \u{b7} 60 min", amount: null, flag: "+$300.00", _sort: "2026-08-05~1~b" },
      { date: "2026-08-06", label: "Call \u{2014} Transfer", detail: "8:00 PM\u{2013}8:15 PM \u{b7} 15 min @ $300.00/hr", amount: 75, _sort: "2026-08-06~1~a" },
      { date: "2026-08-06", label: "Orientation \u{2014} Unit tour", detail: "60 min \u{2014} covered by orientation fee", amount: 0, _sort: "2026-08-06~1~b" },
    ],
    total: 3375,
  };
  const [aug5, aug6] = invoiceDays(august);
  assert.deepEqual(table(aug5), [
    ["24-hour call stipend", "covers the first 4.00 h of work", "4.00 h used of 4.00 h", "$3,000.00"],
    ["Rounding: Morning list", "7:00 AM\u{2013}11:00 AM", "4.00 h", "in $3,000.00 stipend"],
    ["Callback beyond 4 h", "", "1.00 h @ $300.00/hr", "$300.00"],
    ["Procedure: Burr hole", "1:00 PM\u{2013}2:00 PM", "1.00 h", "$300.00"],
  ]);
  // The old "Type \u{2014} note" label reads as the engine writes it now, "Type: note".
  assert.deepEqual(table(aug6), [["Call: Transfer", "8:00 PM\u{2013}8:15 PM", "0.25 h @ $300.00/hr", "$75.00"], ["Orientation: Unit tour", "", "1.00 h", "in orientation fee"]]);
  await assertNoEmDash(august, "August, days");
  await assertNoEmDash({ ...august, total: 1 }, "August, flat");
  await assertNoEmDash(northfield(), "Northfield");
  await assertNoEmDash({ lines: [{ date: "2026-08-01", label: "Airfare", detail: "red-eye \u{2014} receipt on file", amount: 400 }], total: 400 }, "expenses");
  // A dash typed into a note today: the one change a printed label ever gets.
  const typed = computeBilling(FLAT, [entry(FLAT, "Call", "2026-08-04 20:00", "2026-08-04 20:10", { description: "Consult \u{2014} ED" })], true, [], [], null);
  assert.equal(typed.lines[0].label, "Call: Consult \u{2014} ED", "stored as logged");
  assert.equal(invoiceDays({ lines: typed.lines, total: typed.total })[0].rows[0].item, "Call: Consult, ED");
  await assertNoEmDash({ lines: typed.lines, total: typed.total }, "typed dash");
});

// ── Review fixes ────────────────────────────────────────────────

test("an undated charge (the one-time orientation fee, stored undated Jul 23 to Aug 3) prints in its own block, never in the last day's total", async () => {
  // The Jul 28 engine's shape: em-dash labels, the fee last with no date.
  const july = {
    lines: [
      { date: "2026-07-29", label: "Orientation \u{2014} Unit tour", detail: "60 min \u{2014} covered by orientation fee", amount: 0, _sort: "2026-07-29~1~2026-07-29T14:00:00.000Z" },
      { date: "2026-07-30", label: "On-call coverage \u{2014} daily total", detail: "on-call coverage \u{b7} no calls required", amount: 2500, _sort: "2026-07-30~0" },
      { date: "2026-07-31", label: "On-call coverage \u{2014} daily total", detail: "2h 00m logged \u{2014} first 4h covered by the $2,500.00 stipend", amount: 2500, _sort: "2026-07-31~0" },
      { date: null, label: "\u{b7} Rounding \u{2014} Morning list", detail: "7:00 AM\u{2013}9:00 AM \u{b7} 120 min", amount: null, flag: "included", _sort: "2026-07-31~1~2026-07-31T12:00:00.000Z" },
      { date: null, label: "Orientation (one-time)", detail: "", amount: 1500, _sort: "~zzz" },
    ],
    total: 6500,
  };
  const layout = invoiceLayout(july);
  assert.equal(layout.mode, "days", layout.reason);
  assert.deepEqual(layout.days.map((d) => [d.title, d.total]), [["Wed, Jul 29, 2026", 0], ["Thu, Jul 30, 2026", 2500], ["Fri, Jul 31, 2026", 2500], ["Other charges", 1500]]);
  const [, , jul31, other] = layout.days;
  // The work item still sits under its own day; the fee in none of them.
  assert.deepEqual(table(jul31).map((r) => r[0]), ["24-hour call stipend", "Rounding: Morning list"]);
  assert.ok(layout.days.slice(0, 3).every((d) => !d.rows.some((r) => r.item === "Orientation (one-time)")));
  assert.deepEqual(table(other), [["Orientation (one-time)", "", "", "$1,500.00"]]);
  assert.equal([other.date, other.window, other.totalLabel].join("|"), "||Total for other charges");
  assert.equal(sumCents(layout.days.map((d) => d.total)), cents(6500));
  const text = invoicePlainText({ ...DOC, ...july });
  assert.match(text, /Total for Fri, Jul 31, 2026: \$2,500\.00\n\nOther charges\nOrientation \(one-time\)\n   \$1,500\.00\nTotal for other charges: \$1,500\.00/);
  const runs = pdfRuns(july);
  assert.ok(runs.includes("Other charges") && runs.includes("Total for other charges"));
  await assertNoEmDash(july, "July, undated fee");
  // A work item with nothing dated before it still cannot be placed.
  assert.equal(invoiceLayout({ lines: [july.lines[3], ...july.lines.slice(0, 3)], total: 5000 }).mode, "flat");
});

test("the items under a callback add up to it to the cent, and their time to its time (10-minute pieces at $250/hr)", () => {
  const c = { ...STIPEND, id: "c-ten", callStipend: 2000, stipendHours: 2, overageHourlyRate: 250, incrementMinutes: 10, minCallMinutes: 10 };
  const list = [
    entry(c, "Rounding", "2026-08-06 08:00", "2026-08-06 10:00"),
    entry(c, "Call", "2026-08-06 20:00", "2026-08-06 20:05", { description: "ED" }),
    entry(c, "Call", "2026-08-06 21:00", "2026-08-06 21:05", { description: "Floor" }),
  ];
  const priced = computeBilling(c, list, true, list, [], days("2026-08-06"));
  // Each call is 10/60 x $250 = $41.666..., the callback 20/60 x $250 = $83.333...
  assert.deepEqual(priced.lines.filter((l) => l.kind === "work" && l.overMin > 0).map((l) => cents(l.overAmount)), [4167, 4167]);
  assert.equal(cents(priced.lines[0].overAmount), 8333);
  for (const lines of [priced.lines, stripAll(priced.lines)]) {
    const [day] = invoiceDays({ lines, total: priced.total });
    const i = day.rows.findIndex((r) => r.item.startsWith("Callback beyond"));
    assert.deepEqual(table(day).slice(i), [
      ["Callback beyond 2 h", "", "20 min @ $250.00/hr", "$83.33"],
      ["Call: ED", "8:00 PM\u{2013}8:10 PM", "10 min", "$41.67"],
      ["Call: Floor", "9:00 PM\u{2013}9:10 PM", "10 min", "$41.66"],
    ]);
    assert.equal(sumCents(day.rows.slice(i + 1).map((r) => r.amount)), cents(day.rows[i].amount));
    assert.equal(day.total, 2083.33);
  }
});

test("a 10-minute contract prints every duration on the clock, so hours at the rate reproduce each amount; quarter-hour invoices keep decimal hours", () => {
  const c = { ...STIPEND, id: "c-ten-300", incrementMinutes: 10, minCallMinutes: 10 };
  const list = [
    entry(c, "Rounding", "2026-08-06 08:00", "2026-08-06 13:20"),
    entry(c, "Call", "2026-08-06 20:00", "2026-08-06 20:05"),
  ];
  const priced = computeBilling(c, list, true, list, [], days("2026-08-06"));
  const [day] = invoiceDays({ lines: priced.lines, total: priced.total });
  assert.deepEqual(table(day), [
    ["24-hour call stipend", "covers the first 4 h of work", "4 h used of 4 h", "$3,000.00"],
    ["Callback beyond 4 h", "", "1 h 30 min @ $300.00/hr", "$450.00"],
    ["Rounding", "8:00 AM\u{2013}1:20 PM", "5 h 20 min (4 h in stipend, 1 h 20 min beyond)", "$400.00"],
    ["Call", "8:00 PM\u{2013}8:10 PM", "10 min", "$50.00"],
  ]);
  // Every printed duration times the rate is its amount.
  const minutesOf = (t) => { const m = t.match(/^(?:(\d+) h)? ?(?:(\d+) min)?/); return Number(m[1] || 0) * 60 + Number(m[2] || 0); };
  assert.equal(cents((minutesOf("1 h 30 min") / 60) * 300), cents(450));
  assert.equal(cents((minutesOf("1 h 20 min") / 60) * 300), cents(400));
  assert.equal(cents((minutesOf("10 min") / 60) * 300), cents(50));
  // Northfield (quarter hours) is unchanged.
  assert.equal(table(invoiceDays(northfield())[0])[4][2], "1.00 h @ $300.00/hr");
});

test("which contracts print without day totals, pinned: lines carrying fractions of a cent whose rounding misses the total", () => {
  const threeDays = (c, from, to) => ["2026-08-06", "2026-08-07", "2026-08-08"].flatMap((d) => [entry(c, "Rounding", `${d} 08:00`, `${d} 12:00`), entry(c, "Call", `${d} ${from}`, `${d} ${to}`)]);
  const cases = [
    // [what, contract, entries, flat?, the fraction the screen quotes]
    ["$187.50/hr beyond the stipend, 15-minute increments", { ...STIPEND, id: "c-187", overageHourlyRate: 187.5 }, (c) => threeDays(c, "20:00", "20:05"), true, "$3,046.875"],
    ["10-minute increments at $250/hr", { ...STIPEND, id: "c-250", overageHourlyRate: 250, incrementMinutes: 10, minCallMinutes: 10 }, (c) => threeDays(c, "20:00", "20:05"), true, "$3,041.6667"],
    ["hourly, $200/hr, 20-minute call minimum", { ...FLAT, id: "c-200", callHourlyRate: 200, minCallMinutes: 20 }, (c) => ["20:00", "21:00", "22:00"].map((t) => entry(c, "Call", `2026-08-04 ${t}`, `2026-08-04 ${t.replace(":00", ":05")}`)), true, "$66.6667"],
    ["hourly, $262.50/hr, two quarter-hour calls", { ...FLAT, id: "c-262", callHourlyRate: 262.5 }, (c) => ["20:00", "21:00"].map((t) => entry(c, "Call", `2026-08-04 ${t}`, `2026-08-04 ${t.replace(":00", ":05")}`)), true, "$65.625"],
    // Fractions that round back to the total still lay out in days.
    ["one 10-minute day at $250/hr", { ...STIPEND, id: "c-250-one", overageHourlyRate: 250, incrementMinutes: 10, minCallMinutes: 10 }, (c) => threeDays(c, "20:00", "20:05").slice(0, 2), false, null],
    ["quarter hours at $300/hr", { ...STIPEND, id: "c-300" }, (c) => threeDays(c, "20:00", "20:05"), false, null],
  ];
  for (const [what, c, make, flat, fraction] of cases) {
    const list = make(c);
    const priced = computeBilling(c, list, true, list, [], new Set(list.map((e) => e.callDay)));
    const layout = invoiceLayout({ lines: priced.lines, total: priced.total });
    assert.equal(layout.mode, flat ? "flat" : "days", `${what}: ${layout.reason}`);
    assert.equal(layout.fractionalCents ?? null, fraction, what);
    if (flat) assert.match(layout.reason, /^day totals add to \d+, the invoice to \d+$/, what);
  }
  // A flat layout for any other reason says nothing about cents.
  assert.equal(invoiceLayout({ lines: NORTHFIELD.lines, total: 21000 }).fractionalCents, undefined);
});

test("Excel: only charges are numbers in Amount, so its cells above TOTAL sum to the invoice total, and the Day total column does too", async () => {
  const numbers = (ws, col, rows) => rows.filter((r) => ws[XLSX.utils.encode_cell({ r, c: col })]?.t === "n").map((r) => ws[XLSX.utils.encode_cell({ r, c: col })].v);
  const inv = { ...northfield(), paid: 1225, balance: 20000 };
  const { ws, rows } = await xlsxRows(inv);
  const head = rows.findIndex((r) => r[0] === "Item");
  const totalAt = rows.findIndex((r) => r[2] === "TOTAL");
  const body = Array.from({ length: totalAt - head - 1 }, (_, i) => head + 1 + i);
  assert.equal(sumCents(numbers(ws, 3, body)), cents(21225), "Amount");
  assert.equal(sumCents(numbers(ws, 4, body)), cents(21225), "Day total");
  assert.equal(numbers(ws, 3, body).length, 9, "the stipends, callbacks and orientation sessions only");
  // A piece of work under the callback shows its share as words.
  assert.ok(rows.some((r) => r[0] === "Call: Consult C" && r[3] === "$75.00 in callback"));
  assert.ok(rows.some((r) => r[0] === "Procedure: Case T" && r[3] === "$1,650.00 in callback"));
  // Under a day line printed as written, the words name that line.
  const asWritten = structuredClone(NORTHFIELD.lines);
  asWritten[0].amount = 3400;
  const written = await xlsxRows({ lines: asWritten, total: NORTHFIELD.total + 100 });
  assert.ok(written.rows.some((r) => r[0] === "Call: Consult C" && r[3] === "$75.00 in On-call coverage (daily total)"));
  assert.deepEqual([rows[totalAt + 1].slice(2, 4), rows[totalAt + 2].slice(2, 4)], [["Paid", 1225], ["BALANCE DUE", 20000]]);
  assert.equal(ws[XLSX.utils.encode_cell({ r: totalAt, c: 3 })].w, "$21,225.00", "shown as currency");
  assert.equal(ws[XLSX.utils.encode_cell({ r: rows.findIndex((r) => r[2] === "Total for Fri, Sep 25, 2026"), c: 4 })].w, "$5,250.00");
  // The flat table: the work items' "+$75.00" flags stay words.
  const off = { lines: NORTHFIELD.lines, total: 21000 };
  const flat = await xlsxRows(off);
  const fHead = flat.rows.findIndex((r) => r[0] === "Date");
  const fTotal = flat.rows.findIndex((r) => r[2] === "TOTAL");
  const fBody = Array.from({ length: fTotal - fHead - 1 }, (_, i) => fHead + 1 + i);
  assert.equal(sumCents(numbers(flat.ws, 3, fBody)), sumCents(NORTHFIELD.lines.filter((l) => l.amount != null).map((l) => l.amount)));
  assert.ok(flat.rows.some((r) => r[3] === "+$75.00"), "a flag is text");
});

test("PDF: when the table ends near the foot of a page, the payment line, TOTAL DUE box and terms move to the next page whole", () => {
  const c = { ...STIPEND, id: "c-foot" };
  const pad = (n) => String(n).padStart(2, "0");
  let near = 0;
  for (let n = 0; n < 32; n++) {
    const list = [];
    for (let d = 1; d <= 3; d++) {
      const day = `2026-08-${pad(d)}`;
      list.push(entry(c, "Rounding", `${day} 07:30`, `${day} 09:30`, { description: "Rounds" }));
      for (let h = 0; h < (d === 3 ? n : 8); h++) list.push(entry(c, "Call", `${day} ${pad(10 + (h % 13))}:${pad((h * 7) % 50)}`, `${day} ${pad(10 + (h % 13))}:${pad((h * 7) % 50 + 5)}`, { description: "ED consult" }));
    }
    const priced = computeBilling(c, list, true, list, [], days("2026-08-01", "2026-08-02", "2026-08-03"));
    const inv = { lines: priced.lines, total: priced.total, paid: 500, balance: priced.total - 500, billTo: "ap@example.test" };
    const { doc, H, pages } = pdfPages(inv);
    if (doc.lastAutoTable.finalY > 262) near += 1;
    const last = pages[pages.length - 1];
    const at = (t) => last.find((r) => r.text.startsWith(t));
    for (const t of ["Invoice total", "BALANCE DUE", "Terms: Synthetic terms", "Please remit"]) {
      assert.ok(at(t), `${n}: ${t} on the last page`);
      assert.ok(at(t).y > 0 && at(t).y <= H - 14, `${n}: ${t} at ${at(t).y.toFixed(1)} mm, inside the page and above the footer`);
    }
    // Nothing but the footer sits in the bottom 14 mm of any page.
    for (const [p, runs] of pages.entries()) for (const r of runs) if (!r.text.startsWith("Generated by")) assert.ok(r.y <= H - 14, `${n} page ${p + 1}: ${r.text} at ${r.y.toFixed(1)} mm`);
  }
  assert.ok(near >= 2, `${near} tables ended in the bottom band`);
});

test("PDF page breaks keep each day's header with its rows and its total with its last row; a page that carries on a day says which", () => {
  const c = { ...STIPEND, id: "c-breaks" };
  const pad = (n) => String(n).padStart(2, "0");
  const checkPages = (inv, what) => {
    const layout = invoiceLayout(inv);
    const bands = new Set(layout.days.map(bandOf));
    const { pages } = pdfPages(inv);
    pages.forEach((runs, p) => {
      const texts = runs.map((r) => r.text);
      if (p < pages.length - 1) assert.ok(!bands.has(texts[texts.length - 1]), `${what}: page ${p + 1} ends on a bare day header`);
      if (p > 0 && texts[0] === "Item") {
        const first = texts[texts.indexOf("Amount") + 1];
        assert.ok(bands.has(first) || first.endsWith(" (continued)"), `${what}: page ${p + 1} opens with "${first}"`);
      }
    });
    return pages;
  };
  for (let k = 0; k < 24; k++) {
    const list = [];
    for (let d = 1; d <= 6; d++) {
      const day = `2026-08-${pad(d)}`;
      list.push(entry(c, "Rounding", `${day} 07:30`, `${day} 09:30`, { description: "Rounds" }));
      for (let h = 0; h < 3 + ((k * 7 + d * 5) % 13); h++) list.push(entry(c, "Call", `${day} ${pad(10 + (h % 13))}:${pad((h * 7) % 50)}`, `${day} ${pad(10 + (h % 13))}:${pad((h * 7) % 50 + 5)}`, { description: "ED consult" }));
    }
    const priced = computeBilling(c, list, true, list, [], days("2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"));
    checkPages({ lines: priced.lines, total: priced.total }, `invoice ${k}`);
  }
  // The owner's invoice: Saturday runs onto page 2, which says so.
  const pages = checkPages(northfield(), "Northfield");
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[1].slice(0, 5).map((r) => r.text), ["Item", "Time", "Hours", "Amount", "Sat, Sep 26, 2026 (continued)"]);
  assert.equal(pages[0].at(-1).text.startsWith("$"), true, "page 1 ends on a row's amount");
});

test("Word: the column head repeats on every page, no row splits, and a day's header and total keep with their rows", async () => {
  const xml = await docxXml(northfield());
  const rows = [...xml.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)].map((m) => m[1]);
  assert.match(rows[0], /<w:tblHeader\/>/);
  assert.ok(rows.every((r) => /<w:cantSplit\/>/.test(r)), "every row cantSplit");
  const text = (r) => [...r.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
  const keeps = (r) => /<w:keepNext\/>/.test(r);
  const at = (t) => rows.findIndex((r) => text(r).startsWith(t));
  const fri = at("Fri, Sep 25, 2026");
  assert.ok(keeps(rows[fri]) && keeps(rows[fri + 1]), "the header and the first row keep with the next");
  const friTotal = at("Total for Fri, Sep 25, 2026");
  assert.ok(keeps(rows[friTotal - 1]) && !keeps(rows[friTotal]), "the last row keeps with the total");
  assert.ok(!keeps(rows[fri + 3]), "rows in the middle of a day may break");
});
