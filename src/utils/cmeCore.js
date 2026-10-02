// The counting primitives the physician engine (compliance.js) and the PA
// and NP engine (appCompliance.js) share: one date parse, one window
// predicate, one rounding, one topic reader. Moved here unchanged from
// compliance.js, which re-exports every name, so the two engines can never
// count a boundary day or a fraction of an hour differently.

export const MATE_TOPICS = ["Opioid Prescribing", "Substance Use Disorders"];
export const MATE_HOURS = 8;

/**
 * A CME entry's topics as a list. Vera could store them as one string
 * ("Pain Management"), and `(c.topics || []).some` threw on every launch,
 * so a row already saved that way is read as its comma-separated tags.
 */
export function cmeTopics(c) {
  const t = c?.topics;
  if (Array.isArray(t)) return t.filter(x => typeof x === "string");
  return typeof t === "string" ? t.split(/[,;]/).map(x => x.trim()).filter(Boolean) : [];
}

export const MS_PER_DAY = 86400000;

// Parse a date at LOCAL midnight. A bare "YYYY-MM-DD" otherwise parses as UTC
// midnight, which in US time zones lands the evening BEFORE and drops an entry
// dated on the first day of the cycle. Every window bound, the expiration
// anchor, the cycle-start override and each logged entry go through this, so
// the boundary day (window start and window end) is in-cycle.
export function parseLocalDate(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(s.length === 10 ? s + "T00:00:00" : s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Which side of a renewal window an entry falls on, by the same local-midnight
 * parse the engine counts with:
 *   "in"       counted toward the cycle (both boundary days included)
 *   "before"   dated before the window opened
 *   "after"    dated after the window closed
 *   "undated"  no usable date; never counted anywhere
 * The engine's own in-window test, the transcript PDF's entry list and the
 * desk-width CME table all route through this, so the hours a compliance card
 * shows, the rows a transcript prints and the in-window subtotal on the CME
 * page are one number from one predicate.
 */
export function cycleBucket(entry, start, end) {
  const d = parseLocalDate(entry?.date);
  if (!d) return "undated";
  if (d < start) return "before";
  if (d > end) return "after";
  return "in";
}

export function inWindow(entry, start, end) {
  return cycleBucket(entry, start, end) === "in";
}

/**
 * Entries split the way the engine counts them: `inWin` (counted) and
 * `outWin`, each tagged with its `_bucket` ("before", "after", "undated").
 * Home's CME math modal lists from this so an entry dated on the window's
 * first day is counted there as it is in the total (it used to parse the date
 * as UTC midnight and list it as outside the window in US time zones).
 */
export function splitByCycle(entries, start, end) {
  const inWin = [], outWin = [];
  for (const c of entries || []) {
    const b = cycleBucket(c, start, end);
    if (b === "in") inWin.push(c); else outWin.push({ ...c, _bucket: b });
  }
  return { inWin, outWin };
}

// Whole months from `a` to `b`. Used only for state first-cycle rules, whose
// tiers are written in months ("issued 12 to 18 months before expiration").
export function wholeMonthsBetween(a, b) {
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m -= 1;
  return m;
}

export const showDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * Plain-English periodicity for one topic mandate.
 *
 * A physician looking at "12 hrs Pain Management" cannot tell a one-time
 * career requirement from something owed at every renewal, and reading it the
 * wrong way costs either 12 needless hours or a failed audit. Every surface
 * that shows a topic row prints this, so the answer is never left implicit.
 */
export function topicPeriodLabel(period, cycleYears) {
  if (period === "lifetime") return "One time, not every cycle";
  if (period && typeof period === "object" && period.years > 0) {
    if (period.fromToday) return period.years === 1 ? "Within the 12 months before today" : `Within the ${period.years} years before today`;
    const every = period.years === 1 ? "Every year" : `Every ${period.years} years`;
    // A fixed due date (New York prescriber training) names the due date
    // whose period is counted, and the one after it.
    const due = period.due ? parseLocalDate(period.due) : null;
    const next = period.next ? parseLocalDate(period.next) : null;
    if (due && next) return `${every}; counting the period due ${showDate(due)}, next due ${showDate(next)}`;
    return due ? `${every}, next due ${showDate(due)}` : every;
  }
  return cycleYears > 0
    ? `Every renewal cycle (${cycleYears} yr${cycleYears === 1 ? "" : "s"})`
    : "Every renewal cycle";
}

/**
 * Hours to hundredths. Every sum of CME hours is rounded where it is made,
 * before any comparison: 0.1 + 0.2 summed to 0.30000000000000004 on the
 * cards, and 0.7 + 0.2 + 0.1 of a one-hour topic came to 0.9999999999999999
 * and read as unmet.
 */
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

