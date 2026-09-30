import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, field, click, pinClock } from './harness/component-harness.mjs';
import { readContractPick, contractPickValue } from '../src/utils/scheduledContract.js';

// Ticket 292fcbce ("Logging against"), the ways a schedule default can get in
// the physician's way, each found by a review of an earlier attempt:
//  2. Invoices' "Needs invoicing" opens THAT contract, even on a day the
//     schedule shows another.
//  3. A pick holds for its call day across leaving Work and coming back; a
//     pick from an earlier day does not outrank today's schedule.
//  4. A timer restored from the device keeps its contract while it runs,
//     and stopping (or discarding) it does not flip the picker while the
//     timer's own call day lasts; once that call day has ended, the new
//     day's schedule takes over.
//  5. The default follows a schedule that arrives after Work opened and a
//     call day that turns over while it is open, unless he picked for that
//     day, and never while a form or an invoice is open on screen.
// Synthetic contracts and dates only.

const clock = pinClock(test, 'America/Denver', '2026-09-29T10:00:00-06:00');
// The minute check that notices a call day turning over while Work is open.
const minuteChecks = [];
const underlyingSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => { if (ms === 60000) minuteChecks.push(fn); return underlyingSetInterval(fn, ms, ...rest); };
const screens = await loadScreens([
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
].join('\n'));
// Practice's sub-views pull in the whole records layer, so the dashboard is
// bundled with the real records modules (as tests/practice/practice-sub-nav
// does); it only renders here, and with nobody signed in nothing is stored.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
let LocumDashboard;
try {
  ({ LocumDashboard } = await loadScreens('export {default as LocumDashboard} from "./src/components/features/locum/LocumDashboard.jsx";', { real: ['lib/supabase', 'utils/storageScope', 'utils/privateVault'] }));
} finally { delete globalThis.localStorage; }
const TODAY = '2026-09-29';

const hourly = (id, facility) => ({ id, facility, payModel: 'hourly', hourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15, callStipend: 0, startDate: '2026-01-01', endDate: '2026-12-31' });
const NORTH = hourly('c-north', 'Synthetic North Hospital');
const SOUTH = hourly('c-south', 'Synthetic South Hospital');
const EAST = hourly('c-east', 'Synthetic East Clinic');
const CONTRACTS = [NORTH, SOUTH, EAST];
const GROUP = { id: 'c-group', facility: 'Synthetic Valley Neurosurgical Group', payModel: 'daily', dayRate: 2000, callStipend: 1000, startDate: '2026-01-01', endDate: '2028-12-31' };

const row = (contractId, date = TODAY) => ({ id: `s-${contractId}-${date}`, contractId, date, kind: 'call', expected: 1000 });
const picker = (tree) => find(tree, n => n.type === 'select' && n.props['aria-labelledby'] === 'work-log-contract', 'Logging against picker');
// A few renders, so anything an effect changes after a render has landed
// before the picker is read.
const settle = (m) => { m.render(); m.render(); return m.render(); };
const shown = (m) => picker(settle(m)).props.value;
const pick = (m, id) => picker(m.render()).props.onChange({ target: { value: id } });
const openModal = (tree) => nodes(tree).find(n => n.props?.open === true && typeof n.props?.onClose === 'function');
const work = ({ scheduleDays = [], storage = {}, props = {}, contracts = CONTRACTS, dutyDays } = {}) =>
  mount(screens.WorkLog, { data: { locumContracts: contracts, workLog: [], scheduleDays, ...(dutyDays ? { dutyDays } : {}) }, storage, props });

// ── 2. An explicit open wins ─────────────────────────────────────────

test('2: "Needs invoicing" opens that contract on a day the schedule shows another', () => {
  // As LocumDashboard hands it over: the contract written as the one last used, and passed in.
  const m = work({ scheduleDays: [row(SOUTH.id)], storage: { lastContract: NORTH.id }, props: { openContractId: NORTH.id } });
  assert.equal(shown(m), NORTH.id, 'the contract that needs invoicing, not the scheduled one');
  assert.equal(shown(m), NORTH.id, 'and it stays open');
  // An open is not a pick for the day: the next visit to Work follows the
  // schedule, and with nothing scheduled it is still the contract last used.
  assert.equal(shown(work({ scheduleDays: [row(SOUTH.id)], storage: { ...m.storage } })), SOUTH.id);
  assert.equal(shown(work({ scheduleDays: [], storage: { ...m.storage } })), NORTH.id);
});

