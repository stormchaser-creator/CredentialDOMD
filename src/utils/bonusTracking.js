/**
 * Productivity bonus tracking for one agreement.
 *
 * An agreement can carry a wRVU target (the threshold a bonus starts at), an
 * optional period the target repeats on, and a dollar rate per wRVU. From
 * those and the RVU log this works out where the clinician stands in the
 * current period and what the bonus would be on the wRVUs logged so far.
 *
 * The wRVUs come from the RVU log (data.encounters) and nowhere else: the
 * entries saved under this agreement (encounter.contractId) whose date falls
 * in the period. Each entry counts the same way the RVUs tab and the
 * agreement summary total it: every code's wRVU times its units.
 *
 * Pure: no React, no storage, no clock of its own (the caller passes today).
 * The figure is an estimate from what was logged here. It knows nothing of
 * tiers, quality measures, caps or the employer's own count.
 */

export const BONUS_PERIODS = [
  ["annual", "Annual"],
  ["quarterly", "Quarterly"],
  ["monthly", "Monthly"],
];
const PERIOD_MONTHS = { annual: 12, quarterly: 3, monthly: 1 };
const PERIOD_NAME = { annual: "year", quarterly: "quarter", monthly: "month" };

/** The line shown with every estimated bonus. */
export const BONUS_ESTIMATE_NOTE = "Estimated bonus based on your logged wRVUs; your employer's statement is the official number.";

/** One RVU entry's wRVU: each code's wRVU times its units (the RVUs tab's own sum). */
export const encounterWRVU = (enc) => (enc?.codes || []).reduce((t, c) => t + (c.wRVU || 0) * (c.units || 1), 0);

