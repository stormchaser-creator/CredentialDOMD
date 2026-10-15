// A successful save is not an unsent edit just because its device clock was
// ahead of another device. Keep hashes of exact acknowledged client copies,
// scoped to the account and its purge fence. This is deliberately a bounded
// mitigation: unknown/dirty copies keep their existing recovery path; it is
// not server-side conflict resolution. Documents have a separate upload
// lifecycle and are not marked clean here.
import { BASE_KEYS, getActiveUserId, localCopyCurrent, localFence, scopedKey, localWriteGuard, readOfflineText, writeOfflineText } from "./storageScope.js";

const MAX_RECEIPTS = 5000;
const keyFor = (collection, id) => JSON.stringify([collection, id]);
// Three bounded aliases: the submitted client shape, the normalized cloud
// shape, and one known-clean local shape a load or the debounced cache may
// still hold after a newer successful save.
const aliases = value => typeof value === "string" ? { client: value }
  : Object.fromEntries(["client", "cloud", "cached"].filter(key => typeof value?.[key] === "string").map(key => [key, value[key]]));
const matches = (value, hash) => Object.values(aliases(value)).includes(hash);
const details = value => ({ ...aliases(value), ...(typeof value?.cloudVersion === "string" ? { cloudVersion: value.cloudVersion } : {}), ...(typeof value?.clientVersion === "string" ? { clientVersion: value.clientVersion } : {}) });
const sameReceipt = (a, b) => JSON.stringify(details(a)) === JSON.stringify(details(b));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const sha256 = async (text) => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, "0")).join("");

