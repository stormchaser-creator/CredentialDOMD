/**
 * Where the schedule says the physician is working right now, and the
 * "Logging against" pick remembered on this device.
 *
 * The schedule is the Sched. calendar (data.scheduleDays): days entered by
 * hand, loaded from contract dates, or synced from CallSync. Each row names a
 * date and a contract; a vacation row names neither. "Today" is the call day
 * in progress for that row's own contract (billing.js currentCallDay: the
 * 7 AM rule, the contract's own start hour, or its timed coverage blocks),
 * the same boundary every work entry is filed under. At 3 AM the physician is
 * still on the previous day's call, so the previous day's row is the one that
 * counts.
 *
 * Pure: no React, no storage. Unit-tested by tests/work-log-schedule-default.test.mjs
 * and tests/work-log-schedule-default-review.test.mjs.
 */
import { currentCallDay, localDate } from "./billing.js";
import { pickableContracts, coversDate, specificity } from "./contractsForDate.js";

// A call row covers the whole call day (the call runs from one day's start
// hour to the next); a day row covers only the working day inside it.
const KIND_ORDER = { "day+call": 0, call: 0, day: 1 };
const kindRank = (kind) => KIND_ORDER[kind] ?? 1;
const mergeKinds = (a, b) => {
  if (!a) return b || "";
  if (!b || a === b) return a;
  const all = `${a} ${b}`;
  return all.includes("day") && all.includes("call") ? "day+call" : a;
};

/**
 * The contracts the schedule shows for the call day in progress at `now`,
 * best first, as { id, date, kind }: kind is "day", "call" or "day+call"
 * (every row the contract has on that date, together).
 *
 * Only rows naming a live contract count: not a vacation row, not a contract
 * that was deleted, archived or ended (the pickers' own rule,
 * pickableContracts). The order never depends on the order the rows were
 * saved in unless every rule below ties:
 *  1. the call day that began first: a call still running (last night's,
 *     under its contract's 7 AM rule) outranks a contract whose call day has
 *     only just started or reached a timed block's lead-in at midnight;
 *  2. on one date, a row with call before a row with only a day, since the
 *     call covers the whole call day;
 *  3. `prefer` (the contract last used);
 *  4. a coverage block that holds the date before a contract's term
 *     (contractsForDate's specificity);
 *  5. calendar order.
 */
export function scheduledContracts(scheduleDays, contracts, now = new Date(), { prefer = "" } = {}) {
  const at = new Date(now);
  const live = new Map(pickableContracts(contracts, null, { today: localDate(at) }).map(c => [c.id, c]));
  const dayOf = new Map();
  const hits = new Map();
  (scheduleDays || []).forEach((row, order) => {
    if (!row || !row.contractId || row.kind === "vacation") return;
    const c = live.get(row.contractId);
    if (!c) return;
    if (!dayOf.has(c.id)) dayOf.set(c.id, currentCallDay(c, at));
    if (row.date !== dayOf.get(c.id)) return;
    const hit = hits.get(c.id);
    if (hit) hit.kind = mergeKinds(hit.kind, row.kind);
    else hits.set(c.id, { c, date: row.date, kind: row.kind || "", order });
  });
  const fit = (h) => (coversDate(h.c, h.date) ? specificity(h.c, h.date) : 4);
  return [...hits.values()]
    .sort((a, b) => a.date.localeCompare(b.date)
      || kindRank(a.kind) - kindRank(b.kind)
      || (a.c.id === prefer ? 0 : 1) - (b.c.id === prefer ? 0 : 1)
      || fit(a) - fit(b)
      || a.order - b.order)
    .map(h => ({ id: h.c.id, date: h.date, kind: h.kind }));
}

/** The ids of scheduledContracts, best first. */
export function scheduledContractIds(scheduleDays, contracts, now = new Date(), opts = {}) {
  return scheduledContracts(scheduleDays, contracts, now, opts).map(h => h.id);
}

/** The contract the schedule shows for the call day in progress, or "". */
export function scheduledContractId(scheduleDays, contracts, now = new Date(), opts = {}) {
  return scheduledContractIds(scheduleDays, contracts, now, opts)[0] || "";
}

/**
 * A stored "Logging against" value, read as { contractId, callDay }. The
 * device keeps two: the contract last used (BASE_KEYS.lastContract, a bare
 * id as every build has stored it, so callDay is ""), and the contract picked
 * for a call day (BASE_KEYS.contractPick, JSON with that call day).
 */
export function readContractPick(raw) {
  const none = { contractId: "", callDay: "" };
  if (raw && typeof raw === "object") return { contractId: String(raw.contractId || ""), callDay: String(raw.callDay || "") };
  const s = String(raw ?? "").trim();
  if (!s) return none;
  if (!s.startsWith("{")) return { contractId: s, callDay: "" };
  try {
    const v = JSON.parse(s);
    return { contractId: String(v?.contractId || ""), callDay: String(v?.callDay || "") };
  } catch { return none; }
}

/** What to store for a pick: a bare id when it is not tied to a call day. */
export function contractPickValue(contractId, callDay = "") {
  return callDay ? JSON.stringify({ contractId, callDay }) : String(contractId || "");
}

/** True while the pick's own call day is still the call day in progress for its contract. */
export function pickHolds(pick, contracts, now = new Date()) {
  if (!pick?.contractId || !pick.callDay) return false;
  const c = (contracts || []).find(x => x.id === pick.contractId);
  return !!c && pick.callDay === currentCallDay(c, new Date(now));
}

/** Every contract's call day in progress at `now`, as one string that changes when any of them turns over. */
export function callDaysKey(contracts, now = new Date()) {
  const at = new Date(now);
  return [currentCallDay(null, at), ...(contracts || []).map(c => currentCallDay(c, at))].join("|");
}
