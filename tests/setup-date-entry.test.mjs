// SETTINGS-010: the Setup date strip saved on every change of its date field.
// Desktop Chrome, Edge and Firefox fire a change for every year digit typed
// (0002-05-01, 0020-05-01, 0202-05-01, 2026-05-01); the first one saved the
// license as expiring in the year 2, it read EXPIRED, the Dates task closed
// and the row unmounted before the rest of the year could be typed.
//
// In Safari (WebKit 26) the year's last digit then crashed the page: the save
// dated the license and the strip dropped the row while Safari's date field
// was still handling the keystroke in it. The save now waits for the next
// task (the QA lab's own WebKit shows the crash with a plain date input
// removed in its own input event; removed a task later, none).
//
// The real DateRow through the component harness, and the real prepareRecord
// every add and edit passes through. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';
import { prepareRecord } from '../src/utils/recordWrite.js';

async function row(rec = { id: 'lic-synthetic', type: 'State Medical License', state: 'TX', licenseNumber: 'SYN-1' }) {
  const edits = [], captured = [];
  const app = { data: { settings: {}, documents: [] }, editItem: (key, value) => edits.push([key, JSON.parse(JSON.stringify(value))]), addItem() {}, theme: {} };
  const c = await mountComponent('src/components/features/setup/DateFixList.jsx', { app, exportName: 'DateRow', props: { rec, onCaptured: r => captured.push(r.id) } });
  const input = () => c.nodes().find(n => n.type === 'input' && n.props.type === 'date');
  const change = value => { input().props.onChange({ target: { value } }); c.render(); };
  // The next task: what setTimeout(fn, 0) put off runs.
  const later = () => { for (const fn of c.timers.splice(0)) fn(); c.render(); };
  return { c, edits, captured, input, change, later };
}

test('typing a year digit by digit saves only the finished date', async () => {
  const r = await row();
  for (const value of ['0002-05-01', '0020-05-01', '0202-05-01']) r.change(value);
  assert.deepEqual(r.edits, [], 'no year below 1900 is saved');
  assert.equal(r.input().props.value, '0202-05-01', 'the field keeps what is being typed');
  r.change('2026-05-01');
  r.later();
  assert.deepEqual(r.edits.map(([key, value]) => [key, value.expirationDate]), [['licenses', '2026-05-01']]);
  assert.deepEqual(r.captured, ['lic-synthetic']);
});

test('SETTINGS-010: the finished date is saved after the field\'s own event, never inside it, and once', async () => {
  const r = await row();
  for (const value of ['0002-05-01', '0020-05-01', '0202-05-01']) r.change(value);
  r.change('2027-05-01');
  assert.deepEqual(r.edits, [], 'nothing is saved (and the row stays) while the field still handles the keystroke');
  assert.deepEqual(r.captured, []);
  assert.equal(r.input().props.value, '2027-05-01', 'the field shows the whole date meanwhile');
  r.later();
  assert.deepEqual(r.edits.map(([key, value]) => [key, value.expirationDate]), [['licenses', '2027-05-01']]);
  assert.deepEqual(r.captured, ['lic-synthetic']);
  // The Tab that follows leaves the field: not saved a second time.
  r.input().props.onBlur({ target: { value: '2027-05-01' } });
  r.input().props.onKeyDown({ key: 'Enter', target: { value: '2027-05-01' } });
  r.later();
  assert.equal(r.edits.length, 1);
});

