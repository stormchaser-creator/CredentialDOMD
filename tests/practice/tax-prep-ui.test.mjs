import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, find, field, pinClock } from '../harness/component-harness.mjs';
import { fixture } from '../../scripts/fixtures/tax-prep-fixture.mjs';
import { TAX_YEAR } from '../../src/utils/taxConstants.js';

// PRAC-027: Tax Prep's estimated payments. The date a new payment starts
// with is the local day (6 PM Pacific on Sep 29 is Sep 30 in UTC), and a
// recorded payment can be edited at phone width too. Synthetic fixture.

const Y = String(TAX_YEAR);
pinClock(test, 'America/Los_Angeles', `${Y}-09-30T01:00:00.000Z`);
const { TaxPrep } = await loadScreens('export {default as TaxPrep} from "./src/components/features/locum/TaxPrep.jsx";');

const phone = (opts = {}) => mount(TaxPrep, { data: { ...fixture, deductibles: [], taxPayments: fixture.taxPayments.map(p => ({ ...p })) }, ...opts });
const dateInput = (m) => find(field(m.render(), 'Date'), n => n.type === 'input' && n.props.type === 'date', 'date');

test('a new payment starts on the local day, and saves with it', () => {
  const m = phone();
  find(m.render(), n => n.type === 'button' && n.props.children === 'Record', 'Record').props.onClick();
  assert.equal(dateInput(m).props.value, `${Y}-09-29`);
  find(field(m.render(), 'Amount ($)'), n => n.type === 'input', 'amount').props.onChange({ target: { value: '15000' } });
  find(m.render(), n => n.type === 'button' && n.props.children === 'Save payment', 'save').props.onClick();
  const added = m.calls.find(c => c[0] === 'add' && c[1] === 'taxPayments')[2];
  assert.equal(added.date, `${Y}-09-29`);
  assert.equal(added.amount, 15000);
});

test('at phone width each recorded payment has an Edit button that saves the change', () => {
  const m = phone();
  const edits = nodes(m.render()).filter(n => n.type === 'button' && n.props['aria-label'] === 'Edit payment');
  const thisYear = fixture.taxPayments.filter(p => p.taxYear === Y);
  assert.equal(edits.length, thisYear.length);
  // Edit the Q2 federal payment: $30,000 becomes $31,250.
  const q2 = nodes(m.render()).filter(n => n.type === 'button' && n.props['aria-label'] === 'Edit payment')
    .find(n => n.props['data-payment'] === 'p2');
  assert.ok(q2, 'the p2 edit button');
  q2.props.onClick();
  find(field(m.render(), 'Amount ($)'), n => n.type === 'input', 'amount').props.onChange({ target: { value: '31250' } });
  find(m.render(), n => n.type === 'button' && n.props.children === 'Save changes', 'save').props.onClick();
  const saved = m.calls.find(c => c[0] === 'edit' && c[1] === 'taxPayments')[2];
  assert.deepEqual([saved.id, saved.amount, saved.date, saved.note], ['p2', 31250, `${Y}-06-15`, 'Q2 1040-ES']);
});