test('2: a hand-off that arrives while Work is already open is taken too', () => {
  const props = { openContractId: null };
  const m = work({ scheduleDays: [row(SOUTH.id)], props });
  assert.equal(shown(m), SOUTH.id);
  props.openContractId = EAST.id;
  assert.equal(shown(m), EAST.id);
});

test('2: Invoices hands its contract to Work, and any other way into Work carries none', () => {
  const m = mount(LocumDashboard, { data: { locumContracts: CONTRACTS }, props: { initialSub: 'invoices' } });
  Object.assign(globalThis.__screen.app, { plan: 'locum', isDevMode: false, limitedLaunch: { enabled: false }, practiceReadOnly: false });
  find(m.render(), n => typeof n.props?.onOpenContract === 'function', 'Invoices').props.onOpenContract(EAST.id);
  const workLog = (tree) => find(tree, n => 'billDraft' in (n.props || {}), 'WorkLog');
  assert.equal(workLog(m.render()).props.openContractId, EAST.id, 'Work opens on the contract that needs invoicing');
  click(m, 'Sched.');
  click(m, 'Work');
  assert.equal(workLog(m.render()).props.openContractId, null, 'coming back by the tab opens on the default');
});

// ── 3. A pick holds for its call day ─────────────────────────────────

test('3: a pick made on a scheduled day holds after leaving Work and coming back', () => {
  const days = [row(SOUTH.id)];
  const m = work({ scheduleDays: days });
  assert.equal(shown(m), SOUTH.id);
  pick(m, EAST.id);
  assert.deepEqual(readContractPick(m.storage.contractPick), { contractId: EAST.id, callDay: TODAY });
  const back = work({ scheduleDays: days, storage: { ...m.storage } });
  assert.equal(shown(back), EAST.id, 'the pick for today, not the schedule');
});

test("3: a pick from an earlier call day does not outrank today's schedule", () => {
  const m = work({ scheduleDays: [row(SOUTH.id)], storage: { lastContract: EAST.id, contractPick: contractPickValue(EAST.id, '2026-09-28') } });
  assert.equal(shown(m), SOUTH.id);
});

test("3: time logged for another day is not today's pick: the view goes back to the schedule", () => {
  const days = [row(SOUTH.id)];
  const m = work({ scheduleDays: days });
  assert.equal(shown(m), SOUTH.id);
  click(m, 'Log past time');
  find(field(m.render(), 'Contract'), n => n.type === 'select', 'form contract').props.onChange({ target: { value: EAST.id } });
  find(m.render(), n => n.type === 'button' && textOf(n) === 'Other…' && String(n.props.onClick).includes('pickDate'), 'date Other').props.onClick();
  find(m.render(), n => n.type === 'input' && n.props.type === 'date', 'date input').props.onChange({ target: { value: '2026-09-27' } });
  field(m.render(), 'Start time').props.onCommit('09:00');
  field(m.render(), 'End time').props.onCommit('09:30');
  click(m, 'Log it');
  const yes = nodes(m.render()).find(n => n.type === 'button' && textOf(n).includes('Yes, log it here'));
  if (yes) yes.props.onClick();
  const saved = m.calls.find(c => c[0] === 'add' && c[1] === 'workLog')?.[2];
  assert.equal(saved?.contractId, EAST.id, 'the entry is saved where it was logged');
  assert.equal(shown(m), SOUTH.id, "the form closed: today's schedule, as the next visit will show");
  assert.equal(m.storage.lastContract, EAST.id, 'remembered as the contract last used');
  assert.equal(m.storage.contractPick, undefined, 'not as a pick for today');
  assert.equal(shown(work({ scheduleDays: days, storage: { ...m.storage } })), SOUTH.id, "coming back, today's schedule again");
  assert.equal(shown(work({ scheduleDays: [], storage: { ...m.storage } })), EAST.id, 'with nothing scheduled, the contract last used, as before');
});

// ── 4. A running timer keeps its contract ────────────────────────────

