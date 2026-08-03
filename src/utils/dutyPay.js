/**
 * Day-rate pay, straight from Appendix A of the group agreement.
 *
 * Two prices, and they stack:
 *
 *   A day worked      the all-in invoiced day rate ($2,060.09)
 *   A call period     the A-2 grid rate for that hospital and role
 *
 * The day rate is a BUNDLED price. Appendix A calls it "the all-in invoiced
 * day rate" and derives it as $1,615.38 clinical + $187.19 leave component +
 * $257.51 scholarly — but that decomposition is how the number was built,
 * not how it is billed, so it is not something to tick off day by day. A
 * weekday worked invoices one figure.
 *
 * Call is separate and independent: several hospitals can be covered at
 * once, each at its own grid rate, on a worked day or on its own.
 */

export const CALL_ROLES = [
  { id: "primary", label: "Primary" },
  { id: "backup", label: "Backup" },
];

/**
 * The per-hospital grid rate for a role, from the contract's own table.
 * Matching is deliberately forgiving — exact, then case-insensitive, then
 * by the parenthesized abbreviation — because a logged day stores the
 * hospital STRING, and retitling a grid row must not silently zero the
 * call pay already logged under the old title.
 */
export function gridRate(contract, hospital, role) {
  const grid = contract?.callRateGrid;
  if (!Array.isArray(grid) || !hospital) return 0;
  const norm = (s) => String(s || "").trim().toLowerCase();
  const abbrev = (s) => (String(s || "").match(/\(([^)]+)\)\s*$/) || [])[1]?.toLowerCase() || null;
  const row = grid.find(r => r.hospital === hospital)
    || grid.find(r => norm(r.hospital) === norm(hospital))
    || (abbrev(hospital) && grid.find(r => abbrev(r.hospital) === abbrev(hospital)))
    || null;
  if (!row) return 0;
  const v = role === "backup" ? row.backup : row.primary;
  return Number(v) || 0;
}

export function hospitalsFor(contract) {
  const grid = contract?.callRateGrid;
  return Array.isArray(grid) ? grid.map(r => r.hospital) : [];
}

/**
 * The call periods on a day. Several hospitals can be covered at once —
 * primary at one and backup at another — and each pays its own grid rate,
 * so this always returns a list. Days written before multi-call existed
 * carry a single hospital/role pair, which reads as a one-item list.
 */
export function callPeriodsOf(duty) {
  if (!duty) return [];
  if (Array.isArray(duty.callPeriods) && duty.callPeriods.length) {
    return duty.callPeriods.filter(p => p && p.hospital);
  }
  if (duty.callHospital) return [{ hospital: duty.callHospital, role: duty.callRole || "primary" }];
  return [];
}

/**
 * What a single duty day invoices, itemised so the physician can see why.
 * @returns {{lines: {label:string, amount:number}[], total:number}}
 */
export function dutyDayPay(contract, duty) {
  const lines = [];
  if (!contract || !duty) return { lines, total: 0 };

  // One bundled price for a day worked — not a sum of components
  const dayRate = Number(contract.dayRate)
    || (Number(contract.clinicalDayRate) || 0) + (Number(contract.scholarlyRate) || 0);
  if (duty.workedDay && dayRate > 0) {
    lines.push({ label: "Day worked", amount: dayRate });
  }
  for (const p of callPeriodsOf(duty)) {
    const role = p.role === "backup" ? "backup" : "primary";
    lines.push({
      label: `On call — ${p.hospital} (${role})`,
      amount: gridRate(contract, p.hospital, role),
    });
  }

  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { lines, total };
}

/** Plain-language summary of what a day was, for the list row. */
export function dutyLabel(duty) {
  const bits = [];
  if (duty.workedDay) bits.push("Day worked");
  for (const p of callPeriodsOf(duty)) {
    bits.push(`${p.role === "backup" ? "Backup" : "Primary"} call`);
  }
  if (!bits.length) bits.push("No duty logged");
  return bits.join(" + ");
}

/** Totals for a month, the unit this contract invoices in. */
export function summarizeDuties(contract, duties) {
  let total = 0, workedDays = 0, callPeriods = 0, dayWork = 0, callPay = 0;
  // Call pay varies fourfold across the grid, so the split by hospital and
  // role is the number worth seeing — an EMC primary night is two ARMC ones.
  const byHospital = new Map();
  for (const d of duties || []) {
    const pay = dutyDayPay(contract, d);
    total += pay.total;
    if (d.workedDay) workedDays += 1;
    for (const l of pay.lines) {
      if (l.label.startsWith("On call")) callPay += l.amount; else dayWork += l.amount;
    }
    for (const p of callPeriodsOf(d)) {
      callPeriods += 1;
      const role = p.role === "backup" ? "backup" : "primary";
      const key = `${p.hospital}|${role}`;
      const cur = byHospital.get(key) || { hospital: p.hospital, role, periods: 0, amount: 0 };
      cur.periods += 1;
      cur.amount += gridRate(contract, p.hospital, role);
      byHospital.set(key, cur);
    }
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    total: r2(total), workedDays, callPeriods, callDays: callPeriods,
    dayWork: r2(dayWork), callPay: r2(callPay),
    byHospital: [...byHospital.values()].sort((a, b) => b.amount - a.amount).map(h => ({ ...h, amount: r2(h.amount) })),
    days: (duties || []).length,
  };
}

export function monthKey(dateStr) {
  return String(dateStr || "").slice(0, 7);
}

export function monthLabel(key) {
  if (!key) return "";
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, (m || 1) - 1, 1);
  return isNaN(d) ? key : d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
