import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import * as live from "../../src/utils/billing.js";
import * as frozen from "./legacy-billing-4b65234a.mjs";
import * as frozenLayout from "./legacy-invoice-layout-4b65234a.mjs";
import { invoiceLayout, invoiceDays, invoicePlainText } from "../../src/utils/invoiceLayout.js";
import { buildInvoicePdf } from "../../src/utils/invoicePdf.js";
import { invoiceXlsxFile, invoiceDocxFile } from "../../src/utils/invoiceExport.js";
import {
  toClock, clockLabel, timedBlock, timedBlockLabel, timedSpan, isTimedPeriod, hasTimedPeriods, blockCallDays,
  periodProblem, savedPeriod, coveragePeriodText,
} from "../../src/utils/coverageBlocks.js";
import { NORTHFIELD_CONTRACT, northfieldEntries } from "./fixtures/northfield.mjs";
import { TIMED_CONTRACT, UNTIMED_CONTRACT, TIMED_PERIOD, timedBlockEntries } from "./fixtures/timed-block.mjs";

// Coverage blocks with times (src/utils/coverageBlocks.js): the agreement's
// "October 16 (4pm) to October 19 (7am)" bills three call days, work
// outside the block bills hourly on its own line, and a contract whose blocks
// carry no times bills exactly as it did before (the frozen engine at
// 4b65234a is the reference). Synthetic data only. Wall clock on Central time.
const originalTimezone = process.env.TZ;
process.env.TZ = "America/Chicago";
const RealDate = globalThis.Date;
let NOW = "2026-11-20T12:00:00-06:00";
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
const { computeBilling, deriveCallDay, callDayStartHour, splitAtCallDay, splitRows, isStipendDay, startedCoverageDays } = live;
const at = (s) => { const [d, t] = s.split(" "); const [y, m, dd] = d.split("-").map(Number); const [hh, mi] = t.split(":").map(Number); return new Date(y, m - 1, dd, hh, mi).toISOString(); };
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const roundUp = (raw, inc, min) => Math.max(min || 0, Math.ceil(raw / inc) * inc || inc);
const cents = (n) => Math.round(n * 100);
const table = (day) => day.rows.map((r) => [r.item, r.detail ?? r.time, r.hours, r.amountText]);
const all = (list) => [...list];

// An entry built the way the Work Log saves one: call day from the contract.
let seq = 0;
function entry(contract, type, from, to, extra = {}) {
  const s = at(from), e = at(to);
  const raw = Math.max(1, Math.round((new RealDate(e) - new RealDate(s)) / 60000));
  const inc = contract.incrementMinutes || 15;
  const billed = roundUp(raw, inc, type === "Call" || type === "Transfer call" ? (contract.minCallMinutes || 15) : 0);
  seq += 1;
  return {
    id: `e${String(seq).padStart(3, "0")}`, createdAt: `2026-09-01T00:00:${String(seq % 60).padStart(2, "0")}Z`, contractId: contract.id, type,
    date: live.localDate(s), callDay: deriveCallDay(s, contract), startTime: s, endTime: e,
    durationMin: raw, billedMin: billed, description: "", privateNote: "", invoiceId: null, ...extra,
  };
}

// ── Times on a block ─────────────────────────────────────────────

test("times read the way agreements and models write them, as 24-hour HH:MM", () => {
  const cases = { "16:00": "16:00", "4pm": "16:00", "4 PM": "16:00", "4:00 p.m.": "16:00", "(7am)": "07:00", "7 a.m.": "07:00", "6am": "06:00",
    "12am": "00:00", "12pm": "12:00", noon: "12:00", midnight: "00:00", "0700": "07:00", "7:30": "07:30", "07:00:00": "07:00", "6:30 AM": "06:30" };
  for (const [v, want] of Object.entries(cases)) assert.equal(toClock(v), want, v);
  for (const v of ["", null, undefined, "7", "25:00", "13pm", "0am", "evening", "4:75 pm"]) assert.equal(toClock(v), "", String(v));
  assert.equal(clockLabel(16 * 60), "4:00 PM");
  assert.equal(clockLabel(0), "12:00 AM");
  assert.equal(clockLabel(at("2026-10-19 07:00")), "7:00 AM");
});

