/**
 * Coverage blocks with times.
 *
 * A locum agreement states each coverage block with times: "September 25,
 * 2026 (4pm) to September 28, 2026 (7am)", "November 5, 2026 (6am) to
 * November 12, 2026 (6am)". contract.coveragePeriods (the jsonb column
 * locum_contracts.coverage_periods; no column of its own) holds one object
 * per block:
 *
 *   { start: "YYYY-MM-DD", end: "YYYY-MM-DD", startTime?: "HH:MM", endTime?: "HH:MM" }
 *
 * Times are 24-hour wall-clock times on this device's calendar, the clock
 * every call day is decided on (billing.js deriveCallDay). They are
 * optional, and they decide what `end` means:
 *
 *  - No times (every block saved before Sep 2026): `end` is the LAST CALL
 *    DAY, the call that ends the next morning at the contract's call-day
 *    start hour. That meaning is unchanged, and nothing below applies.
 *  - endTime: `end` is the literal date coverage ends, at endTime. "Sep 25
 *    (4pm) to Sep 28 (7am)" is { start: "2026-09-25", startTime: "16:00",
 *    end: "2026-09-28", endTime: "07:00" }: three call days (Sep 25, 26 and
 *    27), not four.
 *  - startTime only: coverage starts at startTime; `end` is still the last
 *    call day, whose call ends the next day at startTime.
 *
 * Inside a timed block the call day turns over at the block's endTime,
 * falling back to its startTime: a 6 AM to 6 AM block files 6:15 AM work
 * under that same day even when the contract's call day starts at 7. The
 * first call day starts at the block's start moment (4:00 PM) and the last
 * ends at its end moment (7:00 AM). Outside every timed block the contract's
 * own call-day start hour decides, as it always has.
 *
 * A call day is keyed by the calendar date its call starts on. The first
 * call day of a block is always the block's start date: a block starting
 * before the day's turnover (7:00 AM start, 5:00 PM turnover) opens with one
 * long call day rather than a short one filed under the day before.
 *
 * No imports: the email-inbound edge function copies this file (through
 * contractsForDate.js, scripts/sync-shared-app-modules.mjs).
 */

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v) => DAY_KEY.test(String(v ?? ""));
const parts = (key) => key.split("-").map(Number);
/** Epoch ms of a wall-clock minute of the day on a calendar date. */
const momentOf = (key, minute) => { const [y, m, d] = parts(key); return new Date(y, m - 1, d, Math.floor(minute / 60), minute % 60).getTime(); };
const addDays = (key, n) => { const [y, m, d] = parts(key); return ymd(new Date(y, m - 1, d + n, 12)); };

/**
 * A time as "HH:MM" (24-hour), or "" when it is not a time. Reads what an
 * agreement or a model writes: "16:00", "4pm", "4 PM", "4:00 p.m.", "(7am)",
 * "0700", "noon", "midnight".
 */
export function toClock(v) {
  if (v == null) return "";
  const s = String(v).trim().toLowerCase().replace(/[().]/g, "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s === "noon") return "12:00";
  if (s === "midnight") return "00:00";
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})? ?(am|pm|a|p)$/);
  if (m) {
    const h = Number(m[1]), mi = Number(m[2] || 0);
    if (h < 1 || h > 12 || mi > 59) return "";
    return `${pad((h % 12) + (m[3].startsWith("p") ? 12 : 0))}:${pad(mi)}`;
  }
  m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/) || s.match(/^(\d{2})(\d{2})$/);
  if (m) {
    const h = Number(m[1]), mi = Number(m[2]);
    return h <= 23 && mi <= 59 ? `${pad(h)}:${pad(mi)}` : "";
  }
  return "";
}

/** Minutes after midnight for a time (anything toClock reads), or null. */
export function clockMinutes(v) {
  const c = toClock(v);
  if (!c) return null;
  const [h, m] = c.split(":").map(Number);
  return h * 60 + m;
}

/** "4:00 PM" for minutes after midnight, or for a moment (Date, ISO string or epoch ms). */
export function clockLabel(v) {
  let min = v;
  if (typeof v !== "number" || v > 1440) { const d = new Date(v); min = d.getHours() * 60 + d.getMinutes(); }
  const h = Math.floor(min / 60), m = min % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

/** "Sep 25" for a moment. */
export const monthDay = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

// The call day a moment falls in when the day turns over at `turnover`
// minutes after midnight (the wall-clock rule, see billing.js deriveCallDay).
const turnoverDay = (ms, turnover) => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() >= turnover ? ymd(d) : ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12));
};

