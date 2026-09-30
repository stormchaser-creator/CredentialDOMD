import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';
import { computeBilling } from '../../src/utils/billing.js';
import { incomeByState } from '../../src/utils/taxEngine.js';

// The Invoices tab, driven through the real component: deleting an invoice
// (PRAC-006), reopening a paid one and recording a payment (PRAC-005).
// Synthetic contracts and invoices only.

pinClock(test, 'America/Chicago', '2026-09-20T12:00:00-05:00');
const { Invoices } = await loadScreens('export {default as Invoices} from "./src/components/features/locum/Invoices.jsx";');

const CONTRACT = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, orientationHourlyRate: 0, orientationFee: 1500, orientationBilled: true, incrementMinutes: 15, minCallMinutes: 15, callStipend: 0 };
const ORIENT = { id: 'o1', contractId: 'c1', type: 'Orientation', date: '2026-09-01', callDay: '2026-09-01', startTime: '2026-09-01T14:00:00.000Z', endTime: '2026-09-01T16:00:00.000Z', durationMin: 120, billedMin: 120, description: 'Orientation', invoiceId: 'inv-a' };
const FEE_LINE = { date: '2026-09-01', label: 'Orientation (one-time)', detail: '', amount: 1500, kind: 'orientationFee' };
const INV_A = { id: 'inv-a', number: 'INV-20260902-01', contractId: 'c1', totalAmount: 1500, sentAt: '2026-09-02T15:00:00.000Z', paidAt: null, entryIds: ['o1'], lines: [FEE_LINE] };

const cardOf = (m, id) => find(m.render(), n => n.type === 'div' && n.key === id, `card ${id}`);
const trashOf = (card) => find(card, n => n.type === 'button' && n.props['aria-label'] === 'Delete invoice', 'Delete invoice');
const buttonIn = (card, label) => find(card, n => n.type === 'button' && textOf(n).includes(label), label);
const ev = { stopPropagation() {} };
const edits = (m, key) => m.calls.filter(c => c[0] === 'edit' && c[1] === key).map(c => c[2]);

test('PRAC-006: deleting the invoice that billed the orientation fee lets the rebuilt invoice bill it again ($1,500)', () => {
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], workLog: [ORIENT], invoices: [INV_A] } });
  trashOf(cardOf(m, 'inv-a')).props.onClick(ev);
  assert.deepEqual(edits(m, 'locumContracts').map(c => c.orientationBilled), [false]);
  const contract = m.data.locumContracts[0];
  const unbilled = m.data.workLog.filter(e => !e.invoiceId);
  const rebuilt = computeBilling(contract, unbilled, true, m.data.workLog, m.data.invoices);
  assert.ok(rebuilt.lines.some(l => l.label === 'Orientation (one-time)' && l.amount === 1500));
  assert.equal(rebuilt.total, 1500);
});

test('PRAC-006: a legacy fee line without kind, or a text-only legacy invoice, also clears the flag', () => {
  for (const inv of [
    { ...INV_A, lines: [{ ...FEE_LINE, kind: undefined }] },
    { ...INV_A, lines: undefined, text: 'Orientation (one-time)  $1,500.00' },
  ]) {
    const m = mount(Invoices, { data: { locumContracts: [CONTRACT], workLog: [ORIENT], invoices: [inv] } });
    trashOf(cardOf(m, 'inv-a')).props.onClick(ev);
    assert.deepEqual(edits(m, 'locumContracts').map(c => c.orientationBilled), [false]);
  }
});

test('PRAC-006: while another invoice still bills the fee, the flag stays set (no double billing)', () => {
  const invB = { ...INV_A, id: 'inv-b', number: 'INV-20260903-01', entryIds: [] };
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], workLog: [ORIENT], invoices: [INV_A, invB] } });
  trashOf(cardOf(m, 'inv-a')).props.onClick(ev);
  assert.equal(edits(m, 'locumContracts').length, 0);
  assert.equal(m.data.locumContracts[0].orientationBilled, true);
});

test('PRAC-006: an invoice without the fee leaves the contract alone; a declined confirm changes nothing', () => {
  const plain = { ...INV_A, lines: [{ date: '2026-09-01', label: 'Hourly', amount: 500 }], totalAmount: 500 };
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], workLog: [ORIENT], invoices: [plain] } });
  trashOf(cardOf(m, 'inv-a')).props.onClick(ev);
  assert.equal(edits(m, 'locumContracts').length, 0);
  const m2 = mount(Invoices, { data: { locumContracts: [CONTRACT], workLog: [ORIENT], invoices: [INV_A] }, confirm: () => false });
  trashOf(cardOf(m2, 'inv-a')).props.onClick(ev);
  assert.equal(m2.calls.length, 0);
});

test('PRAC-006: the delete confirm for an expense invoice names its expenses, not "0 work entries"', () => {
  const exp = { id: 'inv-e', number: 'EXP-20260910-01', kind: 'expenses', contractId: 'c1', totalAmount: 612.4, sentAt: '2026-09-10T15:00:00.000Z', lines: [] };
  const travel = [
    { id: 'x1', contractId: 'c1', date: '2026-09-05', vendor: 'Synthetic Air', amount: 412.4, invoiceId: 'inv-e' },
    { id: 'x2', contractId: 'c1', date: '2026-09-06', vendor: 'Synthetic Inn', amount: 200, invoiceId: 'inv-e' },
  ];
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], invoices: [exp], travelExpenses: travel } });
  trashOf(cardOf(m, 'inv-e')).props.onClick(ev);
  const msg = m.dialogs.find(d => d[0] === 'confirm')[1];
  assert.equal(msg, 'Delete invoice EXP-20260910-01? Its 2 expenses become unbilled again.');
  assert.doesNotMatch(msg, /work entr/);
});

