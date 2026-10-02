// Review of ticket fe321c16's fix. The editors now stay on screen while a
// membership check is pending, and a write refused meanwhile comes back
// false from addItem/editItem (AppContext). Save handlers that ignored that
// cleared the form, the running timer or the dictation, and some said
// "Saved". A refused save must keep what was typed, say nothing was saved,
// and never start paid reading for a file that was not stored.
//
// Real components, synthetic data only, no network or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, field, click, button, pinClock } from '../harness/component-harness.mjs';
import { mountComponent } from '../component-harness.mjs';
import { settleOutcome } from '../helpers/settle-outcome.mjs';

const clock = pinClock(test, 'America/Denver', '2026-08-12T12:00:00-06:00');
const screens = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as RVULog} from "./src/components/features/locum/RVULog.jsx"; export {default as Expenses} from "./src/components/features/locum/Expenses.jsx"; export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx"; export {default as DocumentsSection} from "./src/components/features/DocumentsSection.jsx"; export {default as Contracts} from "./src/components/features/locum/Contracts.jsx"; export {default as TaskNotes} from "./src/components/features/locum/TaskNotes.jsx"; export {default as Forecast} from "./src/components/features/locum/Forecast.jsx";');

const CONTRACT = { id: 'c1', facility: 'Synthetic General', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-08-01', end: '2026-08-20' }], startDate: '2026-08-01', endDate: '2026-08-20' };
const refuseAll = () => true;
const writes = (m) => m.calls.filter(c => c[0] === 'add' || c[0] === 'edit' || c[0] === 'delete');

test('Work Log: Stop and Log refused while membership is re-checked keeps the running timer and logs nothing', () => {
  clock.setNow('2026-08-10T07:15:00-06:00');
  try {
    const timer = { contractId: 'c1', type: 'Call', startedAt: '2026-08-10T12:45:00.000Z', note: 'Synthetic ED consult' };
    const m = mount(screens.WorkLog, { data: { locumContracts: [CONTRACT] }, storage: { timer }, refuse: refuseAll });
    click(m, 'Stop & Log');
    assert.deepEqual(writes(m), [], 'no row was written');
    assert.ok(m.calls.some(c => c[0] === 'refused' && c[2] === 'workLog'), 'the save was attempted and refused');
    assert.deepEqual(m.storage.timer, timer, 'the timer is still saved on the device');
    const page = textOf(m.render());
    assert.match(page, /Stop & Log/, 'and still running on screen');
    assert.doesNotMatch(page, /Logged|logged|billed at|saved/i, 'nothing claims it was saved');
    // Once the answer lands, the same tap logs it.
    const ok = mount(screens.WorkLog, { data: { locumContracts: [CONTRACT] }, storage: { timer: m.storage.timer } });
    click(ok, 'Stop & Log');
    assert.equal(ok.calls.filter(c => c[0] === 'add' && c[1] === 'workLog').length, 1);
    assert.equal(ok.storage.timer ?? null, null);
  } finally { clock.setNow('2026-08-12T12:00:00-06:00'); }
});

test('Work Log: a refused past-time entry keeps the form open with the typed times', () => {
  const m = mount(screens.WorkLog, { data: { locumContracts: [CONTRACT] }, refuse: refuseAll });
  click(m, 'Log past time');
  field(m.render(), 'Start time').props.onCommit('06:45');
  field(m.render(), 'End time').props.onCommit('07:15');
  click(m, 'Log it');
  const yes = nodes(m.render()).find(n => n.type === 'button' && textOf(n).includes('Yes, log it here'));
  if (yes) yes.props.onClick();
  assert.deepEqual(writes(m), []);
  assert.ok(m.calls.some(c => c[0] === 'refused'), 'the save was attempted');
  assert.equal(field(m.render(), 'Start time').props.value, '06:45', 'the form is still open with its start');
  assert.equal(field(m.render(), 'End time').props.value, '07:15');
});

test('RVU log: a refused save keeps the dictation and the reviewed codes, and shows no Saved note', async () => {
  const m = mount(screens.RVULog, { data: { locumContracts: [CONTRACT], encounters: [], caseLogs: [] }, refuse: refuseAll });
  const box = () => find(m.render(), n => n.type === 'textarea' && /New ED consult/.test(n.props.placeholder || ''), 'dictation box');
  box().props.onChange({ target: { value: 'Synthetic consult, high complexity.' } });
  const search = () => find(m.render(), n => n.type === 'input' && /Type a CPT code/.test(n.props.placeholder || ''), 'code search');
  await search().props.onChange({ target: { value: '99223' } });
  find(m.render(), n => n.type === 'button' && /99223/.test(textOf(n)) && n.props.onClick, '99223 result').props.onClick();
  button(m.render(), 'wRVU').props.onClick();
  assert.deepEqual(writes(m), []);
  assert.ok(m.calls.some(c => c[0] === 'refused' && c[2] === 'encounters'));
  const page = textOf(m.render());
  assert.doesNotMatch(page, /Saved/, 'no Saved note for a save that did not happen');
  assert.equal(box().props.value, 'Synthetic consult, high complexity.', 'the dictation is kept');
  assert.ok(button(m.render(), 'wRVU'), 'the reviewed codes and their Save are still there');
});

test('Expenses: a refused save keeps the form and its staged receipt photo', async () => {
  const realReader = globalThis.FileReader;
  globalThis.FileReader = class { readAsDataURL(file) { file.arrayBuffer().then(b => { this.onload?.({ target: { result: `data:${file.type};base64,${Buffer.from(b).toString('base64')}` } }); }); } };
  try {
    const m = mount(screens.Expenses, { data: { locumContracts: [CONTRACT], documents: [] }, refuse: refuseAll });
    click(m, '+ Expense');
    find(m.render(), n => n.type === 'input' && n.props.placeholder === '$ amount', 'amount').props.onChange({ target: { value: '42.50' } });
    const upload = nodes(m.render()).find(n => n.type === 'input' && n.props.type === 'file' && n.props.multiple);
    upload.props.onChange({ target: { files: [new File([new Uint8Array([1, 2, 3])], 'synthetic-receipt.jpg', { type: 'image/jpeg' })], value: '' } });
    // The receipt is read from a real File (another thread): wait for it, bounded.
    await settleOutcome(20);
    assert.match(textOf(m.render()), /synthetic-receipt\.jpg/, 'the receipt is staged');
    click(m, 'Add expense');
    assert.deepEqual(writes(m), [], 'neither the expense nor its receipt was written');
    const page = textOf(m.render());
    assert.match(page, /synthetic-receipt\.jpg/, 'the staged receipt is kept');
    assert.equal(find(m.render(), n => n.type === 'input' && n.props.placeholder === '$ amount', 'amount').props.value, '42.50', 'and so is the amount');
  } finally { globalThis.FileReader = realReader; }
});

test('Days & call: a refused day stays open to save again', () => {
  const daily = { ...CONTRACT, id: 'd1', payModel: 'daily', dayRate: 2000 };
  const m = mount(screens.DutyLog, { data: { locumContracts: [daily], dutyDays: [] }, props: { contract: daily }, refuse: refuseAll });
  const add = nodes(m.render()).find(n => n.type === 'button' && /Log a day|Add day|\+ Day/i.test(textOf(n)));
  assert.ok(add, 'the add button');
  add.props.onClick();
  const saveButton = () => nodes(m.render()).find(n => n.type === 'button' && /^Save( day)?$/i.test(textOf(n).trim()));
  assert.ok(saveButton(), 'the day form is open');
  saveButton().props.onClick();
  const yes = nodes(m.render()).find(n => n.type === 'button' && textOf(n).includes('Yes'));
  if (yes) yes.props.onClick();
  assert.deepEqual(writes(m), []);
  assert.ok(m.calls.some(c => c[0] === 'refused' && c[2] === 'dutyDays'));
  assert.ok(saveButton(), 'the form is still open');
});

test('Contracts: a refused agreement save keeps the form open', () => {
  const m = mount(screens.Contracts, { data: { locumContracts: [CONTRACT] }, refuse: refuseAll });
  const card = find(m.render(), n => n.type === 'div' && n.key === 'c1', 'contract card');
  nodes(card).filter(n => n.type === 'button')[0].props.onClick();
  click(m, 'Save');
  assert.deepEqual(writes(m), []);
  assert.ok(m.calls.some(c => c[0] === 'refused' && c[2] === 'locumContracts'));
  const form = find(m.render(), n => n.props?.title === 'Edit Agreement', 'agreement form');
  assert.equal(form.props.open, true, 'the form is still open');
});

test('To-dos: a refused note stays in the box', () => {
  const m = mount(screens.TaskNotes, { data: { locumContracts: [CONTRACT], taskNotes: [] }, refuse: refuseAll });
  const box = () => find(m.render(), n => n.type === 'input' && /call back Dr/.test(n.props.placeholder || ''), 'note box');
  box().props.onChange({ target: { value: 'Synthetic follow-up' } });
  box().props.onKeyDown({ key: 'Enter' });
  assert.deepEqual(writes(m), []);
  assert.equal(box().props.value, 'Synthetic follow-up');
});

test('Forecast: a refused coverage load claims no days', () => {
  const m = mount(screens.Forecast, { data: { locumContracts: [CONTRACT], scheduleDays: [], workLog: [], invoices: [] }, refuse: refuseAll });
  click(m, 'Load contract coverage dates');
  assert.deepEqual(writes(m), []);
  assert.doesNotMatch(textOf(m.render()), /Loaded \d+ coverage day/);
});

// The first harness: every import stubbed unless passed, so the scanner is a
// recorder and nothing can reach a provider.
const recorder = () => { const calls = []; return { calls, fn: name => (...a) => { calls.push([name, ...a]); return false; } }; };

test('a credential form whose save is refused stays open with what was typed', async () => {
  const rec = recorder();
  const form = await mountComponent('src/components/features/CrudSection.jsx', {
    app: { data: { settings: {}, documents: [] }, theme: {}, user: { id: 'user_synthetic' }, isDesktop: false,
      addItem: rec.fn('addItem'), editItem: rec.fn('editItem'), setData: () => {}, toggleFavorite: () => {} },
    props: { title: 'Licenses', sectionKey: 'licenses', items: [], fields: [{ key: 'licenseNumber', label: 'License Number' }], autoOpen: true, onAutoOpenDone() {},
      onAdd: rec.fn('onAdd'), onEdit: rec.fn('onEdit') },
    modules: { lifecycle: await import('../../src/utils/lifecycle.js'), formLayout: await import('../../src/utils/formLayout.js') },
  });
  const numberField = () => form.nodes().find(n => n.props?.label === 'License Number');
  const input = () => form.nodes(numberField()).find(n => n.type === 'input');
  input().props.onChange({ target: { value: 'SYN-12345' } });
  const add = form.nodes().find(n => n.type === 'button' && form.text(n) === 'Add');
  add.props.onClick();
  assert.deepEqual(rec.calls.map(c => c[0]), ['onAdd'], 'the save was tried once, and nothing else was written');
  const modal = form.nodes().find(n => n.props && 'open' in n.props && n.props.title === 'Add');
  assert.equal(modal.props.open, true, 'the form is still open');
  assert.equal(input().props.value, 'SYN-12345', 'with the number typed in it');
});

test('Documents: an upload that was not saved is never sent to be read', async () => {
  // The real scanner, with its own key set so it would read the file; any
  // request it made would land here instead of a provider.
  const requests = [];
  const realFetch = globalThis.fetch, realReader = globalThis.FileReader;
  globalThis.fetch = async (url) => { requests.push(String(url)); throw new Error('No network in this test'); };
  globalThis.FileReader = class { readAsDataURL(file) { file.arrayBuffer().then(b => { this.onload?.({ target: { result: `data:${file.type};base64,${Buffer.from(b).toString('base64')}` } }); }); } };
  try {
    const m = mount(screens.DocumentsSection, { data: { settings: { apiKey: 'synthetic-key' }, locumContracts: [], documents: [], licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [], deductibles: [], customCategories: [], customRecords: [] }, refuse: refuseAll });
    const upload = nodes(m.render()).find(n => n.type === 'input' && n.props.type === 'file' && n.props.multiple);
    upload.props.onChange({ target: { files: [new File(['%PDF-1.4 synthetic'], 'license.pdf', { type: 'application/pdf' })], value: '' } });
    await settleOutcome(40);
    assert.ok(m.calls.some(c => c[0] === 'refused' && c[1] === 'add' && c[2] === 'documents'), 'the file save was tried and refused');
    assert.deepEqual(requests.filter(url => !/ai-proxy/.test(url)), [], 'nothing was sent to be read');
    assert.match(textOf(m.render()), /"license\.pdf" was not saved, so it was not read\. Nothing was changed\./);
  } finally { globalThis.fetch = realFetch; globalThis.FileReader = realReader; }
});