const TIMER = { contractId: NORTH.id, type: 'Call', startedAt: '2026-09-29T14:40:00.000Z' }; // 8:40 AM, the Sep 29 call day
const OVERNIGHT = { ...TIMER, startedAt: '2026-09-29T12:40:00.000Z' }; // 6:40 AM, the Sep 28 call day

test('4: a restored timer keeps its contract while it runs, over the schedule and a pick for today', () => {
  for (const timer of [TIMER, OVERNIGHT]) {
    const m = work({ scheduleDays: [row(SOUTH.id)], storage: { timer, lastContract: EAST.id, contractPick: contractPickValue(EAST.id, TODAY) } });
    assert.equal(shown(m), NORTH.id);
    assert.ok(textOf(m.render()).includes('Call in progress'));
  }
});

test('4: stopping a restored timer in its own call day does not flip the picker to the schedule', () => {
  const m = work({ scheduleDays: [row(SOUTH.id)], storage: { timer: TIMER } });
  assert.equal(shown(m), NORTH.id);
  click(m, 'Stop & Log');
  const saved = m.calls.find(c => c[0] === 'add' && c[1] === 'workLog')?.[2];
  assert.equal(saved?.contractId, NORTH.id, "the entry is saved on the timer's contract");
  assert.equal(m.storage.timer, undefined, 'the timer is over');
  assert.equal(shown(m), NORTH.id, 'the picker stays where the timer was');
  assert.equal(shown(m), NORTH.id);
  assert.deepEqual(readContractPick(m.storage.contractPick), { contractId: NORTH.id, callDay: TODAY }, 'and the next visit today agrees');
});

test('4: discarding a restored timer does not flip the picker either', () => {
  const m = work({ scheduleDays: [row(SOUTH.id)], storage: { timer: TIMER } });
  click(m, 'Discard');
  assert.equal(m.storage.timer, undefined);
  assert.equal(shown(m), NORTH.id);
});

test("4: stopping or discarding last night's timer after its call day ended hands the picker to today's schedule", () => {
  for (const end of ['Stop & Log', 'Discard']) {
    const m = work({ scheduleDays: [row(SOUTH.id)], storage: { timer: OVERNIGHT } });
    assert.equal(shown(m), NORTH.id, 'while it runs: the timer');
    click(m, end);
    assert.equal(m.storage.timer, undefined);
    if (end === 'Stop & Log') {
      const saved = m.calls.find(c => c[0] === 'add' && c[1] === 'workLog')?.[2];
      assert.equal(saved?.contractId, NORTH.id, "the entry is saved on the timer's contract");
      assert.equal(saved?.callDay, '2026-09-28');
    }
    assert.equal(shown(m), SOUTH.id, `${end}: the Sep 28 call day is over, so the Sep 29 schedule`);
    assert.equal(m.storage.contractPick, undefined, 'nothing is held for today');
    click(m, 'Got a call? Start the timer');
    assert.equal(m.storage.timer?.contractId, SOUTH.id, 'the next timer bills the scheduled contract');
  }
});

test('4: a contract picked for today while a timer runs stays after the timer stops', () => {
  const m = work({ scheduleDays: [row(SOUTH.id)], storage: { timer: OVERNIGHT } });
  pick(m, EAST.id);
  assert.equal(shown(m), EAST.id);
  click(m, 'Stop & Log');
  assert.equal(m.calls.find(c => c[0] === 'add' && c[1] === 'workLog')?.[2]?.contractId, NORTH.id, "the time goes to the timer's contract");
  assert.equal(shown(m), EAST.id, 'the pick stays on screen');
});

test('4: a timer started on this visit keeps its contract when the call day turns over under it, until it stops', () => {
  clock.setNow('2026-09-29T06:50:00-06:00');
  try {
    const m = work({ scheduleDays: [row(NORTH.id, '2026-09-28'), row(SOUTH.id)] });
    assert.equal(shown(m), NORTH.id, "last night's call");
    click(m, 'Got a call? Start the timer');
    clock.setNow('2026-09-29T07:10:00-06:00');
    m.render();
    assert.equal(shown(m), NORTH.id, 'still on the timer while it runs');
    click(m, 'Stop & Log');
    assert.equal(m.calls.find(c => c[0] === 'add' && c[1] === 'workLog')?.[2]?.contractId, NORTH.id);
    assert.equal(shown(m), SOUTH.id, "after it stops, the Sep 28 call day is over: today's schedule");
  } finally { clock.setNow('2026-09-29T10:00:00-06:00'); }
});