export function createRecordAcknowledgements({ activeAccount, fenceFor, copyCurrent, read, write, guardFor = () => null, digest = sha256, receiptBase = BASE_KEYS.recordAcknowledgements, queueBase = BASE_KEYS.pendingOps }) {
  const current = (scope, extra) => {
    try {
      return !!scope?.accountId && activeAccount() === scope.accountId
        && (fenceFor(scope.accountId) ?? null) === scope.fence
        && copyCurrent(scope.accountId, scope.fence) && (!scope.guard || scope.guard()) && (!extra || extra());
    } catch { return false; }
  };
  async function receipts(scope) {
    const raw = await read(receiptBase, scope.accountId);
    if (!current(scope)) throw Error("Stale receipt read");
    if (raw == null) return {};
    const parsed = JSON.parse(raw);
    return parsed?.version === 1 && parsed.fence === scope.fence && parsed.records && typeof parsed.records === "object" && !Array.isArray(parsed.records) ? parsed.records : {};
  }
  function queued(scope) {
    const raw = read(queueBase, scope.accountId);
    const ops = raw == null ? [] : JSON.parse(raw);
    if (!Array.isArray(ops)) throw Error("Unreadable pending writes");
    return new Set(ops.filter(op => op && op.collectionKey && op.op !== "settings")
      .map(op => keyFor(op.collectionKey, typeof op.payload === "object" ? op.payload?.id : op.payload)));
  }
  function capture({ accountId, fence = fenceFor(accountId) ?? null, collectionKey, item, guard = guardFor(accountId) }) {
    if (!item?.id || !collectionKey || collectionKey === "documents") return null;
    const scope = { accountId, fence: fence ?? null, guard };
    if (!current(scope)) return null;
    try {
      return Object.freeze({ ...scope, key: keyFor(collectionKey, item.id), snapshot: JSON.stringify(canonical(item)) });
    } catch { return null; }
  }
  // Acknowledgements remain optional, but concurrent local completions must
  // not overwrite each other's receipts while IndexedDB is awaiting I/O.
  const commits = new Map();
  function serialize(scope, operation) {
    const before = commits.get(scope.accountId) || Promise.resolve();
    const next = before.catch(() => {}).then(operation);
    commits.set(scope.accountId, next);
    return next.finally(() => { if (commits.get(scope.accountId) === next) commits.delete(scope.accountId); });
  }
  async function commit(scope, records, isCurrent) {
    if (!current(scope, isCurrent)) return false;
    const text = JSON.stringify({ version: 1, fence: scope.fence,
      records: Object.fromEntries(Object.entries(records).slice(-MAX_RECEIPTS)) });
    return await write(receiptBase, text, scope.accountId, () => current(scope, isCurrent)) === true && current(scope, isCurrent);
  }
  function tokensFor(data, scope) {
    const tokens = [];
    for (const [collectionKey, items] of Object.entries(data || {})) {
      if (collectionKey === "documents" || !Array.isArray(items)) continue;
      for (const item of items) {
        const token = capture({ ...scope, collectionKey, item });
        if (token) tokens.push(token);
      }
    }
    return tokens;
  }
  async function acknowledge(token, { isCurrent, serverVersion } = {}) {
    if (!token || !current(token, isCurrent)) return false;
    try {
      const fingerprint = await digest(token.snapshot);
      if (!current(token, isCurrent)) return false;
      return await serialize(token, async () => {
        if (!current(token, isCurrent)) return false;
        const records = { ...await receipts(token) };
        const previous = details(records[token.key]);
        // The database can acknowledge this save before the 300ms device
        // cache write runs. Keep the exact prior successful client snapshot
        // clean if a reload still reads it. This hash never carries a write
        // version: it permits adopting cloud data, not replaying an old edit.
        if (previous.client && previous.client !== fingerprint) previous.cached = previous.client;
        // This returned server version belongs to the captured client hash.
        // A save without a version cannot borrow the previous save's version.
        delete records[token.key]; delete previous.clientVersion;
        records[token.key] = { ...previous, client: fingerprint,
          ...(typeof serverVersion === "string" && Number.isFinite(Date.parse(serverVersion)) ? { clientVersion: serverVersion } : {}) };
        return commit(token, records, isCurrent);
      });
    } catch { return false; /* unavailable receipts never discard local data */ }
  }
  async function copies(local, { accountId, fence = fenceFor(accountId) ?? null, isCurrent, guard = guardFor(accountId) } = {}) {
    const scope = { accountId, fence: fence ?? null, guard };
    const empty = () => new Set();
    if (!local || !current(scope, isCurrent)) return empty();
    try {
      // Capture values before the first storage await, just as write tokens
      // are captured before their network request.
      const snapshots = tokensFor(local, scope);
      const saved = await receipts(scope), waiting = queued(scope);
      const candidates = snapshots.filter(token => Object.hasOwn(saved, token.key) && !waiting.has(token.key));
      const matching = await Promise.all(candidates.map(async token => matches(saved[token.key], await digest(token.snapshot)) ? token.key : null));
      if (!current(scope, isCurrent)) return empty();
      // A write queued while hashing is dirty, even when the old receipt
      // matches. Re-read the current queue after the last await.
      const nowWaiting = queued(scope);
      return new Set(matching.filter(key => key && !nowWaiting.has(key)));
    } catch { return empty(); }
  }
  async function acknowledgeCloud(local, cloud, { accountId, fence = fenceFor(accountId) ?? null, isCurrent, guard = guardFor(accountId) } = {}) {
    const scope = { accountId, fence: fence ?? null, guard };
    if (!cloud || !current(scope, isCurrent)) return false;
    try {
      const cloudSnapshots = tokensFor(cloud, scope), localSnapshots = tokensFor(local, scope);
      const before = await receipts(scope), waiting = queued(scope);
      const candidates = cloudSnapshots.filter(token => !waiting.has(token.key));
      const localCandidates = localSnapshots.filter(token => Object.hasOwn(before, token.key) && !waiting.has(token.key));
      const [hashes, localHashes] = await Promise.all([
        Promise.all(candidates.map(async token => [token.key, await digest(token.snapshot), JSON.parse(token.snapshot).updatedAt])),
        Promise.all(localCandidates.map(async token => [token.key, await digest(token.snapshot)])),
      ]);
      if (!current(scope, isCurrent)) return false;
      if (!hashes.length) return false;
      return await serialize(scope, async () => {
        if (!current(scope, isCurrent)) return false;
        const records = { ...await receipts(scope) }, nowWaiting = queued(scope);
        const knownLocal = new Map(localHashes.filter(([key, hash]) => matches(before[key], hash)));
        for (const [key, fingerprint, version] of hashes) {
          // Later saves, including same-content saves with a new version,
          // own their receipt. Queued edits cannot be refreshed as clean.
          if (nowWaiting.has(key) || !sameReceipt(records[key], before[key])) continue;
          const previous = details(records[key]);
          delete previous.cloudVersion; delete records[key];
          records[key] = { ...previous, cloud: fingerprint,
            ...(typeof version === "string" ? { cloudVersion: version } : {}),
            ...(knownLocal.has(key) ? { cached: knownLocal.get(key) } : {}) };
        }
        return commit(scope, records, isCurrent);
      });
    } catch { return false; }
  }
  async function prepare(local, cloud, scope) {
    // Start matching the old client snapshot before refreshing receipts with
    // normalized cloud columns/timestamps. Await both before the caller's
    // merge/rebase, so the exact cached cloud shape stays clean next reload.
    const bound = { guard: guardFor(scope.accountId), ...scope, fence: scope.fence === undefined ? (fenceFor(scope.accountId) ?? null) : scope.fence };
    const [matching] = await Promise.all([copies(local, bound), acknowledgeCloud(local, cloud, bound)]);
    if (!current(bound, bound.isCurrent)) return new Set();
    try {
      const waiting = queued(bound);
      return new Set([...matching].filter(key => !waiting.has(key)));
    } catch { return new Set(); }
  }
  async function expectedVersion({ accountId, fence = fenceFor(accountId) ?? null, collectionKey, previous, isCurrent }) {
    const token = capture({ accountId, fence, collectionKey, item: previous });
    if (!token || !current(token, isCurrent)) return null;
    try {
      const saved = (await receipts(token))[token.key];
      if (!saved) return null;
      const hash = await digest(token.snapshot);
      if (!current(token, isCurrent)) return null;
      const version = (hash === saved.client && saved.clientVersion) || (hash === saved.cloud && saved.cloudVersion) || null;
      if (typeof version !== "string" || !Number.isFinite(Date.parse(version))) return null;
      return { version, record: JSON.parse(token.snapshot) };
    } catch { return null; }
  }
  return { captureRecordWrite: capture, acknowledgeRecordWrite: acknowledge, acknowledgedRecordCopies: copies,
    prepareRecordAcknowledgements: prepare, expectedRecordVersion: expectedVersion };
}

const acknowledgements = createRecordAcknowledgements({
  activeAccount: getActiveUserId, fenceFor: localFence, copyCurrent: localCopyCurrent,
  guardFor: accountId => localWriteGuard(accountId),
  // Queue reads stay synchronous. Receipt consumers are all asynchronous;
  // an unread IndexedDB copy throws and can never masquerade as an empty map.
  read: (base, accountId) => base === BASE_KEYS.recordAcknowledgements
    ? readOfflineText(scopedKey(base, accountId)).then(found => found?.text ?? null)
    : globalThis.localStorage.getItem(scopedKey(base, accountId)),
  write: async (base, value, accountId, guard) => (await writeOfflineText(scopedKey(base, accountId), value, guard)).saved === true,
});
export const { captureRecordWrite, acknowledgeRecordWrite, acknowledgedRecordCopies, prepareRecordAcknowledgements, expectedRecordVersion } = acknowledgements;
export const isAcknowledgedRecordCopy = (copies, collectionKey, id) => copies.has(keyFor(collectionKey, id));
