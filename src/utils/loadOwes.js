// What an account load could not finish for want of a membership answer.
//
// Every app open read the whole account twice, about 3 s apart (production
// gateway logs, 2026-10-02: 20 of 25 launches, 11 of 14 on the owner's
// iPhone): the page load's first membership answer always started a second
// full load (AppContext reconciledAccess), about 37 table reads and a second
// write of the whole device copy, although in the usual launch it did nothing
// the first had not done. The first load leaves only two things for that
// answer:
//   withheld    queued saves from an earlier session (a save that failed on a
//               weak network) that its replay left because no answer allowed
//               them yet (lib/supabase.js replayPendingOps `withheld`);
//   heldWrites  the load's own background writes (the self-heal push of
//               records only on this device, the link sweep, the settings
//               save, a file upload) kept for want of an answer and not
//               queued, or refused as read-only, here or by the server
//               (42501: an answer that later allows them, the enrollment
//               case the second load was added for).
//   lostWrites  the load's own background writes that did not land on the
//               network (bulkSync's rows that failed as transient, a file
//               upload that did, a write that threw). They are not queued:
//               only a load pushes them again.
// A write the server refused as permanent (a CHECK, a type, a column the
// table lacks: syncRules classifyWriteError) is neither: a load again sends
// it the same way and it is refused the same way, so a read again would only
// repeat on every launch for as long as the record exists (review of
// f06d9276). It is listed for the member (SyncIssuesNotice) instead.
// The answer then sends the withheld saves, and anything still queued (a
// replay: no table reads), and reads the account again only when the load
// held or lost a write, when its replay could not run, or when the account's
// deletion stamp moved or cannot be read (AppContext settleFirstAnswer).
//
// One record per load (the latest is in `ref.current`). `done` settles when
// the load ends, whichever way; `settled()` when it and the writes it began
// have. Pure: plain node tests import it.

const READ_ONLY = "membership_read_only";
const ACCOUNT_CHANGED = "membership_account_changed";

export function beginLoadOwes(ref, owner) {
  let finish = () => {};
  const done = new Promise(resolve => { finish = resolve; });
  const writes = [];
  const owes = {
    owner,
    // The load reached the end of a cloud read (records on screen from it).
    cloud: false,
    withheld: 0,
    // The replay could not run at all (the deletion ledger unread, a
    // failure), or a send it made failed: what the queue holds is neither
    // sent nor on screen.
    replayUnread: false,
    // Saves the replay left for want of any answer are shown as sent
    // (AppContext lays them over the read); the answer must then send them.
    laidOver: false,
    heldWrites: false,
    lostWrites: false,
    done,
    finish: () => finish(),
    markCloud: () => { owes.cloud = true; },
    /**
     * A replay's result (replayPendingOps), or null when the replay could
     * not run (the deletion ledger unread, a failure): then everything still
     * queued, `pending`, is owed.
     */
    noteReplay: (result, pending = 0) => {
      if (result && typeof result === "object") {
        owes.withheld = Number(result.withheld) > 0 ? Number(result.withheld) : 0;
        // A save the load's replay sent and the network failed (still queued)
        // is not in the read that followed: the screen shows the account
        // without it (a deleted record still there), as if the replay had
        // not run. One refused as permanent is not owed (above).
        owes.replayUnread = replayLeftUnsent(result);
      } else {
        owes.withheld = Number(pending) > 0 ? Number(pending) : 0;
        owes.replayUnread = owes.withheld > 0;
      }
    },
    /**
     * A replay an answer ran (AppContext replayKeptSaves), not the load's
     * own: it says what is still withheld, and nothing more. A load whose
     * replay could not run showed the read without the queue (a delete
     * already sent shows as present): only a read again puts the screen
     * right, so replayUnread stays (review of e1f4b4c9).
     */
    noteAnswerReplay: (result) => {
      if (!result || typeof result !== "object" || result.skipped === true) return;
      owes.withheld = Number(result.withheld) > 0 ? Number(result.withheld) : 0;
    },
    markLaidOver: () => { owes.laidOver = true; },
    /** A write kept on this device for want of an answer, not queued. */
    held: () => { owes.heldWrites = true; },
    /** A write that did not land and is not queued: only a load sends it again. */
    lost: () => { owes.lostWrites = true; },
    /**
     * A write the server answered and did not take (bulkSync's row, a file
     * upload), by how its error is classified: "transient" is lost, "denied"
     * (the membership refused it on the server) is held, and "permanent" is
     * neither (above).
     */
    unlanded: (kind) => {
      if (kind === "denied") owes.heldWrites = true;
      else if (kind !== "permanent") owes.lostWrites = true;
    },
    /**
     * A write that threw: refused by the membership answer it is held; one
     * for another account is nothing of this load's; anything else (the
     * network) is lost.
     */
    failed: (error) => {
      if (error?.code === READ_ONLY) owes.heldWrites = true;
      else if (error?.code !== ACCOUNT_CHANGED) owes.lostWrites = true;
    },
    track: (promise) => { writes.push(Promise.resolve(promise).catch(() => {})); },
    /** The load ended and every write it began has settled (or failed). */
    async settled() {
      await done;
      let seen = -1;
      while (seen !== writes.length) {
        seen = writes.length;
        await Promise.allSettled(writes.slice());
      }
    },
  };
  if (ref && typeof ref === "object") ref.current = owes;
  return owes;
}

