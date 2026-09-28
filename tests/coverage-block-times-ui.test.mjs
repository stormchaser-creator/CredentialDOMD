import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount as mountScreen, nodes, textOf, find, field, click, pinClock } from './harness/component-harness.mjs';

// Coverage blocks with times in the app: the contract form's start and end
// times, the list that shows them, and the Work Log filing work under the
// block's call days. Driven through the real components
// (tests/harness/component-harness.mjs). Synthetic data only.

pinClock(test, 'America/Chicago', '2026-11-20T12:00:00-06:00');
const screens = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as Contracts} from "./src/components/features/locum/Contracts.jsx";');

const BASE = { facility: 'Synthetic Regional Hospital', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15 };
const UNTIMED = { ...BASE, id: 'c1', coveragePeriods: [{ start: '2026-09-25', end: '2026-09-27' }], startDate: '2026-09-25', endDate: '2026-09-27' };
const TIMED = { ...BASE, id: 'c1', coveragePeriods: [{ start: '2026-09-25', startTime: '16:00', end: '2026-09-28', endTime: '07:00' }], startDate: '2026-09-25', endDate: '2026-09-28' };
const SIX = { ...BASE, id: 'c1', coveragePeriods: [{ start: '2026-11-05', startTime: '06:00', end: '2026-11-12', endTime: '06:00' }], startDate: '2026-11-05', endDate: '2026-11-12' };

const mount = (name, { contracts, workLog = [], invoices = [], ...rest } = {}) =>
  mountScreen(screens[name], { data: { locumContracts: contracts, workLog: [...workLog], invoices }, ...rest });
const inputs = (tree) => nodes(tree).filter(n => n.type === 'input' && typeof n.props['aria-label'] === 'string' && n.props['aria-label'].startsWith('Block '));
const input = (m, label) => find(m.render(), n => n.type === 'input' && n.props['aria-label'] === label, label);
const openContract = (m) => {
  const card = find(m.render(), n => n.type === 'div' && n.key === 'c1', 'contract card');
  nodes(card).filter(n => n.type === 'button')[0].props.onClick();
};
const saved = (m) => m.calls.find(c => c[0] === 'edit' || c[0] === 'add')?.[2];

// ── The contract form ────────────────────────────────────────────

test('each coverage block has a start and an end time, phone-sized (16px), both optional', () => {
  const m = mount('Contracts', { contracts: [UNTIMED] });
  openContract(m);
  const fields = inputs(m.render());
  assert.deepEqual(fields.map(n => [n.props['aria-label'], n.props.type]), [
    ['Block 1 start date', 'date'], ['Block 1 start time (optional)', 'time'],
    ['Block 1 end date', 'date'], ['Block 1 end time (optional)', 'time'],
  ]);
  for (const n of fields) assert.equal(n.props.style.fontSize, 16, n.props['aria-label']);
  assert.equal(input(m, 'Block 1 start time (optional)').props.value, '');
  assert.match(textOf(field(m.render(), 'Coverage dates')), /Times are optional: enter them when the agreement states them\./);
  const hint = field(m.render(), 'Coverage dates').props.hint;
  assert.match(hint, /When the agreement states times, add them and enter the date coverage actually ends: Sep 25 4:00 PM to Sep 28 7:00 AM is three call days/);
  assert.doesNotMatch(hint, /\u{2014}/u, 'no em dash');
});

test('times entered on a block save into coveragePeriods as HH:MM, and the list shows the real window', () => {
  const m = mount('Contracts', { contracts: [UNTIMED] });
  openContract(m);
  input(m, 'Block 1 end date').props.onChange({ target: { value: '2026-09-28' } });
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '16:00' } });
  input(m, 'Block 1 end time (optional)').props.onChange({ target: { value: '07:00' } });
  click(m, 'Save');
  const c = saved(m);
  assert.deepEqual(c.coveragePeriods, [{ start: '2026-09-25', end: '2026-09-28', startTime: '16:00', endTime: '07:00' }]);
  assert.equal(c.endDate, '2026-09-28');
  assert.match(m.html(), /Sep 25, 4:00 PM to Sep 28, 7:00 AM/);
});

test('a block saved without times keeps exactly { start, end }, even after a time was typed and cleared', () => {
  const m = mount('Contracts', { contracts: [UNTIMED] });
  openContract(m);
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '16:00' } });
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '' } });
  click(m, 'Save');
  assert.deepEqual(saved(m).coveragePeriods, [{ start: '2026-09-25', end: '2026-09-27' }]);
  assert.deepEqual(Object.keys(saved(m).coveragePeriods[0]), ['start', 'end']);
});

