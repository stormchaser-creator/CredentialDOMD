// Taking back a change applied on this device while membership was being
// re-checked (limitedLaunchAccess holdForAccess), when the check then refuses
// it. Pure: plain node tests import it.
//
// A change is recorded as what it did to each record (by id), each setting
// and each other value. It is taken back only where nothing has changed it
// since: a record edited again, or a setting typed over, stays as it now is.
// Changes are taken back newest first, so an add followed by an edit of the
// same record comes out whole.

import { rebaseSetupState } from "./syncRules.js";

const same = (left, right) => left === right || JSON.stringify(left) === JSON.stringify(right);

/** What `next` changed in `before`: [{ kind, key, id?, name?, before, after, index? }]. */
export function changesBetween(before, next) {
  const changes = [];
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(next || {})])) {
    if (same(before?.[key], next?.[key])) continue;
    if (key === "settings") {
      const was = before?.settings || {}, now = next?.settings || {};
      for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (!same(was[name], now[name])) changes.push({ kind: "setting", key, name, before: was[name], after: now[name], had: Object.hasOwn(was, name) });
      }
      continue;
    }
    if (!Array.isArray(before?.[key]) && !Array.isArray(next?.[key])) {
      changes.push({ kind: "value", key, before: before?.[key], after: next?.[key], had: Object.hasOwn(before || {}, key) });
      continue;
    }
    const was = Array.isArray(before?.[key]) ? before[key] : [];
    const now = Array.isArray(next?.[key]) ? next[key] : [];
    const after = new Map(now.map(item => [item?.id, item]));
    const seen = new Set();
    was.forEach((item, index) => {
      seen.add(item?.id);
      if (!same(item, after.get(item?.id))) changes.push({ kind: "record", key, id: item?.id, before: item, after: after.get(item?.id), index });
    });
    for (const item of now) if (!seen.has(item?.id)) changes.push({ kind: "record", key, id: item?.id, before: undefined, after: item });
  }
  return changes;
}

/** `current` with `changes` taken back where nothing has touched them since; `current` itself when nothing was. */
export function revertChanges(current, changes) {
  let out = current;
  const edit = () => { if (out === current) out = { ...current }; return out; };
  for (const change of [...(changes || [])].reverse()) {
    if (change.kind === "setting") {
      const settings = out.settings || {};
      if (!same(settings[change.name], change.after)) continue;
      const nextSettings = { ...settings };
      if (change.had) nextSettings[change.name] = change.before; else delete nextSettings[change.name];
      edit().settings = nextSettings;
    } else if (change.kind === "value") {
      if (!same(out[change.key], change.after)) continue;
      if (change.had) edit()[change.key] = change.before; else delete edit()[change.key];
    } else if (change.kind === "record") {
      const list = Array.isArray(out[change.key]) ? out[change.key] : [];
      const at = list.findIndex(item => item?.id === change.id);
      if (change.after === undefined) {
        // Deleted: put back where it was, unless it is back already.
        if (at >= 0 || change.before === undefined) continue;
        const restored = [...list];
        restored.splice(Math.min(change.index ?? restored.length, restored.length), 0, change.before);
        edit()[change.key] = restored;
      } else {
        if (at < 0 || !same(list[at], change.after)) continue;
        const restored = [...list];
        if (change.before === undefined) restored.splice(at, 1); else restored[at] = change.before;
        edit()[change.key] = restored;
      }
    }
  }
  return out;
}

