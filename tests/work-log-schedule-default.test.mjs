import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, textOf, find, pinClock } from './harness/component-harness.mjs';
import { scheduledContractIds, scheduledContractId, readContractPick, contractPickValue, pickHolds } from '../src/utils/scheduledContract.js';

// Ticket 292fcbce ("Logging against"): the Work Log's "Logging against"
// picker starts on the contract the schedule (the Sched. calendar: days
// entered by hand, loaded from contract dates, or synced from CallSync) shows
// for the call day in progress, with no pick needed (AC-1), and can still be
// changed to another contract (AC-2). Only a row that names a live, pickable
// contract counts, "today" is the call day every work entry is filed under,
// and with nothing on the schedule the old default (the contract last used)
// is unchanged. Synthetic contracts and dates only.

const clock = pinClock(test, 'America/Denver', '2026-09-29T10:00:00-06:00');
const { WorkLog } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');
const TODAY = '2026-09-29';

const hourly = (id, facility, extra = {}) => ({ id, facility, payModel: 'hourly', hourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15, callStipend: 0, startDate: '2026-01-01', endDate: '2026-12-31', ...extra });
const NORTH = hourly('c-north', 'Synthetic North Hospital');
const SOUTH = hourly('c-south', 'Synthetic South Hospital');
const EAST = hourly('c-east', 'Synthetic East Clinic');
const CONTRACTS = [NORTH, SOUTH, EAST];
// A day-rate agreement whose call shifts CallSync puts on the calendar: the
// owner's own case is a group agreement like this one.
const GROUP = { id: 'c-group', facility: 'Synthetic Valley Neurosurgical Group', payModel: 'daily', dayRate: 2000, callStipend: 1000, startDate: '2026-01-01', endDate: '2028-12-31' };

const row = (contractId, date = TODAY, extra = {}) => ({ id: `s-${contractId}-${date}`, contractId, date, kind: 'call', expected: 1000, ...extra });
const picker = (tree) => find(tree, n => n.type === 'select' && n.props['aria-labelledby'] === 'work-log-contract', 'Logging against picker');
// A few renders, so anything an effect changes after a render has landed
// before the picker is read.
const settle = (m) => { m.render(); m.render(); return m.render(); };
const shown = (m) => picker(settle(m)).props.value;
const open = (seed) => mount(WorkLog, { data: { locumContracts: CONTRACTS, workLog: [], ...seed.data }, storage: seed.storage || {} });

// ── AC-1 / AC-2 ──────────────────────────────────────────────────────

test('AC-1: Logging against starts on the contract the schedule shows today, not the one last used', () => {
  const m = open({ data: { scheduleDays: [row(SOUTH.id)] }, storage: { lastContract: NORTH.id } });
  const tree = m.render();
  assert.equal(picker(tree).props.value, SOUTH.id, "today's scheduled contract, with no pick needed");
  assert.ok(textOf(tree).includes('On your schedule today'), 'and it says why');
});

test('AC-1: a CallSync shift on the day-rate agreement opens Days & call on that agreement', () => {
  const shift = row(GROUP.id, TODAY, { kind: 'day+call', source: 'callsync', sourceKey: `${TODAY}|synthetic valley medical center|neurosurgery|primary`, note: 'Synthetic Valley Medical Center (Primary)' });
  const m = mount(WorkLog, { data: { locumContracts: [NORTH, GROUP], workLog: [], dutyDays: [], scheduleDays: [shift] }, storage: { lastContract: NORTH.id } });
  const tree = m.render();
  assert.equal(picker(tree).props.value, GROUP.id);
  const duty = find(tree, n => typeof n.props?.onBusyChange === 'function', 'Days & call engine');
  assert.equal(duty.props.contract.id, GROUP.id, 'the day-rate engine is on the scheduled agreement');
});

