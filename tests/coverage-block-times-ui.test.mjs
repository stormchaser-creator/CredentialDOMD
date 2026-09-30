import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount as mountScreen, nodes, textOf, find, field, click, pinClock } from './harness/component-harness.mjs';
import { computeBilling } from '../src/utils/billing.js';

// Coverage blocks with times in the app: the contract form's start and end
// times, the list that shows them, and the Work Log filing work under the
// block's call days. Driven through the real components
// (tests/harness/component-harness.mjs). Synthetic data only.

const clock = pinClock(test, 'America/Chicago', '2026-11-20T12:00:00-06:00');
const screens = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as Contracts} from "./src/components/features/locum/Contracts.jsx";');

const BASE = { facility: 'Synthetic Regional Hospital', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15 };
const UNTIMED = { ...BASE, id: 'c1', coveragePeriods: [{ start: '2026-10-16', end: '2026-10-18' }], startDate: '2026-10-16', endDate: '2026-10-18' };
const TIMED = { ...BASE, id: 'c1', coveragePeriods: [{ start: '2026-10-16', startTime: '16:00', end: '2026-10-19', endTime: '07:00' }], startDate: '2026-10-16', endDate: '2026-10-19' };
const SIX = { ...BASE, id: 'c1', coveragePeriods: [{ start: '2026-11-12', startTime: '06:00', end: '2026-11-19', endTime: '06:00' }], startDate: '2026-11-12', endDate: '2026-11-19' };

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
  assert.match(hint, /When the agreement states times, add them and enter the date coverage actually ends: Oct 16 4:00 PM to Oct 19 7:00 AM is three call days/);
  assert.doesNotMatch(hint, /\u{2014}/u, 'no em dash');
});

test('times entered on a block save into coveragePeriods as HH:MM, and the list shows the real window', () => {
  const m = mount('Contracts', { contracts: [UNTIMED] });
  openContract(m);
  input(m, 'Block 1 end date').props.onChange({ target: { value: '2026-10-19' } });
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '16:00' } });
  input(m, 'Block 1 end time (optional)').props.onChange({ target: { value: '07:00' } });
  click(m, 'Save');
  const c = saved(m);
  // Stamped with the zone the times are on (this device's, Central here).
  assert.deepEqual(c.coveragePeriods, [{ start: '2026-10-16', end: '2026-10-19', startTime: '16:00', endTime: '07:00', tz: 'America/Chicago' }]);
  assert.equal(c.endDate, '2026-10-19');
  assert.match(m.html(), /Oct 16, 4:00 PM to Oct 19, 7:00 AM/);
});

test('a block saved without times keeps exactly { start, end }, even after a time was typed and cleared', () => {
  const m = mount('Contracts', { contracts: [UNTIMED] });
  openContract(m);
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '16:00' } });
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '' } });
  click(m, 'Save');
  assert.deepEqual(saved(m).coveragePeriods, [{ start: '2026-10-16', end: '2026-10-18' }]);
  assert.deepEqual(Object.keys(saved(m).coveragePeriods[0]), ['start', 'end']);
});

test('a block that ends before it starts is refused with the reason, and nothing is saved', () => {
  const m = mount('Contracts', { contracts: [UNTIMED] });
  openContract(m);
  input(m, 'Block 1 end date').props.onChange({ target: { value: '2026-10-16' } });
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '16:00' } });
  input(m, 'Block 1 end time (optional)').props.onChange({ target: { value: '07:00' } });
  click(m, 'Save');
  assert.equal(m.calls.length, 0);
  assert.match(m.html(), /Block 1 ends before it starts \(Oct 16, 4:00 PM to Oct 16, 7:00 AM\)\. Check its dates and times\./);
});

