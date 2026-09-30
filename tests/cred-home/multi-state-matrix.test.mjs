// Multi-State Matrix, driven through the real component with the real
// compliance engine. Every record here is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from '../component-harness.mjs';

const modules = async () => ({
  compliance: await import('../../src/utils/compliance.js'),
  stateRequirements: await import('../../src/constants/stateRequirements.js'),
  states: await import('../../src/constants/states.js'),
  lifecycle: await import('../../src/utils/lifecycle.js'),
});

const account = (over = {}) => ({
  licenses: [], cme: [], privileges: [],
  settings: { degreeType: 'MD' },
  ...over,
});

const mount = async (data, props = {}) => mountComponent('src/components/features/locum/MultiStateMatrix.jsx', {
  app: { data, theme: {} }, props, modules: await modules(),
});

const cells = m => m.nodes().filter(n => n.type?.name === 'Cell');
const cmeCell = m => cells(m).find(n => String(n.props.label).startsWith('CME'));

test('the CME cell shows the hours the engine counted in the renewal window, not zero', async () => {
  const m = await mount(account({
    licenses: [{ id: 'lic-co', state: 'CO', type: 'Medical License', licenseNumber: 'SYN-0001', expirationDate: '2027-04-30' }],
    cme: [{ id: 'cme-1', date: '2026-03-01', hours: 50, category: 'AMA PRA Category 1', title: 'Synthetic course' }],
  }));
  const cell = cmeCell(m);
  assert.ok(cell, 'the CO row has a CME cell');
  assert.equal(cell.props.value, '50 / 30 hrs');
  assert.equal(cell.props.status, '100%');
  assert.equal(cell.props.statusColor, '#10b981');
});

test('the state name is shown beside the code', async () => {
  const m = await mount(account({
    licenses: [{ id: 'lic-co', state: 'CO', type: 'Medical License', expirationDate: '2027-04-30' }],
  }));
  assert.match(m.pageText(), /COColorado/);
});

test('unmet CME topics are listed on the row', async () => {
  const m = await mount(account({
    licenses: [{ id: 'lic-tx', state: 'TX', type: 'Medical License', expirationDate: '2027-04-30' }],
    cme: [{ id: 'cme-1', date: '2026-03-01', hours: 12, category: 'AMA PRA Category 1', title: 'Synthetic course' }],
  }));
  const page = m.pageText();
  assert.match(page, /Unmet topics:/);
  assert.match(page, /Ethics/);
  assert.equal(cmeCell(m).props.value, '12 / 48 hrs');
});

test('"Add a license" on the empty matrix opens the license form', async () => {
  const calls = [];
  const m = await mount(account(), { onAddLicense: () => calls.push('licenses') });
  const button = m.nodes().find(n => n.type === 'button' && m.text(n) === 'Add a license');
  assert.ok(button, 'the empty matrix offers the button');
  button.props.onClick();
  assert.deepEqual(calls, ['licenses']);
});
