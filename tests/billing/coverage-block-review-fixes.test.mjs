import test from "node:test";
import assert from "node:assert/strict";
import { Document, Packer, Paragraph } from "docx";
import * as live from "../../src/utils/billing.js";
import * as frozen from "./legacy-billing-4b65234a.mjs";
import { invoiceDays } from "../../src/utils/invoiceLayout.js";
import {
  timedBlock, blockCallDays, callDayWindow, periodProblem, savedPeriod, isTimedPeriod, timedBlockLabel, blockSummary, validZone,
} from "../../src/utils/coverageBlocks.js";
import { normalizeCoveragePeriods, fileableCoveragePeriods } from "../../src/utils/coverageText.js";
import { normalizeAgreementFields, contractFromScan } from "../../src/utils/docPrefill.js";
import { planFiling } from "../../supabase/functions/_shared/intakeFiling.mjs";
import { officeText } from "../../supabase/functions/_shared/officeText.mjs";
import { TIMED_CONTRACT, TIMED_PERIOD, timedBlockEntries } from "./fixtures/timed-block.mjs";

// Review fixes for coverage blocks with times (feat/coverage-block-times):
// the zone a block's times are on, a start time without an end time, a call
// day whose call has not begun, work just before a block starts, the day
// header of an hourly contract, and the scan paths. Each test fails on the
// branch as it was reviewed. Synthetic data only. Built on Central time.
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
// Runs fn with the process on another zone's clock, then back on Central.
const inZone = (zone, fn) => { process.env.TZ = zone; try { return fn(); } finally { process.env.TZ = "America/Chicago"; } };

const { computeBilling, deriveCallDay, splitRows, startedCoverageDays } = live;
const at = (s) => { const [d, t] = s.split(" "); const [y, m, dd] = d.split("-").map(Number); const [hh, mi] = t.split(":").map(Number); return new Date(y, m - 1, dd, hh, mi).toISOString(); };
const roundUp = (raw, inc, min) => Math.max(min || 0, Math.ceil(raw / inc) * inc || inc);
const cents = (n) => (n == null ? null : Math.round(n * 100));
let seq = 0;
function entry(contract, type, from, to, extra = {}) {
  const s = at(from), e = at(to);
  const raw = Math.max(1, Math.round((new RealDate(e) - new RealDate(s)) / 60000));
  const billed = roundUp(raw, contract.incrementMinutes || 15, type === "Call" ? (contract.minCallMinutes || 15) : 0);
  seq += 1;
  return {
    id: `r${String(seq).padStart(3, "0")}`, createdAt: `2026-09-01T00:00:${String(seq % 60).padStart(2, "0")}Z`, contractId: contract.id, type,
    date: live.localDate(s), callDay: deriveCallDay(s, contract), startTime: s, endTime: e,
    durationMin: raw, billedMin: billed, description: "", privateNote: "", invoiceId: null, ...extra,
  };
}

// ── 1. The zone a block's times are on ───────────────────────────

const ZONED_CONTRACT = { ...TIMED_CONTRACT, coveragePeriods: [{ ...TIMED_PERIOD, tz: "America/Chicago" }] };
const BLOCK_DAYS = new Set(["2026-10-16", "2026-10-17", "2026-10-18"]);
// What an invoice says in money: every line's day, label, kind, minutes and
// cents, its window, the total and the minutes stamped per day. (A line's
// detail also prints the entry's clock times, on the device's clock like
// every invoice line; those are not money.)
const money = (c, list, all, invoices, days) => {
  const p = computeBilling(c, list, true, all, invoices, days);
  return {
    total: cents(p.total), totalMin: p.totalMin, dayOverMin: p.dayOverMin, empty: p.emptyStipendDays,
    lines: p.lines.map((l) => [l.date, l.label, l.kind, l.side ?? null, l.minutes ?? null, l.priorMin ?? null, l.overMin ?? null, cents(l.amount), l.windowText ?? null]),
  };
};

test("a block with a zone bills the same invoice whichever zone it is built in", () => {
  const list = timedBlockEntries();
  const want = money(ZONED_CONTRACT, list, list, [], BLOCK_DAYS);
  assert.equal(want.total, cents(14600));
  for (const zone of ["America/Denver", "America/Los_Angeles", "America/New_York", "UTC", "Asia/Tokyo"]) {
    assert.deepEqual(inZone(zone, () => money(ZONED_CONTRACT, list, list, [], BLOCK_DAYS)), want, zone);
  }
  // The same block with no zone is read on this device's clock, as before.
  assert.equal(inZone("America/Chicago", () => computeBilling(TIMED_CONTRACT, list, true, list, [], BLOCK_DAYS).total), 14600);
});

