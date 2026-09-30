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
 * Pure: no React, no storage. Unit-tested by tests/work-log-schedule-default.test.mjs.
 */
import { currentCallDay, localDate } from "./billing.js";
import { pickableContracts, contractsForDate } from "./contractsForDate.js";

/**
 * The contracts the schedule shows for the call day in progress at `now`,
 * best first. Only rows naming a live contract count: not a vacation row,
 * not a contract that was deleted, archived or ended (the pickers' own rule,
 * pickableContracts). `prefer` (the contract last used) goes first when it is
 * one of them; otherwise a coverage block that holds the date outranks a
 * contract's term (contractsForDate), then calendar order.
 */
export function scheduledContractIds(scheduleDays, contracts, now = new Date(), { prefer = "" } = {}) {
  const at = new Date(now);
  const live = new Map(pickableContracts(contracts, null, { today: localDate(at) }).map(c => [c.id, c]));
  const dayOf = new Map();
  const hits = [];
  for (const row of scheduleDays || []) {
    if (!row || !row.contractId || row.kind === "vacation") continue;
    const c = live.get(row.contractId);
    if (!c || hits.some(h => h.c.id === c.id)) continue;
    if (!dayOf.has(c.id)) dayOf.set(c.id, currentCallDay(c, at));
    if (row.date === dayOf.get(c.id)) hits.push({ c, date: row.date });
  }
  if (hits.length < 2) return hits.map(h => h.c.id);
  const ranked = contractsForDate(hits.map(h => h.c), hits[0].date).ordered.map(c => c.id);
  return prefer && ranked.includes(prefer) ? [prefer, ...ranked.filter(id => id !== prefer)] : ranked;
}

/** The contract the schedule shows for the call day in progress, or "". */
export function scheduledContractId(scheduleDays, contracts, now = new Date(), opts = {}) {
  return scheduledContractIds(scheduleDays, contracts, now, opts)[0] || "";
}

/**
 * The remembered "Logging against" contract, as stored on the device:
 * { contractId, callDay }. callDay is the call day the physician picked it
 * for; "" means it is only the contract last used (every build before this
 * one stored a bare id, and so does Invoices' "Needs invoicing").
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
