import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount as mountScreen, nodes, textOf, find, field, click, pinClock } from './harness/component-harness.mjs';
import { facilityZone } from '../src/utils/facilityZone.js';
import { contractFromScan } from '../src/utils/docPrefill.js';
import { deriveCallDay } from '../src/utils/billing.js';
import { planFiling } from '../supabase/functions/_shared/intakeFiling.mjs';

// A contract's block times are on the facility's clock, not this device's
// (owner's ticket, 2026-11-06): a Pacific phone saved a Fargo, ND agreement
// on Pacific time, so a 7:00 AM Central procedure was filed under the day
// before. Synthetic data only.

const clock = pinClock(test, 'America/Los_Angeles', '2026-11-06T09:00:00-08:00');
const screens = await loadScreens('export {default as Contracts} from "./src/components/features/locum/Contracts.jsx";');

test('the facility zone comes from the state, and from the city in a state split between two zones', () => {
  const z = (v) => { const r = facilityZone(v); return [r.zone, r.sure]; };
  assert.deepEqual(z({ workState: 'ND', location: 'Fargo, ND' }), ['America/Chicago', true]);
  assert.deepEqual(z({ location: 'Synthetic Medical Center, Fargo, North Dakota 58122' }), ['America/Chicago', true]);
  assert.deepEqual(z({ workState: 'ND', location: 'Dickinson, ND' }), ['America/Denver', true]);
  assert.deepEqual(z({ workState: 'ND' }), ['America/Chicago', false], 'a split state with no city: most of it, not sure');
  assert.deepEqual(z({ workState: 'ND', location: 'Unlisted Town, ND' }), ['America/Chicago', false]);
  assert.deepEqual(z({ location: 'El Paso, Texas' }), ['America/Denver', true]);
  assert.deepEqual(z({ location: 'Boise ID' }), ['America/Denver', true]);
  assert.deepEqual(z({ location: 'Coeur d’Alene, ID' }), ['America/Los_Angeles', true]);
  assert.deepEqual(z({ workState: 'CA' }), ['America/Los_Angeles', true]);
  assert.deepEqual(z({ location: 'Loveland, CO' }), ['America/Denver', true]);
  assert.deepEqual(z({ workState: 'AZ' }), ['America/Phoenix', true]);
  // A city counts only in the Work state.
  assert.deepEqual(z({ workState: 'TX', location: 'El Paso, NM' }), ['America/Chicago', false]);
  assert.deepEqual(z({ location: 'Somewhere' }), ['', false]);
  assert.deepEqual(z({}), ['', false]);
});

const BASE = { facility: 'Synthetic Regional Hospital', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15 };
const mount = (opts = {}) => mountScreen(screens.Contracts, { data: { locumContracts: opts.contracts ?? [], workLog: [], invoices: [] }, confirm: opts.confirm });
const input = (m, label) => find(m.render(), n => n.type === 'input' && n.props['aria-label'] === label, label);
const zoneSelect = (tree) => nodes(tree).find(n => n.type === 'select' && n.props['aria-label'] === 'Time zone of the block times');
const zoneCheck = (tree) => nodes(tree).find(n => n.props?.['aria-label'] === 'Time zone check');
const saved = (m) => m.calls.find(c => c[0] === 'edit' || c[0] === 'add')?.[2];
const fill = (m, label, value) => {
  const f = field(m.render(), label);
  const control = nodes(f).find(n => n.type === 'input' || n.type === 'select');
  control.props.onChange({ target: { value } });
};
// The form's own save: "Add" for a new contract, "Save" for one being edited.
const save = (m) => nodes(m.render()).filter(n => n.type === 'button' && ['Add', 'Save'].includes(textOf(n).trim())).at(-1).props.onClick();
const addFargo = (m) => {
  click(m, 'Add');
  fill(m, 'Hospital / Facility', 'Synthetic Fargo Hospital');
  fill(m, 'Work state (for taxes)', 'ND');
  fill(m, 'Location', 'Fargo, ND');
  fill(m, 'Call stipend ($/day)', '3000');
  click(m, '+ Add a date block');
  input(m, 'Block 1 start date').props.onChange({ target: { value: '2026-11-05' } });
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '06:00' } });
  input(m, 'Block 1 end date').props.onChange({ target: { value: '2026-11-12' } });
  input(m, 'Block 1 end time (optional)').props.onChange({ target: { value: '06:00' } });
};

test('on a Pacific phone, a Fargo, ND agreement\'s times are on Central time and say where that came from', () => {
  const m = mount();
  addFargo(m);
  assert.equal(zoneSelect(m.render()).props.value, 'America/Chicago');
  assert.match(textOf(zoneCheck(m.render())), /Set from the facility \(ND\)\./);
  const asked = m.dialogs.length;
  save(m);
  assert.equal(m.dialogs.length, asked, 'nothing to ask: the facility zone');
  assert.deepEqual(saved(m).coveragePeriods.map(p => p.tz), ['America/Chicago']);
});