test("a block with times: its moments, call days, window and the dates it touches", () => {
  const b = timedBlock(TIMED_PERIOD);
  assert.equal(new Date(b.startMs).toISOString(), at("2026-10-16 16:00"));
  assert.equal(new Date(b.endMs).toISOString(), at("2026-10-19 07:00"));
  assert.equal(b.turnover, 7 * 60);
  assert.deepEqual(blockCallDays(b), ["2026-10-16", "2026-10-17", "2026-10-18"]);
  assert.equal(timedBlockLabel(TIMED_PERIOD), "Oct 16, 4:00 PM to Oct 19, 7:00 AM");
  assert.deepEqual(timedSpan(TIMED_PERIOD), { start: "2026-10-16", end: "2026-10-19" });
  // A block ending at midnight does not touch the day it ends on.
  assert.deepEqual(timedSpan({ start: "2026-10-16", startTime: "16:00", end: "2026-10-19", endTime: "00:00" }), { start: "2026-10-16", end: "2026-10-18" });
  // Without times, nothing here applies and the old reading stands.
  assert.equal(timedBlock({ start: "2026-10-16", end: "2026-10-18" }), null);
  assert.equal(isTimedPeriod({ start: "2026-10-16", end: "2026-10-18", startTime: "", endTime: "" }), false);
  assert.equal(isTimedPeriod({ start: "2026-10-16", endTime: "07:00" }), false, "an end time without an end date is no time");
  assert.equal(hasTimedPeriods(UNTIMED_CONTRACT), false);
  assert.equal(hasTimedPeriods(TIMED_CONTRACT), true);
});

test("a start time alone is no time: the block keeps its untimed meaning; end time only: the block starts at that time", () => {
  // Read as a block starting at 6:00 AM, a start time alone turned every
  // call day over at 6:00 AM and kept the end date as a call day of its own
  // (see coverage-block-review-fixes.test.mjs). It is ignored instead.
  const startOnly = { start: "2026-11-12", startTime: "06:00", end: "2026-11-18" };
  assert.equal(timedBlock(startOnly), null);
  assert.equal(isTimedPeriod(startOnly), false);
  const endOnly = timedBlock({ start: "2026-10-16", end: "2026-10-19", endTime: "07:00" });
  assert.equal(new Date(endOnly.startMs).toISOString(), at("2026-10-16 07:00"));
  assert.deepEqual(blockCallDays(endOnly), ["2026-10-16", "2026-10-17", "2026-10-18"]);
  // Starting before the turnover (7:00 AM start, 5:00 PM turnover) opens
  // with one long call day under the start date, never the day before.
  const early = { start: "2026-10-01", startTime: "07:00", end: "2026-10-03", endTime: "17:00" };
  assert.deepEqual(blockCallDays(timedBlock(early)), ["2026-10-01", "2026-10-02"]);
  const c = { id: "c-early", callStipend: 1000, stipendHours: 0, coveragePeriods: [early] };
  assert.equal(deriveCallDay(at("2026-10-01 10:00"), c), "2026-10-01");
  assert.equal(deriveCallDay(at("2026-10-02 16:59"), c), "2026-10-01");
  assert.equal(deriveCallDay(at("2026-10-02 17:00"), c), "2026-10-02");
});

test("a block that ends before it starts covers nothing, and the form says why", () => {
  const bad = { start: "2026-10-16", startTime: "16:00", end: "2026-10-16", endTime: "07:00" };
  assert.equal(timedBlock(bad).valid, false);
  assert.deepEqual(blockCallDays(timedBlock(bad)), []);
  const c = { ...TIMED_CONTRACT, coveragePeriods: [bad] };
  assert.equal(isStipendDay(c, "2026-10-16", []), false);
  assert.match(periodProblem(bad, 2), /^Block 2 ends before it starts \(Oct 16, 4:00 PM to Oct 16, 7:00 AM\)\. Check its dates and times\.$/);
  assert.match(periodProblem({ start: "2026-10-16", end: "", endTime: "07:00" }, 1), /no end date/);
  assert.equal(periodProblem(TIMED_PERIOD, 1), "");
  assert.equal(periodProblem({ start: "2026-10-16", end: "2026-10-18" }, 1), "");
});

test("a block saves its times as HH:MM, and a block without times saves exactly what it always did", () => {
  assert.deepEqual(savedPeriod({ start: "2026-10-16", end: "2026-10-18" }), { start: "2026-10-16", end: "2026-10-18" });
  assert.deepEqual(Object.keys(savedPeriod({ start: "2026-10-16", end: "2026-10-18", startTime: "", endTime: "" })), ["start", "end"]);
  assert.deepEqual(savedPeriod({ start: "2026-10-16", end: "2026-10-19", startTime: "4pm", endTime: "07:00" }), TIMED_PERIOD);
  const fmt = (d) => `<${d}>`;
  assert.equal(coveragePeriodText(TIMED_PERIOD, fmt), "Oct 16, 4:00 PM to Oct 19, 7:00 AM");
  assert.equal(coveragePeriodText({ start: "2026-10-16", end: "2026-10-18" }, fmt), "<2026-10-16> \u{2013} <2026-10-18>");
  assert.equal(coveragePeriodText({ start: "2026-10-16", end: "2026-10-16" }, fmt), "<2026-10-16>");
});

