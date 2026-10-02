import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, pinClock } from '../harness/component-harness.mjs';
import { typedChanges, editOverCurrent } from '../../src/utils/formEdits.js';

// Review of release/goal2 (2026-10-01): the Expenses and Days & call edit
// forms saved the record as it was when the form opened. A form left open on
// the iPhone across the resume reload, while desktop Chrome billed that
// expense or day on EXP-3, sent invoice_id = null on Save: unbilled on every
// device while EXP-3 still listed it, and offered for a second invoice. The
// reverse put a deleted invoice's id back. Save now lays only what the form
// changed over the record as the page has it then.
// Synthetic expenses, days, amounts and numbers only.

createRequire(import.meta.url)('jspdf');
pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const S = await loadScreens([
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";',
].join(' '));

const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const tapButton = (m, label) => {
  const b = nodes(m.render()).find(n => n?.type === 'button' && textOf(n) === label);
  assert.ok(b, `not found: ${label}`);
  return b.props.onClick({ stopPropagation() {} });
};
const edits = (m, key) => m.calls.filter(c => c[0] === 'edit' && c[1] === key).map(c => c[2]);

test('typedChanges / editOverCurrent: only what the form changed goes over the record as it is now', () => {
  const opened = { id: 'x', notes: 'a', invoiceId: null, tags: ['p'] };
  assert.deepEqual(typedChanges(opened, { ...opened, notes: 'b' }), { notes: 'b' });
  assert.deepEqual(typedChanges(opened, { ...opened, tags: ['p'] }), {}, 'a list compared by value');
  assert.deepEqual(editOverCurrent(opened, { ...opened, notes: 'b' }, { id: 'x', notes: 'a', invoiceId: 'inv-3', tags: ['p'] }),
    { id: 'x', notes: 'b', invoiceId: 'inv-3', tags: ['p'] });
  assert.deepEqual(editOverCurrent(opened, { ...opened, notes: 'b' }, null), { ...opened, notes: 'b' }, 'gone from the page: the opened copy');
});

const EXPENSE = { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', notes: '', invoiceId: null };
function openExpense(m) {
  const row = nodes(m.render()).find(n => n?.type === 'div' && typeof n.props?.onClick === 'function' && textOf(n).includes('Synthetic Inn'));
  assert.ok(row, 'the expense row');
  row.props.onClick();
  m.render();
}
function typeExpenseNote(m, value) {
  const notes = nodes(m.render()).find(n => n?.type === 'textarea' && n.props['aria-label'] === 'Notes');
  notes.props.onChange({ target: { value } });
  m.render();
}

test('Expenses: a form open while another device bills the expense keeps its invoice on Save', async () => {
  const m = mount(S.Expenses, { data: { travelExpenses: [EXPENSE], invoices: [], documents: [] } });
  m.render(); await settle();
  openExpense(m);
  typeExpenseNote(m, 'Confirmation 0001');
  // Desktop Chrome sends and records EXP-3; the resume reload brings it in.
  m.data.invoices = [{ id: 'exp-3', number: 'EXP-20260910-3', kind: 'expenses', entryIds: ['x1'] }];
  m.data.travelExpenses = [{ ...EXPENSE, invoiceId: 'exp-3' }];
  m.render(); await settle();
  tapButton(m, 'Save');
  const [saved] = edits(m, 'travelExpenses');
  assert.equal(saved.invoiceId, 'exp-3', 'still billed on EXP-3');
  assert.equal(saved.notes, 'Confirmation 0001', 'the typed note is saved');
});

test('Expenses: a form opened on a billed expense the desk has since unbilled does not put the old invoice back', async () => {
  const billed = { ...EXPENSE, invoiceId: 'exp-2' };
  const m = mount(S.Expenses, { data: { travelExpenses: [billed], invoices: [{ id: 'exp-2', number: 'EXP-20260909-2', kind: 'expenses', entryIds: ['x1'] }], documents: [] } });
  m.render(); await settle();
  openExpense(m);
  typeExpenseNote(m, 'Late folio');
  m.data.invoices = [];
  m.data.travelExpenses = [{ ...EXPENSE }];
  m.render(); await settle();
  tapButton(m, 'Save');
  const [saved] = edits(m, 'travelExpenses');
  assert.equal(saved.invoiceId, null, 'stays unbilled');
  assert.equal(saved.notes, 'Late folio');
});

const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', agency: 'Synthetic Staffing', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
const DAY = { id: 'd1', contractId: 'c-day', date: '2026-09-07', workedDay: true, callPeriods: [], notes: '', invoiceId: null, placementOk: true };
function openDay(m) {
  const row = nodes(m.render()).find(n => n?.props?.role === 'button' && typeof n.props?.onKeyDown === 'function' && typeof n.props?.onClick === 'function');
  assert.ok(row, 'the day row');
  row.props.onClick();
  m.render();
}
function typeDayNote(m, value) {
  const field = nodes(m.render()).find(n => n?.props?.label === 'Note on the invoice');
  const input = nodes(field.props.children).find(n => n?.type === 'input');
  input.props.onChange({ target: { value } });
  m.render();
}

test('Days & call: a day billed on another device while its form was open keeps its invoice, and Save asks first', async () => {
  const m = mount(S.DutyLog, { data: { locumContracts: [DAILY], dutyDays: [DAY], invoices: [] }, props: { contract: DAILY } });
  m.render(); await settle();
  openDay(m);
  typeDayNote(m, 'Covered the late case');
  m.data.invoices = [{ id: 'inv-3', number: 'INV-20260910-3', contractId: 'c-day', entryIds: ['d1'] }];
  m.data.dutyDays = [{ ...DAY, invoiceId: 'inv-3' }];
  m.render(); await settle();
  tapButton(m, 'Save');
  assert.ok(m.dialogs.some(d => d[0] === 'confirm' && /already on a sent invoice/.test(d[1])), 'asked, as the day is billed now');
  const [saved] = edits(m, 'dutyDays');
  assert.equal(saved.invoiceId, 'inv-3', 'still billed on INV-…-3');
  assert.equal(saved.notes, 'Covered the late case');
});

test('Days & call: a day the desk unbilled while its form was open is not put back on the deleted invoice', async () => {
  const billed = { ...DAY, invoiceId: 'inv-2' };
  const m = mount(S.DutyLog, { data: { locumContracts: [DAILY], dutyDays: [billed], invoices: [{ id: 'inv-2', number: 'INV-20260909-2', contractId: 'c-day', entryIds: ['d1'] }] }, props: { contract: DAILY } });
  m.render(); await settle();
  openDay(m);
  typeDayNote(m, 'Covered the late case');
  m.data.invoices = [];
  m.data.dutyDays = [{ ...DAY }];
  m.render(); await settle();
  tapButton(m, 'Save');
  assert.ok(!m.dialogs.some(d => d[0] === 'confirm' && /already on a sent invoice/.test(d[1])), 'not asked: it is unbilled now');
  const [saved] = edits(m, 'dutyDays');
  assert.equal(saved.invoiceId, null);
  assert.equal(saved.notes, 'Covered the late case');
});