test('times set on another zone than the facility\'s are flagged, fixable in one tap, and confirmed before saving', () => {
  const m = mount({ confirm: () => false });
  addFargo(m);
  zoneSelect(m.render()).props.onChange({ target: { value: 'America/Los_Angeles' } });
  assert.match(textOf(zoneCheck(m.render())), /This facility \(ND\) is on Central time, but the times are set to Pacific time\./);
  save(m);
  assert.equal(m.calls.length, 0, 'declined: nothing saved');
  assert.match(m.dialogs.at(-1)[1], /^This facility \(ND\) is on Central time, but the times are set to Pacific time\. Save with the times on Pacific time\?$/);
  click(m, 'Use Central time');
  assert.equal(zoneSelect(m.render()).props.value, 'America/Chicago');
  assert.equal(zoneCheck(m.render()), undefined);
  save(m);
  assert.equal(saved(m).coveragePeriods[0].tz, 'America/Chicago');
});

test('a saved contract on the wrong zone opens with the mismatch said (the Fargo contract before its fix)', () => {
  const WRONG = { ...BASE, id: 'c1', workState: 'ND', location: 'Fargo, ND', coveragePeriods: [{ start: '2026-11-05', startTime: '06:00', end: '2026-11-12', endTime: '06:00', tz: 'America/Los_Angeles' }], startDate: '2026-11-05', endDate: '2026-11-12' };
  const m = mount({ contracts: [WRONG] });
  const card = find(m.render(), n => n.type === 'div' && n.key === 'c1', 'contract card');
  nodes(card).filter(n => n.type === 'button')[0].props.onClick();
  assert.equal(zoneSelect(m.render()).props.value, 'America/Los_Angeles', 'the saved zone is kept until changed');
  assert.match(textOf(zoneCheck(m.render())), /is on Central time, but the times are set to Pacific time/);
});

test('a state split between zones with no known city is named, never confirmed on a guess', () => {
  const m = mount();
  click(m, 'Add');
  fill(m, 'Hospital / Facility', 'Synthetic Hospital');
  fill(m, 'Work state (for taxes)', 'ND');
  fill(m, 'Call stipend ($/day)', '3000');
  click(m, '+ Add a date block');
  input(m, 'Block 1 start date').props.onChange({ target: { value: '2026-11-05' } });
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '06:00' } });
  input(m, 'Block 1 end date').props.onChange({ target: { value: '2026-11-12' } });
  input(m, 'Block 1 end time (optional)').props.onChange({ target: { value: '06:00' } });
  assert.match(textOf(zoneCheck(m.render())), /Most of ND is on Central time: check it for this facility\./);
  zoneSelect(m.render()).props.onChange({ target: { value: 'America/Denver' } });
  const asked = m.dialogs.length;
  save(m);
  assert.equal(m.dialogs.length, asked);
  assert.equal(saved(m).coveragePeriods[0].tz, 'America/Denver');
});

test('with no state, the times stay on this device\'s zone, as before', () => {
  const m = mount();
  click(m, 'Add');
  fill(m, 'Hospital / Facility', 'Synthetic Hospital');
  fill(m, 'Call stipend ($/day)', '3000');
  click(m, '+ Add a date block');
  input(m, 'Block 1 start date').props.onChange({ target: { value: '2026-11-05' } });
  input(m, 'Block 1 start time (optional)').props.onChange({ target: { value: '06:00' } });
  input(m, 'Block 1 end date').props.onChange({ target: { value: '2026-11-12' } });
  input(m, 'Block 1 end time (optional)').props.onChange({ target: { value: '06:00' } });
  assert.equal(zoneSelect(m.render()).props.value, 'America/Los_Angeles');
  save(m);
  assert.equal(saved(m).coveragePeriods[0].tz, 'America/Los_Angeles');
});

test('a scanned or emailed Fargo agreement is filed on Central time, and a 7:00 AM Central entry lands on its own call day', () => {
  const extracted = { facility: 'Synthetic Fargo Hospital', location: 'Fargo, ND', callStipend: '3000',
    coveragePeriods: [{ start: '2026-11-05', startTime: '06:00', end: '2026-11-12', endTime: '06:00' }] };
  // The Files tab: DocumentsSection passes the facility zone (this device's only without a state).
  const scanned = contractFromScan(extracted, { zone: facilityZone(extracted).zone || 'America/Los_Angeles' }).entry;
  assert.equal(scanned.coveragePeriods[0].tz, 'America/Chicago');
  // docs@: the server has no clock of its own and files the facility's.
  let n = 0;
  const plan = planFiling({ scan: { documentType: 'agreement', confidence: 'high', extracted }, docId: 'doc-1', fileName: 'synthetic.pdf', mimeType: 'application/pdf',
    userId: 'profile-1', rows: [], categories: [], now: '2026-11-04T12:00:00.000Z', newId: () => `id-${++n}` });
  assert.equal(plan.writes[0].row.coverage_periods[0].tz, 'America/Chicago');
  const noState = planFiling({ scan: { documentType: 'agreement', confidence: 'high', extracted: { ...extracted, location: '' } }, docId: 'doc-2', fileName: 'synthetic.pdf', mimeType: 'application/pdf',
    userId: 'profile-1', rows: [], categories: [], now: '2026-11-04T12:00:00.000Z', newId: () => `id-${++n}` });
  assert.equal(noState.writes[0].row.coverage_periods[0].tz, undefined, 'no state: no zone, as before');
  // 7:00 to 10:00 AM Central on Nov 6 is after that morning's 6:00 AM Central turnover.
  const contract = { ...BASE, id: 'c1', coveragePeriods: scanned.coveragePeriods };
  assert.equal(deriveCallDay(new Date('2026-11-06T13:00:00Z').toISOString(), contract), '2026-11-06');
});