// ── Call days ────────────────────────────────────────────────────

const SIX_TO_SIX = { id: "c-six", callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15,
  coveragePeriods: [{ start: "2026-11-12", startTime: "06:00", end: "2026-11-19", endTime: "06:00" }] };

test("a 6 AM to 6 AM block: 6:15 AM work files under that same day, though the contract's call day starts at 7", () => {
  assert.equal(callDayStartHour(SIX_TO_SIX), 7);
  assert.equal(deriveCallDay(at("2026-11-13 06:15"), SIX_TO_SIX), "2026-11-13");
  assert.equal(deriveCallDay(at("2026-11-13 05:59"), SIX_TO_SIX), "2026-11-12");
  assert.equal(deriveCallDay(at("2026-11-12 06:15"), SIX_TO_SIX), "2026-11-12");
  assert.equal(deriveCallDay(at("2026-11-19 05:59"), SIX_TO_SIX), "2026-11-18");
  // Outside the block the contract's own 7:00 decides.
  assert.equal(deriveCallDay(at("2026-11-19 06:15"), SIX_TO_SIX), "2026-11-18");
  assert.equal(deriveCallDay(at("2026-11-19 07:15"), SIX_TO_SIX), "2026-11-19");
  // Before the block begins on its start date, Nov 11 is no call day, so the
  // block's first day takes it (coverageBlocks.js leadInCallDay).
  assert.equal(deriveCallDay(at("2026-11-12 05:30"), SIX_TO_SIX), "2026-11-12");
  assert.equal(deriveCallDay(at("2026-11-11 23:30"), SIX_TO_SIX), "2026-11-11");
  // The number form is the old rule, untouched.
  assert.equal(deriveCallDay(at("2026-11-13 06:15"), 7), "2026-11-12");
  assert.equal(callDayStartHour(SIX_TO_SIX, at("2026-11-13 06:15")), 6);
  assert.equal(callDayStartHour(SIX_TO_SIX, at("2026-11-19 06:15")), 7);
  assert.equal(live.currentCallDay(SIX_TO_SIX, new Date(at("2026-11-15 06:30"))), "2026-11-15");
  assert.deepEqual(["2026-11-11", "2026-11-12", "2026-11-18", "2026-11-19"].map((d) => isStipendDay(SIX_TO_SIX, d, [])), [false, true, true, false]);
  assert.equal(startedCoverageDays(SIX_TO_SIX).length, 7);

  const early = entry(SIX_TO_SIX, "Call", "2026-11-13 06:15", "2026-11-13 06:17", { description: "Synthetic early call" });
  assert.equal(early.callDay, "2026-11-13");
  const priced = computeBilling(SIX_TO_SIX, [early], true, [early], [], new Set(["2026-11-13"]));
  assert.deepEqual(priced.lines.map((l) => [l.date, l.label, l.flag ?? l.amount]), [
    ["2026-11-13", "On-call coverage (daily total)", 3000],
    [null, "\u{b7} Call: Synthetic early call", "included"],
  ]);
  assert.equal(invoiceDays({ lines: priced.lines, total: priced.total })[0].window, "call 6:00 AM Nov 13 to 6:00 AM Nov 14");
});

test("the 6 AM block across the November fall-back still turns over at 6:00 on the wall clock", () => {
  const c = { ...SIX_TO_SIX, coveragePeriods: [{ start: "2026-10-30", startTime: "06:00", end: "2026-11-03", endTime: "06:00" }] };
  assert.equal(deriveCallDay(at("2026-11-01 05:30"), c), "2026-10-31");
  assert.equal(deriveCallDay(at("2026-11-01 06:00"), c), "2026-11-01");
  assert.equal(deriveCallDay(at("2026-11-02 05:59"), c), "2026-11-01");
});

test("after the 6 AM block ends, a 6:15 AM entry bills after the call ended, at the hourly rate", () => {
  const late = entry(SIX_TO_SIX, "Rounding", "2026-11-19 06:15", "2026-11-19 06:45", { description: "Synthetic handoff" });
  assert.equal(late.callDay, "2026-11-18");
  const priced = computeBilling(SIX_TO_SIX, [late], true, [late], [], new Set(["2026-11-18"]));
  const out = priced.lines.find((l) => l.kind === "outside");
  assert.deepEqual([out.date, out.label, out.minutes, out.amount, out.item], ["2026-11-18", "After call ended at 6:00 AM", 30, 150, "Rounding: Synthetic handoff"]);
  assert.equal(priced.total, 3000 + 150);
  assert.equal(priced.lines.filter((l) => l.label.startsWith("\u{b7} ")).length, 0, "nothing of it is stipend work");
});