/** True when a block states a time (endTime counts only with an end date). */
export function isTimedPeriod(p) {
  if (!p || !isDay(p.start)) return false;
  return clockMinutes(p.startTime) != null || (isDay(p.end) && clockMinutes(p.endTime) != null);
}

/** True when any of the contract's blocks states a time. Without one, nothing here changes anything. */
export function hasTimedPeriods(contract) {
  return (contract?.coveragePeriods || []).some(isTimedPeriod);
}

/**
 * A timed block as moments, or null for a block without times:
 * { period, startMs, endMs, turnover (minutes after midnight), firstDay,
 * lastDay, valid }. valid is false when it ends at or before it starts; such
 * a block covers nothing (the contract form refuses to save one).
 */
export function timedBlock(p) {
  if (!isTimedPeriod(p)) return null;
  const startMin = clockMinutes(p.startTime);
  const endMin = isDay(p.end) ? clockMinutes(p.endTime) : null;
  const turnover = endMin ?? startMin;
  const startMs = momentOf(p.start, startMin ?? turnover);
  const endMs = endMin != null ? momentOf(p.end, endMin) : momentOf(addDays(isDay(p.end) ? p.end : p.start, 1), turnover);
  const firstDay = p.start;
  const last = turnoverDay(endMs - 1, turnover);
  return { period: p, startMs, endMs, turnover, firstDay, lastDay: last > firstDay ? last : firstDay, valid: endMs > startMs };
}

/** The contract's valid timed blocks, earliest start first. */
export function timedBlocks(contract) {
  return (contract?.coveragePeriods || []).map(timedBlock).filter((b) => b && b.valid).sort((a, b) => a.startMs - b.startMs);
}

/** The timed block a moment falls inside (start inclusive, end exclusive), or null. */
export function timedBlockAt(contract, at) {
  const ms = new Date(at).getTime();
  if (!Number.isFinite(ms)) return null;
  return timedBlocks(contract).find((b) => ms >= b.startMs && ms < b.endMs) || null;
}

/** The call day of a moment inside a timed block, or null when it is outside every timed block. */
export function timedCallDay(contract, at) {
  const b = timedBlockAt(contract, at);
  if (!b) return null;
  const k = turnoverDay(new Date(at).getTime(), b.turnover);
  return k < b.firstDay ? b.firstDay : k > b.lastDay ? b.lastDay : k;
}

/** The call days of a timed block, in order. */
export function blockCallDays(b) {
  const out = [];
  if (!b?.valid) return out;
  for (let k = b.firstDay, i = 0; k <= b.lastDay && i < 1000; k = addDays(k, 1), i++) out.push(k);
  return out;
}

/** The timed block whose call days include this call day, or null. */
export function blockForCallDay(contract, dayKey) {
  if (!isDay(dayKey)) return null;
  return timedBlocks(contract).find((b) => dayKey >= b.firstDay && dayKey <= b.lastDay) || null;
}

/** When one call day of a timed block runs: { startMs, endMs }. */
export function callDayWindow(b, dayKey) {
  return {
    startMs: dayKey <= b.firstDay ? b.startMs : momentOf(dayKey, b.turnover),
    endMs: dayKey >= b.lastDay ? b.endMs : momentOf(addDays(dayKey, 1), b.turnover),
  };
}

/** "call 4:00 PM Sep 25 to 7:00 AM Sep 26": the window a timed call day covers, for the invoice. */
export function callDayWindowText(b, dayKey) {
  const w = callDayWindow(b, dayKey);
  return `call ${clockLabel(w.startMs)} ${monthDay(w.startMs)} to ${clockLabel(w.endMs)} ${monthDay(w.endMs)}`;
}

/** Whether a period (timed or not) has this call day. An untimed block keeps its old meaning: start through end. */
export function periodHasCallDay(p, dayKey) {
  if (!p?.start || !dayKey) return false;
  const b = timedBlock(p);
  if (b) return b.valid && dayKey >= b.firstDay && dayKey <= b.lastDay;
  return dayKey >= p.start && dayKey <= (p.end || p.start);
}