test('a block that ends before it starts is refused with the reason, and nothing is saved', () => {
  const m = mount('Contracts', { contracts: [UNTIMED] });
  openContract(m);
  input(m, 'Block 1 end date').props.onChange({ target: { value: '2026-09-25' } });
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '16:00' } });
  input(m, 'Block 1 end time (optional)').props.onChange({ target: { value: '07:00' } });
  click(m, 'Save');
  assert.equal(m.calls.length, 0);
  assert.match(m.html(), /Block 1 ends before it starts \(Sep 25, 4:00 PM to Sep 25, 7:00 AM\)\. Check its dates and times\./);
});

test('a contract with times opens with them in the inputs and lists its window', () => {
  const m = mount('Contracts', { contracts: [TIMED] });
  assert.match(m.html(), /Sep 25, 4:00 PM to Sep 28, 7:00 AM/);
  openContract(m);
  assert.equal(input(m, 'Block 1 start time (optional)').props.value, '16:00');
  assert.equal(input(m, 'Block 1 end time (optional)').props.value, '07:00');
  click(m, 'Save');
  assert.deepEqual(saved(m).coveragePeriods, TIMED.coveragePeriods);
});

// ── The Work Log ─────────────────────────────────────────────────

const save = (m, label) => {
  click(m, label);
  const yes = nodes(m.render()).find(n => n.type === 'button' && textOf(n).includes('Yes, log it here'));
  if (yes) yes.props.onClick();
};
function logPastTime(m, date, start, end, type = 'Call') {
  click(m, 'Log past time');
  let tree = m.render();
  find(tree, n => n.type === 'button' && textOf(n) === 'Other…' && n.props.onClick && String(n.props.onClick).includes('pickDate'), 'date Other').props.onClick();
  tree = m.render();
  find(tree, n => n.type === 'input' && n.props.type === 'date', 'date input').props.onChange({ target: { value: date } });
  if (type !== 'Call') find(m.render(), n => n.type === 'button' && textOf(n) === type, `type ${type}`).props.onClick();
  field(m.render(), 'Start time').props.onCommit(start);
  field(m.render(), 'End time').props.onCommit(end);
  save(m, 'Log it');
}
const adds = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'workLog').map(c => c[2]);

test('a 6 AM to 6 AM block: 6:15 AM work on Nov 6 files under Nov 6, not Nov 5', () => {
  const m = mount('WorkLog', { contracts: [SIX] });
  logPastTime(m, '2026-11-06', '06:15', '06:45');
  const [row] = adds(m);
  assert.equal(row.callDay, '2026-11-06');
  assert.equal(row.date, '2026-11-06');
  assert.equal(m.dialogs.length, 0, 'inside the block: no schedule question');
  assert.match(m.html(), /Stipend day: 0h 30m of the 4h covered by the stipend logged/);
});

test('the sign-out after the block ended: filed under the last call day, and the notice says what bills outside the stipend', () => {
  const m = mount('WorkLog', { contracts: [TIMED] });
  logPastTime(m, '2026-09-28', '06:30', '08:45');
  const [row] = adds(m);
  assert.equal(row.callDay, '2026-09-27');
  assert.equal(row.billedMin, 135);
  const html = m.html();
  assert.match(html, /Stipend day: 0h 30m of the 4h covered by the stipend logged/);
  assert.match(html, /This Call has 105 min after the call ended at 7:00 AM: that time bills at \$300\.00\/hr, outside the stipend\./);
});

test('the Work Log day shows the time outside the call hours and its dollars in the day total', () => {
  const entry = { id: 'w1', createdAt: '2026-09-28T13:00:00Z', contractId: 'c1', type: 'Rounding', date: '2026-09-25', callDay: '2026-09-25',
    startTime: new Date(2026, 8, 25, 15, 30).toISOString(), endTime: new Date(2026, 8, 25, 19, 30).toISOString(), durationMin: 240, billedMin: 240,
    description: 'Synthetic rounds', privateNote: '', invoiceId: null };
  const m = mount('WorkLog', { contracts: [TIMED], workLog: [entry] });
  const html = m.html();
  assert.match(html, /3h 30m logged · first 4h in the stipend · 0h 30m outside the call hours, billed hourly/);
  // $3,000 stipend + 30 min at $300/hr before the call began.
  assert.match(html, /\$3,150\.00/);
});