test("a later invoice built in another zone never counts minutes the first invoice already billed", () => {
  // Oct 16 to 18 invoiced on Central time, then an Oct 18 call logged late
  // and invoiced from a Pacific-time laptop.
  const list = timedBlockEntries();
  const first = computeBilling(ZONED_CONTRACT, list, true, list, [], BLOCK_DAYS);
  const inv = { id: "inv-1", contractId: ZONED_CONTRACT.id, entryIds: list.map((e) => e.id), dayOverMin: first.dayOverMin, lines: first.lines };
  const billed = list.map((e) => ({ ...e, invoiceId: "inv-1" }));
  const late = entry(ZONED_CONTRACT, "Call", "2026-10-18 23:10", "2026-10-18 23:12", { description: "Synthetic late call" });
  const all = [...billed, late];
  const want = money(ZONED_CONTRACT, [late], all, [inv], new Set(["2026-10-18"]));
  const day = want.lines.find((l) => l[1] === "Additional work (daily total)");
  // Prior: Oct 18's rounding 240, case 210, two calls 15 each, and only the
  // sign-out's 30 minutes inside the block (its 105 after went out on the
  // After line). 525 logged, 285 over, 270 of it billed: 15 min left.
  assert.deepEqual([day[5], day[6], day[7]], [510, 15, cents(75)]);
  for (const zone of ["America/Los_Angeles", "America/New_York", "Asia/Tokyo"]) {
    assert.deepEqual(inZone(zone, () => money(ZONED_CONTRACT, [late], all, [inv], new Set(["2026-10-18"]))), want, zone);
  }
});

test("a zoned block reads its moments on its own clock, the same as this device's when the zones agree", () => {
  const blocks = [
    TIMED_PERIOD,
    { start: "2026-10-30", startTime: "06:00", end: "2026-11-03", endTime: "06:00" },
    { start: "2026-10-31", startTime: "01:30", end: "2026-11-02", endTime: "01:30" },
    { start: "2027-03-12", startTime: "02:30", end: "2027-03-16", endTime: "02:30" },
  ];
  for (const p of blocks) {
    const device = timedBlock(p), zoned = timedBlock({ ...p, tz: "America/Chicago" });
    assert.deepEqual([zoned.startMs, zoned.endMs, blockCallDays(zoned)], [device.startMs, device.endMs, blockCallDays(device)], JSON.stringify(p));
    for (const k of blockCallDays(device)) assert.deepEqual(callDayWindow(zoned, k), callDayWindow(device, k), `${p.start} ${k}`);
    // Read from Tokyo, the zoned block is still Central time.
    assert.deepEqual(inZone("Asia/Tokyo", () => { const b = timedBlock({ ...p, tz: "America/Chicago" }); return [b.startMs, b.endMs, blockCallDays(b), timedBlockLabel({ ...p, tz: "America/Chicago" })]; }),
      [device.startMs, device.endMs, blockCallDays(device), timedBlockLabel(p)]);
  }
  // Across the fall-back, read from UTC: the call day from 6:00 AM Oct 31
  // (daylight time) to 6:00 AM Nov 1 (standard time) runs 25 hours.
  const fallBack = timedBlock({ ...blocks[1], tz: "America/Chicago" });
  const w = inZone("UTC", () => callDayWindow(fallBack, "2026-10-31"));
  assert.deepEqual([new RealDate(w.startMs).toISOString(), new RealDate(w.endMs).toISOString()], ["2026-10-31T11:00:00.000Z", "2026-11-01T12:00:00.000Z"]);
  assert.equal(validZone("US/Central"), "America/Chicago");
  assert.equal(validZone("Not/AZone"), "");
});

test("the form's zone is saved with a block that has times, and never with one that has none", () => {
  assert.deepEqual(savedPeriod({ ...TIMED_PERIOD }, "America/Denver"), { ...TIMED_PERIOD, tz: "America/Denver" });
  assert.deepEqual(savedPeriod({ ...TIMED_PERIOD, tz: "America/Chicago" }), { ...TIMED_PERIOD, tz: "America/Chicago" });
  assert.deepEqual(savedPeriod({ start: "2026-10-16", end: "2026-10-18", tz: "America/Chicago" }, "America/Denver"), { start: "2026-10-16", end: "2026-10-18" });
  assert.deepEqual(savedPeriod({ ...TIMED_PERIOD, tz: "nowhere" }), TIMED_PERIOD);
});

// ── 2. A start time without an end time ──────────────────────────

