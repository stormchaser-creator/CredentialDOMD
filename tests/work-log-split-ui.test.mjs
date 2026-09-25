import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount as mountScreen, nodes, textOf, find, field, click, pinClock } from './harness/component-harness.mjs';

// The three Work Log save paths (timer, new entry, edit), the group edit and
// delete, and the contract form's call-day settings, driven through the real
// components (tests/harness/component-harness.mjs). Synthetic data only.

const clock = pinClock(test, 'America/Denver', '2026-08-12T12:00:00-06:00');
const screens = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as Contracts} from "./src/components/features/locum/Contracts.jsx";');

const CONTRACT = { id: 'c1', facility: 'Synthetic General', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-07-28', end: '2026-08-09' }], startDate: '2026-07-28', endDate: '2026-08-09' };

const mount = (name, { contracts, workLog = [], invoices = [], ...rest } = {}) =>
  mountScreen(screens[name], { data: { locumContracts: contracts, workLog: [...workLog], invoices }, ...rest });

// Save, answering the "Check the date" schedule question with yes when it
// asks (Aug 10 is past these synthetic coverage dates).
const save = (m, label) => {
  click(m, label);
  const yes = nodes(m.render()).find(n => n.type === 'button' && textOf(n).includes('Yes, log it here'));
  if (yes) yes.props.onClick();
};
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// Log 06:45 to 07:15 on Aug 10 through the "Log past time" form.
function logPastTime(m, date, start, end) {
  click(m, 'Log past time');
  let tree = m.render();
  find(tree, n => n.type === 'button' && textOf(n) === 'Other…' && n.props.onClick && String(n.props.onClick).includes('pickDate'), 'date Other').props.onClick();
  tree = m.render();
  find(tree, n => n.type === 'input' && n.props.type === 'date', 'date input').props.onChange({ target: { value: date } });
  field(m.render(), 'Start time').props.onCommit(start);
  field(m.render(), 'End time').props.onCommit(end);
  save(m, 'Log it');
}

const adds = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'workLog').map(c => c[2]);
const LEGACY_KEYS = ['id', 'createdAt', 'contractId', 'type', 'date', 'callDay', 'startTime', 'endTime', 'durationMin', 'billedMin', 'description', 'privateNote', 'invoiceId'];

test('new entry, splitting off: one row with exactly the keys it always had, whole under Aug 9', () => {
  const m = mount('WorkLog', { contracts: [CONTRACT] });
  logPastTime(m, '2026-08-10', '06:45', '07:15');
  const rows = adds(m);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), LEGACY_KEYS);
  assert.equal(rows[0].callDay, '2026-08-09');
  assert.equal(rows[0].billedMin, 30);
});

test('new entry, splitting on: one row per piece with a shared group id, and the notice says where each went', () => {
  const m = mount('WorkLog', { contracts: [{ ...CONTRACT, splitAtDayStart: true, dayStartHour: 7 }] });
  logPastTime(m, '2026-08-10', '06:45', '07:15');
  const rows = adds(m);
  assert.deepEqual(rows.map(r => `${hhmm(r.startTime)}-${hhmm(r.endTime)} ${r.callDay} ${r.billedMin}`), ['06:45-07:00 2026-08-09 15', '07:00-07:15 2026-08-10 15']);
  assert.ok(rows[0].splitGroupId && rows[0].splitGroupId === rows[1].splitGroupId);
  assert.notEqual(rows[0].id, rows[1].id);
  const html = m.html();
  assert.match(html, /crossed the 7:00 AM start of the call day, so it is split/);
  assert.match(html, /continues on the Aug 10, 2026 call day/);
  assert.match(html, /continued from the Aug 9, 2026 call day/);
});

test('timer, splitting on: Stop and Log writes the pieces too', () => {
  clock.setNow('2026-08-10T07:15:00-06:00');
  try {
    const m = mount('WorkLog', {
      contracts: [{ ...CONTRACT, splitAtDayStart: true }],
      storage: { timer: { contractId: 'c1', type: 'Call', startedAt: '2026-08-10T12:45:00.000Z' } },
    });
    click(m, 'Stop & Log');
    const rows = adds(m);
    assert.deepEqual(rows.map(r => `${hhmm(r.startTime)}-${hhmm(r.endTime)} ${r.callDay} ${r.billedMin}`), ['06:45-07:00 2026-08-09 15', '07:00-07:15 2026-08-10 15']);
    assert.equal(rows[0].splitGroupId, rows[1].splitGroupId);
  } finally { clock.setNow('2026-08-12T12:00:00-06:00'); }
});

