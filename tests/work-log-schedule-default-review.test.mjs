import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, field, click, pinClock } from './harness/component-harness.mjs';
import { scheduledContracts, scheduledContractIds, readContractPick, contractPickValue } from '../src/utils/scheduledContract.js';

// Ticket 292fcbce ("Logging against"), the second review of the schedule
// default. Each test names the finding it pins:
//  F1  which contract wins when two rows fall on different call days never
//      depends on the order the rows were saved in, and a timed block's
//      lead-in at midnight never takes the picker off a call still running;
//  F3/F7  time logged for another day is the contract last used, not a pick
//      for today: this visit shows what the next one will, and it never
//      replaces a contract picked for today;
//  F4  Invoices' "Needs invoicing" leaves a contract picked for today alone;
//  F5  a split day (a day at one contract, call at another) is decided by
//      the rows' kinds, not the order they were saved in, and the note under
//      the picker names both;
//  F6  the contract last used is still stored as a bare id (the QA lab's
//      PRAC-021 reads it so); the pick for a call day has its own slot.
// Synthetic contracts and dates only.

const clock = pinClock(test, 'America/Denver', '2026-09-29T10:00:00-06:00');
const minuteChecks = [];
const underlyingSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => { if (ms === 60000) minuteChecks.push(fn); return underlyingSetInterval(fn, ms, ...rest); };
const { WorkLog } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');
const TODAY = '2026-09-29';

const hourly = (id, facility, extra = {}) => ({ id, facility, payModel: 'hourly', hourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15, callStipend: 0, startDate: '2026-01-01', endDate: '2026-12-31', ...extra });
const NORTH = hourly('c-north', 'Synthetic North Hospital');
const SOUTH = hourly('c-south', 'Synthetic South Hospital');
const EAST = hourly('c-east', 'Synthetic East Clinic');
const CONTRACTS = [NORTH, SOUTH, EAST];

const row = (contractId, date = TODAY, kind = 'call') => ({ id: `s-${contractId}-${date}-${kind}`, contractId, date, kind, expected: 1000 });
const picker = (tree) => find(tree, n => n.type === 'select' && n.props['aria-labelledby'] === 'work-log-contract', 'Logging against picker');
const settle = (m) => { m.render(); m.render(); return m.render(); };
const shown = (m) => picker(settle(m)).props.value;
const pick = (m, id) => picker(m.render()).props.onChange({ target: { value: id } });
const work = ({ scheduleDays = [], storage = {}, props = {}, contracts = CONTRACTS } = {}) =>
  mount(WorkLog, { data: { locumContracts: contracts, workLog: [], scheduleDays }, storage, props });

// Log past time on `contractId` for `date`, 9:00 to 9:30, through the form.
function logPast(m, contractId, date) {
  click(m, 'Log past time');
  find(field(m.render(), 'Contract'), n => n.type === 'select', 'form contract').props.onChange({ target: { value: contractId } });
  find(m.render(), n => n.type === 'button' && textOf(n) === 'Other…' && String(n.props.onClick).includes('pickDate'), 'date Other').props.onClick();
  find(m.render(), n => n.type === 'input' && n.props.type === 'date', 'date input').props.onChange({ target: { value: date } });
  field(m.render(), 'Start time').props.onCommit('09:00');
  field(m.render(), 'End time').props.onCommit('09:30');
  click(m, 'Log it');
  const yes = nodes(m.render()).find(n => n.type === 'button' && textOf(n).includes('Yes, log it here'));
  if (yes) yes.props.onClick();
  const saved = m.calls.filter(c => c[0] === 'add' && c[1] === 'workLog').at(-1)?.[2];
  assert.equal(saved?.contractId, contractId, 'the entry is saved where it was logged');
  assert.equal(saved?.callDay, date);
}

// ── F1: the call still running outranks a lead-in, in either row order ─

