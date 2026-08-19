/**
 * Which agreement is in force on a given day.
 *
 * A physician can hold two contracts at one facility (a prior term and the
 * current one) and several contracts at once. Picking `contracts[0]` sent
 * August work to a contract that ended in June, so every place that needs
 * "where was I that day" uses this instead.
 *
 * Ranking, most specific first:
 *   0  an explicit coverage block containing the date (a real booking)
 *   1  a short term containing it (under ~2 months: a locums assignment)
 *   2  a long term containing it (a multi-year agreement, weak evidence)
 *   3  dates on file are incomplete
 */
const periodsOf = (c) =>
  (c?.coveragePeriods?.length
    ? c.coveragePeriods
    : [{ start: c?.startDate || c?.termStart, end: c?.endDate || c?.termEnd }]);

export function coversDate(contract, date) {
  if (!contract || !date) return false;
  return periodsOf(contract).some(p => p?.start && date >= p.start && (!p.end || date <= p.end));
}

export function specificity(contract, date) {
  if (!contract || !date) return 3;
  const blocks = contract.coveragePeriods?.length ? contract.coveragePeriods : null;
  if (blocks && blocks.some(p => p?.start && date >= p.start && (!p.end || date <= p.end))) return 0;
  const from = contract.startDate || contract.termStart;
  const to = contract.endDate || contract.termEnd;
  if (!from || !to) return 3;
  const days = Math.round((new Date(to) - new Date(from)) / 86400000);
  return days <= 62 ? 1 : 2;
}

/** { covering (ranked), rest, ordered } for a date. */
export function contractsForDate(contracts, date) {
  const list = contracts || [];
  const covering = list.filter(c => coversDate(c, date))
    .sort((a, b) => specificity(a, date) - specificity(b, date));
  const rest = list.filter(c => !coversDate(c, date));
  return { covering, rest, ordered: [...covering, ...rest] };
}

/** The contract to assume for a date, or "" when nothing is on file. */
export function contractIdForDate(contracts, date) {
  return contractsForDate(contracts, date).covering[0]?.id || "";
}

/** "Jul 2026 to Jun 2029", for telling two agreements at one facility apart. */
export function termLabel(contract) {
  const from = contract?.startDate || contract?.termStart;
  const to = contract?.endDate || contract?.termEnd;
  const fmt = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "";
  return from ? `${fmt(from)} to ${to ? fmt(to) : "open"}` : "";
}