test('timer, splitting off: the stamp and the row are unchanged', () => {
  clock.setNow('2026-08-10T07:15:00-06:00');
  try {
    const m = mount('WorkLog', { contracts: [CONTRACT], storage: { timer: { contractId: 'c1', type: 'Call', startedAt: '2026-08-10T12:45:00.000Z' } } });
    click(m, 'Stop & Log');
    const rows = adds(m);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]), LEGACY_KEYS);
    assert.equal(rows[0].callDay, '2026-08-09');
  } finally { clock.setNow('2026-08-12T12:00:00-06:00'); }
});

const PIECES = [
  { id: 'p1', createdAt: '2026-08-10T13:20:00Z', contractId: 'c1', type: 'Call', date: '2026-08-10', callDay: '2026-08-09', startTime: '2026-08-10T12:45:00.000Z', endTime: '2026-08-10T13:00:00.000Z', durationMin: 15, billedMin: 15, description: 'ED consult', privateNote: '', invoiceId: null, splitGroupId: 'g-old', favorite: true },
  { id: 'p2', createdAt: '2026-08-10T13:20:00Z', contractId: 'c1', type: 'Call', date: '2026-08-10', callDay: '2026-08-10', startTime: '2026-08-10T13:00:00.000Z', endTime: '2026-08-10T13:15:00.000Z', durationMin: 15, billedMin: 15, description: 'ED consult', privateNote: '', invoiceId: null, splitGroupId: 'g-old', favorite: false },
];
const editRow = (m, id) => {
  const tree = m.render();
  const row = find(tree, n => n.type === 'div' && n.key === id, `row ${id}`);
  find(row, n => n.type === 'button' && nodes(n).some(x => x.type?.name === 'EditIcon' || x.type === 'svg' || typeof x.type === 'function'), 'edit').props.onClick({ stopPropagation() {} });
};

test('editing a piece opens the whole entry and rewrites both pieces in place', () => {
  const m = mount('WorkLog', { contracts: [{ ...CONTRACT, splitAtDayStart: true }], workLog: PIECES });
  editRow(m, 'p2');
  assert.equal(field(m.render(), 'Start time').props.value, '06:45');
  assert.equal(field(m.render(), 'End time').props.value, '07:15');
  field(m.render(), 'End time').props.onCommit('07:30');
  save(m, 'Save changes');
  const edits = m.calls.filter(c => c[0] === 'edit').map(c => c[2]);
  assert.deepEqual(edits.map(r => `${r.id} ${hhmm(r.startTime)}-${hhmm(r.endTime)} ${r.callDay} ${r.billedMin}`), ['p1 06:45-07:00 2026-08-09 15', 'p2 07:00-07:30 2026-08-10 30']);
  assert.ok(edits[0].splitGroupId && edits[0].splitGroupId === edits[1].splitGroupId);
  assert.deepEqual(edits.map(r => r.favorite), [true, false], 'each piece keeps its own star');
  assert.equal(m.calls.filter(c => c[0] !== 'edit').length, 0);
});

test('editing a piece of a partly invoiced entry warns about the invoice first', () => {
  const pieces = PIECES.map((p, i) => (i === 0 ? { ...p, invoiceId: 'inv1' } : p));
  const m = mount('WorkLog', { contracts: [{ ...CONTRACT, splitAtDayStart: true }], workLog: pieces, invoices: [{ id: 'inv1', number: 'INV-SYN-1', contractId: 'c1' }], confirm: () => false });
  editRow(m, 'p2');
  save(m, 'Save changes');
  assert.match(m.dialogs.map(d => d[1]).join('\n'), /Part of this entry is already billed on INV-SYN-1/);
  assert.equal(m.calls.length, 0, 'declined: nothing written');
});

test('editing a split entry back under one day, with splitting now off, leaves one whole row', () => {
  const m = mount('WorkLog', { contracts: [CONTRACT], workLog: PIECES });
  editRow(m, 'p1');
  save(m, 'Save changes');
  const edits = m.calls.filter(c => c[0] === 'edit').map(c => c[2]);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].id, 'p1');
  assert.equal(edits[0].splitGroupId, null);
  assert.equal(`${hhmm(edits[0].startTime)}-${hhmm(edits[0].endTime)} ${edits[0].callDay} ${edits[0].billedMin}`, '06:45-07:15 2026-08-09 30');
  assert.deepEqual(m.calls.filter(c => c[0] === 'delete').map(c => c[2]), ['p2']);
});