test("a start time with no end time: the form refuses it, a scan drops it, and a stored one bills as the untimed block", () => {
  const startOnly = { start: "2026-10-16", startTime: "16:00", end: "2026-10-19" };
  assert.equal(periodProblem(startOnly, 1), "Block 1 has a start time but no end time. Enter when coverage ends.");
  assert.equal(isTimedPeriod(startOnly), false);
  assert.deepEqual(normalizeAgreementFields({ coveragePeriods: [{ start: "2026-10-16", startTime: "4pm", end: "2026-10-19" }] }).coveragePeriods, [{ start: "2026-10-16", end: "2026-10-19" }]);
  assert.deepEqual(normalizeCoveragePeriods([], { text: "Coverage October 16, 2026 (4pm) to October 19, 2026." }), [{ start: "2026-10-16", end: "2026-10-19" }]);
  // Stored anyway (a block filed before this rule): days still turn over at
  // the contract's 7:00, not at 4:00 PM, exactly as the engine before times.
  const list = timedBlockEntries();
  const c = { ...TIMED_CONTRACT, coveragePeriods: [startOnly] };
  const plain = { ...TIMED_CONTRACT, coveragePeriods: [{ start: "2026-10-16", end: "2026-10-19" }] };
  assert.equal(JSON.stringify(computeBilling(c, list, true, list, [], null)), JSON.stringify(frozen.computeBilling(plain, list, true, list, [], null)));
  assert.equal(deriveCallDay(at("2026-10-17 07:30"), c), "2026-10-17", "7:30 AM Oct 17 is Oct 17's work, not Oct 16's");
  assert.equal(deriveCallDay(at("2026-10-19 10:00"), c), "2026-10-19");
});

// ── 5. A call day whose call has not begun ───────────────────────

test("before a timed block's call begins, the day bills its early work only; its stipend waits for the call", () => {
  const saved = NOW;
  try {
    NOW = "2026-10-16T11:00:00-05:00";
    const consult = entry(TIMED_CONTRACT, "Consult", "2026-10-16 08:00", "2026-10-16 09:00", { description: "Synthetic consult" });
    assert.equal(consult.callDay, "2026-10-16");
    const early = computeBilling(TIMED_CONTRACT, [consult], true, [consult], [], new Set(["2026-10-16"]));
    assert.equal(early.total, 300);
    assert.deepEqual(early.lines.map((l) => [l.date, l.label, l.kind, l.minutes, l.amount]), [["2026-10-16", "Before call began at 4:00 PM", "outside", 60, 300]]);
    assert.deepEqual(early.emptyStipendDays, []);
    assert.equal(early.dayOverMin["2026-10-16"], undefined, "no stipend day was billed");
    assert.equal(invoiceDays({ lines: early.lines, total: early.total })[0].window, "call 4:00 PM Oct 16 to 7:00 AM Oct 17");

    // Invoiced like that, the stipend is still owed once the call has begun.
    NOW = "2026-10-17T12:00:00-05:00";
    const inv = { id: "inv-early", contractId: TIMED_CONTRACT.id, entryIds: [consult.id], dayOverMin: early.dayOverMin, lines: early.lines };
    const billed = { ...consult, invoiceId: "inv-early" };
    const call = entry(TIMED_CONTRACT, "Call", "2026-10-16 22:00", "2026-10-16 22:02", { description: "Synthetic call" });
    const later = computeBilling(TIMED_CONTRACT, [call], true, [billed, call], [inv], new Set(["2026-10-16"]));
    const day = later.lines.find((l) => l.date === "2026-10-16" && l.amount != null);
    assert.deepEqual([day.label, day.priorMin, day.loggedMin, day.amount], ["On-call coverage (daily total)", 0, 15, 3000]);
    assert.equal(later.total, 3000);
    // With nothing logged, the day still waits for 4:00 PM (as before).
    NOW = "2026-10-16T15:59:00-05:00";
    assert.deepEqual(startedCoverageDays(TIMED_CONTRACT), []);
  } finally { NOW = saved; }
});

test("work already logged inside the block means its call is under way: the day bills its stipend", () => {
  const saved = NOW;
  try {
    NOW = "2026-10-16T17:00:00-05:00";
    const r = entry(TIMED_CONTRACT, "Rounding", "2026-10-16 15:30", "2026-10-16 16:30");
    const p = computeBilling(TIMED_CONTRACT, [r], true, [r], [], new Set(["2026-10-16"]));
    assert.equal(p.total, 3000 + 150);
  } finally { NOW = saved; }
});

// ── 6 and 7. Work just before a block starts ─────────────────────

