import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, find, pinClock } from './harness/component-harness.mjs';

// Ticket 292fcbce ("Logging against"): pins AC-1 and AC-2 against the
// shipped behavior in WorkLog.jsx. Synthetic contracts and dates only.

pinClock(test, 'America/Denver', '2026-09-29T10:00:00-06:00');
const { WorkLog } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');
const TODAY = '2026-09-29';

const hourly = (id, facility) => ({ id, facility, payModel: 'hourly', hourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15, callStipend: 0, startDate: '2026-01-01', endDate: '2026-12-31' });
const ALPHA = hourly('c-alpha', 'Synthetic Alpha Hospital');
const BETA = hourly('c-beta', 'Synthetic Beta Clinic');
const CONTRACTS = [ALPHA, BETA];
const row = (contractId) => ({ id: `s-${contractId}`, contractId, date: TODAY, kind: 'call', expected: 1000 });
const picker = (tree) => find(tree, n => n.type === 'select' && n.props['aria-labelledby'] === 'work-log-contract', 'Logging against picker');
const shown = (m) => { m.render(); m.render(); return picker(m.render()).props.value; };

test('AC-1 pin: Logging against opens on the contract the schedule shows today, no pick needed', () => {
  const m = mount(WorkLog, { data: { locumContracts: CONTRACTS, workLog: [], scheduleDays: [row(BETA.id)] }, storage: { lastContract: ALPHA.id } });
  assert.equal(shown(m), BETA.id);
});

test('AC-2 pin: that default can still be changed to a different contract', () => {
  const m = mount(WorkLog, { data: { locumContracts: CONTRACTS, workLog: [], scheduleDays: [row(BETA.id)] }, storage: {} });
  assert.equal(shown(m), BETA.id);
  picker(m.render()).props.onChange({ target: { value: ALPHA.id } });
  assert.equal(shown(m), ALPHA.id);
});