/**
 * What the page load's first answer that allows changes does, from what the
 * latest load of the account left: "load" (read the account again), "replay"
 * (send the withheld saves, and whatever else is still queued: `queued`, the
 * queue's length once the load's writes settled, holds a save the load's
 * writes queued when the network failed them) or "none". A load that never
 * reached the end of a cloud read (it fell back to this device's copy) is
 * read again, as before. "replay" and "none" both read the account's
 * deletion stamp first (AppContext settleFirstAnswer).
 */
export function firstAnswerPlan(owes, ownerId, queued = 0) {
  if (!owes || owes.owner !== ownerId || !owes.cloud || owes.heldWrites || owes.lostWrites || owes.replayUnread) return "load";
  return owes.withheld > 0 || Number(queued) > 0 ? "replay" : "none";
}

/**
 * Whether a replay left a send that a read again can change: `{ failed:
 * true }` (AppContext replayKeptSaves: the stamp, the ledger or the network
 * stopped it), or a send that failed for a reason that can clear
 * (replayPendingOps `unsent`; a result without it counts every failure). A
 * send refused as permanent is not one.
 */
export function replayLeftUnsent(result) {
  if (!result || typeof result !== "object") return false;
  if (result.failed === true) return true;
  return Number(Object.hasOwn(result, "unsent") ? result.unsent : result.failed) > 0;
}

/**
 * After that replay: a save the load showed as sent (laidOver) that the
 * answer still does not allow (a scope it does not include) is not what the
 * account holds, so the account is read again.
 */
export function readAfterReplay(owes, result) {
  return !!owes?.laidOver && !!result && typeof result === "object" && result.skipped !== true && Number(result.withheld) > 0;
}

/**
 * `merged` with the saves a load's replay left for want of any answer
 * (`unanswered`, queue ids) whose record the read and this device's copy
 * both lack: a record added in an earlier session whose save never landed
 * and whose device copy write was lost with the page (iOS discarding it).
 * The answer sends them; the screen shows them meanwhile, as it shows the
 * deletes and stars held the same way (utils/heldChanges.js). Documents are
 * left to the file upload; `skip(key, id)` names any other record not to
 * show (deleted, or an invoice number the account already has).
 */
export function layWithheldSaves(merged, ops, unanswered, keys, skip = () => false) {
  if (!unanswered?.size || !Array.isArray(ops) || !Array.isArray(keys)) return merged;
  let out = merged;
  for (const op of ops) {
    if (!op || !unanswered.has(op.queueId) || op.op !== "upsert" || op.collectionKey === "documents" || !keys.includes(op.collectionKey)) continue;
    const item = op.payload;
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id) continue;
    const list = Array.isArray(out?.[op.collectionKey]) ? out[op.collectionKey] : [];
    if (list.some(x => x?.id === item.id) || skip(op.collectionKey, item.id, item)) continue;
    if (out === merged) out = { ...merged };
    out[op.collectionKey] = [...list, { ...item }];
  }
  return out;
}
