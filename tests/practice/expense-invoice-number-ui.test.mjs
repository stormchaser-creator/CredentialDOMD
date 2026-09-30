import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, find, textOf, click, pinClock } from '../harness/component-harness.mjs';

// PRAC-007 / PRAC-030: two expense invoices sent the same day, one per
// agency, through the real Expenses screen, are recorded as EXP-...-01 and
// EXP-...-02 (both were EXP-...-01). Synthetic records only.

pinClock(test, 'America/Chicago', '2026-09-29T12:00:00-05:00');
const { Expenses } = await loadScreens('export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";');

const shared = [];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { clipboard: { writeText: async () => {} }, canShare: () => true, share: async (x) => { shared.push(x); } },
});

const EXPENSES = [
  { id: 'x1', date: '2026-09-20', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing A', invoiceId: null },
  { id: 'x2', date: '2026-09-21', amount: 88, category: 'Fuel', vendor: 'Synthetic Fuel', agency: 'Synthetic Staffing B', invoiceId: null },
];
const settle = () => new Promise(r => setTimeout(r, 0));

test('two expense invoices on one day get two numbers, and each is recorded at its own total', async () => {
  const m = mount(Expenses, { data: { travelExpenses: EXPENSES.map(e => ({ ...e })), invoices: [] } });
  for (const agency of ['Synthetic Staffing A', 'Synthetic Staffing B']) {
    click(m, 'Invoice');
    find(m.render(), n => n.type === 'button' && textOf(n) === agency, `${agency} chip`).props.onClick();
    await find(m.render(), n => n.type === 'button' && textOf(n).includes('Create & send'), 'send').props.onClick();
    await settle();
  }
  const invoices = m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
  assert.deepEqual(invoices.map(i => i.number), ['EXP-20260929-01', 'EXP-20260929-02']);
  assert.deepEqual(invoices.map(i => i.totalAmount), [412.4, 88]);
  assert.equal(shared.length, 2);
});
