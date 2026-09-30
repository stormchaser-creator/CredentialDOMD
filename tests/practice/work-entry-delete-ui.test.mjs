import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, find, pinClock } from '../harness/component-harness.mjs';

// PRAC-011: deleting one work entry removes its private note from this
// device's vault too (the split-entry path already did). A refused delete
// keeps both. Synthetic note text only.

pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const { WorkLog } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');

const CONTRACT = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };
const ENTRY = { id: 'w1', createdAt: '2026-09-09T20:00:00Z', contractId: 'c1', type: 'Consult', date: '2026-09-09', callDay: '2026-09-09', startTime: '2026-09-09T19:00:00.000Z', endTime: '2026-09-09T20:00:00.000Z', durationMin: 60, billedMin: 60, description: 'ED consult', privateNote: '', invoiceId: null };

const deleteW1 = (opts = {}) => {
  const m = mount(WorkLog, { data: { locumContracts: [CONTRACT], workLog: [{ ...ENTRY }] }, storage: { lastContract: 'c1' }, ...opts });
  globalThis.__screen.vault['workLog:w1'] = 'Synthetic bed 4 reminder';
  find(m.render(), n => n.type === 'button' && n.props['aria-label'] === 'Delete entry', 'delete').props.onClick({ stopPropagation() {} });
  return m;
};

test('deleting a single entry also clears its private note', () => {
  const m = deleteW1();
  assert.deepEqual(m.calls, [['delete', 'workLog', 'w1']]);
  assert.equal(globalThis.__screen.vault['workLog:w1'], undefined);
});

test('a refused delete keeps the entry and its note', () => {
  const m = deleteW1({ refuse: (op) => op === 'delete' });
  assert.deepEqual(m.calls, [['refused', 'delete', 'workLog']]);
  assert.equal(globalThis.__screen.vault['workLog:w1'], 'Synthetic bed 4 reminder');
});

test('a declined confirm keeps the entry and its note', () => {
  const m = deleteW1({ confirm: () => false });
  assert.equal(m.calls.length, 0);
  assert.equal(globalThis.__screen.vault['workLog:w1'], 'Synthetic bed 4 reminder');
});
