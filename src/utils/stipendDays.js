/**
 * A stipend day billed twice (review of release/goal2, 2026-10-02).
 *
 * A stipend contract's coverage day bills its stipend with nothing logged on
 * it (billing.js computeBilling: emptyStipendDays). Such a day has no entry
 * for an invoice to list: WorkLog stamps a zero-minute CallDay marker with
 * the invoice's id instead, and the invoice's entryIds never name it. So a
 * Work log preview left open on the iPhone from before the Mac billed those
 * days (or read from an old copy) found nothing billed in its entryIds, the
 * server check it makes before Send and Copy said "free", its markers were
 * new rows the server's move guard never sees, and the account then held two
 * invoices charging the same stipends with nothing on Home or the Invoices
 * tab saying so.
 *
 * Here a call day's stipend is a thing a check can ask about by its own id
 * (stipendDayKey), answered from what proves the stipend billed: a billed row
 * of that contract filed under the day (billing.js stipendBilled's rule), or
 * an invoice with a coverage line on it. invoiceRecord.invoicesBilledTwice
 * reads the coverage lines the same way.
 *
 * Pure: no React, no DOM.
 */

import { callDayOf, coveragePartsOf } from "./billing.js";

/** The label of a stipend day's money line on an invoice (billing.js computeBilling). */
export const COVERAGE_LINE_LABEL = "On-call coverage (daily total)";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PREFIX = "stipend-day:";

/** The check id of contract `contractId`'s stipend on call day `date`. */
export const stipendDayKey = (contractId, date) => `${PREFIX}${contractId}:${date}`;

/** { contractId, date } of a stipendDayKey, or null for any other id. */
export function parseStipendDayKey(id) {
  const s = String(id ?? "");
  if (!s.startsWith(PREFIX)) return null;
  const rest = s.slice(PREFIX.length);
  const at = rest.lastIndexOf(":");
  if (at <= 0) return null;
  const date = rest.slice(at + 1);
  return DAY.test(date) ? { contractId: rest.slice(0, at), date } : null;
}

/** The call days whose stipend invoice `inv` charges: the dates of its coverage lines with money on them. */
export function coverageDaysOf(inv) {
  const out = new Set();
  for (const line of Array.isArray(inv?.lines) ? inv.lines : []) {
    if (line && line.label === COVERAGE_LINE_LABEL && Number(line.amount) > 0 && DAY.test(String(line.date || ""))) out.add(String(line.date));
  }
  return out;
}

/**
 * The call day whose stipend billed row `e` proves billed for contract `c`,
 * or null: any row of the contract on an invoice except orientation, and
 * except work billed before a timed block's call began, which went out
 * without the stipend (billing.js stipendBilled).
 */
export function provesStipendDay(c, e) {
  if (!c || !e || !e.invoiceId || e.contractId !== c.id || e.type === "Orientation") return null;
  const parts = coveragePartsOf(c, e);
  if (parts && !parts.inside && !parts.after) return null;
  const day = callDayOf(e);
  return DAY.test(String(day || "")) ? String(day) : null;
}

/**
 * The check's items for contract `c`'s stipend days in this copy: one
 * { id: stipendDayKey, invoiceId } per call day billed by billing.js's own
 * rules (stipendBilled), from `rows` (its work log) and `invoices` (their
 * coverage lines). They sit beside the entries in a record check
 * (invoiceRecordCheck.beginRecordCheck, itemsBilledSince).
 */
export function stipendDayItems(c, rows = [], invoices = []) {
  if (!c?.id || !((c.callStipend || 0) > 0)) return [];
  const on = new Map();
  for (const e of rows || []) {
    const day = provesStipendDay(c, e);
    if (day && !on.has(day)) on.set(day, e.invoiceId);
  }
  // An invoice's coverage line counts where billing.js reads it: on an
  // invoice stamped with that day's overage (dayOverMin), so this copy never
  // calls a day billed that computeBilling would bill.
  for (const inv of invoices || []) {
    if (!inv?.id || inv.contractId !== c.id || !inv.dayOverMin) continue;
    for (const day of coverageDaysOf(inv)) if (inv.dayOverMin[day] != null && !on.has(day)) on.set(day, inv.id);
  }
  return [...on].map(([day, invoiceId]) => ({ id: stipendDayKey(c.id, day), invoiceId }));
}

/** The check ids of a Work log preview: its entries, and each call day whose stipend it charges. */
export function previewCheckIds(preview, contractId) {
  const ids = Array.isArray(preview?.entryIds) ? [...preview.entryIds] : [];
  if (!contractId) return ids;
  for (const day of coverageDaysOf(preview)) ids.push(stipendDayKey(contractId, day));
  return ids;
}

/** `ids` parted into row ids and the call days of `contractId`'s stipend keys. */
export function splitStipendDayKeys(ids, contractId) {
  const rows = [];
  const days = [];
  for (const id of ids || []) {
    const k = parseStipendDayKey(id);
    if (!k) rows.push(id);
    else if (k.contractId === String(contractId) && !days.includes(k.date)) days.push(k.date);
  }
  return { rows, days };
}

/**
 * The server's answer (lib/supabase.js readInvoiceRecordState, read with
 * `stipend`) with the call days of `days` whose stipend its rows prove billed
 * added under their stipendDayKey, named by the invoice that bills them.
 */
export function withStipendDays(res, c, days) {
  if (!res || res.error || !res.data || !c?.id) return res;
  const want = new Set(days || []);
  const billedIds = [...(res.data.billedIds || [])];
  const billedOn = { ...(res.data.billedOn || {}) };
  for (const r of res.data.stipendRows || []) {
    const day = provesStipendDay(c, r);
    if (!day || !want.has(day)) continue;
    const key = stipendDayKey(c.id, day);
    if (!billedIds.includes(key)) billedIds.push(key);
    if (!billedOn[key]) billedOn[key] = r.number || null;
  }
  return { ...res, data: { ...res.data, billedIds, billedOn } };
}

/** "days" when every id billed is a stipend day, else "entries": what a notice names. */
export const billedWhat = (ids) => {
  const list = Array.isArray(ids) ? ids : Object.keys(ids || {});
  return list.length && list.every(id => parseStipendDayKey(id)) ? "days" : "entries";
};