test('PRAC-006: a mixed invoice names work entries and days separately', () => {
  const inv = { ...INV_A, lines: [] };
  const duty = [{ id: 'd1', contractId: 'c1', date: '2026-09-01', workedDay: true, invoiceId: 'inv-a' }];
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], workLog: [ORIENT], dutyDays: duty, invoices: [inv] } });
  trashOf(cardOf(m, 'inv-a')).props.onClick(ev);
  assert.equal(m.dialogs.find(d => d[0] === 'confirm')[1], 'Delete invoice INV-20260902-01? Its 1 work entry and 1 day become unbilled again.');
});

const SETTLED = {
  id: 'inv-p', number: 'INV-20260826-03', contractId: 'c1', totalAmount: 8000, sentAt: '2026-08-25T15:00:00.000Z', paidAt: '2026-09-15T15:00:00.000Z',
  lines: [{ date: '2026-08-20', label: 'Hourly', amount: 8000 }],
  payments: [{ amount: 5000, date: '2026-09-01', note: 'check 1041' }, { amount: 3000, date: '2026-09-15', note: '' }],
};

test('PRAC-005: Reopen asks first, removes only the last payment, and keeps the $5,000 first payment', () => {
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], invoices: [SETTLED] } });
  buttonIn(cardOf(m, 'inv-p'), 'Reopen').props.onClick(ev);
  const ask = m.dialogs.find(d => d[0] === 'confirm')?.[1] || '';
  assert.match(ask, /Reopen INV-20260826-03\? This removes the \$3,000\.00 payment recorded Sep 15, 2026\. Earlier payments stay\./);
  const [saved] = edits(m, 'invoices');
  assert.deepEqual(saved.payments, [{ amount: 5000, date: '2026-09-01', note: 'check 1041' }]);
  assert.equal(saved.paidAt, null);
  // The card now reads $3,000 still owed, $5,000 received.
  assert.match(textOf(cardOf(m, 'inv-p')), /\$5,000\.00 received · \$3,000\.00 still owed/);
  // Tax Prep income keeps the $5,000 that did arrive (it read $0 after the old Reopen).
  const contracts = [{ ...CONTRACT, workState: 'CO' }];
  assert.equal(incomeByState([SETTLED], contracts, 2026).total, 8000);
  assert.equal(incomeByState(m.data.invoices, contracts, 2026).total, 5000);
});

test('PRAC-005: Reopen declined changes nothing', () => {
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], invoices: [SETTLED] }, confirm: () => false });
  buttonIn(cardOf(m, 'inv-p'), 'Reopen').props.onClick(ev);
  assert.equal(m.calls.length, 0);
});

test('PRAC-005: Reopen on a legacy invoice settled by paidAt only clears paidAt behind a confirm', () => {
  const legacy = { ...SETTLED, payments: undefined };
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], invoices: [legacy] } });
  buttonIn(cardOf(m, 'inv-p'), 'Reopen').props.onClick(ev);
  assert.match(m.dialogs.find(d => d[0] === 'confirm')[1], /Reopen INV-20260826-03\? It goes back to \$8,000\.00 owed\./);
  assert.equal(edits(m, 'invoices')[0].paidAt, null);
});

test('PRAC-005: a refused payment keeps the form open with what was typed', () => {
  const open = { ...SETTLED, id: 'inv-o', paidAt: null, payments: [] };
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], invoices: [open] }, refuse: (op, key) => op === 'edit' && key === 'invoices' });
  buttonIn(cardOf(m, 'inv-o'), 'Record payment').props.onClick(ev);
  const tree = m.render();
  const [amount] = nodes(tree).filter(n => n.type === 'input' && n.props.type === 'number');
  amount.props.onChange({ target: { value: '2500' } });
  nodes(m.render()).find(n => n.type === 'input' && n.props.placeholder === 'optional').props.onChange({ target: { value: 'check 2207' } });
  find(m.render(), n => n.type === 'button' && textOf(n).includes('Record partial payment'), 'record').props.onClick();
  assert.deepEqual(m.calls, [['refused', 'edit', 'invoices']]);
  const after = m.render();
  assert.ok(nodes(after).some(n => n.type === 'button' && textOf(n).includes('Record partial payment')), 'the payment form is still open');
  assert.equal(nodes(after).find(n => n.type === 'input' && n.props.placeholder === 'optional').props.value, 'check 2207');
});

test('PRAC-005: an accepted payment of $2,500 is recorded and closes the form', () => {
  const open = { ...SETTLED, id: 'inv-o', paidAt: null, payments: [] };
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], invoices: [open] } });
  buttonIn(cardOf(m, 'inv-o'), 'Record payment').props.onClick(ev);
  nodes(m.render()).find(n => n.type === 'input' && n.props.type === 'number').props.onChange({ target: { value: '2500' } });
  find(m.render(), n => n.type === 'button' && textOf(n).includes('Record partial payment'), 'record').props.onClick();
  assert.deepEqual(edits(m, 'invoices')[0].payments.map(p => p.amount), [2500]);
  assert.ok(!nodes(m.render()).some(n => n.type === 'button' && textOf(n).includes('Record partial payment')));
});
