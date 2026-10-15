// Immutable recovery copies are never outbound writes or ordinary backups.
// Each content-addressed entry has its own key, so two tabs cannot lose one
// another's entries by replacing a shared map. No unresolved copy is evicted.
import { getActiveUserId, localFence, localCopyCurrent } from "./storageScope.js";

export const RECOVERY_BASE = "credentialdomd-sync-recovery-v1";
export const RECOVERY_GENERATION = "credentialdomd-sync-recovery-generation";
const listeners = new Set();
const failures = new Map();
export const stableJson = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const sha256 = async text => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), x => x.toString(16).padStart(2, "0")).join("");
const prefix = accountId => `${RECOVERY_BASE}:${encodeURIComponent(accountId)}:`;
const failure = () => Object.assign(new Error("This device could not safely save recovery copies. Your existing copies have not been replaced. Free device storage and try again."), { code: "sync_recovery_unavailable" });
const changed = () => Object.assign(new Error("The account or local copy changed."), { code: "membership_account_changed" });
const notify = id => { for (const fn of listeners) { try { fn(id); } catch { /* observer only */ } } };
export const onRecoveryChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const recoveryFailureFor = id => failures.get(id) || null;
export function reportRecoveryFailure(id, message) { failures.set(id, message); notify(id); }

export function createSyncRecovery({ storage = () => globalThis.localStorage, activeAccount = getActiveUserId,
  fenceFor = localFence, copyCurrent = localCopyCurrent, digest = sha256 } = {}) {
  const guard = scope => {
    if (!scope?.accountId || activeAccount() !== scope.accountId || (fenceFor(scope.accountId) ?? null) !== scope.fence
      || !copyCurrent(scope.accountId, scope.fence) || (scope.isCurrent && !scope.isCurrent())) throw changed();
  };
  const keys = accountId => {
    const out = [], db = storage(), start = prefix(accountId);
    for (let i = 0; i < db.length; i++) { const key = db.key(i); if (key?.startsWith(start)) out.push(key); }
    return out;
  };
  function read(accountId, { fence = fenceFor(accountId) ?? null, isCurrent } = {}) {
    const scope = { accountId, fence, isCurrent }; guard(scope);
    try {
      const entries = keys(accountId).map(key => {
        const entry = JSON.parse(storage().getItem(key));
        if (entry?.schemaVersion !== 1 || entry.accountId !== accountId || typeof entry.entryId !== "string"
          || !entry.collectionKey || !entry.recordId || key !== prefix(accountId) + entry.entryId) throw failure();
        return entry;
      }).filter(entry => entry.fence === fence);
      guard(scope);
      return entries;
    } catch (err) { if (err.code === "membership_account_changed") throw err; throw failure(); }
  }
  async function preserve({ accountId, fence = fenceFor(accountId) ?? null, collectionKey, local, cloud, isCurrent }) {
    const scope = { accountId, fence, isCurrent }; guard(scope);
    try {
      // Capture both snapshots and the purge generation before any await.
      let generation = storage().getItem(RECOVERY_GENERATION);
      // Reserve the purge barrier before a hash can be outstanding. A device
      // that has never used recovery needs no new storage during sign-out;
      // it may already be full and need the ordinary cache purge to free it.
      if (generation === null) {
        generation = crypto.randomUUID();
        storage().setItem(RECOVERY_GENERATION, generation);
        if (storage().getItem(RECOVERY_GENERATION) !== generation) throw failure();
      }
      const captured = stableJson({ schemaVersion: 1, accountId, fence, collectionKey, recordId: local?.id || cloud?.id, local, cloud });
      const entryId = await digest(captured);
      guard(scope);
      if (storage().getItem(RECOVERY_GENERATION) !== generation) throw changed();
      const key = prefix(accountId) + entryId;
      const entry = JSON.stringify({ ...JSON.parse(captured), entryId });
      const before = storage().getItem(key);
      if (before !== null && before !== entry) throw failure();
      if (before === null) storage().setItem(key, entry);
      if (storage().getItem(key) !== entry) throw failure();
      guard(scope);
      if (storage().getItem(RECOVERY_GENERATION) !== generation) throw changed();
      failures.delete(accountId); notify(accountId);
      return entryId;
    } catch (err) {
      if (err.code === "membership_account_changed") throw err;
      failures.set(accountId, failure().message); notify(accountId); throw failure();
    }
  }
  function discard(accountId, entryId) {
    const entry = read(accountId).find(item => item.entryId === entryId);
    if (!entry) return false;
    storage().removeItem(prefix(accountId) + entryId);
    if (storage().getItem(prefix(accountId) + entryId) !== null) throw failure();
    notify(accountId); return true;
  }
  function purge(accountId) {
    if (storage().getItem(RECOVERY_GENERATION) === null && keys(accountId).length === 0) {
      // No preserve can be hashing without the preallocated marker above.
      failures.delete(accountId); notify(accountId); return;
    }
    // A single non-identifying generation fences pending hashes in every tab.
    // Write it before deleting any source data; refusal aborts the purge.
    const generation = crypto.randomUUID();
    storage().setItem(RECOVERY_GENERATION, generation);
    if (storage().getItem(RECOVERY_GENERATION) !== generation) throw failure();
    for (const key of keys(accountId)) storage().removeItem(key);
    if (keys(accountId).length) throw failure();
    failures.delete(accountId); notify(accountId);
  }
  return { preserveRecovery: preserve, readRecovery: read, discardRecovery: discard, purgeRecovery: purge };
}

export const { preserveRecovery, readRecovery, discardRecovery, purgeRecovery } = createSyncRecovery();
export function recoveryDownload(accountId, entryId) {
  const entries = readRecovery(accountId).filter(item => !entryId || item.entryId === entryId);
  return { type: "CredentialDOMD recovery copies", schemaVersion: 1,
    note: "Saved versions for review. This is not an automatic restore file.", entries };
}