test('AC-2: the scheduled default can still be changed, and the pick sticks', () => {
  const m = open({ data: { scheduleDays: [row(SOUTH.id)] } });
  assert.equal(shown(m), SOUTH.id);
  picker(m.render()).props.onChange({ target: { value: EAST.id } });
  assert.equal(shown(m), EAST.id, 'the pick shows');
  assert.equal(shown(m), EAST.id, 'and holds across renders');
  assert.deepEqual(readContractPick(m.storage.lastContract), { contractId: EAST.id, callDay: TODAY }, 'remembered with the call day it was made on');
});

// ── Objection 1: only live, pickable contracts; the call-day boundary ─

test('a vacation row for today never wins and never blocks a real scheduled row', () => {
  const m = open({ data: { scheduleDays: [{ id: 's-off', date: TODAY, kind: 'vacation', note: 'Off' }, row(SOUTH.id)] }, storage: { lastContract: NORTH.id } });
  assert.equal(shown(m), SOUTH.id);
});

test('a row for a deleted, archived or ended contract falls through to the contract last used', () => {
  const archived = { ...SOUTH, customFields: { archivedAt: '2026-08-01T00:00:00Z' } };
  const ended = { ...EAST, endDate: '2026-07-31' };
  for (const [what, contracts, id] of [['deleted', [NORTH, EAST], 'c-gone'], ['archived', [NORTH, archived, EAST], SOUTH.id], ['ended', [NORTH, SOUTH, ended], EAST.id]]) {
    const m = mount(WorkLog, { data: { locumContracts: contracts, workLog: [], scheduleDays: [row(id), { ...row(id), id: 's-dup' }] }, storage: { lastContract: NORTH.id } });
    assert.equal(shown(m), NORTH.id, `a ${what} contract's row is skipped`);
  }
  const mixed = mount(WorkLog, { data: { locumContracts: [NORTH, archived, EAST], workLog: [], scheduleDays: [row(SOUTH.id), row(EAST.id)] }, storage: { lastContract: NORTH.id } });
  assert.equal(shown(mixed), EAST.id, 'and a live row after it still counts');
});

test("today is the call day in progress: before its start hour the previous day's row counts", () => {
  const early = { ...SOUTH, dayStartHour: 5 }; // this agreement's call day starts at 5 AM
  const days = [row(NORTH.id, '2026-09-28'), row(early.id, '2026-09-29')];
  clock.setNow('2026-09-29T06:30:00-06:00');
  try {
    const m = mount(WorkLog, { data: { locumContracts: [NORTH, early, EAST], workLog: [], scheduleDays: days }, storage: { lastContract: NORTH.id } });
    // At 6:30 NORTH (7 AM rule) is still on the Sep 28 call day; the 5 AM
    // agreement is already on Sep 29. Both are scheduled: the one last used first.
    assert.deepEqual(scheduledContractIds(days, [NORTH, early, EAST], new Date()).sort(), [early.id, NORTH.id].sort(), "each agreement's own call day");
    assert.equal(shown(m), NORTH.id, "last night's call is still in progress");
    const only = mount(WorkLog, { data: { locumContracts: [NORTH, SOUTH, EAST], workLog: [], scheduleDays: [row(NORTH.id, '2026-09-28'), row(SOUTH.id, '2026-09-29')] }, storage: { lastContract: EAST.id } });
    assert.equal(shown(only), NORTH.id, "at 6:30 the Sep 29 row is not today's yet under the 7 AM rule");
  } finally { clock.setNow('2026-09-29T10:00:00-06:00'); }
  const later = mount(WorkLog, { data: { locumContracts: [NORTH, SOUTH, EAST], workLog: [], scheduleDays: [row(NORTH.id, '2026-09-28'), row(SOUTH.id, '2026-09-29')] }, storage: { lastContract: EAST.id } });
  assert.equal(shown(later), SOUTH.id, 'after 7 AM the Sep 29 row is today');
});

// ── Objection 6: no schedule today, exactly the old default ──────────

