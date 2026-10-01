// Records saved with an id the cloud can never accept, and how to repair them.
//
// Every synced table keys its rows by a uuid. Manual deduction lines were
// given "ded-<ms>-<random>" ids (DeductionMemo's own makeId), so the insert
// failed with 22P02, was queued, and failed again on every replay and every
// self-heal: the line lived in this device's cache only, never reached a
// second browser, and was lost for good at sign-out. Hospital rotations used
// the same pattern ("rot-..."). Those two now mint real uuids; this repairs the
// rows already on a device, once, before the pending-op replay and the
// self-heal push run.
//
// Pure: plain node tests import it.

import { isUuid } from "./syncRules.js";

/** The collections whose screens minted non-uuid ids. Nothing else is renamed. */
export const ID_REPAIR_COLLECTIONS = Object.freeze(["deductibles", "rotations"]);

/**
 * The cached file with every non-uuid id in ID_REPAIR_COLLECTIONS replaced by
 * `makeId()`, the edit stamped so the self-heal push sends it, and every
 * document linked to an old id relinked to the new one (the link sweep on
 * another device would otherwise unlink the attached receipt).
 *
 * Returns { blob, remapped } where remapped is [[collection, oldId, newId]].
 * The blob is returned unchanged (same object) when nothing needed repair.
 */
export function repairRecordIds(blob, makeId, now = new Date().toISOString()) {
  const remapped = [];
  if (!blob || typeof blob !== "object") return { blob, remapped };
  let out = blob;
  for (const key of ID_REPAIR_COLLECTIONS) {
    const rows = blob[key];
    if (!Array.isArray(rows) || !rows.some((r) => r?.id && !isUuid(r.id))) continue;
    out = out === blob ? { ...blob } : out;
    out[key] = rows.map((r) => {
      if (!r?.id || isUuid(r.id)) return r;
      const id = makeId();
      remapped.push([key, r.id, id]);
      return { ...r, id, updatedAt: now };
    });
  }
  if (!remapped.length) return { blob, remapped };
  const links = new Map(remapped.map(([key, from, to]) => [`${key}:${from}`, `${key}:${to}`]));
  if (Array.isArray(out.documents) && out.documents.some((d) => links.has(d?.linkedTo))) {
    out.documents = out.documents.map((d) => (links.has(d?.linkedTo) ? { ...d, linkedTo: links.get(d.linkedTo), updatedAt: now } : d));
  }
  return { blob: out, remapped };
}

const RECORD_OPS = new Set(["upsert", "favorite", "delete", "tombstone", "patch"]);
const opId = (op) => (op?.payload && typeof op.payload === "object" ? op.payload.id : op?.payload);

/**
 * The pending-op queue with the repair applied. A queued write of a renamed
 * record carries its new id; one whose record is not in the cached file (a
 * delete, a tombstone, a star) had no cloud row to reach and is dropped, as is
 * any other op in a repaired collection whose id still is not a uuid.
 */
export function repairQueuedIds(ops, remapped) {
  if (!Array.isArray(ops)) return { ops, changed: false };
  const byOld = new Map(remapped.map(([key, from, to]) => [`${key}:${from}`, to]));
  let changed = false;
  const out = [];
  for (const op of ops) {
    const id = opId(op);
    if (!RECORD_OPS.has(op?.op) || !ID_REPAIR_COLLECTIONS.includes(op.collectionKey) || !id || isUuid(id)) { out.push(op); continue; }
    changed = true;
    const to = byOld.get(`${op.collectionKey}:${id}`);
    if (to && op.op === "upsert" && op.payload && typeof op.payload === "object") {
      out.push({ ...op, payload: { ...op.payload, id: to } });
    }
  }
  return { ops: changed ? out : ops, changed };
}

/** Private notes are keyed "section:recordId": follow the rename. */
export function repairVaultKeys(vault, remapped) {
  if (!vault || typeof vault !== "object" || !remapped.length) return { vault, changed: false };
  let changed = false;
  const out = { ...vault };
  for (const [key, from, to] of remapped) {
    const old = `${key}:${from}`;
    if (Object.hasOwn(out, old)) { out[`${key}:${to}`] = out[old]; delete out[old]; changed = true; }
  }
  return { vault: changed ? out : vault, changed };
}

/**
 * Apply the repair to one account's stored copies: the cached file, the
 * pending-op queue and the private vault. The storage calls are passed in so
 * this stays testable; AppContext runs it once per load, before the replay.
 * Returns the remapped ids.
 */
export async function repairStoredIds({ readCached, saveCached, readQueue, writeQueue, readVault, writeVault, makeId, now }) {
  // The cached file is read asynchronously (it lives in IndexedDB).
  const { blob, remapped } = repairRecordIds(await readCached(), makeId, now);
  if (remapped.length) await saveCached(blob);
  const queue = repairQueuedIds(readQueue(), remapped);
  if (queue.changed) writeQueue(queue.ops);
  const vault = repairVaultKeys(readVault(), remapped);
  if (vault.changed) writeVault(vault.vault);
  return remapped;
}