/** A positive finite number, or null. "" / 0 / "abc" / a negative are all "not set". */
export function positiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const validBonusPeriod = (p) => (Object.hasOwn(PERIOD_MONTHS, p) ? p : null);

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, "0");
/** A real calendar date as "YYYY-MM-DD", or null ("2026-02-30" is not one). */
export function validIsoDate(value) {
  const m = typeof value === "string" && value.slice(0, 10).match(ISO);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

/**
 * The anchor moved by whole months, keeping its day of the month. A month too
 * short for that day uses its last day (an anchor on the 31st gives Feb 28 or
 * 29), and later periods go back to the anchor's own day: each is counted
 * from the anchor, never from the period before it.
 */
function addMonths(anchor, months) {
  const [y, m, d] = anchor.split("-").map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12), month = (index % 12 + 12) % 12 + 1;
  return `${year}-${pad(month)}-${pad(Math.min(d, daysInMonth(year, month)))}`;
}
function dayBefore(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * The bonus period that holds `today` ("YYYY-MM-DD", the caller's local day).
 *
 *   period + start date   periods repeat from the start date: a year, quarter
 *                         or month each, first day to the day before the next
 *                         one starts. A fiscal year is a start date of Jul 1.
 *   period, no start      the calendar year, quarter or month (anchor Jan 1).
 *   no period             one open window: from the start date when there is
 *                         one, else everything logged under the agreement.
 *
 * Returns { start, end, period, calendar, upcoming }: start and end are
 * inclusive days (null when that side is open); `calendar` says the calendar
 * default stood in for a missing start date; `upcoming` that the start date is
 * still ahead, in which case the window is the first period.
 */
export function currentBonusPeriod(contract, today) {
  const period = validBonusPeriod(contract?.bonusPeriod);
  const anchor = validIsoDate(contract?.bonusPeriodStart);
  const day = validIsoDate(today);
  if (!period) return { start: anchor, end: null, period: null, calendar: false, upcoming: Boolean(anchor && day && day < anchor) };
  const months = PERIOD_MONTHS[period];
  const base = anchor || `${(day || "2000-01-01").slice(0, 4)}-01-01`;
  if (!day || day < base) return { start: base, end: dayBefore(addMonths(base, months)), period, calendar: !anchor, upcoming: Boolean(day) };
  // The estimate from whole months can land one period late when the day of
  // the month is before the anchor's; step back until the start is not past today.
  const [by, bm] = base.split("-").map(Number), [ty, tm] = day.split("-").map(Number);
  let k = Math.floor(((ty - by) * 12 + (tm - bm)) / months);
  while (k > 0 && addMonths(base, k * months) > day) k--;
  while (addMonths(base, (k + 1) * months) <= day) k++;
  return { start: addMonths(base, k * months), end: dayBefore(addMonths(base, (k + 1) * months)), period, calendar: !anchor, upcoming: false };
}

/** Whether an entry dated `date` counts in the window (both ends inclusive). */
export function inBonusPeriod(date, window) {
  // An open window is everything under the agreement, dated or not, the same
  // total the agreement summary shows.
  if (!window.start && !window.end) return true;
  const d = validIsoDate(date);
  if (!d) return false;
  return (!window.start || d >= window.start) && (!window.end || d <= window.end);
}

// Money and wRVUs are worked in whole units so 0.1 + 0.2 never reaches a cent:
// wRVUs in hundredths, the rate in ten-thousandths of a dollar.
const hundredths = (n) => Math.round((Number(n) || 0) * 100);
const tenThousandths = (n) => Math.round((Number(n) || 0) * 10000);

/**
 * The estimated bonus in dollars, to the cent:
 *   (logged wRVUs - threshold) x rate, and $0 at or below the threshold.
 * wRVUs are taken to two decimals (as the RVU log shows them) and the rate to
 * four; a half cent rounds up. Null when the threshold or the rate is not set.
 */
export function estimatedBonus(loggedWRVU, target, rate) {
  const t = positiveNumber(target), r = positiveNumber(rate);
  if (t === null || r === null) return null;
  const over = hundredths(loggedWRVU) - hundredths(t);
  if (over <= 0) return 0;
  // hundredths x ten-thousandths = millionths of a dollar; 10,000 of them a cent.
  return Math.round((over * tenThousandths(r)) / 10000) / 100;
}

/**
 * Where one agreement stands against its bonus terms.
 *
 * status:
 *   "none"            no target and no rate: nothing to track yet
 *   "needs-target"    a rate without a target: no progress and no bonus figure
 *   "needs-rate"      a target without a rate: progress, but no bonus figure
 *   "ready"           both: progress and the estimated bonus
 *
 * logged      wRVUs logged under this agreement in the window, to two decimals
 * percent     logged / target x 100, a whole number rounded DOWN so 99.6% never
 *             reads as reached; null without a target. Can pass 100.
 * fill        0 to 1 for the bar (capped at the target)
 * remaining   wRVUs still to go to the target (0 once reached); null without one
 * over        wRVUs above the target (0 until reached); null without one
 * bonus       estimatedBonus(...), or null unless status is "ready"
 * unassigned  wRVUs in the window saved with no agreement picked: they count
 *             toward no agreement, so the card can say so
 */
export function bonusProgress(contract, encounters, today) {
  const target = positiveNumber(contract?.bonusWrvuTarget);
  const rate = positiveNumber(contract?.bonusRatePerWrvu);
  const window = currentBonusPeriod(contract, today);
  const status = target === null && rate === null ? "none" : target === null ? "needs-target" : rate === null ? "needs-rate" : "ready";
  let sum = 0, loose = 0, entries = 0;
  for (const e of encounters || []) {
    if (!inBonusPeriod(e?.date, window)) continue;
    if (e.contractId === contract?.id) { sum += encounterWRVU(e); entries++; }
    else if (!e.contractId) loose += encounterWRVU(e);
  }
  const logged = hundredths(sum) / 100;
  const out = {
    status, target, rate, window, logged, entries,
    unassigned: hundredths(loose) / 100,
    percent: null, fill: 0, remaining: null, over: null, bonus: null,
  };
  if (target !== null) {
    const diff = hundredths(logged) - hundredths(target);
    out.percent = Math.floor((hundredths(logged) * 100) / hundredths(target));
    out.fill = Math.max(0, Math.min(1, logged / target));
    out.remaining = diff >= 0 ? 0 : -diff / 100;
    out.over = diff > 0 ? diff / 100 : 0;
  }
  if (status === "ready") out.bonus = estimatedBonus(logged, target, rate);
  return out;
}

/** Whether an agreement carries any bonus term at all. */
export const hasBonusTerms = (contract) => positiveNumber(contract?.bonusWrvuTarget) !== null || positiveNumber(contract?.bonusRatePerWrvu) !== null;

/** "Jul 1, 2026 - Jun 30, 2027", "This calendar quarter (...)", "Since Jul 1, 2026", "All logged wRVUs". */
export function bonusPeriodLabel(window, formatDate = (d) => d) {
  if (!window.period) return window.start ? `Since ${formatDate(window.start)}` : "All wRVUs logged under this agreement";
  const span = `${formatDate(window.start)} to ${formatDate(window.end)}`;
  if (window.upcoming) return `First ${PERIOD_NAME[window.period]} starts ${formatDate(window.start)}`;
  return window.calendar ? `This calendar ${PERIOD_NAME[window.period]} (${span})` : `This ${PERIOD_NAME[window.period]} (${span})`;
}

/** "$1,234.50" */
export const bonusMoney = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "6,120.5" / "6,000": wRVUs to at most two decimals. */
export const bonusWRVU = (n) => (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * The bonus fields as the agreement form saves them, or a problem to show.
 * Blank means "not set" and saves as null (a NULL column), never 0.
 */
export function savedBonusTerms(form) {
  const blank = (v) => v === null || v === undefined || String(v).trim() === "";
  const out = { bonusWrvuTarget: null, bonusPeriod: null, bonusPeriodStart: null, bonusRatePerWrvu: null };
  if (!blank(form.bonusWrvuTarget)) {
    const n = positiveNumber(form.bonusWrvuTarget);
    if (n === null) return { problem: "The wRVU target must be a number above 0, or left blank." };
    out.bonusWrvuTarget = hundredths(n) / 100;
  }
  if (!blank(form.bonusRatePerWrvu)) {
    const n = positiveNumber(form.bonusRatePerWrvu);
    if (n === null) return { problem: "The $ per wRVU rate must be a number above 0, or left blank." };
    out.bonusRatePerWrvu = tenThousandths(n) / 10000;
  }
  out.bonusPeriod = validBonusPeriod(form.bonusPeriod);
  if (!blank(form.bonusPeriodStart)) {
    const d = validIsoDate(String(form.bonusPeriodStart));
    if (!d) return { problem: "The bonus period start date is not a valid date." };
    out.bonusPeriodStart = d;
  }
  return { terms: out };
}

export const BONUS_FIELDS = ["bonusWrvuTarget", "bonusPeriod", "bonusPeriodStart", "bonusRatePerWrvu"];