test("splitting on: a call crossing the 6:00 AM turnover splits there, and a sign-out crossing the block's end splits at its end", () => {
  const six = { ...SIX_TO_SIX, splitAtDayStart: true };
  const pieces = splitAtCallDay(entry(six, "Call", "2026-11-13 05:45", "2026-11-13 06:15"), six);
  assert.deepEqual(pieces.map((r) => `${hhmm(r.startTime)}-${hhmm(r.endTime)} ${r.callDay} ${r.billedMin}`), ["05:45-06:00 2026-11-12 15", "06:00-06:15 2026-11-13 15"]);
  // No cut at 7:00 inside the block: the contract's hour is not the turnover there.
  assert.equal(splitAtCallDay(entry(six, "Procedure", "2026-11-13 06:30", "2026-11-13 07:30"), six).length, 1);

  const timed = { ...TIMED_CONTRACT, splitAtDayStart: true };
  const signOut = entry(timed, "Sign-out", "2026-10-19 06:30", "2026-10-19 08:45");
  const split = splitRows(signOut, timed, (() => { let n = 0; return () => `g${++n}`; })());
  assert.deepEqual(split.map((r) => `${hhmm(r.startTime)}-${hhmm(r.endTime)} ${r.callDay} ${r.billedMin}`), ["06:30-07:00 2026-10-18 30", "07:00-08:45 2026-10-19 105"]);
  // Split or whole, the sign-out bills the same dollars.
  const days = new Set(["2026-10-18", "2026-10-19"]);
  const whole = computeBilling(TIMED_CONTRACT, [signOut], true, [signOut], [], days);
  const parts = computeBilling(timed, split, true, split, [], days);
  assert.equal(whole.total, parts.total);
  assert.equal(whole.total, 3000 + 525);
});

// ── The timed-block invoice ─────────────────────────────────────

const timedInvoice = () => {
  const list = timedBlockEntries();
  const priced = computeBilling(TIMED_CONTRACT, list, true, list, [], null);
  return { list, priced, inv: { lines: priced.lines, total: priced.total } };
};

test("Oct 16 4:00 PM to Oct 19 7:00 AM bills three call days, not four", () => {
  const { priced } = timedInvoice();
  const stipendDays = priced.lines.filter((l) => l.label === "On-call coverage (daily total)").map((l) => l.date);
  assert.deepEqual(stipendDays, ["2026-10-16", "2026-10-17", "2026-10-18"]);
  assert.equal(isStipendDay(TIMED_CONTRACT, "2026-10-19", []), false);
  assert.deepEqual(startedCoverageDays(TIMED_CONTRACT), ["2026-10-16", "2026-10-17", "2026-10-18"]);
  // Before the call begins on Oct 16 its stipend is not yet owed.
  assert.deepEqual(startedCoverageDays(TIMED_CONTRACT, new Date(at("2026-10-16 15:59"))), []);
  assert.deepEqual(startedCoverageDays(TIMED_CONTRACT, new Date(at("2026-10-16 16:00"))), ["2026-10-16"]);
});

test("day 1: orientation $1,625, before call began 0.50 h $150, stipend $3,000, callback beyond 0.50 h $150, total $4,925", () => {
  const { inv } = timedInvoice();
  const [fri] = invoiceDays(inv);
  assert.equal(fri.title, "Fri, Oct 16, 2026");
  assert.equal(fri.window, "call 4:00 PM Oct 16 to 7:00 AM Oct 17");
  assert.equal(fri.total, 4925);
  assert.deepEqual(table(fri), [
    ["Orientation", "8:30 AM–11:00 AM", "2.50 h @ $250.00/hr", "$625.00"],
    ["Orientation", "11:30 AM–3:30 PM", "4.00 h @ $250.00/hr", "$1,000.00"],
    ["Before call began at 4:00 PM", "", "0.50 h @ $300.00/hr", "$150.00"],
    ["Rounding: Synthetic rounds and family meeting", "3:30 PM–4:00 PM", "0.50 h", "$150.00"],
    ["Call stipend", "covers the first 4.00 h of work", "4.00 h used of 4.00 h", "$3,000.00"],
    ["Rounding: Synthetic rounds and family meeting", "4:00 PM–7:30 PM", "3.50 h", "in $3,000.00 stipend"],
    ["Call: Synthetic consult A", "10:45 PM–11:00 PM", "0.25 h", "in $3,000.00 stipend"],
    ["Call: Synthetic phone call B", "1:00 AM–1:15 AM", "0.25 h", "in $3,000.00 stipend"],
    ["Callback beyond 4 h", "", "0.50 h @ $300.00/hr", "$150.00"],
    ["Call: Synthetic phone call C", "1:45 AM–2:00 AM", "0.25 h", "$75.00"],
    ["Call: Synthetic ED call D", "2:00 AM–2:15 AM", "0.25 h", "$75.00"],
  ]);
  assert.deepEqual(fri.rows.filter((r) => r.sums).map((r) => r.amount), [625, 1000, 150, 3000, 150]);
});

