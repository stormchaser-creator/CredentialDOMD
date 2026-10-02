import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find } from '../harness/component-harness.mjs';
import { invoicesBilledTwice, billedTwiceLine } from '../../src/utils/invoiceRecord.js';

// Review of release/goal2 (2026-10-01): a recorded invoice (INV-C) whose
// days the server kept on another recorded invoice (INV-A) was silent. It
// is said now on Home and the Invoices tab, by both numbers, with the
// delete that settles it; nothing else is flagged. Synthetic data only.

createRequire(import.meta.url)('jspdf');
const S = await loadScreens([
  'export {default as BilledTwiceInvoices} from "./src/components/shared/BilledTwiceInvoices.jsx";',
  'export {default as Invoices} from "./src/components/features/locum/Invoices.jsx";',
].join(' '));
const { BilledTwiceInvoices, Invoices } = S;

const C = { id: 'c-day', facility: 'Synthetic Valley Hospital', agency: 'Synthetic Staffing', payModel: 'daily', dayRate: 2000 };
const day = (id, date, invoiceId) => ({ id, contractId: 'c-day', date, workedDay: true, callPeriods: [], invoiceId });
const A = { id: 'inv-a', number: 'INV-20260910-01', contractId: 'c-day', entryIds: ['d1', 'd2'], totalAmount: 4000, sentAt: '2026-09-10T15:00:00Z', periodStart: '2026-09-07', periodEnd: '2026-09-08' };
const Cdup = { id: 'inv-c', number: 'INV-20260910-03', contractId: 'c-day', entryIds: ['d1', 'd2', 'd3'], totalAmount: 6000, sentAt: '2026-09-10T16:00:00Z', periodStart: '2026-09-07', periodEnd: '2026-09-09' };
const seed = (extra = {}) => ({
  locumContracts: [C],
  dutyDays: [day('d1', '2026-09-07', 'inv-a'), day('d2', '2026-09-08', 'inv-a'), day('d3', '2026-09-09', 'inv-c')],
  invoices: [A, Cdup],
  ...extra,
});

test('a recorded invoice listing days another recorded invoice holds is found, partly, by both numbers', () => {
  const twice = invoicesBilledTwice(seed());
  assert.equal(twice.length, 1);
  const [b] = twice;
  assert.equal(b.invoice.id, 'inv-c');
  assert.deepEqual(b.on, ['INV-20260910-01']);
  assert.equal(b.count, 2); assert.equal(b.listed, 3); assert.equal(b.full, false); assert.equal(b.items, 'days');
  assert.match(billedTwiceLine(b), /^2 of its 3 days are on INV-20260910-01, which was recorded first, so INV-20260910-03 asks for them a second time/);
  assert.match(billedTwiceLine(b), /bill the days that are not on INV-20260910-01 again\.$/);
  assert.doesNotMatch(billedTwiceLine(b), /\u2014/, 'no em dash');
});

test('nothing is flagged for ordinary invoices, a written off duplicate, a deleted original, or expenses kept apart', () => {
  // Two invoices on their own days.
  assert.deepEqual(invoicesBilledTwice({ dutyDays: [day('d1', '2026-09-07', 'inv-a'), day('d3', '2026-09-09', 'inv-c')], invoices: [{ ...A, entryIds: ['d1'] }, { ...Cdup, entryIds: ['d3'] }] }), []);
  // The duplicate written off: settled.
  assert.deepEqual(invoicesBilledTwice(seed({ invoices: [A, { ...Cdup, writeOffAt: '2026-09-20T00:00:00Z' }] })), []);
  // The original deleted: its days released (or on INV-C), nothing double.
  assert.deepEqual(invoicesBilledTwice(seed({ invoices: [Cdup], dutyDays: [day('d1', '2026-09-07', null), day('d2', '2026-09-08', null), day('d3', '2026-09-09', 'inv-c')] })), []);
  // An expense invoice and a day invoice sharing no row.
  const exp = { id: 'inv-e', number: 'EXP-20260910-01', kind: 'expenses', entryIds: ['x1'], totalAmount: 90 };
  assert.deepEqual(invoicesBilledTwice({ invoices: [A, exp], dutyDays: [day('d1', '2026-09-07', 'inv-a')], travelExpenses: [{ id: 'x1', invoiceId: 'inv-e' }] }), []);
  // Two expense invoices for the same receipt.
  const exp2 = { ...exp, id: 'inv-e2', number: 'EXP-20260910-02' };
  const both = invoicesBilledTwice({ invoices: [exp, exp2], travelExpenses: [{ id: 'x1', invoiceId: 'inv-e' }] });
  assert.deepEqual(both.map(b => [b.invoice.number, b.on, b.items, b.full]), [['EXP-20260910-02', ['EXP-20260910-01'], 'expenses', true]]);
});

test('Home says it and opens the Invoices tab', () => {
  let opened = 0;
  const m = mount(BilledTwiceInvoices, { data: seed(), props: { onOpen() { opened += 1; } } });
  const text = textOf(m.render());
  assert.match(text, /INV-20260910-03 bills days already on INV-20260910-01/);
  const b = find(m.render(), n => n.type === 'button' && textOf(n) === 'Open Invoices', 'Open Invoices');
  b.props.onClick();
  assert.equal(opened, 1);
  // Nothing to say, nothing shown.
  const quiet = mount(BilledTwiceInvoices, { data: seed({ invoices: [A] }), props: { onOpen() {} } });
  assert.equal(quiet.render(), null);
});

test('the Invoices tab says it and deletes the duplicate, leaving the days on the original', () => {
  const m = mount(Invoices, { data: seed() });
  const tree = m.render();
  const card = find(tree, n => n?.type === BilledTwiceInvoices, 'the billed twice card');
  const inner = mount(BilledTwiceInvoices, { data: m.data, props: card.props });
  const del = find(inner.render(), n => n.type === 'button' && textOf(n) === 'Delete INV-20260910-03', 'Delete INV-20260910-03');
  del.props.onClick();
  assert.deepEqual(m.calls.filter(c => c[0] === 'delete').map(c => c.slice(1)), [['invoices', 'inv-c']], 'INV-C deleted');
  const edits = m.calls.filter(c => c[0] === 'edit' && c[1] === 'dutyDays').map(c => [c[2].id, c[2].invoiceId]);
  assert.deepEqual(edits, [['d3', null]], 'only INV-C\'s own day is released; INV-A keeps its days');
  assert.ok(nodes(tree).length > 0);
});

test('Home carries the card, opening the Invoices tab', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /tab === "home" && <BilledTwiceInvoices onOpen=\{openInvoicesTab\} \/>/);
  assert.match(app, /const openInvoicesTab = \(\) => \{\s*setLocumSeed\(\{ sub: "invoices" \}\);\s*setTab\("locum"\); setSubPage\("invoices"\);/);
});
