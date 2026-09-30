import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, field, click, pinClock } from '../harness/component-harness.mjs';
import { dutyDayPay } from '../../src/utils/dutyPay.js';

// PRAC-001: the agreement form's pay model and call rate grid. A saved pay
// model used to win over the rates forever (a day-rate contract turned
// hourly stayed "daily"), and a grid could only come from the AI read.
// Driven through the real Contracts screen. Synthetic contracts only.

pinClock(test, 'America/Chicago', '2026-09-20T12:00:00-05:00');
const { Contracts } = await loadScreens('export {default as Contracts} from "./src/components/features/locum/Contracts.jsx";');

const DAILY = { id: 'c1', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 0, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [] };
const edit = (m) => nodes(find(m.render(), n => n.type === 'div' && n.key === 'c1', 'card')).filter(n => n.type === 'button')[0].props.onClick();
const input = (m, label) => find(field(m.render(), label), n => n.type === 'input', label);
const saved = (m) => m.calls.filter(c => c[0] === 'edit' || c[0] === 'add').filter(c => c[1] === 'locumContracts').map(c => c[2]);
const submitNew = (m) => find(m.render(), n => n.type === 'button' && textOf(n) === 'Add', 'form Add button').props.onClick();
const payModel = (m) => find(field(m.render(), 'Pay model'), n => n.type === 'select', 'pay model select');

test('a day-rate contract turned hourly: the mismatch is refused and named, then the picked model saves', () => {
  const m = mount(Contracts, { data: { locumContracts: [DAILY] } });
  edit(m);
  assert.equal(payModel(m).props.value, 'daily', 'the saved model is shown');
  input(m, 'Day rate ($/day worked)').props.onChange({ target: { value: '' } });
  input(m, 'Hourly rate ($/hr)').props.onChange({ target: { value: '250' } });
  click(m, 'Save');
  assert.deepEqual(saved(m), [], 'not saved as a $0 day-rate contract');
  assert.match(textOf(m.render()), /Pay model is Day rate, but the day rate is empty while Hourly is set\. Pick Hourly under Pay model, or enter the day rate\./);
  payModel(m).props.onChange({ target: { value: 'hourly' } });
  click(m, 'Save');
  const [c] = saved(m);
  assert.equal(c.payModel, 'hourly');
  assert.equal(c.hourlyRate, 250);
  assert.equal(c.dayRate, 0);
});

test('a new agreement nobody picked a model for still works it out from the rates', () => {
  const m = mount(Contracts, { data: { locumContracts: [] } });
  click(m, 'Add');
  input(m, 'Hospital / Facility').props.onChange({ target: { value: 'Synthetic Mercy' } });
  input(m, 'Call stipend ($/day)').props.onChange({ target: { value: '3000' } });
  assert.equal(payModel(m).props.value, 'stipend');
  submitNew(m);
  assert.equal(saved(m)[0].payModel, 'stipend');
});

test('the call rate grid can be entered by hand and prices call per hospital', () => {
  const m = mount(Contracts, { data: { locumContracts: [] } });
  click(m, 'Add');
  input(m, 'Hospital / Facility').props.onChange({ target: { value: 'Synthetic Group' } });
  input(m, 'Day rate ($/day worked)').props.onChange({ target: { value: '1875.40' } });
  click(m, '+ Add hospital');
  click(m, '+ Add hospital');
  click(m, '+ Add hospital');
  const set = (label, value) => find(m.render(), n => n.type === 'input' && n.props['aria-label'] === label, label).props.onChange({ target: { value } });
  set('Hospital 1', '  Synthetic Regional (SR) ');
  set('Hospital 1 primary rate', '1000');
  set('Hospital 1 backup rate', '400');
  set('Hospital 2', 'Synthetic Mercy (SM)');
  set('Hospital 2 primary rate', '2200');
  set('Hospital 2 backup rate', '800');
  // Row 3 is left blank: it is dropped, not saved as a nameless $0 row.
  submitNew(m);
  const [c] = saved(m);
  assert.equal(c.payModel, 'daily');
  assert.deepEqual(c.callRateGrid, [
    { hospital: 'Synthetic Regional (SR)', primary: 1000, backup: 400 },
    { hospital: 'Synthetic Mercy (SM)', primary: 2200, backup: 800 },
  ]);
  const day = { date: '2026-09-01', workedDay: true, callPeriods: [{ hospital: 'Synthetic Mercy (SM)', role: 'backup' }] };
  assert.equal(dutyDayPay(c, day).total, 2675.40);
});

test('removing every grid row saves no grid, and a misread row can be corrected', () => {
  const graded = { ...DAILY, callRateGrid: [{ hospital: 'Synthetic Regional (SR)', primary: 100, backup: 400 }] };
  const m = mount(Contracts, { data: { locumContracts: [graded] } });
  edit(m);
  find(m.render(), n => n.type === 'input' && n.props['aria-label'] === 'Hospital 1 primary rate', 'rate').props.onChange({ target: { value: '1000' } });
  click(m, 'Save');
  assert.deepEqual(saved(m)[0].callRateGrid, [{ hospital: 'Synthetic Regional (SR)', primary: 1000, backup: 400 }]);

  const m2 = mount(Contracts, { data: { locumContracts: [graded] } });
  edit(m2);
  find(m2.render(), n => n.type === 'button' && n.props['aria-label'] === 'Remove hospital 1', 'remove').props.onClick();
  click(m2, 'Save');
  assert.equal(saved(m2)[0].callRateGrid, null);
});

test('renaming a grid row that logged call days use asks first: those days would price $0', () => {
  const graded = { ...DAILY, callRateGrid: [{ hospital: 'Synthetic Regional (SR)', primary: 1000, backup: 400 }] };
  const days = [{ id: 'd1', contractId: 'c1', date: '2026-09-01', workedDay: true, callPeriods: [{ hospital: 'Synthetic Regional (SR)', role: 'primary' }] }];
  const m = mount(Contracts, { data: { locumContracts: [graded], dutyDays: days }, confirm: () => false });
  edit(m);
  find(m.render(), n => n.type === 'input' && n.props['aria-label'] === 'Hospital 1', 'name').props.onChange({ target: { value: 'Synthetic Northside' } });
  click(m, 'Save');
  assert.match(m.dialogs.map(d => d[1]).join('\n'), /1 logged call period \(Synthetic Regional \(SR\)\) would price at \$0/);
  assert.deepEqual(saved(m), [], 'declined: nothing saved');
});

test('the agreement summary shows the grid, so a misread rate can be spotted', async () => {
  const { ContractSummary } = await loadScreens('export {default as ContractSummary} from "./src/components/features/locum/ContractSummary.jsx";');
  const graded = { ...DAILY, callRateGrid: [{ hospital: 'Synthetic Regional (SR)', primary: 1000, backup: 400 }] };
  const m = mount(ContractSummary, { data: { locumContracts: [graded] }, props: { contract: graded, onClose() {} } });
  assert.match(textOf(find(m.render(), n => n.props?.['aria-label'] === 'Call rate grid', 'grid')), /Call at Synthetic Regional \(SR\): \$1,000\.00 primary · \$400\.00 backup/);
});