test("the sign-out on the last morning: 30 min inside Oct 18's call day, 105 min after call ended at $300/hr", () => {
  const { priced, inv } = timedInvoice();
  const days = invoiceDays(inv);
  assert.deepEqual(days.map((d) => d.window), [
    "call 4:00 PM Oct 16 to 7:00 AM Oct 17", "call 7:00 AM Oct 17 to 7:00 AM Oct 18", "call 7:00 AM Oct 18 to 7:00 AM Oct 19",
  ]);
  const sun = days[2];
  assert.deepEqual(table(sun).slice(-4), [
    ["Call: Synthetic phone call K", "5:30 AM–5:45 AM", "0.25 h", "$75.00"],
    ["Sign-out: Synthetic sign out", "6:30 AM–7:00 AM", "0.50 h", "$150.00"],
    ["After call ended at 7:00 AM", "", "1.75 h @ $300.00/hr", "$525.00"],
    ["Sign-out: Synthetic sign out", "7:00 AM–8:45 AM", "1.75 h", "$525.00"],
  ]);
  assert.equal(sun.total, 3000 + 1350 + 525);
  const after = priced.lines.find((l) => l.kind === "outside" && l.side === "after");
  assert.deepEqual([after.date, after.minutes, after.rate, after.amount], ["2026-10-18", 105, 300, 525]);
  assert.equal(priced.dayOverMin["2026-10-18"], 270, "only minutes inside the block draw the allowance");
});

test("same grand total and minutes as the same block entered without times (end date = last call day)", () => {
  const { list, priced, inv } = timedInvoice();
  const untimed = computeBilling(UNTIMED_CONTRACT, list, true, list, [], null);
  assert.equal(priced.total, 14600);
  assert.equal(untimed.total, priced.total);
  assert.equal(untimed.totalMin, priced.totalMin);
  assert.deepEqual(invoiceDays(inv).map((d) => d.total), [4925, 4800, 4875]);
  // The same agreement entered with the end date as written and no times
  // bills a fourth, empty stipend day: the $3,000 that should not be there.
  const asWritten = computeBilling({ ...UNTIMED_CONTRACT, coveragePeriods: [{ start: "2026-10-16", end: "2026-10-19" }] }, list, true, list, [], null);
  assert.equal(asWritten.total - priced.total, 3000);
});

test("billing never rewrites the stored rows", () => {
  const list = timedBlockEntries();
  const before = JSON.stringify(list);
  computeBilling(TIMED_CONTRACT, list, true, list, [], null);
  assert.equal(JSON.stringify(list), before);
});

test("a later invoice: work already billed draws the allowance with its minutes inside the block only", () => {
  const list = timedBlockEntries();
  const rounding = { ...list[2], invoiceId: "inv-1" };
  const calls = list.slice(3, 7);
  const allEntries = [list[0], list[1], rounding, ...calls];
  const earlier = { id: "inv-1", contractId: TIMED_CONTRACT.id, entryIds: [rounding.id], dayOverMin: { "2026-10-16": 0 },
    lines: [{ date: "2026-10-16", label: "On-call coverage (daily total)", amount: 3150 }] };
  const priced = computeBilling(TIMED_CONTRACT, calls, true, allEntries, [earlier], new Set(["2026-10-16"]));
  const day = priced.lines.find((l) => l.label === "Additional work (daily total)");
  assert.deepEqual([day.priorMin, day.loggedMin, day.overMin, day.amount], [210, 270, 30, 150]);
  assert.equal(priced.lines.some((l) => l.kind === "outside"), false, "the rounding's 30 minutes before the call went out on its own invoice");
  assert.equal(priced.total, 150);
});