test('SETTINGS-010: a date the save refuses (a membership check) stays typed, and Enter saves it again', async () => {
  let refuse = true;
  const edits = [];
  const app = { data: { settings: {}, documents: [] }, editItem: (key, value) => { edits.push(value.expirationDate); return !refuse; }, addItem() {}, theme: {} };
  const c = await mountComponent('src/components/features/setup/DateFixList.jsx', { app, exportName: 'DateRow', props: { rec: { id: 'lic-r', state: 'NM' }, onCaptured() {} } });
  const input = () => c.nodes().find(n => n.type === 'input' && n.props.type === 'date');
  input().props.onChange({ target: { value: '2027-05-01' } });
  for (const fn of c.timers.splice(0)) fn();
  assert.deepEqual(edits, ['2027-05-01']);
  assert.equal(input().props.value, '2027-05-01');
  refuse = false;
  input().props.onKeyDown({ key: 'Enter', target: { value: '2027-05-01' } });
  for (const fn of c.timers.splice(0)) fn();
  assert.deepEqual(edits, ['2027-05-01', '2027-05-01']);
});

// Review of release/goal2 (2026-10-02): the saved date stayed the field's
// draft for as long as the row was mounted. SetupPage's DEA drawer keeps the
// row after a save; a newer date from another device was hidden behind the
// typed one, and typing the typed date back saved nothing.
test('a row kept on screen after a save shows the record\'s date when it changes, and can save the old one again', async () => {
  const rec = { id: 'dea-synthetic', type: 'DEA Registration', state: 'TX', expirationDate: '2026-01-01' };
  const r = await row(rec);
  r.change('2027-05-01');
  r.later();
  assert.deepEqual(r.edits.map(([, v]) => v.expirationDate), ['2027-05-01']);
  r.c.setProps({ rec: { ...rec, expirationDate: '2027-05-01' }, onCaptured() {} });
  assert.equal(r.input().props.value, '2027-05-01');
  r.c.setProps({ rec: { ...rec, expirationDate: '2028-05-01' }, onCaptured() {} });   // a sync from the Mac
  assert.equal(r.input().props.value, '2028-05-01', 'the record\'s date, not the one typed before');
  r.change('2027-05-01');
  r.input().props.onBlur({ target: { value: '2027-05-01' } });
  r.later();
  assert.deepEqual(r.edits.map(([, v]) => v.expirationDate), ['2027-05-01', '2027-05-01'], 'saved again');
  // Must pass: a date still being typed is not swept away by a change elsewhere.
  const t = await row(rec);
  t.change('0202-05-01');
  t.c.setProps({ rec: { ...rec, expirationDate: '2029-01-01' }, onCaptured() {} });
  assert.equal(t.input().props.value, '0202-05-01');
});

test('leaving the field or pressing Enter saves a finished date once; a partial one is not saved', async () => {
  const r = await row();
  r.change('');
  r.input().props.onBlur({ target: { value: '' } });
  assert.deepEqual(r.edits, []);
  const s = await row({ id: 'lic-2', state: 'CA', expirationDate: '2027-01-31' });
  s.input().props.onBlur({ target: { value: '2027-01-31' } });
  assert.deepEqual(s.edits, [], 'an unchanged date is not saved again');
  const t = await row();
  t.input().props.onKeyDown({ key: 'Enter', target: { value: '0020-05-01' } });
  assert.deepEqual(t.edits, [], 'Enter on a half-typed year saves nothing');
});

test('prepareRecord never stores an expiration or issue year before 1900, on any path', () => {
  const added = prepareRecord('licenses', { id: 'a', type: 'DEA Registration', expirationDate: '0002-05-01', issuedDate: '0020-01-01' }, '');
  assert.equal(added.expirationDate, '');
  assert.equal(added.issuedDate, '');
  const previous = { id: 'b', type: 'DEA Registration', expirationDate: '2026-05-01' };
  const edited = prepareRecord('licenses', { ...previous, expirationDate: '0202-05-01' }, '', previous);
  assert.equal(edited.expirationDate, '2026-05-01', 'an edit keeps the date it had');
  assert.equal(prepareRecord('licenses', { id: 'c', expirationDate: '2026-05-01' }, '').expirationDate, '2026-05-01');
  assert.equal(prepareRecord('licenses', { id: 'd', expirationDate: '1999-12-31' }, '').expirationDate, '1999-12-31');
});
