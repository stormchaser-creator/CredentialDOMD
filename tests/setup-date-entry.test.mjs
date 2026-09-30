// SETTINGS-010: the Setup date strip saved on every change of its date field.
// Desktop Chrome, Edge and Firefox fire a change for every year digit typed
// (0002-05-01, 0020-05-01, 0202-05-01, 2026-05-01); the first one saved the
// license as expiring in the year 2, it read EXPIRED, the Dates task closed
// and the row unmounted before the rest of the year could be typed.
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
  return { c, edits, captured, input, change };
}

test('typing a year digit by digit saves only the finished date', async () => {
  const r = await row();
  for (const value of ['0002-05-01', '0020-05-01', '0202-05-01']) r.change(value);
  assert.deepEqual(r.edits, [], 'no year below 1900 is saved');
  assert.equal(r.input().props.value, '0202-05-01', 'the field keeps what is being typed');
  r.change('2026-05-01');
  assert.deepEqual(r.edits.map(([key, value]) => [key, value.expirationDate]), [['licenses', '2026-05-01']]);
  assert.deepEqual(r.captured, ['lic-synthetic']);
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