test("every format prints the window and the before/after rows, and the day totals add up to the invoice", async () => {
  const { inv } = timedInvoice();
  const DOC = { number: "INV-SYN-2", physician: "Synthetic Physician, DO", facility: "Synthetic Regional Hospital", agency: "Synthetic Staffing", periodStart: "2026-10-16", periodEnd: "2026-10-18", terms: "Synthetic terms" };
  const doc = { ...DOC, ...inv };
  const layout = invoiceLayout(doc);
  assert.equal(layout.mode, "days", layout.reason);
  assert.equal(cents(layout.days.reduce((s, d) => s + d.total, 0)), cents(inv.total));
  const text = invoicePlainText(doc);
  for (const words of ["Fri, Oct 16, 2026 \u{b7} call 4:00 PM Oct 16 to 7:00 AM Oct 17", "Before call began at 4:00 PM", "After call ended at 7:00 AM", "Total for Fri, Oct 16, 2026: $4,925.00", "TOTAL DUE: $14,600.00"]) {
    assert.ok(text.includes(words), `text: ${words}`);
  }
  assert.ok(!text.includes(EM_DASH));
  const pdf = Buffer.from(buildInvoicePdf(doc).output("arraybuffer")).toString("latin1");
  for (const words of ["call 4:00 PM Oct 16 to 7:00 AM Oct 17", "Before call began at 4:00 PM", "After call ended at 7:00 AM", "Call stipend"]) assert.ok(pdf.includes(words), `PDF: ${words}`);
  const wb = XLSX.read(new Uint8Array(await invoiceXlsxFile(doc).arrayBuffer()), { type: "array" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Invoice, { header: 1, defval: "" });
  assert.ok(rows.some((r) => r[0] === "Before call began at 4:00 PM" && r[3] === 150));
  assert.ok(rows.some((r) => r[0] === "Rounding: Synthetic rounds and family meeting" && r[3] === "$150.00 in Before call began at 4:00 PM"));
  const head = rows.findIndex((r) => r[0] === "Item");
  const totalRow = rows.findIndex((r) => r[2] === "TOTAL");
  const amounts = rows.slice(head + 1, totalRow).map((r) => r[3]).filter((v) => typeof v === "number");
  assert.equal(cents(amounts.reduce((s, v) => s + v, 0)), cents(inv.total), "the Amount column sums to the invoice");
  const zip = await JSZip.loadAsync(await (await invoiceDocxFile(doc)).arrayBuffer());
  const xml = await zip.file("word/document.xml").async("string");
  for (const words of ["call 4:00 PM Oct 16 to 7:00 AM Oct 17", "Before call began at 4:00 PM", "After call ended at 7:00 AM"]) assert.ok(xml.includes(words), `Word: ${words}`);
  assert.ok(!JSON.stringify(layout).includes(EM_DASH));
});

test("times stored the loose way (\"4pm\", from a scan) bill the same as HH:MM", () => {
  const list = timedBlockEntries();
  const loose = { ...TIMED_CONTRACT, coveragePeriods: [{ ...TIMED_PERIOD, startTime: "4pm", endTime: "7 AM" }] };
  assert.equal(JSON.stringify(computeBilling(loose, list, true, list, [], null)), JSON.stringify(computeBilling(TIMED_CONTRACT, list, true, list, [], null)));
});

test("orientation keeps its own terms inside or outside the block", () => {
  const c = TIMED_CONTRACT;
  const o = entry(c, "Orientation", "2026-10-16 17:00", "2026-10-16 18:00");
  const priced = computeBilling(c, [o], true, [o], [], new Set(["2026-10-16"]));
  const line = priced.lines.find((l) => l.kind === "orientation");
  assert.deepEqual([line.minutes, line.amount], [60, 250]);
  assert.equal(priced.lines.some((l) => l.kind === "outside"), false);
});

test("an entry crossing the block start is shared out by its clock time, in whole increments", () => {
  const c = TIMED_CONTRACT;
  // 3:50 to 4:40 PM, 50 raw minutes, billed 60: 10 min before, 40 inside,
  // so 1 of 4 increments before (largest remainder) and 3 inside.
  const e = entry(c, "Procedure", "2026-10-16 15:50", "2026-10-16 16:40");
  const parts = live.coveragePartsOf(c, e);
  assert.deepEqual([parts.before, parts.inside, parts.after], [15, 45, 0]);
  // A call answered a minute before 4:00 bills its minimum before the call began.
  const call = entry(c, "Call", "2026-10-16 15:59", "2026-10-16 16:01");
  assert.deepEqual(live.coveragePartsOf(c, call) && [live.coveragePartsOf(c, call).before, live.coveragePartsOf(c, call).inside], [15, 0]);
  // Wholly inside: nothing to share.
  assert.equal(live.coveragePartsOf(c, entry(c, "Call", "2026-10-16 17:00", "2026-10-16 17:02")), null);
  assert.equal(live.stipendMinutesOf(c, e), 45);
  assert.deepEqual(live.outsideChargeOf(c, e), { minutes: 15, amount: 75, rate: 300 });
});

test("two blocks back to back: work across the seam is inside coverage, as before", () => {
  const c = { ...SIX_TO_SIX, coveragePeriods: [
    { start: "2026-11-12", startTime: "06:00", end: "2026-11-19", endTime: "06:00" },
    { start: "2026-11-19", startTime: "06:00", end: "2026-11-22", endTime: "06:00" },
  ] };
  const e = entry(c, "Procedure", "2026-11-19 05:30", "2026-11-19 06:30");
  assert.equal(e.callDay, "2026-11-18");
  assert.equal(live.coveragePartsOf(c, e), null);
});

// ── No times: byte-identical to the engine before this change ────

test("Northfield without times: every line, amount, total and minute byte-identical to 4b65234a", () => {
  const list = northfieldEntries();
  for (const days of [null, new Set(["2026-10-16", "2026-10-18"])]) {
    assert.equal(JSON.stringify(computeBilling(NORTHFIELD_CONTRACT, list, true, list, [], days)), JSON.stringify(frozen.computeBilling(NORTHFIELD_CONTRACT, list, true, list, [], days)));
  }
});

// A seeded generator of contracts WITHOUT times and their work: whatever it
// makes, the live engine must price exactly as the frozen one.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DAY0 = new RealDate(2026, 9, 20, 12).getTime();
const dayKey = (n) => { const d = new Date(DAY0 + n * 86400000); return live.localDate(d); };
function scenario(r, n) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const c = {
    id: `c${n}`, callStipend: r() < 0.75 ? pick([1000, 2500, 3000]) : 0, stipendHours: pick([0, 2, 4, 6]),
    overageHourlyRate: pick([0, 250, 262.5, 300]), hourlyRate: pick([0, 150, 250]), callHourlyRate: pick([0, 100, 150]),
    orientationHourlyRate: pick([0, 150, 300]), orientationFee: pick([0, 0, 500]), orientationBilled: r() < 0.2,
    incrementMinutes: pick([15, 15, 10, 30]), minCallMinutes: pick([15, 30]), coveragePeriods: [],
  };
  if (r() < 0.35) c.dayStartHour = pick([0, 6, 7, 8, 12, 23, "", null, "x"]);
  if (r() < 0.35) c.splitAtDayStart = r() < 0.7;
  const blocks = Math.floor(r() * 4);
  for (let i = 0; i < blocks; i++) {
    const s = Math.floor(r() * 40);
    c.coveragePeriods.push(r() < 0.1 ? { start: dayKey(s) } : { start: dayKey(s), end: dayKey(s + Math.floor(r() * 8)) });
  }
  const list = [];
  const count = Math.floor(r() * 24);
  for (let i = 0; i < count; i++) {
    const type = pick(["Call", "Call", "Transfer call", "Rounding", "Procedure", "Consult", "Orientation", "CallDay", "Sign-out"]);
    const start = DAY0 + Math.floor(r() * 40 * 1440) * 60000;
    const raw = pick([0, 1, 2, 7, 15, 29, 45, 90, 135, 240, 600]);
    const s = new Date(start).toISOString(), e = new Date(start + raw * 60000).toISOString();
    const inc = c.incrementMinutes;
    const billed = type === "CallDay" ? 0 : roundUp(Math.max(1, raw), inc, type === "Call" || type === "Transfer call" ? c.minCallMinutes : 0);
    const stamp = r() < 0.9 ? { callDay: frozen.deriveCallDay(s, frozen.callDayStartHour(c)) } : {};
    list.push({
      id: `x${n}-${i}`, createdAt: new Date(DAY0 + i * 1000).toISOString(), contractId: c.id, type, date: live.localDate(s), ...stamp,
      startTime: type === "CallDay" && r() < 0.5 ? null : s, endTime: type === "CallDay" && r() < 0.5 ? null : e,
      durationMin: raw, billedMin: billed, description: r() < 0.5 ? `Synthetic note ${i}` : "", privateNote: "",
      invoiceId: r() < 0.2 ? "inv-a" : null,
    });
  }
  const invoiced = list.filter((x) => x.invoiceId);
  const invoices = invoiced.length && r() < 0.7 ? [{
    id: "inv-a", contractId: c.id, entryIds: invoiced.map((x) => x.id),
    dayOverMin: Object.fromEntries(invoiced.map((x) => [x.callDay || x.date, Math.floor(r() * 3) * 15])),
    lines: r() < 0.5 ? [{ date: invoiced[0].callDay || invoiced[0].date, label: "On-call coverage (daily total)", amount: c.callStipend }] : [],
  }] : [];
  const unbilled = list.filter((x) => !x.invoiceId);
  const days = r() < 0.4 ? new Set(unbilled.map((x) => x.callDay || x.date).filter(() => r() < 0.6)) : null;
  return { c, list, unbilled, invoices, days, includeOrientation: r() < 0.8 };
}

