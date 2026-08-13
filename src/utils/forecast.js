/**
 * Billing forecast: schedule future days per contract with an expected
 * dollar amount (defaulted from what each contract has actually paid per
 * day historically), project income forward, then reconcile each month
 * against what was really billed — over- or under-estimated, by how much.
 */

const pad = (n) => String(n).padStart(2, "0");
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** date → billed dollars, from invoice line items and ANMG duty days. */
export function actualByDate(data) {
  const map = {};
  for (const inv of data.invoices || []) {
    if (inv.kind === "expenses") continue;
    for (const l of inv.lines || []) {
      if (l.amount == null || !l.date) continue;
      map[l.date] = (map[l.date] || 0) + (parseFloat(l.amount) || 0);
    }
    if (!(inv.lines || []).length && inv.periodStart) {
      // legacy invoice without lines: lump on its period start
      map[inv.periodStart] = (map[inv.periodStart] || 0) + (parseFloat(inv.totalAmount) || 0);
    }
  }
  for (const d of data.dutyDays || []) {
    // Invoiced duty days already arrived via their invoice's per-day lines —
    // counting them again doubled ANMG's July.
    if (d.invoiceId) continue;
    if (d.date && parseFloat(d.amount) > 0) map[d.date] = (map[d.date] || 0) + parseFloat(d.amount);
  }
  return map;
}

/** Per-contract average billed per worked day, from actuals; contract rates as fallback. */
export function contractDayAverage(data, contractId) {
  let sum = 0;
  const days = new Set();
  for (const inv of data.invoices || []) {
    if (inv.contractId !== contractId || inv.kind === "expenses") continue;
    for (const l of inv.lines || []) {
      if (l.amount == null || !l.date) continue;
      sum += parseFloat(l.amount) || 0;
      days.add(l.date);
    }
  }
  for (const d of data.dutyDays || []) {
    if (d.invoiceId) continue; // same dedupe as actualByDate
    if (d.contractId === contractId && parseFloat(d.amount) > 0 && d.date) {
      sum += parseFloat(d.amount);
      days.add(d.date);
    }
  }
  if (days.size > 0) return Math.round(sum / days.size);
  const c = (data.locumContracts || []).find(x => x.id === contractId);
  return parseFloat(c?.callStipend) || parseFloat(c?.dayRate) || 0;
}

/**
 * Month-by-month projection + reconciliation for a year.
 * Past months: scheduled estimate vs actual billed (delta = actual − est).
 * Future months: scheduled estimate only.
 * Projected year = actuals for past + estimates for today-forward.
 */
export function yearOutlook(scheduleDays, actuals, year, todayIso) {
  const months = [];
  let projectedYear = 0;
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${pad(m)}`;
    const sched = scheduleDays.filter(s => String(s.date || "").startsWith(key));
    const est = sched.reduce((t, s) => t + (parseFloat(s.expected) || 0), 0);
    const actual = Object.entries(actuals)
      .filter(([d]) => d.startsWith(key))
      .reduce((t, [, v]) => t + v, 0);
    const past = key < todayIso.slice(0, 7);
    const current = key === todayIso.slice(0, 7);
    // The year projection trusts reality where it exists: actuals through
    // today, estimates for days still ahead.
    if (past) projectedYear += actual;
    else if (current) {
      projectedYear += actual + sched
        .filter(s => s.date > todayIso)
        .reduce((t, s) => t + (parseFloat(s.expected) || 0), 0);
    } else projectedYear += est;
    months.push({
      key, est, actual, past: past || current,
      delta: est > 0 || actual > 0 ? actual - est : 0,
      hasData: est > 0 || actual > 0,
    });
  }
  return { months, projectedYear };
}