// ── 5. Late schedule data and a call day that turns over ─────────────

test('5: a schedule that arrives after Work opened becomes the default', () => {
  const m = work({ storage: { lastContract: NORTH.id } });
  assert.equal(shown(m), NORTH.id);
  m.data.scheduleDays = [row(EAST.id)]; // a cloud load or a CallSync sync lands
  assert.equal(shown(m), EAST.id);
});

test('5: ...but never over a contract picked for today', () => {
  const m = work({ storage: { lastContract: NORTH.id } });
  pick(m, SOUTH.id);
  m.data.scheduleDays = [row(EAST.id)];
  assert.equal(shown(m), SOUTH.id);
});

test('5: the call day turning over while Work is open moves the default to the new day', () => {
  clock.setNow('2026-09-29T06:50:00-06:00');
  try {
    const days = [row(NORTH.id, '2026-09-28'), row(SOUTH.id, '2026-09-29')];
    const m = work({ scheduleDays: days, storage: { lastContract: EAST.id } });
    assert.equal(shown(m), NORTH.id, "6:50 AM: last night's call");
    const check = minuteChecks.at(-1);
    assert.ok(check, 'a minute check is running');
    clock.setNow('2026-09-29T07:01:00-06:00');
    check();
    assert.equal(shown(m), SOUTH.id, "7:01 AM: today's scheduled contract");

    // A pick made for last night's call day does not hold into the new one.
    clock.setNow('2026-09-29T06:50:00-06:00');
    const picked = work({ scheduleDays: days, storage: { lastContract: EAST.id } });
    pick(picked, EAST.id);
    assert.equal(shown(picked), EAST.id);
    clock.setNow('2026-09-29T07:01:00-06:00');
    minuteChecks.at(-1)();
    assert.equal(shown(picked), SOUTH.id, 'the Sep 28 pick gives way to the Sep 29 schedule');
    // One made in the new call day does.
    pick(picked, EAST.id);
    minuteChecks.at(-1)();
    assert.equal(shown(picked), EAST.id);
  } finally { clock.setNow('2026-09-29T10:00:00-06:00'); }
});

test('5: nothing swaps the contract while a form is open on it; the default applies once it closes', () => {
  const m = work({ storage: { lastContract: NORTH.id } });
  click(m, 'Log past time');
  m.render();
  m.data.scheduleDays = [row(EAST.id)];
  const tree = settle(m);
  assert.equal(picker(tree).props.value, NORTH.id, 'held while the form is open');
  const formContract = nodes(tree).find(n => n.type === 'select' && n.props['aria-labelledby'] !== 'work-log-contract');
  assert.equal(formContract?.props.value, NORTH.id, 'the entry being typed still bills the contract it was opened on');
  openModal(tree).props.onClose();
  assert.equal(shown(m), EAST.id, 'closed: the schedule default applies');
});

test('5: Days & call tells Work while a day or an invoice is open, so it is held too', () => {
  const calls = [];
  const duty = mount(screens.DutyLog, { data: { locumContracts: [GROUP], dutyDays: [] }, props: { contract: GROUP, onBusyChange: (b) => calls.push(b) } });
  duty.render();
  click(duty, '+ Log a day');
  duty.render();
  assert.equal(calls.at(-1), true, 'busy while the day is open');
  openModal(duty.render()).props.onClose();
  duty.render();
  assert.equal(calls.at(-1), false, 'free once it closes');

  const m = work({ contracts: [NORTH, GROUP], dutyDays: [], storage: { lastContract: GROUP.id } });
  const engine = find(m.render(), n => typeof n.props?.onBusyChange === 'function', 'Days & call');
  engine.props.onBusyChange(true);
  settle(m);
  m.data.scheduleDays = [row(NORTH.id)];
  assert.equal(shown(m), GROUP.id, 'held while Days & call has something open');
  engine.props.onBusyChange(false);
  assert.equal(shown(m), NORTH.id, 'then the schedule default applies');
});