/**
 * What the saves this device keeps for want of a membership answer (queued
 * awaitingAccess, lib/supabase.js; the ones an answer then refused are among
 * them, marked accessRefused) do to the records a load reads back from the
 * account: a delete takes its record out, a star sets it. The account still
 * has the record, or its old star, until the save goes up, and the load's
 * merge put that back on screen, although the notice says the change stays
 * on this device: a refused delete came back, and a refused star was lost (a
 * star never stamps updatedAt, so the account's copy won the merge). Weeks
 * later a renewal then sent the delete of a record the member had been
 * looking at since. Adds and edits already survive a load (the self-heal
 * keeps the newer copy here).
 *
 * Kept settings saves are laid over the profile settings read back too. A
 * kept Setup board save (setupState, one object written whole) is laid over
 * as what it changed from the copy it was made from (its setupBase,
 * syncRules rebaseSetupState), so a newer copy from another device keeps its
 * skips and declarations. One kept without its base (an older build) is not
 * laid over at all: the account's copy is the newer one there.
 *
 * An edit queued as what it changed (lib/supabase.js editMeta: `changed`,
 * held or failed alike) is laid over the row read back by those fields alone,
 * and `edited` names it: the self-heal must not push this device's whole
 * copy over the account's, which would put back every column another device
 * changed since (review of 9484782c). Replay sends the edit as it is.
 *
 * `ops`: the account's queue as stored. Returns { data, deleted, edited }:
 * `data` is `merged` with those applied (itself when nothing was), `deleted`
 * the ids taken out, which the self-heal must not push back up either, and
 * `edited` the `${collection}:${id}` of the edits laid over.
 */
export function applyHeldQueue(merged, ops, keys) {
  const deleted = new Map(); // collection -> Set(id)
  const stars = new Map(); // collection -> Map(id -> favorite)
  const edits = new Map(); // collection -> Map(id -> { field: value })
  // Profile settings kept the same way (a save made before a page load's
  // first answer, then a reload): the profile row read back does not have
  // them yet, so they are laid over it, oldest first, as replay will send them.
  let settings = null;
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op?.awaitingAccess === true && op.op === "settings" && op.payload && typeof op.payload === "object" && !Array.isArray(op.payload)) {
      settings ??= { ...(merged?.settings || {}) };
      for (const [name, value] of Object.entries(op.payload)) {
        if (name !== "setupState") { settings[name] = value; continue; }
        if (Object.hasOwn(op, "setupBase")) settings.setupState = rebaseSetupState(settings.setupState, op.setupBase, value);
      }
      continue;
    }
    if (op?.op === "upsert" && Array.isArray(op.changed) && Array.isArray(keys) && keys.includes(op.collectionKey)
      && op.payload && typeof op.payload === "object" && typeof op.payload.id === "string" && op.payload.id) {
      if (!edits.has(op.collectionKey)) edits.set(op.collectionKey, new Map());
      const fields = edits.get(op.collectionKey).get(op.payload.id) || {};
      for (const name of op.changed) if (typeof name === "string" && Object.hasOwn(op.payload, name)) fields[name] = op.payload[name];
      edits.get(op.collectionKey).set(op.payload.id, fields);
      continue;
    }
    if (op?.awaitingAccess !== true || !Array.isArray(keys) || !keys.includes(op.collectionKey)) continue;
    const id = op.payload && typeof op.payload === "object" ? op.payload.id : op.payload;
    if (!id || typeof id !== "string") continue;
    if (op.op === "delete" || op.op === "tombstone") {
      if (!deleted.has(op.collectionKey)) deleted.set(op.collectionKey, new Set());
      deleted.get(op.collectionKey).add(id);
    } else if (op.op === "favorite") {
      if (!stars.has(op.collectionKey)) stars.set(op.collectionKey, new Map());
      stars.get(op.collectionKey).set(id, op.payload?.favorite === true);
    }
  }
  const ids = new Set([...deleted.values()].flatMap(set => [...set]));
  const edited = new Set();
  if (!deleted.size && !stars.size && !settings && !edits.size) return { data: merged, deleted: ids, edited };
  const data = { ...merged };
  if (settings) data.settings = settings;
  for (const key of new Set([...deleted.keys(), ...stars.keys(), ...edits.keys()])) {
    if (!Array.isArray(data[key])) continue;
    const gone = deleted.get(key), starred = stars.get(key), changed = edits.get(key);
    data[key] = data[key]
      .filter(item => !gone?.has(item?.id))
      .map(item => {
        let next = item;
        if (changed?.has(item?.id)) { next = { ...next, ...changed.get(item.id) }; edited.add(`${key}:${item.id}`); }
        if (starred?.has(item?.id) && (next.favorite === true) !== starred.get(item.id)) next = { ...next, favorite: starred.get(item.id) };
        return next;
      });
  }
  return { data, deleted: ids, edited };
}