test('deleting one piece asks once and deletes the whole entry', () => {
  const m = mount('WorkLog', { contracts: [{ ...CONTRACT, splitAtDayStart: true }], workLog: PIECES });
  const row = find(m.render(), n => n.type === 'div' && n.key === 'p2', 'row p2');
  const buttons = nodes(row).filter(n => n.type === 'button');
  buttons.at(-1).props.onClick({ stopPropagation() {} });
  assert.match(m.dialogs[0][1], /split at the start of the call day into 2 parts. Delete all 2\?/);
  assert.deepEqual(m.calls.map(c => `${c[0]} ${c[2]}`), ['delete p1', 'delete p2']);
});

test('a piece whose partner is invoiced cannot be deleted on its own', () => {
  const pieces = PIECES.map((p, i) => (i === 0 ? { ...p, invoiceId: 'inv1' } : p));
  const m = mount('WorkLog', { contracts: [{ ...CONTRACT, splitAtDayStart: true }], workLog: pieces, invoices: [{ id: 'inv1', number: 'INV-SYN-1', contractId: 'c1' }] });
  const row = find(m.render(), n => n.type === 'div' && n.key === 'p2', 'row p2');
  nodes(row).filter(n => n.type === 'button').at(-1).props.onClick({ stopPropagation() {} });
  assert.match(m.dialogs[0][1], /Part of this entry is on INV-SYN-1/);
  assert.equal(m.calls.length, 0);
});

// ── The contract form ────────────────────────────────────────────

const openContract = (m, facility) => {
  const tree = m.render();
  const card = find(tree, n => n.type === 'div' && n.key === 'c1', facility);
  nodes(card).filter(n => n.type === 'button')[0].props.onClick();
};

test('a contract saved without touching the call-day settings writes none of their keys', () => {
  const m = mount('Contracts', { contracts: [CONTRACT] });
  openContract(m, 'Synthetic General');
  click(m, 'Save');
  const saved = m.calls.find(c => c[0] === 'edit')[2];
  assert.equal('splitAtDayStart' in saved, false);
  assert.equal('dayStartHour' in saved, false);
});

test('the form sets both settings, and a contract loaded with them saves them back', () => {
  const m = mount('Contracts', { contracts: [CONTRACT] });
  openContract(m, 'Synthetic General');
  let tree = m.render();
  const setting = field(tree, 'Start of the call day');
  assert.match(textOf(setting), /Split calls that cross the start of the call day/);
  find(setting, n => n.type === 'input' && n.props.type === 'checkbox', 'checkbox').props.onChange({ target: { checked: true } });
  find(field(m.render(), 'Start of the call day'), n => n.type === 'select', 'hour').props.onChange({ target: { value: '8' } });
  tree = m.render();
  assert.match(field(tree, 'Coverage dates').props.hint, /An entry that runs past it is split/);
  assert.match(field(tree, 'Coverage dates').props.hint, /8:00 AM/);
  click(m, 'Save');
  const saved = m.calls.find(c => c[0] === 'edit')[2];
  assert.equal(saved.splitAtDayStart, true);
  assert.equal(saved.dayStartHour, 8);

  const again = mount('Contracts', { contracts: [{ ...CONTRACT, splitAtDayStart: false, dayStartHour: 7 }] });
  openContract(again, 'Synthetic General');
  click(again, 'Save');
  const back = again.calls.find(c => c[0] === 'edit')[2];
  assert.equal(back.splitAtDayStart, false);
  assert.equal(back.dayStartHour, 7);
});

test('the coverage hint no longer claims a crossing call bills hourly', () => {
  const m = mount('Contracts', { contracts: [CONTRACT] });
  openContract(m, 'Synthetic General');
  const hint = field(m.render(), 'Coverage dates').props.hint;
  assert.doesNotMatch(hint, /work after that final 7 AM bills hourly/);
  assert.match(hint, /Work that starts after that final 7:00 AM bills hourly with no stipend/);
  assert.match(hint, /counts whole toward Aug 9, inside the stipend, unless you turn on splitting below/);
  assert.doesNotMatch(hint, /\u{2014}/u, 'no em dash');
  const setting = field(m.render(), 'Start of the call day').props.hint;
  assert.match(setting, /bills the same total minutes it would whole/);
  assert.match(setting, /Entries already logged keep their call day unless you edit them/);
  assert.doesNotMatch(setting, /\u{2014}/u, 'no em dash');
});