const SIX = { id: "c-six", callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15,
  coveragePeriods: [{ start: "2026-11-12", startTime: "06:00", end: "2026-11-19", endTime: "06:00", tz: "America/Chicago" }] };

test("5:30 to 7:30 AM on the day a 6:00 AM block starts: 30 min before the call, 90 min in its allowance, like two entries split at 6:00", () => {
  const whole = entry(SIX, "Rounding", "2026-11-12 05:30", "2026-11-12 07:30", { description: "Synthetic rounds" });
  assert.equal(whole.callDay, "2026-11-12", "filed under the block's first day, not Nov 11");
  const days = new Set(["2026-11-11", "2026-11-12"]);
  const one = computeBilling(SIX, [whole], true, [whole], [], days);
  assert.equal(one.total, 3150);
  assert.deepEqual(one.lines.map((l) => [l.date, l.label, l.minutes, l.amount]), [
    ["2026-11-12", "On-call coverage (daily total)", undefined, 3000],
    ["2026-11-12", "Before call began at 6:00 AM", 30, 150],
    [null, "\u{b7} Rounding: Synthetic rounds", 90, null],
  ]);
  const a = entry(SIX, "Rounding", "2026-11-12 05:30", "2026-11-12 06:00", { description: "Synthetic rounds" });
  const b = entry(SIX, "Rounding", "2026-11-12 06:00", "2026-11-12 07:30", { description: "Synthetic rounds" });
  assert.equal(computeBilling(SIX, [a, b], true, [a, b], [], days).total, one.total);
  // Splitting on: nothing to cut, the whole entry is Nov 12's.
  assert.equal(splitRows(whole, { ...SIX, splitAtDayStart: true }, () => "x").length, 1);
});

test("5:50 to 6:10 AM on the block's first day: 15 min before the call, 15 min in the allowance", () => {
  const call = entry(SIX, "Call", "2026-11-12 05:50", "2026-11-12 06:10");
  assert.equal(call.callDay, "2026-11-12");
  const p = computeBilling(SIX, [call], true, [call], [], new Set(["2026-11-11", "2026-11-12"]));
  assert.equal(p.total, 3000 + 75);
  assert.equal(p.dayOverMin["2026-11-12"], 0);
  assert.deepEqual(live.coveragePartsOf(SIX, call) && [live.coveragePartsOf(SIX, call).before, live.coveragePartsOf(SIX, call).inside], [15, 15]);
});

test("a block right after another: the first block's morning stays its own", () => {
  const two = { ...SIX, coveragePeriods: [{ start: "2026-11-01", end: "2026-11-11" }, SIX.coveragePeriods[0]] };
  // 5:30 AM Nov 12 is Nov 11's call (the untimed block's last call day).
  assert.equal(deriveCallDay(at("2026-11-12 05:30"), two), "2026-11-11");
});

// ── 8. The day header of an hourly contract ──────────────────────

test("an hourly contract with a 6:00 AM block: the day header states the block's call day", () => {
  const hourly = { id: "c-hourly", payModel: "hourly", callStipend: 0, hourlyRate: 250, callHourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15,
    coveragePeriods: [{ start: "2026-11-12", startTime: "06:00", end: "2026-11-19", endTime: "06:00", tz: "America/Chicago" }] };
  const call = entry(hourly, "Call", "2026-11-13 06:15", "2026-11-13 06:45", { description: "Synthetic early call" });
  assert.equal(call.callDay, "2026-11-13");
  const p = computeBilling(hourly, [call], true, [call], [], null);
  assert.equal(p.total, 100);
  const [day] = invoiceDays({ lines: p.lines, total: p.total });
  assert.equal(day.window, "call 6:00 AM Nov 13 to 6:00 AM Nov 14");
  assert.equal(p.lines[0].dayStartHour, 6);
});

// ── 9. The Files tab and the docs@ inbox ─────────────────────────