// D: hourly on the 7 AM rule, on overnight call Oct 15. B: a timed block,
// Oct 16 4:00 PM to Oct 19 7:00 AM, its Oct 16 row loaded from its dates.
// From midnight Oct 16, B's lead-in already files under Oct 16 while D's
// call day is still Oct 15.
const D = hourly('c-d', 'Synthetic Overnight Hospital', { startDate: '2026-01-01', endDate: '2026-12-31' });
const B = hourly('c-b', 'Synthetic Block Hospital', { coveragePeriods: [{ start: '2026-10-16', startTime: '16:00', end: '2026-10-19', endTime: '07:00' }], startDate: '2026-10-16', endDate: '2026-10-19' });
const D_ROW = row(D.id, '2026-10-15');
const B_ROW = row(B.id, '2026-10-16');

test('F1: at 00:30 a block\'s lead-in never outranks last night\'s call, whatever order the rows were saved in', () => {
  const at = new Date('2026-10-16T00:30:00-06:00');
  assert.deepEqual(scheduledContractIds([B_ROW, D_ROW], [D, B], at), [D.id, B.id], 'block row saved first');
  assert.deepEqual(scheduledContractIds([D_ROW, B_ROW], [D, B], at), [D.id, B.id], 'call row saved first');
  assert.deepEqual(scheduledContractIds([B_ROW, D_ROW], [D, B], at, { prefer: B.id }), [D.id, B.id], 'not even the contract last used jumps a call still running');
  assert.deepEqual(scheduledContractIds([B_ROW, D_ROW], [D, B], new Date('2026-10-16T08:00:00-06:00')), [B.id], "after 7 AM D's Oct 15 call is over");
});

test('F1: the picker stays on the overnight call when midnight passes, and a 2 AM timer bills it', () => {
  clock.setNow('2026-10-15T23:50:00-06:00');
  try {
    const m = work({ contracts: [D, B], scheduleDays: [B_ROW, D_ROW] });
    assert.equal(shown(m), D.id, '11:50 PM: on D\'s call');
    clock.setNow('2026-10-16T00:30:00-06:00');
    minuteChecks.at(-1)();
    assert.equal(shown(m), D.id, '00:30: still D, though B\'s lead-in moved the call days');
    assert.ok(textOf(m.render()).includes('On your schedule today'));
    clock.setNow('2026-10-16T02:00:00-06:00');
    minuteChecks.at(-1)();
    click(m, 'Got a call? Start the timer');
    assert.equal(m.storage.timer?.contractId, D.id, 'the 2 AM consult bills D');
  } finally { clock.setNow('2026-09-29T10:00:00-06:00'); }
});

// ── F3 / F7: time logged for another day ──────────────────────────────

test('F3: time logged for another day is the contract last used; the view goes back to today\'s schedule, now and on the next visit', () => {
  const days = [row(SOUTH.id)];
  const m = work({ scheduleDays: days });
  assert.equal(shown(m), SOUTH.id);
  logPast(m, EAST.id, '2026-09-27');
  assert.equal(shown(m), SOUTH.id, 'this visit: today\'s schedule once the form closes');
  assert.equal(m.storage.lastContract, EAST.id, 'remembered as the contract last used');
  assert.equal(m.storage.contractPick, undefined, 'and not as a pick for any day');
  click(m, 'Got a call? Start the timer');
  assert.equal(m.storage.timer?.contractId, SOUTH.id, 'the next timer bills the scheduled contract');
  assert.equal(shown(work({ scheduleDays: days, storage: { lastContract: EAST.id } })), SOUTH.id, 'the next visit agrees');
});

test('F3: with nothing scheduled today, time logged for another day moves the picker to it, as before', () => {
  const m = work({ storage: { lastContract: NORTH.id } });
  assert.equal(shown(m), NORTH.id);
  logPast(m, EAST.id, '2026-09-27');
  assert.equal(shown(m), EAST.id, 'the contract last used');
  assert.equal(shown(work({ storage: { ...m.storage } })), EAST.id, 'and on the next visit');
});