test('a contract with times opens with them in the inputs and lists its window', () => {
  const m = mount('Contracts', { contracts: [TIMED] });
  assert.match(m.html(), /Oct 16, 4:00 PM to Oct 19, 7:00 AM/);
  openContract(m);
  assert.equal(input(m, 'Block 1 start time (optional)').props.value, '16:00');
  assert.equal(input(m, 'Block 1 end time (optional)').props.value, '07:00');
  click(m, 'Save');
  assert.deepEqual(saved(m).coveragePeriods, [{ ...TIMED.coveragePeriods[0], tz: 'America/Chicago' }]);
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

test('a 6 AM to 6 AM block: 6:15 AM work on Nov 13 files under Nov 13, not Nov 12', () => {
  const m = mount('WorkLog', { contracts: [SIX] });
  logPastTime(m, '2026-11-13', '06:15', '06:45');
  const [row] = adds(m);
  assert.equal(row.callDay, '2026-11-13');
  assert.equal(row.date, '2026-11-13');
  assert.equal(m.dialogs.length, 0, 'inside the block: no schedule question');
  assert.match(m.html(), /Stipend day: 0h 30m of the 4h covered by the stipend logged/);
});

test('the sign-out after the block ended: filed under the last call day, and the notice says what bills outside the stipend', () => {
  const m = mount('WorkLog', { contracts: [TIMED] });
  logPastTime(m, '2026-10-19', '06:30', '08:45');
  const [row] = adds(m);
  assert.equal(row.callDay, '2026-10-18');
  assert.equal(row.billedMin, 135);
  const html = m.html();
  assert.match(html, /Stipend day: 0h 30m of the 4h covered by the stipend logged/);
  assert.match(html, /This Call has 105 min after the call ended at 7:00 AM: that time bills at \$300\.00\/hr, outside the stipend\./);
});

test('the Work Log day shows the time outside the call hours and its dollars in the day total', () => {
  const entry = { id: 'w1', createdAt: '2026-10-19T13:00:00Z', contractId: 'c1', type: 'Rounding', date: '2026-10-16', callDay: '2026-10-16',
    startTime: new Date(2026, 9, 16, 15, 30).toISOString(), endTime: new Date(2026, 9, 16, 19, 30).toISOString(), durationMin: 240, billedMin: 240,
    description: 'Synthetic rounds', privateNote: '', invoiceId: null };
  const m = mount('WorkLog', { contracts: [TIMED], workLog: [entry] });
  const html = m.html();
  assert.match(html, /3h 30m logged · first 4h in the stipend · 0h 30m outside the call hours, billed hourly/);
  // $3,000 stipend + 30 min at $300/hr before the call began.
  assert.match(html, /\$3,150\.00/);
});

// ── Review fixes ─────────────────────────────────────────────────

// The open form's text, read off the element tree (rendering the open Modal
// to HTML would leave its document listener pending for the next render).
const shown = (m) => textOf(m.render());
const zoneSelect = (tree) => nodes(tree).find(n => n.type === 'select' && n.props['aria-label'] === 'Time zone of the block times');

test('each block says what it bills as, and gaining an end time on the same end date asks before a call day is lost', () => {
  const NOV = { ...BASE, id: 'c1', coveragePeriods: [{ start: '2026-11-12', end: '2026-11-18' }], startDate: '2026-11-12', endDate: '2026-11-18' };
  const m = mount('Contracts', { contracts: [NOV], confirm: () => false });
  openContract(m);
  assert.match(shown(m), /7 call days: Nov 12 to Nov 18/);
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '06:00' } });
  assert.match(shown(m), /Block 1 has a start time but no end time\. Enter when coverage ends\./);
  input(m, 'Block 1 end time (optional)').props.onChange({ target: { value: '06:00' } });
  assert.match(shown(m), /Nov 12, 6:00 AM to Nov 18, 6:00 AM \u{b7} 6 call days: Nov 12 to Nov 17/u);
  click(m, 'Save');
  assert.equal(m.calls.length, 0, 'declined: nothing saved');
  const [kind, said] = m.dialogs.at(-1);
  assert.equal(kind, 'confirm');
  assert.match(said, /^Block 1 was saved without times, so (.+) was its last call day \(7 call days: Nov 12 to Nov 18\)\. With an end time, \1 is the date coverage ends: Nov 12, 6:00 AM to Nov 18, 6:00 AM \u{b7} 6 call days: Nov 12 to Nov 17\./u);
  assert.doesNotMatch(said, /\u{2014}/u);
  // The agreement's coverage runs to 6:00 AM Nov 19: with that end date
  // there is nothing to ask, and the block keeps its seven call days.
  input(m, 'Block 1 end date').props.onChange({ target: { value: '2026-11-19' } });
  assert.match(shown(m), /7 call days: Nov 12 to Nov 18/);
  const asked = m.dialogs.length;
  click(m, 'Save');
  assert.equal(m.dialogs.length, asked);
  assert.deepEqual(saved(m).coveragePeriods, [{ start: '2026-11-12', end: '2026-11-19', startTime: '06:00', endTime: '06:00', tz: 'America/Chicago' }]);
});

