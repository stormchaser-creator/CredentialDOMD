import { createSyncRecovery, stableJson, reportRecoveryFailure } from '../src/utils/syncRecovery.js';
export function recoveryFor(values, actor, fence = () => null) {
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key), key: i => [...values.keys()][i] ?? null, get length() { return values.size; } };
  return { stableJson, reportRecoveryFailure, ...createSyncRecovery({ storage: () => storage, activeAccount: actor,
    fenceFor: fence, copyCurrent: (_id, expected) => expected === fence() }) };
}
