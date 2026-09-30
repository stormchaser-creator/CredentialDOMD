// SYNC-020: "Restore from a file" for private notes merged ANY JSON object
// into the vault, so the full backup picked by mistake became "private notes".
// Synthetic notes only.
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i], get length() { return store.size; } };
globalThis.window = { sessionStorage: globalThis.localStorage };
const { setActiveUserId } = await import('../src/utils/storageScope.js');
const { importVault, vaultCount, exportVault } = await import('../src/utils/privateVault.js');
setActiveUserId('user_syntheticA');

test('SYNC-020: a full backup, an array or a stray object is not a vault export, and nothing changes', () => {
  const backup = { licenses: [{ id: 'l1' }], settings: { name: 'Synthetic' }, _exportMeta: { app: 'CredentialDOMD' } };
  for (const wrong of [backup, [{ 'workLog:w1': 'x' }], { hello: 'world' }, { 'workLog:w1': 42 }, { 'workLog:w1': '' }]) {
    assert.deepEqual(importVault(wrong), { ok: false, reason: 'not-a-vault' }, JSON.stringify(wrong));
  }
  assert.equal(vaultCount(), 0);
});

test('SYNC-020: a vault export restores only its "section:id" notes and says how many', () => {
  const result = importVault({ 'workLog:00000000-0000-4000-8000-000000000001': 'Synthetic note', 'encounters:e1': 'Another', licenses: [{ id: 'x' }] });
  assert.deepEqual(result, { ok: true, restored: 2 });
  assert.equal(vaultCount(), 2);
  assert.deepEqual(Object.keys(exportVault()).sort(), ['encounters:e1', 'workLog:00000000-0000-4000-8000-000000000001']);
});