// Passes on the build before this change too: nothing here may move.
test('with nothing scheduled today the picker opens exactly as before', () => {
  const otherDays = [row(SOUTH.id, '2026-09-27'), row(SOUTH.id, '2026-09-30'), { id: 's-off', date: TODAY, kind: 'vacation' }];
  assert.equal(shown(open({ data: { scheduleDays: otherDays }, storage: { lastContract: EAST.id } })), EAST.id, 'the contract last used');
  assert.equal(shown(open({ data: {}, storage: { lastContract: EAST.id } })), EAST.id, 'no calendar at all');
  assert.equal(shown(open({ data: {}, storage: {} })), NORTH.id, 'nothing remembered: the first contract');
  const timer = { contractId: EAST.id, type: 'Call', startedAt: '2026-09-29T15:50:00.000Z' };
  assert.equal(shown(open({ data: { scheduleDays: otherDays }, storage: { timer, lastContract: NORTH.id } })), EAST.id, "a running timer's contract");
  const logged = { id: 'w1', createdAt: '2026-09-20T15:00:00Z', contractId: SOUTH.id, type: 'Call', date: '2026-09-20', callDay: '2026-09-20', startTime: '2026-09-20T15:00:00.000Z', endTime: '2026-09-20T15:30:00.000Z', durationMin: 30, billedMin: 30, description: '', privateNote: '', invoiceId: null };
  assert.equal(shown(open({ data: { scheduleDays: otherDays, workLog: [logged] }, storage: { lastContract: 'c-gone' } })), SOUTH.id, 'a remembered contract since deleted: the most recent entry\'s');
});

test('with nothing scheduled today, a pick stored with an earlier call day is still the contract last used', () => {
  assert.equal(shown(open({ data: { scheduleDays: [] }, storage: { lastContract: contractPickValue(EAST.id, '2026-09-20') } })), EAST.id);
});

// ── The pure rules ───────────────────────────────────────────────────

test('scheduledContractIds: one id per contract, the one last used first, a coverage block before a term', () => {
  const blocked = hourly('c-block', 'Synthetic Block Hospital', { coveragePeriods: [{ start: '2026-09-28', end: '2026-10-02' }] });
  const days = [row(NORTH.id), row(blocked.id), row(NORTH.id, TODAY, { id: 's-backup', kind: 'call' })];
  const at = new Date('2026-09-29T10:00:00-06:00');
  assert.deepEqual(scheduledContractIds(days, [NORTH, blocked], at), [blocked.id, NORTH.id], 'a real booking before a year-long term');
  assert.deepEqual(scheduledContractIds(days, [NORTH, blocked], at, { prefer: NORTH.id }), [NORTH.id, blocked.id], 'the contract last used first');
  assert.equal(scheduledContractId([], [NORTH], at), '');
  assert.equal(scheduledContractId(null, null, at), '');
});

test('readContractPick reads every stored shape; pickHolds only for its own call day', () => {
  assert.deepEqual(readContractPick('c-north'), { contractId: 'c-north', callDay: '' });
  assert.deepEqual(readContractPick(contractPickValue('c-north', TODAY)), { contractId: 'c-north', callDay: TODAY });
  assert.deepEqual(readContractPick(null), { contractId: '', callDay: '' });
  assert.deepEqual(readContractPick('{broken'), { contractId: '', callDay: '' });
  assert.equal(contractPickValue('c-north', ''), 'c-north', 'not tied to a day: stored as a bare id, as before');
  const at = new Date('2026-09-29T10:00:00-06:00');
  assert.equal(pickHolds({ contractId: NORTH.id, callDay: TODAY }, CONTRACTS, at), true);
  assert.equal(pickHolds({ contractId: NORTH.id, callDay: '2026-09-28' }, CONTRACTS, at), false);
  assert.equal(pickHolds({ contractId: 'c-gone', callDay: TODAY }, CONTRACTS, at), false);
  assert.equal(pickHolds({ contractId: NORTH.id, callDay: '' }, CONTRACTS, at), false);
});
