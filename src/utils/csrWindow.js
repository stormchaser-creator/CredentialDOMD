// The period a state controlled substance registration (CSR) runs on, for
// CME the registration itself requires (Delaware: 2 hours each CSR period,
// attested at CSR renewal, not at the medical license renewal).
//
// Kept apart from stateDuties.js so the CME engine (compliance.js) can read
// it: stateDuties.js imports compliance.js.
import { STATE_CSR } from "../constants/stateControlledSubstance.js";
import { localToday } from "./dateDays.js";

const pad = (n) => String(n).padStart(2, "0");
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The next expiration a fixed rule gives, on or after today, or null when
 * the rule fixes no date. { month: 12, day: 31, everyYears: 1 } on
 * 2026-11-18 is 2026-12-31; { month: 6, day: 30, everyYears: 2, years: "odd" }
 * is 2027-06-30.
 */
export function nextFixedExpiry(rule, now = new Date()) {
  const e = rule?.expires;
  if (!e || !e.month || !e.day) return null;
  const today = localToday(now);
  for (let y = now.getFullYear(); y <= now.getFullYear() + 4; y++) {
    if (e.everyYears === 2 && e.years === "odd" && y % 2 === 0) continue;
    if (e.everyYears === 2 && e.years === "even" && y % 2 !== 0) continue;
    if (e.everyYears !== 1 && e.everyYears !== 2) return null;
    if (e.everyYears === 2 && !e.years) return null;
    const d = `${y}-${pad(e.month)}-${pad(e.day)}`;
    if (d >= today) return d;
  }
  return null;
}

/**
 * The CSR period CME is counted in: { end, years, source }. `end` is the
 * expiration on the physician's own registration record when one is on file
 * and not yet passed ("record"), otherwise the next expiration the state's
 * fixed rule gives ("rule"). Null when the state has no fixed CSR cycle.
 */
export function csrCountingPeriod(state, recordExpiration, now = new Date()) {
  const rule = Object.hasOwn(STATE_CSR, state || "") ? STATE_CSR[state] : null;
  const years = rule?.expires?.everyYears;
  if (!years) return null;
  const rec = String(recordExpiration || "").slice(0, 10);
  if (ISO.test(rec) && rec >= localToday(now)) return { end: rec, years, source: "record" };
  const end = nextFixedExpiry(rule, now);
  return end ? { end, years, source: "rule" } : null;
}
