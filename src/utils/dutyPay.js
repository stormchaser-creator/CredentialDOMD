/**
 * Day-rate pay, straight from Appendix A of the group agreement.
 *
 * This contract does not pay by the hour and does not have a stipend that
 * "includes the first N hours." It pays per DAY WORKED and per ACCEPTED
 * 24-HOUR CALL PERIOD, and the two stack. A-3 spells out every combination:
 *
 *   Weekday worked                  clinical + scholarly
 *   Weekday worked + weeknight call clinical + scholarly + grid
 *   Weekend 24-hr call              grid only
 *   Federal holiday, on call        grid only
 *   Federal holiday, off            nothing (carried by the leave component)
 *
 * The scholarly fee is paid on WORKED WEEKDAYS ONLY — V4 of the agreement
 * moved it off call days, re-dividing the $60,000 educational envelope over
 * 233 worked weekdays instead of 281 duty days. It remains contingent on the
 * monthly teaching log, so it stays a checkbox rather than an assumption.
 */

export const CALL_ROLES = [
  { id: "primary", label: "Primary" },
  { id: "backup", label: "Backup" },
];

/** The per-hospital grid rate for a role, from the contract's own table. */
export function gridRate(contract, hospital, role) {
  const grid = contract?.callRateGrid;
  if (!Array.isArray(grid) || !hospital) return 0;
  const row = grid.find(r => r.hospital === hospital);
  if (!row) return 0;
  const v = role === "backup" ? row.backup : row.primary;
  return Number(v) || 0;
}

export function hospitalsFor(contract) {
  const grid = contract?.callRateGrid;
  return Array.isArray(grid) ? grid.map(r => r.hospital) : [];
}

/**
 * What a single duty day invoices, itemised so the physician can see why.
 * @returns {{lines: {label:string, amount:number}[], total:number}}
 */
export function dutyDayPay(contract, duty) {
  const lines = [];
  if (!contract || !duty) return { lines, total: 0 };

  const clinical = Number(contract.clinicalDayRate) || 0;
  const scholarly = Number(contract.scholarlyRate) || 0;

  if (duty.workedDay && clinical > 0) {
    lines.push({ label: "Clinical day (incl. leave differential)", amount: clinical });
  }
  // Worked weekdays only: a call day earns the grid rate and nothing else
  if (duty.workedDay && duty.scholarly && scholarly > 0) {
    lines.push({ label: "Faculty & scholarly activity", amount: scholarly });
  }
  if (duty.callHospital) {
    const rate = gridRate(contract, duty.callHospital, duty.callRole || "primary");
    const role = duty.callRole === "backup" ? "backup" : "primary";
    lines.push({ label: `On call — ${duty.callHospital} (${role})`, amount: rate });
  }

  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { lines, total };
}

/** Plain-language summary of what a day was, for the list row. */
export function dutyLabel(duty) {
  const bits = [];
  if (duty.workedDay) bits.push("Day worked");
  if (duty.callHospital) bits.push(`${duty.callRole === "backup" ? "Backup" : "Primary"} call`);
  if (!bits.length) bits.push("No duty logged");
  return bits.join(" + ");
}

/** Totals for a month, the unit this contract invoices in. */
export function summarizeDuties(contract, duties) {
  let total = 0, workedDays = 0, callDays = 0;
  for (const d of duties || []) {
    total += dutyDayPay(contract, d).total;
    if (d.workedDay) workedDays += 1;
    if (d.callHospital) callDays += 1;
  }
  return { total: Math.round(total * 100) / 100, workedDays, callDays, days: (duties || []).length };
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