test('F3: time logged for today is a pick for today', () => {
  const days = [row(SOUTH.id)];
  const m = work({ scheduleDays: days });
  logPast(m, EAST.id, TODAY);
  assert.equal(shown(m), EAST.id);
  assert.deepEqual(readContractPick(m.storage.contractPick), { contractId: EAST.id, callDay: TODAY });
  assert.equal(shown(work({ scheduleDays: days, storage: { ...m.storage } })), EAST.id, 'and it holds on the next visit that day');
});

test('F7: a contract picked for today survives logging past time, on this visit and the next', () => {
  const days = [row(SOUTH.id)];
  for (const loggedOn of [EAST.id, NORTH.id]) {
    const m = work({ scheduleDays: days });
    pick(m, EAST.id);
    logPast(m, loggedOn, '2026-09-28');
    assert.equal(shown(m), EAST.id, `this visit (logged on ${loggedOn}): still the pick`);
    assert.deepEqual(readContractPick(m.storage.contractPick), { contractId: EAST.id, callDay: TODAY }, 'the pick for today is untouched');
    assert.equal(m.storage.lastContract, loggedOn, 'the contract last used is the one just logged');
    assert.equal(shown(work({ scheduleDays: days, storage: { ...m.storage } })), EAST.id, 'the next visit: the pick, not the schedule');
  }
});

// ── F4: Needs invoicing leaves today's pick alone ────────────────────

test('F4: opening "Needs invoicing" for another contract does not drop the pick for today', () => {
  const days = [row(SOUTH.id)];
  const m = work({ scheduleDays: days });
  pick(m, EAST.id);
  // LocumDashboard's hand-off: the open written as the contract last used, and passed in.
  const storage = { ...m.storage, lastContract: NORTH.id };
  const opened = work({ scheduleDays: days, storage, props: { openContractId: NORTH.id } });
  assert.equal(shown(opened), NORTH.id, 'the contract that needs invoicing opens');
  assert.equal(shown(work({ scheduleDays: days, storage: { ...opened.storage } })), EAST.id, 'back to Work by the tab: the pick for today');
  assert.equal(shown(work({ storage: { ...opened.storage, contractPick: undefined } })), NORTH.id, 'with no pick and nothing scheduled: the contract last used, as before');
});

// ── F5: a split day ─────────────────────────────────────────────────

test('F5: a day at one contract and call at another: the call contract, in either row order, and the note names both', () => {
  const split = [row(EAST.id, TODAY, 'day'), row(SOUTH.id, TODAY, 'call')];
  for (const days of [split, [...split].reverse()]) {
    assert.deepEqual(scheduledContracts(days, CONTRACTS, new Date()), [
      { id: SOUTH.id, date: TODAY, kind: 'call' },
      { id: EAST.id, date: TODAY, kind: 'day' },
    ]);
    for (const lastContract of [undefined, EAST.id]) {
      const m = work({ scheduleDays: days, storage: lastContract ? { lastContract } : {} });
      assert.equal(shown(m), SOUTH.id, `the call covers the whole call day (last used: ${lastContract || 'none'})`);
      assert.ok(textOf(m.render()).includes('On your schedule today (call). Also scheduled: Synthetic East Clinic (day)'), textOf(m.render()));
    }
  }
  const m = work({ scheduleDays: split });
  pick(m, EAST.id);
  assert.equal(shown(m), EAST.id, 'one tap to the other, and it holds');
  assert.ok(textOf(m.render()).includes('On your schedule today (day). Also scheduled: Synthetic South Hospital (call)'));
});

