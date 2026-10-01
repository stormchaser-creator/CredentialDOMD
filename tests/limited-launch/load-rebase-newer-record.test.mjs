// A record edited during a load whose copy here, as the load began, was
// already newer than the cloud read (its own write not landed yet: in flight,
// held for a membership answer, queued). The load's rebase used to patch only
// the fields edited during the load onto the older read, so an unsynced
// renewal date went back to the read's under the newest stamp. The whole
// record is taken, as the self-heal takes a newer local copy.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localChangesSince, rebaseLocalChanges } from '../../src/utils/loadRebase.js';

const L = '00000000-0000-4000-8000-00000000011a';
const t0 = '2026-09-30T09:00:00.000Z', t1 = '2026-09-30T10:00:00.000Z', t2 = '2026-09-30T10:00:09.000Z';

test('rebase: an edit during the load to a record whose pre-load copy is newer than the read keeps the whole pre-load record, not the read\'s older fields', () => {
  const base = { licenses: [{ id: L, state: 'WA', exp: '2028-01-01', notes: '', updatedAt: t1 }] };
  const now = { licenses: [{ id: L, state: 'WA', exp: '2028-01-01', notes: 'filed', updatedAt: t2 }] };
  const read = { licenses: [{ id: L, state: 'WA', exp: '2026-12-31', notes: '', updatedAt: t0 }] };
  const since = localChangesSince(base, now);
  assert.equal(since.touches('licenses', L), true);
  const out = rebaseLocalChanges(read, since);
  assert.deepEqual(out.licenses, [{ id: L, state: 'WA', exp: '2028-01-01', notes: 'filed', updatedAt: t2 }], 'the renewal date made before the load is kept');
});

test('rebase: when the read is newer than the pre-load copy (another device), only the fields edited during the load are laid over it', () => {
  const base = { licenses: [{ id: L, state: 'WA', exp: '2028-01-01', notes: '', updatedAt: t0 }] };
  const now = { licenses: [{ id: L, state: 'WA', exp: '2028-01-01', notes: 'filed', updatedAt: t2 }] };
  const read = { licenses: [{ id: L, state: 'OR', exp: '2029-01-01', notes: '', updatedAt: t1 }] };
  const out = rebaseLocalChanges(read, localChangesSince(base, now));
  assert.deepEqual(out.licenses, [{ id: L, state: 'OR', exp: '2029-01-01', notes: 'filed', updatedAt: t2 }], 'the other device\'s fields stay');
});

test('rebase: a star during the load (no stamp) onto a read newer than the pre-load copy stays a star only', () => {
  const base = { licenses: [{ id: L, exp: '2028-01-01', updatedAt: t0 }] };
  const now = { licenses: [{ id: L, exp: '2028-01-01', favorite: true, updatedAt: t0 }] };
  const read = { licenses: [{ id: L, exp: '2029-01-01', updatedAt: t1 }] };
  const out = rebaseLocalChanges(read, localChangesSince(base, now));
  assert.deepEqual(out.licenses, [{ id: L, exp: '2029-01-01', favorite: true, updatedAt: t1 }]);
});
