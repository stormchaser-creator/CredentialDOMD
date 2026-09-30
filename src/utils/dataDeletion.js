/**
 * A server-side data deletion reaches every device of the member.
 *
 * Delete All My Data, and the deletion 7 days after a cancellation, empty the
 * account on the server and leave it OPEN (owner decision 2026-09-29): the
 * member signs in again and starts over with a blank account. Every other
 * device that member used still holds its local copy from before: the record
 * file (license and DEA numbers included), the private vault, queued writes
 * that never reached the cloud, and the device keys. Left alone, that copy is
 * shown again, and the offline queue and the self-heal push (AppContext) send
 * it straight back up, undoing the deletion.
 *
 * The server says when the data was deleted: profiles.deleted_at while the
 * account is still closed, profiles.data_deleted_at once its owner has signed
 * in and it has reopened, and the dataDeletedAt field of the sign-in receipt
 * (initialize-clerk-profile, migration 20260930020000). Each device remembers
 * the stamp it last purged for under WIPE_SEEN_KEY, which no purge removes,
 * and purges everything this account keeps on the device once per new stamp,
 * BEFORE anything is loaded, replayed or pushed.
 *
 * A purge is fenced (purgeAccountCopy): another tab of the account still
 * showing records from before it would otherwise write them straight back
 * into the cache or the write queue, and once the stamp is recorded nothing
 * would purge them again. The fence moves first, and that tab writes nothing
 * more to the local copy until it has loaded again.
 */
import { WIPE_SEEN_KEY, lsGet, lsSet, purgeForSignOut, advanceLocalFence } from "./storageScope.js";

const instant = (value) => (typeof value === "string" && value ? Date.parse(value) : NaN);

/** The later of two deletion stamps, or whichever one is usable. */
function later(a, b) {
  const ta = instant(a), tb = instant(b);
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : null;
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
}

/** When this profile row's data was last deleted by the server, or null. */
export function accountDataDeletedAt(profile) {
  if (!profile || typeof profile !== "object") return null;
  return later(profile.deleted_at, profile.data_deleted_at);
}

/**
 * Same deletion? Compared as instants: the server renders one timestamp as
 * "...789+00:00" and delete-account's reply as "...789Z". Two blanks (no
 * deletion either side) are the same; a blank and a stamp are not.
 */
export function sameDeletionStamp(a, b) {
  const blankA = a == null || a === "", blankB = b == null || b === "";
  if (blankA || blankB) return blankA && blankB;
  const ta = instant(a), tb = instant(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb;
  return a === b;
}

/** True when this device has already purged its copy for `stamp`. */
export function dataDeletionHonored(userId, stamp) {
  if (!userId || !stamp) return true;
  return sameDeletionStamp(lsGet(WIPE_SEEN_KEY, userId), stamp);
}

/**
 * The device that ran the deletion has purged already; it records the stamp
 * delete-account answered with, so its next load keeps what it writes from
 * here on instead of purging it as pre-deletion data. It moves the purge
 * fence too: a tab that loaded while the deletion was still running holds
 * records from before it, and must write none of them back.
 */
export function recordDataDeletionSeen(userId, stamp) {
  if (!userId || !Number.isFinite(instant(stamp))) return false;
  const recorded = lsSet(WIPE_SEEN_KEY, stamp, userId);
  advanceLocalFence(userId);
  return recorded;
}

/**
 * Purge everything this account keeps on the device, fenced: the purge fence
 * moves FIRST (src/utils/storageScope.js LOCAL_FENCE_KEY), so every other tab
 * of this account on this device stops writing its copy back (cache, write
 * queue, vault, device keys) before the copy is removed, and cannot refill
 * it afterwards. `sourceSubject` is a continuity account's bound development
 * identity, whose old namespace holds the same member's pre-deletion copy.
 * Throws continuity_retirement_unavailable, like purgeForSignOut, when the
 * recovery barrier cannot be saved.
 */
export async function purgeAccountCopy(userId, { sourceSubject = null } = {}) {
  if (!userId) return;
  const fenced = advanceLocalFence(userId);
  await purgeForSignOut(userId);
  if (sourceSubject && sourceSubject !== userId) await purgeForSignOut(sourceSubject);
  // Storage was too full to take the marker before the purge freed it.
  if (!fenced) advanceLocalFence(userId);
}

/**
 * Drop everything this account keeps on the device when `stamp` is a
 * deletion it has not purged for yet: the record file, the private vault, the
 * Assistant transcript, timers, queued writes, the offline identity, the
 * membership answer and the device keys (AI keys and the portal-password lock
 * code), and retire any unfinished development-to-production recovery so the
 * old copy cannot be copied back. `sourceSubject` is the bound development
 * identity of a continuity account (from the authenticated binding only):
 * its old namespace holds the same member's pre-deletion copy and goes too.
 *
 * Returns true when it purged. Throws continuity_retirement_unavailable when
 * the recovery barrier cannot be saved; nothing is removed then, and the
 * caller must stop rather than load.
 */
export async function honorAccountDataDeletion(userId, stamp, { sourceSubject = null } = {}) {
  if (!userId || !stamp || dataDeletionHonored(userId, stamp)) return false;
  await purgeAccountCopy(userId, { sourceSubject });
  lsSet(WIPE_SEEN_KEY, stamp, userId);
  return true;
}
