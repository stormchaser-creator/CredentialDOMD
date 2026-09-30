// QA3: a save kept on the device while membership was re-checked, then
// refused by the check, is taken back (src/utils/heldChanges.js). Only what
// nothing has changed since is taken back. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { changesBetween, revertChanges } from '../../src/utils/heldChanges.js';

const before = {
  settings: { name: 'Synthetic Physician', npi: '' },
  cme: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
  invoices: [],
  lastSync: 'x',
};

test('an add, an edit, a delete, a setting and a value all come back out', () => {
  const next = {
    settings: { name: 'Synthetic Physician', npi: '1234567893', phone: '555' },
    cme: [{ id: 'a', title: 'A edited' }, { id: 'c', title: 'C' }],
    invoices: [{ id: 'inv', number: 'INV-1' }],
    lastSync: 'y',
  };
  const reverted = revertChanges(next, changesBetween(before, next));
  assert.deepEqual(reverted, before);
  assert.equal(Object.hasOwn(reverted.settings, 'phone'), false, 'a setting that was not there is removed, not blanked');
});

test('what changed again since is left as it now is', () => {
  const next = { ...before, cme: [{ id: 'a', title: 'A edited' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }], invoices: [{ id: 'inv', number: 'INV-1' }] };
  const changes = changesBetween(before, next);
  // Since then: the invoice got its storage path recorded, and A was edited again.
  const now = { ...next, cme: [{ id: 'a', title: 'A edited twice' }, next.cme[1], next.cme[2]], invoices: [{ id: 'inv', number: 'INV-1', paidAt: '2026-09-29' }] };
  const reverted = revertChanges(now, changes);
  assert.equal(reverted, now, 'nothing to take back');
});

test('two held saves of one record, taken back newest first, leave it as it was', () => {
  const added = { ...before, invoices: [{ id: 'inv', number: 'INV-1' }] };
  const edited = { ...added, invoices: [{ id: 'inv', number: 'INV-1', paidAt: '2026-09-29' }] };
  const first = changesBetween(before, added), second = changesBetween(added, edited);
  const reverted = revertChanges(revertChanges(edited, second), first);
  assert.deepEqual(reverted.invoices, []);
});

test('nothing changed: the same object comes back', () => {
  assert.equal(revertChanges(before, changesBetween(before, before)), before);
});
