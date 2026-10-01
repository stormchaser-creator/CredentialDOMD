import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, find, click, pinClock } from '../harness/component-harness.mjs';
import { allDeductions } from '../../src/utils/deductions.js';

// PRAC-028: a new manual deduction line opens on the device's local day (the
// UTC day was tomorrow every evening in the Americas, and stayed the day the
// app loaded), and its tax year follows the date unless the member typed a
// different year. Synthetic amounts only.

// 6:30 PM Pacific on Sep 30 is already Oct 1 in UTC.
const clock = pinClock(test, 'America/Los_Angeles', '2026-09-30T18:30:00-07:00');
const { DeductionMemo } = await loadScreens('export {default as DeductionMemo} from "./src/components/features/locum/DeductionMemo.jsx";');

const formEl = (m) => find(m.render(), n => typeof n.type === 'function' && 'onSave' in (n.props || {}), 'deduction form');
// Render the form component itself to reach its inputs.
const input = (m, label) => {
  const f = formEl(m);
  const tree = f.type(f.props);
  const walk = (n) => (Array.isArray(n) ? n.flatMap(walk) : n && typeof n === 'object' ? [n, ...walk(n.props?.children)] : []);
  return find(walk(tree), n => n.props?.['aria-label'] === label, label);
};

test('PRAC-028: the default date is the local day, not the UTC day', () => {
  const m = mount(DeductionMemo, { data: { deductibles: [] } });
  click(m, '+ Add line item');
  assert.equal(formEl(m).props.form.date, '2026-09-30');
  assert.equal(formEl(m).props.form.taxYear, '2026');
});

test('PRAC-028: a form opened after midnight reads the new day', () => {
  const m = mount(DeductionMemo, { data: { deductibles: [] } });
  clock.setNow('2027-01-02T09:00:00-08:00');
  try {
    click(m, '+ Add line item');
    assert.equal(formEl(m).props.form.date, '2027-01-02');
    assert.equal(formEl(m).props.form.taxYear, '2027');
  } finally {
    clock.setNow('2026-09-30T18:30:00-07:00');
  }
});

test('PRAC-028: a receipt dated last December is saved to last year and leaves this year alone', () => {
  const m = mount(DeductionMemo, { data: { deductibles: [] } });
  click(m, '+ Add line item');
  input(m, 'Date').props.onChange({ target: { value: '2025-12-15' } });
  assert.equal(formEl(m).props.form.taxYear, '2025', 'the year follows the date');
  input(m, 'Description').props.onChange({ target: { value: 'Synthetic board exam' } });
  input(m, 'Amount').props.onChange({ target: { value: '450' } });
  formEl(m).props.onSave();
  const saved = m.calls.find(c => c[0] === 'add')[2];
  assert.equal(saved.taxYear, '2025');
  assert.equal(allDeductions(m.data, '2025').filter(d => d.description === 'Synthetic board exam').length, 1);
  assert.equal(allDeductions(m.data, '2026').filter(d => d.description === 'Synthetic board exam').length, 0);
});

test('PRAC-028: a year the member typed stays when the date changes afterwards', () => {
  const m = mount(DeductionMemo, { data: { deductibles: [] } });
  click(m, '+ Add line item');
  input(m, 'Tax year').props.onChange({ target: { value: '2025' } });
  input(m, 'Date').props.onChange({ target: { value: '2026-09-01' } });
  assert.equal(formEl(m).props.form.taxYear, '2025');
});

// A date input reports "" on the way to a new value (Backspace in a Chrome
// date segment, Firefox's clear button, the iOS picker's Reset). The year
// must still follow the next date: the member never touched the tax year.
test('PRAC-028: the year still follows the date after the date field was empty', () => {
  const m = mount(DeductionMemo, { data: { deductibles: [] } });
  click(m, '+ Add line item');
  input(m, 'Date').props.onChange({ target: { value: '' } });
  input(m, 'Date').props.onChange({ target: { value: '2025-12-20' } });
  assert.equal(formEl(m).props.form.date, '2025-12-20');
  assert.equal(formEl(m).props.form.taxYear, '2025', 'the year follows the date');
  input(m, 'Description').props.onChange({ target: { value: 'Synthetic CME course' } });
  input(m, 'Amount').props.onChange({ target: { value: '300' } });
  formEl(m).props.onSave();
  const saved = m.calls.find(c => c[0] === 'add')[2];
  assert.equal(saved.taxYear, '2025');
  assert.ok(!('taxYearTyped' in saved), 'the form flag is not saved on the row');
});

test('PRAC-028: a typed year stays through an empty date and a new date', () => {
  const m = mount(DeductionMemo, { data: { deductibles: [] } });
  click(m, '+ Add line item');
  input(m, 'Tax year').props.onChange({ target: { value: '2025' } });
  input(m, 'Date').props.onChange({ target: { value: '' } });
  input(m, 'Date').props.onChange({ target: { value: '2026-03-01' } });
  assert.equal(formEl(m).props.form.taxYear, '2025');
});

test('PRAC-028: typing the same year as the date keeps the year following', () => {
  const m = mount(DeductionMemo, { data: { deductibles: [] } });
  click(m, '+ Add line item');
  input(m, 'Tax year').props.onChange({ target: { value: '2026' } });
  input(m, 'Date').props.onChange({ target: { value: '2025-12-20' } });
  assert.equal(formEl(m).props.form.taxYear, '2025');
});