test("400 generated contracts without times: the live engine prices every one exactly as 4b65234a", () => {
  const r = rng(20260928);
  for (let n = 0; n < 400; n++) {
    const { c, list, unbilled, invoices, days, includeOrientation } = scenario(r, n);
    const want = JSON.stringify(frozen.computeBilling(c, unbilled, includeOrientation, list, invoices, days));
    const got = JSON.stringify(computeBilling(c, unbilled, includeOrientation, list, invoices, days));
    assert.equal(got, want, `scenario ${n}`);
    // The same invoice laid out by the live and the frozen layout.
    const priced = JSON.parse(got);
    if (priced.lines.length) {
      const inv = { lines: priced.lines, total: priced.total, dayStartHour: frozen.callDayStartHour(c) };
      // A flat table whose lines carry fractions of a cent now foots to the
      // total with one "Rounding adjustment" row (Oct 2026); nothing else moved.
      const liveLayout = invoiceLayout(inv);
      if (liveLayout.rows) liveLayout.rows = liveLayout.rows.filter((r) => r[1] !== "Rounding adjustment");
      assert.deepEqual(liveLayout, frozenLayout.invoiceLayout(inv), `layout ${n}`);
      // The text invoice's line format changed on purpose in Oct 2026 (an
      // amount closes its item's line instead of following a note with "=";
      // a blank facility prints no "To:" line). Every day total and the total
      // due still read exactly as the frozen layout printed them.
      const money = (t) => t.split("\n").filter((l) => /^Total for |^TOTAL DUE|^BALANCE DUE|^Invoice total|^Paid/.test(l));
      assert.deepEqual(money(invoicePlainText(inv)), money(frozenLayout.invoicePlainText(inv)), `text ${n}`);
    }
    assert.equal(live.currentCallDay(c), frozen.currentCallDay(c), `today ${n}`);
    assert.equal(callDayStartHour(c), frozen.callDayStartHour(c), `hour ${n}`);
    for (const x of list) {
      if (!x.startTime) continue;
      assert.equal(deriveCallDay(x.startTime, c), frozen.deriveCallDay(x.startTime, frozen.callDayStartHour(c)), `call day ${n} ${x.id}`);
      assert.equal(isStipendDay(c, x.callDay || x.date, list), frozen.isStipendDay(c, x.callDay || x.date, list), `stipend day ${n} ${x.id}`);
      let a = 0, b = 0;
      assert.equal(JSON.stringify(splitRows(x, c, () => `id${++a}`)), JSON.stringify(frozen.splitRows(x, c, () => `id${++b}`)), `split ${n} ${x.id}`);
    }
  }
});

