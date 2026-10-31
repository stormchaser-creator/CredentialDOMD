import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, field, click, pinClock } from './harness/component-harness.mjs';
import { scheduledContractsOn } from '../src/utils/scheduledContract.js';

// Ticket 292fcbce ("Logging against"), the entry's own date: Log past time
// opens on the contract the schedule shows for the date being logged, and
// follows that date when it is changed, unless a contract was picked by
// hand. With nothing scheduled on the date the form keeps the page's
// contract, as before; with several, a call row beats a day-only row, then
// the contract last used, and the note under the picker names the others.
// Synthetic contracts and dates only.

const clock = pinClock(test, 'America/Denver', '2026-09-29T10:00:00-06:00');
const { WorkLog } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');
const TODAY = '2026-09-29';
const YESTERDAY = '2026-09-28';

const hourly = (id, facility, extra = {}) => ({ id, facility, payModel: 'hourly', hourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15, callStipend: 0, startDate: '2026-01-01', endDate: '2026-12-31', ...extra });
const NORTH = hourly('c-north', 'Synthetic North Hospital');
const SOUTH = hourly('c-south', 'Synthetic South Hospital');
const EAST = hourly('c-east', 'Synthetic East Clinic');
const CONTRACTS = [NORTH, SOUTH, EAST];
const GROUP = { id: 'c-group', facility: 'Synthetic Valley Group', payModel: 'daily', dayRate: 2000, callStipend: 1000, startDate: '2026-01-01', endDate: '2028-12-31' };

const row = (contractId, date = TODAY, kind = 'call') => ({ id: `s-${contractId}-${date}-${kind}`, contractId, date, kind, expected: 1000 });
const picker = (tree) => find(tree, n => n.type === 'select' && n.props['aria-labelledby'] === 'work-log-contract', 'Logging against picker');
const formPicker = (m) => find(field(m.render(), 'Contract'), n => n.type === 'select', 'form contract');
const formValue = (m) => { m.render(); m.render(); return formPicker(m).props.value; };
const formText = (m) => textOf(field(m.render(), 'Contract'));
const work = ({ scheduleDays = [], storage = {}, contracts = CONTRACTS } = {}) =>
  mount(WorkLog, { data: { locumContracts: contracts, workLog: [], scheduleDays }, storage });
const pressDay = (m, label) => find(m.render(), n => n.type === 'button' && textOf(n) === label, label).props.onClick();
const pickDate = (m, date) => {
  const input = () => nodes(m.render()).find(n => n.type === 'input' && n.props.type === 'date');
  if (!input()) find(m.render(), n => n.type === 'button' && textOf(n) === 'Other…' && String(n.props.onClick).includes('pickDate'), 'date Other').props.onClick();
  find(m.render(), n => n === input() || (n.type === 'input' && n.props.type === 'date'), 'date input').props.onChange({ target: { value: date } });
};
const save = (m) => {
  field(m.render(), 'Start time').props.onCommit('09:00');
  field(m.render(), 'End time').props.onCommit('09:30');
  click(m, 'Log it');
  const yes = nodes(m.render()).find(n => n.type === 'button' && textOf(n).includes('Yes, log it here'));
  if (yes) yes.props.onClick();
  return m.calls.filter(c => c[0] === 'add' && c[1] === 'workLog').at(-1)?.[2];
};

// ── The pure rule ────────────────────────────────────────────────────

test('scheduledContractsOn: the rows on that date only, call before day, then the contract last used', () => {
  const days = [row(NORTH.id, YESTERDAY, 'day'), row(SOUTH.id, YESTERDAY, 'call'), row(EAST.id, TODAY), { id: 'v', date: YESTERDAY, kind: 'vacation' }];
  assert.deepEqual(scheduledContractsOn(days, CONTRACTS, YESTERDAY).map(s => s.id), [SOUTH.id, NORTH.id], 'call row first, whatever order saved');
  assert.deepEqual(scheduledContractsOn(days, CONTRACTS, TODAY).map(s => s.id), [EAST.id]);
  assert.deepEqual(scheduledContractsOn(days, CONTRACTS, '2026-09-27'), [], 'nothing scheduled');
  assert.deepEqual(scheduledContractsOn(days, CONTRACTS, ''), [], 'no date');
  const two = [row(NORTH.id, YESTERDAY), row(SOUTH.id, YESTERDAY)];
  assert.deepEqual(scheduledContractsOn(two, CONTRACTS, YESTERDAY).map(s => s.id), [NORTH.id, SOUTH.id], 'tie: calendar order');
  assert.deepEqual(scheduledContractsOn(two, CONTRACTS, YESTERDAY, { prefer: SOUTH.id }).map(s => s.id), [SOUTH.id, NORTH.id], 'tie: the contract last used');
});

test('scheduledContractsOn: a contract that has since ended still counts on a date its term covered', () => {
  const OLD = hourly('c-old', 'Synthetic Old Hospital', { startDate: '2026-03-01', endDate: '2026-04-30' });
  assert.deepEqual(scheduledContractsOn([row(OLD.id, '2026-04-10')], [OLD, NORTH], '2026-04-10').map(s => s.id), [OLD.id]);
  assert.deepEqual(scheduledContractsOn([row(OLD.id, '2026-04-10')], [{ ...OLD, customFields: { archivedAt: '2026-05-01' } }, NORTH], '2026-04-10'), [], 'not an archived one');
});

