// FROZEN COPY of src/utils/invoiceLayout.js at 4b65234a (2026-09-28), before
// coverage blocks could carry times. tests/billing/coverage-block-times.test.mjs
// lays out invoices from contracts WITHOUT times with it and with the live
// layout, and requires the same days, rows and totals. It reads the frozen
// engine's helpers too. Never edit it to make a test pass: it is the reference.

import { formatDate } from "../../src/utils/helpers.js";
import { plainDashes } from "../../src/utils/outgoingText.js";
import { money, invoicePayment, TEXT_RULE } from "../../src/utils/invoiceCover.js";
import { DEFAULT_CALL_DAY_START_HOUR, hourLabel, apportion } from "./legacy-billing-4b65234a.mjs";

/**
 * The invoice as its reader sees it: one block per day, each opening with
 * the date (and, on a call day, the 24-hour window it covers) and closing
 * with that day's total. Every format reads this one model: the PDF
 * (invoicePdf.js), Word and Excel (invoiceExport.js) and the plain-text
 * invoice (invoicePlainText below), so they can never disagree.
 *
 * Why it exists: a stipend day used to print as one "daily total" line with
 * its work listed underneath as "included" or "+$75.00", and nothing said
 * what a day came to or what "included" was worth (a stipend
 * invoice, Sep 2026). A call day now reads:
 *
 *   Fri, Oct 16, 2026 · call day 7:00 AM Oct 16 to 7:00 AM Oct 17
 *   24-hour call stipend   covers the first 4.00 h of work   4.00 h used of 4.00 h   $3,000.00
 *     Rounding: ...        3:30 PM–7:30 PM                    4.00 h                 in $3,000.00 stipend
 *   Callback beyond 4 h                                       1.00 h @ $300.00/hr    $300.00
 *     Call: ...            10:30 PM–10:45 PM                  0.25 h                 $75.00
 *   Total for Fri, Oct 16, 2026                                                      $4,800.00
 *
 * Presentation only. No amount is computed here: every dollar printed is a
 * line's own amount (or, for a work item, the dollars the engine already
 * stated for it, or its share of the callback's cents when those round a
 * cent off: callbackShares), and a day total is the sum of that day's money
 * lines.
 *
 * Lines come in two shapes. New lines carry the numbers they were written
 * from (billing.js, LAYOUT_LINE_FIELDS). Invoices saved before that are
 * resent from their stored lines, so the same numbers are read back out of
 * the label, detail and flag text those lines have always had. Anything that
 * does not read cleanly stays one row with its text as written.
 *
 * The invariant, enforced below: the day totals add up EXACTLY (to the cent)
 * to the invoice total, and each day's money rows add up to its day total.
 * When that cannot be shown, the invoice prints in the old flat layout
 * (Date | Item | Details | Amount) rather than print a wrong number. The one
 * everyday cause is a rate that bills fractions of a cent ($262.50/hr bills
 * $65.625 for 15 minutes): lines rounded one by one then miss the total by a
 * cent. The layout says so (fractionalCents) and the screens tell the
 * physician; rounding the lines themselves would be a pricing change.
 *
 * A line with no date is a piece of work under the dated line before it
 * ("\u{b7} <Type>: <note>", no amount of its own). Any other undated line
 * (the one-time orientation fee, stored undated from Jul 23 to Aug 3 2026)
 * belongs to no day, so it prints in a last block, "Other charges", with its
 * own total, never inside the last day's.
 */

// ── Ordering (unchanged from invoicePdf.js, where it used to live) ──

/**
 * Chronological line order, even for invoices saved before lines carried
 * _sort keys: day by day → stipend → calls by clock time (pre-7am counts
 * as end of the call day) → other work → one-time orientation last.
 */
const parseDetailTime = (detail = "") => {
  const m = String(detail || "").match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  let mins = h * 60 + parseInt(m[2], 10);
  if (mins < 7 * 60) mins += 24 * 60; // before 7am = tail of the call day
  return mins;
};
const rank = (l) =>
  !l.date ? 9
    : l.label?.startsWith("Call coverage") ? 0
      : l.label?.startsWith("Call") ? 1
        : 2;