test("before the coverage starts, today's sweep matches the frozen engine too", () => {
  const saved = NOW;
  try {
    for (const now of ["2026-10-25T06:30:00-05:00", "2026-11-01T06:30:00-06:00", "2026-11-01T07:30:00-06:00"]) {
      NOW = now;
      const r = rng(7);
      for (let n = 0; n < 60; n++) {
        const { c, list, unbilled, invoices, days, includeOrientation } = scenario(r, n);
        assert.equal(JSON.stringify(computeBilling(c, unbilled, includeOrientation, list, invoices, days)), JSON.stringify(frozen.computeBilling(c, unbilled, includeOrientation, list, invoices, days)), `${now} ${n}`);
      }
    }
  } finally { NOW = saved; }
});

test("a timed contract adds only the new fields to its lines, and only where a block reaches", () => {
  const { priced } = timedInvoice();
  const extra = new Set(["side", "item", "windowText"]);
  for (const l of priced.lines) {
    for (const k of Object.keys(l)) assert.ok(live.LAYOUT_LINE_FIELDS.includes(k) || ["date", "label", "detail", "amount", "flag", "_sort"].includes(k), k);
    if (l.kind !== "outside" && l.kind !== "stipendDay" && l.kind !== "additionalDay") assert.ok(!Object.keys(l).some((k) => extra.has(k)), l.label);
  }
  assert.ok(all(priced.lines).filter((l) => l.kind === "stipendDay").every((l) => typeof l.windowText === "string"));
});
