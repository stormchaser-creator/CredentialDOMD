// Changes made on this device while a load was reading the account, laid over
// what that load read before it replaces the records on screen and the
// device copy. Pure: plain node tests import it.
//
// A load reads the account's tables, then the device copy, then the deletion
// ledger, and only then replaces the records in memory and writes them over
// the device copy. A save that lands after its table was read is in neither
// read, so the replace used to drop it from the screen and from the device
// copy (the account kept it; it came back on the next load). Seen every time
// the app opened: the membership answer starts a second load a moment after
// the first (AppContext, reconciledAccess), and a category or a licence made
// in that moment vanished. QA lab, 2026-09-30.
//
// What changed is taken from the records themselves: the records in memory
// when the load began against the records in memory when it replaces them
// (changesBetween), so every path that changes a record (add, edit, delete,
// star, a custom category, a revert of a refused change) is covered without
// each one keeping a journal. Each change is replayed onto what the load read:
//  - a delete takes the record out;
//  - an add puts the record in, over the account's copy if the read caught it;
//  - an edit sets only the fields it changed, so what the account changed in
//    other fields (on another device) stays. An edit stamps updatedAt; an
//    account copy newer than that edit wins, as on any load. A star never
//    stamps it, so a star is always laid over (as utils/heldChanges.js
//    applyHeldQueue does for a star kept for an answer);
//  - a record in the deletion ledger is never put back.
// A setting typed meanwhile is laid over the account's the same way.

import { changesBetween } from "./heldChanges.js";

const same = (left, right) => left === right || JSON.stringify(left) === JSON.stringify(right);
const NONE = Object.freeze({ changes: [], touches: () => false });

/**
 * The record and setting changes from `base` (the records in memory when a
 * load began) to `now` (the records in memory now). Either missing: none.
 * `touches(key, id)`: whether a record was added, edited or deleted here since.
 */
export function localChangesSince(base, now) {
  if (!base || !now || base === now) return NONE;
  const changes = changesBetween(base, now).filter(change => change.kind === "setting" || (change.kind === "record" && change.id));
  if (!changes.length) return NONE;
  const touched = new Set(changes.filter(change => change.kind === "record").map(change => `${change.key}\u0000${change.id}`));
  return { changes, touches: (key, id) => touched.has(`${key}\u0000${id}`) };
}

/**
 * `merged` (what the load read, after its own rules) with `since` (from
 * localChangesSince) replayed onto it. `gone`: the deletion ledger's ids.
 * Returns `merged` itself when there is nothing to lay over.
 */
export function rebaseLocalChanges(merged, since, gone = null) {
  const changes = since?.changes || [];
  if (!changes.length || !merged) return merged;
  const out = { ...merged };
  for (const change of changes) {
    if (change.kind === "setting") {
      const settings = { ...(out.settings || {}) };
      if (change.after === undefined) delete settings[change.name]; else settings[change.name] = change.after;
      out.settings = settings;
      continue;
    }
    const { key, id, before, after } = change;
    const list = Array.isArray(out[key]) ? [...out[key]] : [];
    const at = list.findIndex(item => item?.id === id);
    if (after === undefined) {
      if (at < 0) continue;
      list.splice(at, 1);
      out[key] = list;
      continue;
    }
    if (gone?.has?.(id)) continue;
    if (at < 0) {
      list.push(after);
      out[key] = list;
      continue;
    }
    const read = list[at];
    if (before === undefined) {
      list[at] = { ...read, ...after };
      out[key] = list;
      continue;
    }
    const fields = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
      .filter(name => !same(before?.[name], after?.[name]));
    if (!fields.length) continue;
    const readT = read?.updatedAt ? Date.parse(read.updatedAt) || 0 : 0;
    if (fields.includes("updatedAt")) {
      const localT = after?.updatedAt ? Date.parse(after.updatedAt) : 0;
      if (readT && localT && readT > localT) continue;
    }
    // The record as it was here when the load began is itself newer than
    // what the load read: an edit whose cloud write had not landed (in
    // flight, held for a membership answer, queued). The read is older than
    // the whole record, not only the fields edited since, and the self-heal,
    // which would keep the newer copy, leaves a record touched during the
    // load alone. The whole record is taken, as the self-heal takes it;
    // patched field by field, an unsynced renewal date made just before the
    // load went back to the read's.
    const beforeT = before?.updatedAt ? Date.parse(before.updatedAt) || 0 : 0;
    if (beforeT && beforeT > readT) {
      list[at] = after;
      out[key] = list;
      continue;
    }
    const patched = { ...read };
    for (const name of fields) {
      if (Object.hasOwn(after, name)) patched[name] = after[name]; else delete patched[name];
    }
    list[at] = patched;
    out[key] = list;
  }
  return out;
}