export function sortInvoiceLines(lines = []) {
  return [...(lines || [])].sort((a, b) => {
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

// ── Text helpers ──

// Nothing printed carries an em dash (house rule; older stored lines were
// written with them), and a narrow no-break space from a browser's time
// format reads as a plain space. Otherwise text is printed as written: an
// entry's label is "<Type>: <billing note>" exactly as logged.
const clean = (s) => plainDashes(String(s ?? "").replace(/[\u{202f}\u{a0}]/gu, " "));
// Before Sep 2 2026 the engine joined an entry's type and note with an em
// dash ("Call \u{2014} note"); today it writes "Call: note". A label stored
// that way reads the way the same entry is labelled now. (A label already in
// "Type: note" form only loses a dash typed into the note, like any text.)
const cleanLabel = (s) => clean(String(s ?? "").replace(/^([^\u{2014}:\n]+?) \u{2014} /u, "$1: "));

const cents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => c / 100;

// Hours. Minutes that are a multiple of 3 are exact to two decimals (m/60 is
// 5m/300), so a quarter-hour contract such as Northfield's reads "2.50 h". On a
// contract that bills 10-minute pieces, 80 minutes would read "1.33 h", and
// 1.33 h at $300.00/hr is $399.00 against a $400.00 line; so an invoice with
// any such duration prints every duration on the clock instead ("1 h 20 min").
const offDecimal = (min) => Number.isInteger(Number(min)) && Number(min) % 3 !== 0;
const clockText = (min) => {
  const m = Number(min), h = Math.floor(m / 60), r = m % 60;
  return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
};
const MINUTE_FIELDS = ["minutes", "includedMin", "overMin", "allowanceMin", "loggedMin", "usedMin"];
/** The invoice's two hour formats: hrs "2.50 h" (the Hours column), hrsShort "4 h", "4.5 h" (inside a label). */
const hoursFormat = (clock) => ({
  hrs: (min) => (clock ? clockText(min) : `${(Number(min) / 60).toFixed(2)} h`),
  hrsShort: (min) => (clock ? clockText(min) : `${Number((Number(min) / 60).toFixed(2))} h`),
});
const num = (v) => (v == null || v === "" ? null : Number(v));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const at = (key, add = 0) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d + add, 12); };
/** "Fri, Oct 16, 2026". */
export const dayTitle = (key) => at(key).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const shortDay = (key, add) => at(key, add).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const validHour = (h) => (Number.isInteger(h) && h >= 0 && h <= 23 ? h : null);
/** "call day 7:00 AM Oct 16 to 7:00 AM Oct 17". */
export const callWindowText = (key, hour) => `call day ${hourLabel(hour)} ${shortDay(key, 0)} to ${hourLabel(hour)} ${shortDay(key, 1)}`;

// ── Reading a line: its own fields, or its stored text ──

const MONEY = String.raw`\$[\d,]+\.\d{2}`;
const SPAN = String.raw`\d{1,2}:\d{2} [AP]M\u{2013}\d{1,2}:\d{2} [AP]M`;
const NO_RATE = String.raw`(?: \(NO after-stipend rate set on this contract\)|, NO after-stipend rate set on this contract)`;
const re = (s) => new RegExp(s, "u");
const STIPEND_LABEL = /^On-call coverage(?: \(daily total\)|: daily total)$/u;
const ADDITIONAL_LABEL = /^Additional work(?: \(daily total\)|: daily total)$/u;
const STIPEND_DETAIL = re(String.raw`^(\d+)h (\d{2})m logged, first (\d+(?:\.\d+)?)h covered by the (${MONEY}) stipend(?:, (\d+)h (\d{2})m beyond(?: @ (${MONEY})/hr \(\+(${MONEY})\)|${NO_RATE}))?$`);
const EMPTY_STIPEND_DETAIL = re(String.raw`^on-call coverage(?: \u{b7} |, )no calls required$`);
const ADDITIONAL_DETAIL = re(String.raw`^stipend billed earlier \u{b7} (\d+)h (\d{2})m more logged, (?:within stipend hours|(\d+)h (\d{2})m beyond stipend hours(?: @ (${MONEY})/hr|${NO_RATE}))$`);
const TIMED_DETAIL = re(String.raw`^(?:(performed .+?) \u{b7} )?(?:(${SPAN}) \u{b7} )?(\d+) min @ (${MONEY})/hr(?: \((.+)\))?$`);
const FEE_COVERED_DETAIL = re(String.raw`^(?:(performed .+?) \u{b7} )?(?:(${SPAN}) \u{b7} )?(\d+) min(?: \(covered by orientation fee\)|, covered by orientation fee)$`);
const CONTAINER_DETAIL = re(String.raw`^(?:(${SPAN}) \u{b7} )?during (.+?), no separate charge(?: \((.+)\))?$`);
const WORK_DETAIL = re(String.raw`^(?:(${SPAN}) \u{b7} )?(\d+) min(?: \((\d+)m included, (\d+)m beyond\)|, (\d+)m included, (\d+)m beyond)?(?: \(during (.+?), already covered\)|, during (.+?), already covered)?(?: \((continue[sd] .+)\))?$`);
const toDollars = (s) => Number(String(s).replace(/[$,]/g, ""));
const hm = (h, m) => Number(h) * 60 + Number(m);
const SUB_PREFIX = "\u{b7} ";
const stripSub = (label) => (label.startsWith(SUB_PREFIX) ? label.slice(SUB_PREFIX.length) : label);

/** A stored line as the facts the layout needs. Throws when its amount is unusable. */
function factOf(line) {
  const label = line?.kind ? clean(line.label) : cleanLabel(line?.label);
  const amount = line?.amount == null || line.amount === "" ? null : Number(line.amount);
  if (amount != null && !Number.isFinite(amount)) throw Error(`line amount is not a number: ${line.amount}`);
  const base = { date: line?.date || null, label, amount, detail: clean(line?.detail), flag: clean(line?.flag) };
  return line?.kind ? factFromFields(base, line) : factFromText(base);
}

function factFromFields(base, l) {
  const time = clean(l.timeText), note = clean(l.note);
  switch (l.kind) {
    case "stipendDay":
    case "additionalDay": {
      const rate = num(l.rate) || 0, overMin = num(l.overMin) || 0;
      return {
        ...base, type: l.kind === "stipendDay" ? "stipend" : "additional",
        stipend: num(l.stipend), allowanceMin: num(l.allowanceMin), loggedMin: num(l.loggedMin), usedMin: num(l.usedMin),
        overMin, overAmount: num(l.overAmount) || 0, rate, noRate: overMin > 0 && !(rate > 0),
        dayStartHour: validHour(num(l.dayStartHour)),
      };
    }
    case "work": {
      const overMin = num(l.overMin) || 0;
      return {
        ...base, type: "work", item: stripSub(base.label), time, note, during: clean(l.during),
        minutes: num(l.minutes) || 0, includedMin: num(l.includedMin) || 0, overMin,
        overAmount: num(l.overAmount) || 0, noRate: overMin > 0 && !(num(l.rate) > 0),
      };
    }
    case "hourly":
    case "orientation":
      return { ...base, type: "timed", item: base.label, time, note, minutes: num(l.minutes) || 0, rate: num(l.rate) || 0, coveredByFee: l.coveredByFee === true, dayStartHour: validHour(num(l.dayStartHour)) };
    case "container":
      return { ...base, type: "container", item: base.label, time, note, during: clean(l.during), dayStartHour: validHour(num(l.dayStartHour)) };
    default:
      return { ...base, type: "plain", item: base.label };
  }
}

function factFromText(base) {
  const { label, detail, flag } = base;
  if (!base.date && label.startsWith(SUB_PREFIX)) {
    const item = stripSub(label);
    const m = detail.match(WORK_DETAIL);
    const plus = flag.match(re(String.raw`^\+(${MONEY})$`));
    if (!m || !(flag === "included" || flag === "no charge" || flag === "no rate set" || plus)) {
      return { ...base, type: "workText", item, beyond: !!plus || flag === "no rate set" };
    }
    const minutes = Number(m[2]);
    const inc = m[3] ?? m[5], over = m[4] ?? m[6];
    const during = m[7] ?? m[8] ?? "";
    const fact = { ...base, type: "work", item, time: m[1] || "", note: m[9] || "", during, minutes, includedMin: 0, overMin: 0, overAmount: 0, noRate: false };
    if (flag === "no charge") return during ? fact : { ...base, type: "workText", item, beyond: false };
    if (flag === "included") return { ...fact, includedMin: minutes };
    const split = inc != null ? { includedMin: Number(inc), overMin: Number(over) } : { includedMin: 0, overMin: minutes };
    return plus
      ? { ...fact, ...split, overAmount: toDollars(plus[1]) }
      : { ...fact, ...split, noRate: true };
  }
  if (base.date && STIPEND_LABEL.test(label)) {
    if (EMPTY_STIPEND_DETAIL.test(detail)) {
      return { ...base, type: "stipend", stipend: base.amount, allowanceMin: null, loggedMin: 0, usedMin: 0, overMin: 0, overAmount: 0, rate: 0, noRate: false, dayStartHour: null };
    }
    const m = detail.match(STIPEND_DETAIL);
    if (!m) return { ...base, type: "plain", item: label, callDay: true };
    const loggedMin = hm(m[1], m[2]), allowanceMin = Math.round(Number(m[3]) * 60);
    const overMin = m[5] != null ? hm(m[5], m[6]) : 0;
    const rate = m[7] ? toDollars(m[7]) : 0;
    return {
      ...base, type: "stipend", stipend: toDollars(m[4]), allowanceMin, loggedMin, usedMin: Math.min(loggedMin, allowanceMin),
      overMin, overAmount: m[8] ? toDollars(m[8]) : 0, rate, noRate: overMin > 0 && !m[7], dayStartHour: null,
    };
  }
  if (base.date && ADDITIONAL_LABEL.test(label)) {
    const m = detail.match(ADDITIONAL_DETAIL);
    if (!m) return { ...base, type: "plain", item: label, callDay: true };
    const overMin = m[3] != null ? hm(m[3], m[4]) : 0;
    return {
      ...base, type: "additional", stipend: null, allowanceMin: null, loggedMin: hm(m[1], m[2]), usedMin: null,
      overMin, overAmount: overMin > 0 ? base.amount : 0, rate: m[5] ? toDollars(m[5]) : 0, noRate: overMin > 0 && !m[5], dayStartHour: null,
    };
  }
  let m = detail.match(TIMED_DETAIL);
  if (m) return { ...base, type: "timed", item: label, note: [m[1], m[5]].filter(Boolean).join("; "), time: m[2] || "", minutes: Number(m[3]), rate: toDollars(m[4]), coveredByFee: false };
  m = detail.match(FEE_COVERED_DETAIL);
  if (m) return { ...base, type: "timed", item: label, note: m[1] || "", time: m[2] || "", minutes: Number(m[3]), rate: 0, coveredByFee: true };
  m = detail.match(CONTAINER_DETAIL);
  if (m && base.amount === 0) return { ...base, type: "container", item: label, time: m[1] || "", during: m[2], note: m[3] || "" };
  return { ...base, type: "plain", item: label };
}

// ── Rows ──
//
// A row: { level, item, time, note, hours, detail, amount, amountText, sums, tone }
//   level      0 = a money row, 1 = a piece of work under it (indented, quiet)
//   detail     when not null, the row's words span the Time and Hours columns
//   amount     a dollar figure printed in the Amount column (null: words only)
//   sums       true when the row is part of the day total
//   tone       "normal" | "included" (inside the stipend) | "quiet" (no charge)

const row = (r) => ({ level: 0, item: "", time: "", note: "", hours: "", detail: null, amount: null, amountText: "", sums: false, tone: "normal", ...r });
const moneyRow = (f, r) => row({ item: f.item ?? f.label, amount: f.amount, amountText: f.amount == null ? f.flag : money(f.amount), sums: f.amount != null, tone: f.amount === 0 ? "quiet" : "normal", ...r });

function plainRow(f, { hrs }) {
  if (f.type === "timed") {
    return moneyRow(f, f.coveredByFee
      ? { time: f.time, note: f.note, hours: hrs(f.minutes), amountText: "in orientation fee", tone: "quiet" }
      : { time: f.time, note: f.note, hours: `${hrs(f.minutes)} @ ${money(f.rate)}/hr` });
  }
  if (f.type === "container") {
    return moneyRow(f, { time: f.time, note: f.note, hours: `during ${f.during}`, amountText: "no charge", tone: "quiet" });
  }
  return moneyRow(f, { detail: f.detail || null });
}

/** A piece of work under its day line. share: this item's cents of the callback, when they were shared out (callbackShares). */
function workRow(w, stipend, { hrs }, share = null) {
  const inStipend = isNum(stipend) && stipend > 0 ? `in ${money(stipend)} stipend` : "in stipend";
  if (w.type === "workText") {
    const plus = w.flag.match(re(String.raw`^\+(${MONEY})$`));
    return row({
      level: 1, item: w.item, detail: w.detail || null,
      amount: plus ? toDollars(plus[1]) : null,
      amountText: plus ? plus[1] : w.flag === "included" ? inStipend : w.flag,
      tone: w.flag === "included" ? "included" : plus ? "normal" : "quiet",
    });
  }
  const base = { level: 1, item: w.item, time: w.time, note: w.note };
  if (w.during) return row({ ...base, hours: `during ${w.during}`, amountText: "no charge", tone: "quiet" });
  if (!(w.overMin > 0)) return row({ ...base, hours: hrs(w.minutes), amountText: inStipend, tone: "included" });
  const hours = w.includedMin > 0
    ? `${hrs(w.minutes)} (${hrs(w.includedMin)} in stipend, ${hrs(w.overMin)} beyond)`
    : hrs(w.minutes);
  if (w.noRate) return row({ ...base, hours, amountText: "no rate set", tone: "quiet" });
  const amount = share == null ? w.overAmount : fromCents(share);
  return row({ ...base, hours, amount, amountText: money(amount) });
}

/**
 * The items beyond the allowance print their own dollars under the callback
 * as its breakdown. Rounded one by one they can miss it by a cent: two
 * 10-minute calls at $250.00/hr are $41.67 each, the callback for their 20
 * minutes $83.33. Then the callback's cents are shared out by the items'
 * minutes, largest remainder first (apportion, billing.js, the rule the
 * engine uses to share out a split entry's increments), so the breakdown
 * adds up to the callback exactly. Nothing is shared when the items already
 * add up, or when they are not exactly the callback's minutes.
 */
function callbackShares(day, work) {
  const shares = new Map();
  if (!(day.overMin > 0) || day.noRate) return shares;
  const beyond = work.filter((w) => (w.type === "workText" ? w.beyond : w.overMin > 0));
  if (!beyond.length || beyond.some((w) => w.type !== "work" || w.noRate || !Number.isInteger(w.overMin))) return shares;
  if (beyond.reduce((s, w) => s + w.overMin, 0) !== day.overMin) return shares;
  const target = cents(day.overAmount);
  if (beyond.reduce((s, w) => s + cents(w.overAmount), 0) === target) return shares;
  apportion(target, beyond.map((w) => w.overMin)).forEach((c, i) => shares.set(beyond[i], c));
  return shares;
}

/** The stipend (or later-work) line split into the stipend, its work, and the callback beyond it. */
function stipendSection(day, work, ctx) {
  const { hrs, hrsShort } = ctx;
  const stipend = isNum(day.stipend) ? day.stipend : ctx.stipend;
  const allowance = isNum(day.allowanceMin) ? day.allowanceMin : ctx.allowanceMin;
  // Split only when the parts reproduce the line to the cent: the stipend
  // plus the callback is the line's amount, and the callback is its hours
  // at its rate.
  const parts = day.type === "stipend"
    ? isNum(day.stipend) && cents(day.stipend) + cents(day.overAmount) === cents(day.amount)
    : cents(day.overAmount) === cents(day.amount ?? 0);
  const callbackPriced = day.overMin > 0 && !day.noRate
    ? cents((day.overMin / 60) * day.rate) === cents(day.overAmount)
    : cents(day.overAmount) === 0;
  const splits = parts && callbackPriced;
  if (!splits) {
    // The numbers do not reconcile with the line: print it as written.
    return [moneyRow(day, { item: day.label, detail: day.detail || null }), ...work.map((w) => workRow(w, stipend, ctx))];
  }
  const rows = [];
  const allowanceText = isNum(allowance) && allowance > 0;
  if (day.type === "stipend") {
    rows.push(row({
      item: "24-hour call stipend",
      time: allowanceText ? `covers the first ${hrs(allowance)} of work` : "on-call coverage",
      hours: !(day.loggedMin > 0) ? "no work logged"
        : allowanceText ? `${hrs(Math.min(day.usedMin ?? day.loggedMin, allowance))} used of ${hrs(allowance)}`
          : `${hrs(day.loggedMin)} logged`,
      amount: day.stipend, amountText: money(day.stipend), sums: true,
    }));
  } else {
    rows.push(row({
      item: "24-hour call stipend",
      time: "billed on an earlier invoice",
      hours: allowanceText && isNum(day.usedMin) ? `${hrs(day.usedMin)} used of ${hrs(allowance)}` : `${hrs(day.loggedMin)} more logged`,
    }));
  }
  const callback = day.overMin > 0 ? row({
    item: allowanceText ? `Callback beyond ${hrsShort(allowance)}` : "Callback beyond stipend hours",
    hours: day.noRate ? `${hrs(day.overMin)}, no after-stipend rate set` : `${hrs(day.overMin)} @ ${money(day.rate)}/hr`,
    amount: day.overAmount, amountText: money(day.overAmount), sums: true, tone: day.overAmount === 0 ? "quiet" : "normal",
  }) : null;
  // Work is in the order the allowance was drawn down: everything inside
  // it, then (once an item runs past it) the callback and the rest.
  const shares = callbackShares(day, work);
  let placed = false;
  for (const w of work) {
    const beyond = w.type === "workText" ? w.beyond : w.overMin > 0;
    if (callback && !placed && beyond) { rows.push(callback); placed = true; }
    rows.push(workRow(w, stipend, ctx, shares.get(w) ?? null));
  }
  if (callback && !placed) rows.push(callback);
  return rows;
}

const TIMED_TYPES = new Set(["timed", "container", "work"]);
/** Whether a billed span ("2:00 AM–2:30 AM") starts before the call day's start hour. */
const startsBefore = (time, hour) => {
  const m = String(time || "").match(/^(\d{1,2}):(\d{2}) ([AP]M)/u);
  if (!m) return false;
  const h = (Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0);
  return h * 60 + Number(m[2]) < hour * 60;
};

/** A piece of work stored under the day line before it: "\u{b7} <label>", no amount of its own. */
const isWorkItem = (line) => String(line?.label ?? "").startsWith(SUB_PREFIX) && (line?.amount == null || line.amount === "");

/**
 * Group lines into units, a dated line and the work items stored after it,
 * and set apart every other undated line (see "Other charges" above).
 */
function unitsOf(lines) {
  const units = [], other = [];
  for (const line of lines) {
    if (line?.date) units.push({ head: line, lines: [line] });
    else if (!isWorkItem(line)) other.push(line);
    else if (units.length) units[units.length - 1].lines.push(line);
    else units.push({ head: null, lines: [line] });
  }
  return { units, other };
}
const unitOrder = (a, b) => {
  const x = a.head, y = b.head;
  const d = (x.date || "").localeCompare(y.date || "");
  if (d) return d;
  if (x._sort && y._sort) return x._sort.localeCompare(y._sort);
  const r = rank(x) - rank(y);
  if (r) return r;
  const ta = parseDetailTime(x.detail), tb = parseDetailTime(y.detail);
  return ta != null && tb != null ? ta - tb : 0;
};

/**
 * The day blocks for an invoice, or null when they cannot be shown with
 * every number adding up (the caller prints the flat layout instead).
 * inv: { lines, total | totalAmount, dayStartHour? }.
 */
export function invoiceDays(inv = {}) {
  const lines = Array.isArray(inv?.lines) ? inv.lines.filter(Boolean) : [];
  if (!lines.length) throw Error("no lines");
  const { units, other } = unitsOf(lines);
  if (!units.length) throw Error("no dated line");
  if (units[0].head === null) throw Error("lines before the first dated line");
  for (const u of units) if (!DAY_KEY.test(String(u.head.date))) throw Error(`not a day: ${u.head.date}`);
  const byDay = new Map();
  for (const u of [...units].sort(unitOrder)) {
    const k = u.head.date;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(...u.lines.map(factOf));
  }
  const otherFacts = other.map(factOf);
  const all = [...byDay.values(), otherFacts].flat();
  // One contract per invoice, so a legacy day that does not state its
  // allowance or stipend (a day with no work) reads it from one that does.
  const known = all.find((f) => (f.type === "stipend" || f.type === "additional") && isNum(f.allowanceMin) && f.allowanceMin > 0);
  const knownStipend = all.find((f) => (f.type === "stipend" || f.type === "additional") && isNum(f.stipend) && f.stipend > 0);
  const clock = all.some((f) => MINUTE_FIELDS.some((k) => offDecimal(f[k])));
  const ctx = { allowanceMin: known?.allowanceMin ?? null, stipend: knownStipend?.stipend ?? null, ...hoursFormat(clock) };
  const invoiceHour = all.find((f) => isNum(f.dayStartHour))?.dayStartHour;
  const fallbackHour = invoiceHour ?? validHour(num(inv?.dayStartHour)) ?? DEFAULT_CALL_DAY_START_HOUR;

  const days = [];
  let sum = 0;
  for (const [date, facts] of byDay) {
    const dayFacts = facts.filter((f) => f.type === "stipend" || f.type === "additional");
    if (dayFacts.length > 1) throw Error(`two daily totals on ${date}`);
    const [day] = dayFacts;
    const work = facts.filter((f) => f.type === "work" || f.type === "workText");
    const rows = facts.filter((f) => !dayFacts.includes(f) && !work.includes(f)).map((f) => plainRow(f, ctx));
    if (day) rows.push(...stipendSection(day, work, ctx));
    else rows.push(...work.map((w) => workRow(w, ctx.stipend, ctx)));
    const totalCents = facts.reduce((s, f) => s + (f.amount == null ? 0 : cents(f.amount)), 0);
    const rowCents = rows.reduce((s, r) => s + (r.sums ? cents(r.amount) : 0), 0);
    if (rowCents !== totalCents) throw Error(`rows of ${date} add to ${rowCents}, lines to ${totalCents}`);
    sum += totalCents;
    const title = dayTitle(date);
    // A call day always says its 24 hours. Any other day of logged work says
    // them only when it holds work from the small hours, which the engine
    // files under the day before (a 2:00 AM call listed under Aug 4 is the
    // morning of Aug 5).
    const hour = day?.dayStartHour ?? facts.find((f) => isNum(f.dayStartHour))?.dayStartHour ?? fallbackHour;
    const smallHours = facts.some((f) => TIMED_TYPES.has(f.type) && startsBefore(f.time, hour));
    const callDay = !!day || facts.some((f) => f.callDay) || smallHours;
    days.push({
      date, title,
      window: callDay ? callWindowText(date, hour) : "",
      rows: rows.map(cleanRow),
      total: fromCents(totalCents),
      totalLabel: `Total for ${title}`,
    });
  }
  if (otherFacts.length) {
    // Charges that belong to no day: printed as stored, undated, in a block
    // of their own after the last day, with their own total.
    const rows = otherFacts.map((f) => plainRow(f, ctx));
    const totalCents = otherFacts.reduce((s, f) => s + (f.amount == null ? 0 : cents(f.amount)), 0);
    sum += totalCents;
    days.push({ date: null, title: OTHER_TITLE, window: "", rows: rows.map(cleanRow), total: fromCents(totalCents), totalLabel: `Total for ${OTHER_TITLE.toLowerCase()}` });
  }
  const invoiceTotal = inv?.total ?? inv?.totalAmount;
  if (invoiceTotal == null || invoiceTotal === "" || !Number.isFinite(Number(invoiceTotal))) throw Error("no invoice total");
  if (sum !== cents(invoiceTotal)) {
    const err = Error(`day totals add to ${sum}, the invoice to ${cents(invoiceTotal)}`);
    err.code = "total";
    throw err;
  }
  return days;
}

/** The block that holds charges with no date. */
export const OTHER_TITLE = "Other charges";

/** Whether an amount carries a fraction of a cent ($65.625). */
const subCent = (a) => a != null && a !== "" && Number.isFinite(Number(a)) && Math.abs(Number(a) * 100 - Math.round(Number(a) * 100)) > 1e-6;
/** "$65.625", "$66.6667": an amount to the fraction of a cent it carries (at most four places). */
export const exactMoney = (a) => `$${Number(a).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

const cleanRow = (r) => ({
  ...r,
  item: clean(r.item), time: clean(r.time), note: clean(r.note), hours: clean(r.hours),
  detail: r.detail == null ? null : clean(r.detail), amountText: clean(r.amountText),
});

/** The pre-day-block table, Date | Item | Details | Amount: the fallback. */
export function flatInvoiceRows(lines = []) {
  return sortInvoiceLines(lines).map((l) => [
    l.date ? formatDate(l.date) : "",
    cleanLabel(l.label),
    clean(l.detail),
    l.amount == null ? clean(l.flag) : money(l.amount),
  ]);
}

/**
 * What every format prints: { mode: "days", days } when the day blocks add
 * up, otherwise { mode: "flat", rows, reason, fractionalCents? } (the old
 * table; fractionalCents, e.g. "$65.625", when a line's fraction of a cent is
 * why the day totals could not add up).
 */
export function invoiceLayout(inv = {}) {
  try {
    return { mode: "days", days: invoiceDays(inv) };
  } catch (err) {
    const flat = { mode: "flat", rows: flatInvoiceRows(inv?.lines || []), reason: String(err?.message || err) };
    // Day totals that miss the invoice total by rounding: say which line
    // carries the fraction of a cent, so the screen can tell the physician.
    const fraction = err?.code === "total" ? (inv?.lines || []).find((l) => subCent(l?.amount)) : null;
    return fraction ? { ...flat, fractionalCents: exactMoney(fraction.amount) } : flat;
  }
}

// ── Plain text ──

/** The itemized part of the plain-text invoice (between the two rules). */
export function invoiceItemsText(inv = {}) {
  const layout = invoiceLayout(inv);
  const out = [];
  if (layout.mode === "flat") {
    for (const l of inv.lines || []) {
      if (l.amount == null) {
        // Work item under a daily total, indented, flagged like the app
        out.push(clean(`     ${cleanLabel(l.label)} ${l.detail}${l.flag ? ` (${l.flag})` : ""}`));
        continue;
      }
      out.push(clean(`${l.date ? formatDate(l.date) + "  " : ""}${cleanLabel(l.label)}`));
      out.push(clean(`   ${l.detail ? l.detail + " = " : ""}${money(l.amount)}`));
    }
    return out;
  }
  const SEP = " \u{b7} ";
  layout.days.forEach((day, i) => {
    if (i) out.push("");
    out.push(day.window ? `${day.title}${SEP}${day.window}` : day.title);
    for (const r of day.rows) {
      const words = r.detail != null ? [r.detail] : [r.time, r.note, r.hours].filter(Boolean);
      if (r.level === 1) {
        out.push(`     ${[r.item, ...words, r.amountText].filter(Boolean).join(SEP)}`);
        continue;
      }
      out.push(r.item);
      const said = words.join(SEP);
      if (said || r.amountText) out.push(`   ${said}${said && r.amountText ? " = " : ""}${r.amountText}`);
    }
    out.push(`${day.totalLabel}: ${money(day.total)}`);
  });
  return out;
}

/**
 * The whole plain-text invoice (the Copy button, the text-only share). One
 * builder for the time engine (WorkLog) and the day-rate engine (DutyLog).
 * args: { number, physician, npi, email, facility, agency, periodStart,
 * periodEnd, terms, lines, total, paid?, balance?, dayStartHour? }.
 */
export function invoicePlainText(args = {}, { generatedOn = new Date() } = {}) {
  const out = [`INVOICE ${args.number || ""}`, TEXT_RULE];
  out.push(`From: ${args.physician || "Physician"}${args.npi ? " \u{b7} NPI " + args.npi : ""}`);
  if (args.email) out.push(`Email: ${args.email}`);
  out.push(`To: ${args.facility || ""}${args.agency ? " (via " + args.agency + ")" : ""}`);
  if (args.periodStart) out.push(`Period: ${formatDate(args.periodStart)} \u{2013} ${formatDate(args.periodEnd || args.periodStart)}`);
  if (args.terms) out.push(`Terms: ${args.terms}`);
  out.push(TEXT_RULE);
  out.push(...invoiceItemsText(args));
  out.push(TEXT_RULE);
  const pay = invoicePayment(args);
  if (pay.hasPayment) {
    out.push(`Invoice total: ${money(pay.total)}`, `Paid: ${money(pay.paid)}`, pay.settled ? "PAID IN FULL" : `BALANCE DUE: ${money(pay.balance)}`);
  } else {
    out.push(`TOTAL DUE: ${money(pay.total)}`);
  }
  out.push("", `Generated by CredentialDOMD \u{b7} ${generatedOn.toLocaleDateString()}`);
  return clean(out.join("\n"));
}