/**
 * The calendar dates a timed block touches, { start, end }, for "is this
 * contract in force on this date" (the pickers and the schedule guard): Sep
 * 25 4:00 PM to Sep 28 7:00 AM touches Sep 25 through Sep 28; a block ending
 * at midnight does not touch the day it ends on. null for a block without
 * times (callers keep their own reading of it).
 */
export function timedSpan(p) {
  const b = timedBlock(p);
  if (!b) return null;
  if (!b.valid) return { start: p.start, end: p.start };
  return { start: ymd(new Date(b.startMs)), end: ymd(new Date(b.endMs - 1)) };
}

/** "Sep 25, 4:00 PM to Sep 28, 7:00 AM" for a timed block, or null for one without times. */
export function timedBlockLabel(p) {
  const b = timedBlock(p);
  if (!b) return null;
  return `${monthDay(b.startMs)}, ${clockLabel(b.startMs)} to ${monthDay(b.endMs)}, ${clockLabel(b.endMs)}`;
}

/**
 * How a block reads in a list: "Sep 25, 4:00 PM to Sep 28, 7:00 AM" with
 * times; without, "<start> – <end>" through formatDate (helpers.js), the way
 * the lists have always written it.
 */
export function coveragePeriodText(p, formatDate) {
  return timedBlockLabel(p) ?? `${formatDate(p.start)}${p.end && p.end !== p.start ? " \u{2013} " + formatDate(p.end) : ""}`;
}

/** A block as saved: times kept only when they read as times ("HH:MM"), so a block without times saves exactly what it always did. */
export function savedPeriod(p) {
  const { startTime, endTime, ...rest } = p || {};
  const st = toClock(startTime), et = toClock(endTime);
  return { ...rest, ...(st ? { startTime: st } : {}), ...(et ? { endTime: et } : {}) };
}

/** Why a coverage block cannot be saved (n: its number in the list), or "". */
export function periodProblem(p, n) {
  if ((toClock(p?.startTime) || toClock(p?.endTime)) && !isDay(p?.start)) return `Block ${n} has a time but no start date.`;
  if (toClock(p?.endTime) && !isDay(p?.end)) return `Block ${n} has an end time but no end date. Enter the date coverage ends.`;
  const b = timedBlock(p);
  if (b && !b.valid) return `Block ${n} ends before it starts (${timedBlockLabel(p)}). Check its dates and times.`;
  return "";
}

/**
 * Every stretch of time the contract's blocks cover, as [startMs, endMs)
 * pairs: a timed block from its start to its end moment, an untimed block
 * from its start date at `hour` to the morning after its last call day.
 */
export function coveredIntervals(contract, hour) {
  const out = [];
  for (const p of contract?.coveragePeriods || []) {
    if (!p || !isDay(p.start)) continue;
    const b = timedBlock(p);
    if (b) { if (b.valid) out.push([b.startMs, b.endMs]); continue; }
    const end = isDay(p.end) && p.end >= p.start ? p.end : p.start;
    out.push([momentOf(p.start, hour * 60), momentOf(addDays(end, 1), hour * 60)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// Milliseconds of [a, z) that no interval covers.
const uncovered = (a, z, intervals) => {
  if (!(z > a)) return 0;
  let left = z - a, at = a;
  for (const [s, e] of intervals) {
    const from = Math.max(s, at), to = Math.min(e, z);
    if (to > from) { left -= to - from; at = to; }
  }
  return Math.max(0, left);
};
const coveredAt = (t, intervals) => intervals.some(([s, e]) => t >= s && t < e);

/**
 * How a span of work filed under one of block b's call days sits against
 * the block, in milliseconds: before its start moment, inside it, after its
 * end moment. Time another block covers (two blocks back to back) counts as
 * inside, as a crossing entry always has. A zero-length span is an instant
 * and weighs 1 on the side it falls.
 */
export function spanAgainstBlock(s, en, b, intervals = []) {
  if (!(en > s)) {
    const out = !coveredAt(s, intervals);
    const before = out && s < b.startMs ? 1 : 0, after = out && s >= b.endMs ? 1 : 0;
    return { before, inside: 1 - before - after, after };
  }
  const before = s < b.startMs ? uncovered(s, Math.min(en, b.startMs), intervals) : 0;
  const after = en > b.endMs ? uncovered(Math.max(s, b.endMs), en, intervals) : 0;
  return { before, inside: en - s - before - after, after };
}