// ── Log past time follows the entry's date ───────────────────────────

test("the form opens on today's scheduled contract and follows the date to yesterday's", () => {
  const m = work({ scheduleDays: [row(SOUTH.id, TODAY), row(NORTH.id, YESTERDAY)], storage: { lastContract: EAST.id } });
  assert.equal(picker(m.render()).props.value, SOUTH.id);
  click(m, 'Log past time');
  assert.equal(formValue(m), SOUTH.id, 'today: the schedule');
  pressDay(m, 'Yesterday');
  assert.equal(formValue(m), NORTH.id, "yesterday: yesterday's schedule, no pick needed");
  assert.ok(formText(m).includes('On your schedule for this date'), 'and it says why');
  pressDay(m, 'Today');
  assert.equal(formValue(m), SOUTH.id, 'back to today');
  pressDay(m, 'Yesterday');
  const saved = save(m);
  assert.equal(saved?.contractId, NORTH.id, 'the entry bills the contract the schedule showed on its date');
  assert.equal(saved?.callDay, YESTERDAY);
});

test('a date typed in follows its schedule; a date with nothing scheduled keeps the page contract, as before', () => {
  const m = work({ scheduleDays: [row(SOUTH.id, TODAY), row(EAST.id, '2026-09-20')] });
  click(m, 'Log past time');
  pickDate(m, '2026-09-20');
  assert.equal(formValue(m), EAST.id);
  pickDate(m, '2026-09-21');
  assert.equal(formValue(m), SOUTH.id, "nothing on Sep 21: the page's contract");
  assert.ok(!formText(m).includes('On your schedule'), 'and no schedule note');
});

test('a contract picked in the form stays when the date changes', () => {
  const m = work({ scheduleDays: [row(SOUTH.id, TODAY), row(NORTH.id, YESTERDAY)] });
  click(m, 'Log past time');
  formPicker(m).props.onChange({ target: { value: EAST.id } });
  pressDay(m, 'Yesterday');
  assert.equal(formValue(m), EAST.id, 'his pick wins');
  assert.equal(save(m)?.contractId, EAST.id);
});

test("a contract picked on the page for today stays for today's entries; yesterday still follows the schedule", () => {
  const m = work({ scheduleDays: [row(SOUTH.id, TODAY), row(NORTH.id, YESTERDAY)] });
  picker(m.render()).props.onChange({ target: { value: EAST.id } });
  click(m, 'Log past time');
  assert.equal(formValue(m), EAST.id, "today: the page's pick");
  pressDay(m, 'Yesterday');
  assert.equal(formValue(m), NORTH.id, "yesterday: yesterday's schedule");
});

test('two contracts on the date: the call row is the default and the other is named', () => {
  const m = work({ scheduleDays: [row(EAST.id, YESTERDAY, 'day'), row(NORTH.id, YESTERDAY, 'call')] });
  click(m, 'Log past time');
  pressDay(m, 'Yesterday');
  assert.equal(formValue(m), NORTH.id);
  assert.ok(formText(m).includes('Also scheduled: Synthetic East Clinic (day)'), formText(m));
});

test('a day-rate agreement on the date is not a time default: the form keeps the page contract', () => {
  const m = work({ contracts: [NORTH, SOUTH, GROUP], scheduleDays: [row(GROUP.id, YESTERDAY)], storage: { lastContract: SOUTH.id } });
  click(m, 'Log past time');
  pressDay(m, 'Yesterday');
  assert.equal(formValue(m), SOUTH.id);
});

test('a schedule that loads while the form is open does not swap the form contract', () => {
  const m = work({ storage: { lastContract: NORTH.id } });
  click(m, 'Log past time');
  m.render();
  m.data.scheduleDays = [row(EAST.id, TODAY)];
  assert.equal(formValue(m), NORTH.id, 'worked out when the form opened');
  pressDay(m, 'Yesterday');
  pressDay(m, 'Today');
  assert.equal(formValue(m), EAST.id, 'changing the date looks again');
});

test("at 3 AM on last night's call the form opens on last night's contract, as the page does", () => {
  // The page's own rule (scheduledContract.js): at 3 AM he is still on the
  // previous day's call. Today's calendar date in the form must not jump to
  // the contract whose day has not started yet.
  clock.setNow('2026-09-29T03:00:00-06:00');
  try {
    const m = work({ scheduleDays: [row(SOUTH.id, YESTERDAY), row(NORTH.id, TODAY)] });
    assert.equal(picker(m.render()).props.value, SOUTH.id, "the page: last night's call");
    click(m, 'Log past time');
    assert.equal(formValue(m), SOUTH.id, 'the form agrees with the page');
    assert.ok(!formText(m).includes('On your schedule for this date'), 'no note claiming it is booked on the calendar date');
    pressDay(m, 'Yesterday');
    assert.equal(formValue(m), SOUTH.id, "yesterday: yesterday's schedule");
  } finally {
    clock.setNow('2026-09-29T10:00:00-06:00');
  }
});
