// PRAC-028 / SYNC-003: manual deduction lines were saved with "ded-<ms>-<rand>"
// ids. deductibles.id is a uuid, so every insert, replay and self-heal failed
// with 22P02 and the line lived in one device's cache until sign-out lost it.
// Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { repairRecordIds, repairQueuedIds, repairVaultKeys, repairStoredIds } from '../src/utils/idRepair.js';
import { isUuid } from '../src/utils/syncRules.js';

const src = (p) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf8');
const NOW = '2026-09-29T12:00:00.000Z';
const ids = (...list) => { const q = [...list]; return () => q.shift(); };
const NEW_A = '00000000-0000-4000-8000-00000000000a';
const NEW_B = '00000000-0000-4000-8000-00000000000b';
const KEEP = '00000000-0000-4000-8000-0000000000cc';

test('PRAC-028: a manual deduction line is saved with a uuid, never a "ded-" id', () => {
  const memo = src('components/features/locum/DeductionMemo.jsx');
  assert.doesNotMatch(memo, /ded-\$\{Date\.now/);
  assert.match(memo, /addItem\("deductibles", \{ id: generateId\(\),/);
  assert.match(memo, /import \{ generateId \} from "..\/..\/..\/utils\/helpers"/);
  assert.doesNotMatch(src('components/features/locum/HospitalRotations.jsx'), /rot-\$\{Date\.now/, 'rotations minted the same kind of id');
});

test('SYNC-003: the load-time repair renames "ded-" rows and relinks their receipts', () => {
  const blob = {
    deductibles: [{ id: 'ded-1727600000000-ab12cd', amount: 10 }, { id: KEEP, amount: 20 }, { id: 'ded-2', amount: 30 }],
    documents: [{ id: 'd1', linkedTo: 'deductibles:ded-1727600000000-ab12cd' }, { id: 'd2', linkedTo: `deductibles:${KEEP}` }, { id: 'd3', linkedTo: '' }],
    licenses: [{ id: 'not-a-uuid-but-not-ours' }],
  };
  const { blob: out, remapped } = repairRecordIds(blob, ids(NEW_A, NEW_B), NOW);
  assert.deepEqual(remapped, [['deductibles', 'ded-1727600000000-ab12cd', NEW_A], ['deductibles', 'ded-2', NEW_B]]);
  assert.ok(out.deductibles.every((d) => isUuid(d.id)));
  assert.equal(out.deductibles[0].updatedAt, NOW, 'stamped so the self-heal push sends it');
  assert.equal(out.deductibles[1], blob.deductibles[1], 'a good row is untouched');
  assert.equal(out.documents[0].linkedTo, `deductibles:${NEW_A}`);
  assert.equal(out.documents[1], blob.documents[1]);
  assert.equal(out.licenses, blob.licenses, 'only the collections that minted bad ids are renamed');
  assert.equal(repairRecordIds({ deductibles: [{ id: KEEP }] }, ids()).remapped.length, 0);
});

test('SYNC-003: dead queued ops are dropped and a queued save follows the rename', () => {
  const remapped = [['deductibles', 'ded-1', NEW_A]];
  const ops = [
    { op: 'upsert', collectionKey: 'deductibles', payload: { id: 'ded-1', amount: 10 }, queueId: 'a' },
    { op: 'delete', collectionKey: 'deductibles', payload: 'ded-9', queueId: 'b' },
    { op: 'tombstone', collectionKey: 'deductibles', payload: 'ded-9', queueId: 'c' },
    { op: 'upsert', collectionKey: 'deductibles', payload: { id: 'ded-unknown' }, queueId: 'd' },
    { op: 'upsert', collectionKey: 'licenses', payload: { id: KEEP }, queueId: 'e' },
    { op: 'settings', collectionKey: 'settings', payload: { theme: 'dark' }, queueId: 'f' },
  ];
  const { ops: out, changed } = repairQueuedIds(ops, remapped);
  assert.equal(changed, true);
  assert.deepEqual(out.map((o) => o.queueId), ['a', 'e', 'f']);
  assert.equal(out[0].payload.id, NEW_A);
  assert.equal(out[0].payload.amount, 10);
});

test('SYNC-003: a private note on a renamed record follows it', () => {
  const { vault, changed } = repairVaultKeys({ 'deductibles:ded-1': 'note', 'workLog:x': 'other' }, [['deductibles', 'ded-1', NEW_A]]);
  assert.equal(changed, true);
  assert.deepEqual(vault, { [`deductibles:${NEW_A}`]: 'note', 'workLog:x': 'other' });
});

test('SYNC-003: the stored repair writes the file, the queue and the vault once, and is a no-op after', async () => {
  const store = {
    file: { deductibles: [{ id: 'ded-1', amount: 10 }], documents: [] },
    queue: [{ op: 'upsert', collectionKey: 'deductibles', payload: { id: 'ded-1' }, queueId: 'q' }],
    vault: {},
  };
  const writes = [];
  const io = {
    readCached: () => store.file, saveCached: async (b) => { writes.push('file'); store.file = b; },
    readQueue: () => store.queue, writeQueue: (q) => { writes.push('queue'); store.queue = q; },
    readVault: () => store.vault, writeVault: (v) => { writes.push('vault'); store.vault = v; },
    makeId: ids(NEW_A), now: NOW,
  };
  await repairStoredIds(io);
  assert.deepEqual(writes, ['file', 'queue']);
  assert.equal(store.file.deductibles[0].id, NEW_A);
  assert.equal(store.queue[0].payload.id, NEW_A);
  writes.length = 0;
  await repairStoredIds({ ...io, makeId: () => assert.fail('nothing left to rename') });
  assert.deepEqual(writes, []);
});

test('SYNC-003: AppContext runs the repair before the pending-op replay', () => {
  const ctx = src('context/AppContext.jsx');
  const repair = ctx.indexOf('await repairStoredIds(');
  const replay = ctx.indexOf('await replayPendingOps(profile.id, authUserId');
  assert.ok(repair > 0 && replay > repair);
});
