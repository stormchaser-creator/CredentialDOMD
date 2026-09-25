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

// No dedicated column for this yet — it rides in customFields like every
// other extra property (see splitFields in utils/assistant.js), so
// archiving a contract needs no schema change.
export function isArchived(contract) {
  return !!contract?.customFields?.archivedAt;
}

/** Contracts selectable for NEW logging — archived ones stay out of the
 *  picker unless already selected, so an old entry doesn't lose its label. */
export function selectableContracts(contracts, currentId) {
  return (contracts || []).filter(c => !isArchived(c) || c.id === currentId);
}

/** "Jul 2026 to Jun 2029", for telling two agreements at one facility apart. */
export function termLabel(contract) {
  const from = contract?.startDate || contract?.termStart;
  const to = contract?.endDate || contract?.termEnd;
  const fmt = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "";
  return from ? `${fmt(from)} to ${to ? fmt(to) : "open"}` : "";
}

// ── Ended contracts ─────────────────────────────────────────────
//
// A contract whose last day passed more than ENDED_AFTER_DAYS ago drops out
// of the pickers on its own (ticket 8360f6e6: the fellowship that ended in
// June kept appearing). It is still listed under Work > Agreements, a
// "Show ended contracts" choice brings it back into any picker, and a picker
// always keeps the contract already selected and any contract in force on
// the date being logged.
export const ENDED_AFTER_DAYS = 30;
export const SHOW_ENDED = "__show_ended__";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Today on this device's calendar, YYYY-MM-DD. */
export const todayLocal = () => ymd(new Date());

const termBounds = (c) => {
  const starts = [c?.startDate, c?.termStart, ...(c?.coveragePeriods || []).map(p => p?.start)].filter(Boolean).sort();
  const ends = [c?.endDate, c?.termEnd, ...(c?.coveragePeriods || []).map(p => p?.end || p?.start)].filter(Boolean).sort();
  return { start: starts[0] || "", end: ends[ends.length - 1] || "" };
};

/** The contract's last day in force (the latest of its end date, term end and coverage blocks), or "" when open-ended. */
export function contractEndDate(contract) {
  return termBounds(contract).end;
}

/** True when the contract ended more than ENDED_AFTER_DAYS before `today`. */
export function isEnded(contract, today = todayLocal()) {
  const end = contractEndDate(contract);
  if (!end || !today) return false;
  const [y, m, d] = today.split("-").map(Number);
  return end < ymd(new Date(y, m - 1, d - ENDED_AFTER_DAYS));
}

/** Whether the date falls anywhere in the contract's overall term (first start to last end), coverage gaps included. */
export function termCovers(contract, date) {
  if (!contract || !date) return false;
  const { start, end } = termBounds(contract);
  return !!start && date >= start && (!end || date <= end);
}

/**
 * Contracts to offer in a picker: not archived, and not ended unless
 * `showEnded`, the contract is `currentId`, or its term covers `date`.
 */
export function pickableContracts(contracts, currentId, { showEnded = false, date = "", today = todayLocal() } = {}) {
  return (contracts || []).filter(c => c.id === currentId
    || (!isArchived(c) && (showEnded || !isEnded(c, today) || (date && termCovers(c, date)))));
}

/** How many ended contracts a picker is hiding (0 once "Show ended contracts" is on). */
export function hiddenEndedCount(contracts, currentId, opts = {}) {
  if (opts.showEnded) return 0;
  const shown = new Set(pickableContracts(contracts, currentId, opts).map(c => c.id));
  return (contracts || []).filter(c => !isArchived(c) && !shown.has(c.id)).length;
}

// ── Agencies ────────────────────────────────────────────────────
//
// One agency often appears under two spellings ("MPLT Healthcare" and "MPLT
// Healthcare, LLC."). Stored names are never rewritten; lists and matching
// compare on this key instead.
const AGENCY_SUFFIXES = new Set(["llc", "inc", "incorporated", "ltd", "corp", "corporation", "co", "llp", "pllc", "pc", "lp"]);

/** Case-, punctuation- and company-suffix-insensitive key for an agency name. */
export function agencyKey(name) {
  const words = String(name || "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,'\u{2019}]/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim().split(" ").filter(Boolean);
  while (words.length > 1 && AGENCY_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/** True when two agency names are the same agency. */
export function sameAgency(a, b) {
  const ka = agencyKey(a);
  return !!ka && ka === agencyKey(b);
}

// Newest first: the contract created last carries the spelling to show.
const recency = (c) => `${c?.createdAt || "9999"}|${c?.endDate || c?.termEnd || ""}`;

/**
 * The agencies to offer as chips: one per agency, from contracts that are
 * neither archived nor ended, spelled as on the most recently created of
 * them, most recent first. `extra` names (an unbilled expense's agency, say)
 * are appended when no listed agency matches them.
 */
export function agencyOptions(contracts, { extra = [], today = todayLocal() } = {}) {
  const byKey = new Map();
  for (const c of pickableContracts(contracts, null, { today })) {
    const name = String(c.agency || "").trim();
    const key = agencyKey(name);
    if (!key) continue;
    const cur = byKey.get(key);
    if (!cur || recency(c) > cur.rank) byKey.set(key, { name, rank: recency(c) });
  }
  const list = [...byKey.values()].sort((a, b) => b.rank.localeCompare(a.rank)).map(x => x.name);
  for (const n of extra) {
    const name = String(n || "").trim();
    if (name && !list.some(x => sameAgency(x, name))) list.push(name);
  }
  return list;
}

/**
 * The agency to assume for an expense dated `date`: the one on the contract
 * in force that day (a coverage block first, then the shortest term), spelled
 * the way the chips spell it. "" when no contract with an agency covers it.
 */
export function agencyForDate(contracts, date, { today = todayLocal() } = {}) {
  if (!date) return "";
  const inForce = (contracts || [])
    .filter(c => !isArchived(c) && agencyKey(c.agency) && termCovers(c, date))
    .sort((a, b) => specificity(a, date) - specificity(b, date)
      || termBounds(b).start.localeCompare(termBounds(a).start));
  const hit = inForce[0];
  if (!hit) return "";
  return agencyOptions(contracts, { today }).find(n => sameAgency(n, hit.agency)) || String(hit.agency).trim();
}

/** The picker choice that reveals ended contracts. */
export const showEndedLabel = (n) => `Show ended contracts (${n})`;