const docxText = async (lines) => {
  const buf = await Packer.toBuffer(new Document({ sections: [{ children: lines.map((t) => new Paragraph(t)) }] }));
  return officeText(new Uint8Array(buf), "synthetic-agreement.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
};

test("a Word agreement filed from the Files tab: the model's missing times come from its words, and it bills three call days", async () => {
  const { text } = await docxText([
    "Synthetic Locum Assignment Confirmation",
    "Coverage: October 16, 2026 (4pm) to October 19, 2026 (7am).",
    "Rate: $3,000 per 24-hour call including the first 4 hours worked.",
  ]);
  assert.match(text, /October 16, 2026 \(4pm\)/);
  // The model read the dates but not the times.
  const fields = { facility: "Synthetic Regional Hospital", callStipend: "3000", stipendHours: "4", overageHourlyRate: "300", coveragePeriods: [{ start: "2026-10-16", end: "2026-10-19" }] };
  const { entry: saved, problem } = contractFromScan(fields, { text, zone: "America/Chicago" });
  assert.equal(problem, "");
  assert.deepEqual(saved.coveragePeriods, [{ start: "2026-10-16", end: "2026-10-19", startTime: "16:00", endTime: "07:00", tz: "America/Chicago" }]);
  assert.deepEqual([saved.callStipend, saved.stipendHours, saved.incrementMinutes], [3000, 4, 15]);
  const list = timedBlockEntries();
  assert.equal(computeBilling({ ...TIMED_CONTRACT, coveragePeriods: saved.coveragePeriods }, list, true, list, [], null).total, 14600);
  // Times the model wrote its own way read as HH:MM.
  assert.deepEqual(contractFromScan({ coveragePeriods: [{ start: "2026-10-16", startTime: "4:00 PM", end: "2026-10-19", endTime: "7 a.m." }] }).entry.coveragePeriods,
    [{ start: "2026-10-16", end: "2026-10-19", startTime: "16:00", endTime: "07:00" }]);
});

test("a scanned block that ends before it starts is not saved from the Files tab, and says why", () => {
  const { problem } = contractFromScan({ coveragePeriods: [{ start: "2026-10-19", startTime: "16:00", end: "2026-10-16", endTime: "07:00" }] });
  assert.equal(problem, "Block 1 ends before it starts (Oct 19, 4:00 PM to Oct 16, 7:00 AM). Check its dates and times. Fix its dates here or remove the block, then save.");
  const { kept, refused } = fileableCoveragePeriods([TIMED_PERIOD, { start: "2026-10-16", startTime: "16:00", end: "2026-10-16", endTime: "07:00" }]);
  assert.deepEqual([kept, refused.map((r) => r.label)], [[TIMED_PERIOD], ["Oct 16, 4:00 PM to Oct 16, 7:00 AM"]]);
});

test("an agreement forwarded to docs@: blocks shaped as the app saves them, a block that ends before it starts kept only as text", () => {
  const scan = { documentType: "agreement", confidence: "high", extracted: {
    facility: "Synthetic Regional Hospital", agency: "Synthetic Staffing", startDate: "2026-10-16", endDate: "2026-11-19", callStipend: "3000",
    coveragePeriods: [
      { start: "2026-10-16", startTime: "4:00 PM", end: "2026-10-19", endTime: "7am" },
      { start: "2026-11-12", startTime: "06:00", end: "2026-11-18" },
      { start: "2026-12-10", startTime: "16:00", end: "2026-12-09", endTime: "07:00" },
    ],
  } };
  let n = 0;
  const plan = planFiling({ scan, docId: "doc-1", fileName: "synthetic.pdf", mimeType: "application/pdf", userId: "profile-1", rows: [], categories: [], now: "2026-10-19T12:00:00.000Z", newId: () => `id-${++n}` });
  assert.equal(plan.outcome, "created");
  const row = plan.writes[0].row;
  assert.deepEqual(row.coverage_periods, [
    { start: "2026-10-16", end: "2026-10-19", startTime: "16:00", endTime: "07:00" },
    { start: "2026-11-12", end: "2026-11-18" },
  ]);
  assert.deepEqual(row.custom_fields, { "Coverage block not filed": "Dec 10, 4:00 PM to Dec 9, 7:00 AM (ends before it starts)" });
});

// ── 3. What a block bills as, said under it ─────────────────────

test("a block's call days, said the way the Contracts form shows them", () => {
  assert.equal(blockSummary({ start: "2026-11-12", end: "2026-11-18" }), "7 call days: Nov 12 to Nov 18");
  assert.equal(blockSummary({ start: "2026-11-12", startTime: "06:00", end: "2026-11-18", endTime: "06:00" }), "Nov 12, 6:00 AM to Nov 18, 6:00 AM \u{b7} 6 call days: Nov 12 to Nov 17");
  assert.equal(blockSummary(TIMED_PERIOD), "Oct 16, 4:00 PM to Oct 19, 7:00 AM \u{b7} 3 call days: Oct 16 to Oct 18");
  assert.equal(blockSummary({ start: "2026-11-12", end: "" }), "1 call day: Nov 12");
  assert.equal(blockSummary({ start: "2026-10-16", startTime: "16:00", end: "2026-10-16", endTime: "07:00" }), "");
  assert.equal(blockSummary({ start: "", end: "2026-10-16" }), "");
});
