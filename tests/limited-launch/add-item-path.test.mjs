import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { withStoragePath } from '../../src/utils/docStoragePath.js';

// SYNC-017: once a document's file and row land, addItem records where the
// file lives, so the cached copy (utils/storage saveData) drops the bytes.
// Kept, four ~3 MB uploads in one session filled localStorage and froze the
// offline copy. Runs the actual addItem from AppContext.jsx with synthetic
// dependencies; no React, no network.
const source = await readFile(process.env.APPCONTEXT_SOURCE_FILE || new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  const addItem = useCallback(');
const end = source.indexOf('  // Whether addItem would accept', start);
if (start < 0 || end < start) throw new Error('addItem could not be located');

function harness({ path = 'user_syntheticA/doc-1', owner = 'user_syntheticA' } = {}) {
  let state = { documents: [], settings: {} };
  let resolveInsert;
  const inserted = new Promise((r) => { resolveInsert = r; });
  const ctx = {
    useCallback: (fn) => fn, prepareRecord: (_k, raw) => raw, dataRef: { current: state },
    updateSection: (key, fn) => { state = { ...state, [key]: fn(state[key]) }; return true; },
    alertWriteRefused() {}, scopesForWrite() {}, isDeviceOnlySection: () => false,
    dataOwnerRef: { current: owner }, userIdRef: { current: 'profileA' }, getActiveUserId: () => owner,
    sbInsert: async () => { await inserted; return path; },
    setData: (fn) => { state = typeof fn === 'function' ? fn(state) : fn; }, withStoragePath,
  };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.addItem = addItem;`, ctx);
  return { add: ctx.addItem, state: () => state, land: () => resolveInsert(), ctx };
}

test('SYNC-017: an uploaded document gets its storage path in state, so its bytes can leave the cache', async () => {
  const h = harness();
  h.add('documents', { id: 'doc-1', name: 'a.pdf', data: 'data:application/pdf;base64,YQ==' });
  assert.equal(h.state().documents[0].storagePath, undefined);
  h.land(); await new Promise((r) => setImmediate(r));
  assert.equal(h.state().documents[0].storagePath, 'user_syntheticA/doc-1');
  assert.ok(h.state().documents[0].updatedAt === undefined, 'recorded, not stamped as an edit');
});

test('SYNC-017: nothing is recorded when the add did not land, or the account changed meanwhile', async () => {
  const none = harness({ path: null });
  none.add('documents', { id: 'doc-1' }); none.land(); await new Promise((r) => setImmediate(r));
  assert.equal(none.state().documents[0].storagePath, undefined);
  const switched = harness();
  switched.add('documents', { id: 'doc-1' });
  switched.ctx.dataOwnerRef.current = 'user_syntheticB';
  switched.land(); await new Promise((r) => setImmediate(r));
  assert.equal(switched.state().documents[0].storagePath, undefined);
});