test('F5: a day row and a call row on one contract read as day and call; one contract alone keeps the plain note', () => {
  const days = [row(SOUTH.id, TODAY, 'day'), row(SOUTH.id, TODAY, 'call'), row(EAST.id, TODAY, 'call')];
  assert.deepEqual(scheduledContracts(days, CONTRACTS, new Date(), { prefer: EAST.id }).map(s => [s.id, s.kind]), [[EAST.id, 'call'], [SOUTH.id, 'day+call']]);
  const alone = work({ scheduleDays: [row(SOUTH.id)] });
  const note = nodes(alone.render()).find(n => n.type === 'div' && textOf(n).startsWith('On your schedule'));
  assert.equal(textOf(note), 'On your schedule today');
});

// ── F6: the contract last used stays a bare id ──────────────────────

test('F6: a pick stores the contract last used as a bare id (QA lab PRAC-021) and the pick with its call day in its own slot', () => {
  const m = work({ scheduleDays: [row(SOUTH.id)] });
  pick(m, EAST.id);
  assert.equal(m.storage.lastContract, EAST.id, 'a bare id, as every build has stored it');
  assert.deepEqual(readContractPick(m.storage.contractPick), { contractId: EAST.id, callDay: TODAY });
  assert.equal(shown(work({ scheduleDays: [row(SOUTH.id)], storage: { ...m.storage } })), EAST.id, 'after a reload the pick still shows');
  // With nothing scheduled (the QA lab's account), the same.
  const plain = work();
  pick(plain, EAST.id);
  assert.equal(plain.storage.lastContract, EAST.id);
  assert.equal(shown(work({ storage: { ...plain.storage } })), EAST.id);
  // A pick from an earlier day in its slot never outranks the contract last used.
  assert.equal(shown(work({ storage: { lastContract: NORTH.id, contractPick: contractPickValue(EAST.id, '2026-09-20') } })), NORTH.id);
});

// ── A to-do billed from Days & call (the one other caller that switched
//    the view without a pick) ─────────────────────────────────────────

const GROUP = { id: 'c-group', facility: 'Synthetic Valley Neurosurgical Group', payModel: 'daily', dayRate: 2000, callStipend: 1000, startDate: '2026-01-01', endDate: '2028-12-31' };
const openModal = (tree) => nodes(tree).find(n => n.props?.open === true && typeof n.props?.onClose === 'function');

test('a to-do billed while the day-rate agreement is on screen holds the time contract behind its form; only saving it for today makes it the pick', () => {
  const draft = { date: TODAY, type: 'Call', start: '09:00', end: '09:30', description: 'Synthetic consult callback', privateNote: '', contractId: NORTH.id, taskId: null };
  const bill = (storage = {}) => {
    const props = { billDraft: draft, onBillDraftDone: () => { props.billDraft = null; } };
    return mount(WorkLog, { data: { locumContracts: [NORTH, GROUP], workLog: [], dutyDays: [], scheduleDays: [row(GROUP.id, TODAY, 'day')] }, storage, props });
  };

  const cancelled = bill();
  assert.equal(shown(cancelled), NORTH.id, 'the time engine the entry lands in, behind the form');
  assert.equal(openModal(cancelled.render())?.props.title, 'Log past time');
  openModal(cancelled.render()).props.onClose();
  assert.equal(shown(cancelled), GROUP.id, "closed without saving: today's schedule");
  assert.equal(cancelled.storage.contractPick, undefined);
  assert.equal(cancelled.storage.lastContract, NORTH.id, 'the contract last used, as before');

  const saved = bill();
  assert.equal(shown(saved), NORTH.id);
  click(saved, 'Log it');
  const yes = nodes(saved.render()).find(n => n.type === 'button' && textOf(n).includes('Yes, log it here'));
  if (yes) yes.props.onClick();
  assert.equal(saved.calls.find(c => c[0] === 'add' && c[1] === 'workLog')?.[2]?.contractId, NORTH.id);
  assert.equal(shown(saved), NORTH.id, 'saved for today: a pick for today');
  assert.deepEqual(readContractPick(saved.storage.contractPick), { contractId: NORTH.id, callDay: TODAY });
});