test('block times are saved on the zone picked for them, and a contract opens on its own zone', () => {
  const m = mount('Contracts', { contracts: [UNTIMED] });
  openContract(m);
  assert.equal(zoneSelect(m.render()), undefined, 'no times, no zone to pick');
  input(m, 'Block 1 end date').props.onChange({ target: { value: '2026-10-19' } });
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '16:00' } });
  input(m, 'Block 1 end time (optional)').props.onChange({ target: { value: '07:00' } });
  assert.equal(zoneSelect(m.render()).props.value, 'America/Chicago', "this device's zone by default");
  zoneSelect(m.render()).props.onChange({ target: { value: 'America/Denver' } });
  click(m, 'Save');
  assert.equal(saved(m).coveragePeriods[0].tz, 'America/Denver');
  const again = mount('Contracts', { contracts: [{ ...TIMED, coveragePeriods: [{ ...TIMED.coveragePeriods[0], tz: 'America/Denver' }] }] });
  openContract(again);
  assert.equal(zoneSelect(again.render()).props.value, 'America/Denver');
});

const editRow = (m, id) => {
  const row = find(m.render(), n => n.type === 'div' && n.key === id, `row ${id}`);
  find(row, n => n.type === 'button' && nodes(n).some(x => x.type?.name === 'EditIcon' || x.type === 'svg' || typeof x.type === 'function'), 'edit').props.onClick({ stopPropagation() {} });
};
// Nov 13 6:15 AM, logged and invoiced under Nov 12 before the block had times
// (the contract's call day starts at 7). The block now runs 6:00 AM to 6:00 AM.
const BILLED_CALL = { id: 'w6', createdAt: '2026-11-13T13:00:00Z', contractId: 'c1', type: 'Call', date: '2026-11-13', callDay: '2026-11-12',
  startTime: new Date(2026, 10, 13, 6, 15).toISOString(), endTime: new Date(2026, 10, 13, 6, 30).toISOString(), durationMin: 15, billedMin: 15,
  description: 'Synthetic early call', privateNote: '', invoiceId: 'inv1' };
const BILLED_INV = { id: 'inv1', number: 'INV-SYN-1', contractId: 'c1', entryIds: ['w6'], dayOverMin: { '2026-11-12': 0 }, lines: [{ date: '2026-11-12', label: 'On-call coverage (daily total)', amount: 3000 }] };

test('editing an invoiced entry after its block gained times keeps the call day its invoice billed, and the next day still owes its stipend', () => {
  const m = mount('WorkLog', { contracts: [SIX], workLog: [BILLED_CALL], invoices: [BILLED_INV] });
  editRow(m, 'w6');
  find(field(m.render(), 'Billing note (optional)'), n => n.type === 'textarea', 'note').props.onChange({ target: { value: 'Synthetic early call, reviewed' } });
  save(m, 'Save changes');
  const written = m.calls.filter(c => c[0] === 'edit').map(c => c[2]);
  assert.equal(written.length, 1);
  assert.deepEqual([written[0].callDay, written[0].invoiceId, written[0].description], ['2026-11-12', 'inv1', 'Synthetic early call, reviewed']);
  const nov13 = computeBilling(SIX, m.data.workLog.filter(e => !e.invoiceId), true, m.data.workLog, m.data.invoices, new Set(['2026-11-13']));
  assert.equal(nov13.total, 3000, 'Nov 13 is not read as billed');
});

test("moving an invoiced entry's time to another call day waits for its invoice to be deleted", () => {
  const m = mount('WorkLog', { contracts: [SIX], workLog: [BILLED_CALL], invoices: [BILLED_INV] });
  editRow(m, 'w6');
  field(m.render(), 'Start time').props.onCommit('09:00');
  field(m.render(), 'End time').props.onCommit('09:15');
  save(m, 'Save changes');
  assert.match(m.dialogs.map(d => d[1]).join('\n'), /This change would move this entry to a different call day from the one INV-SYN-1 billed it under\. Delete that invoice in the Invoices tab first/);
  assert.equal(m.calls.length, 0, 'nothing written');
});

test('a timer started at 5:30 AM on the day a 6:00 AM block starts is inside the schedule', () => {
  clock.setNow('2026-11-12T05:30:00-06:00');
  try {
    const m = mount('WorkLog', { contracts: [SIX] });
    click(m, 'Got a call');
    assert.equal(m.storage?.timer?.contractId ?? 'c1', 'c1');
    assert.doesNotMatch(m.html(), /isn't inside a scheduled coverage block/);
  } finally { clock.setNow('2026-11-20T12:00:00-06:00'); }
});
