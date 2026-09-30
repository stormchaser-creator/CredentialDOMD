// Vera's add and edit of a built-in record pass the identifier gate before
// anything is written. A W-9, a CV or an application page put "SSN" or a full
// date of birth into create_record's customFields (or a field of its own);
// AssistantSection wrote them to the record's custom_fields column and
// offered them to Admin > Field proposals as samples, with only her prompt
// in the way. The custom-record and scan paths already gated them.
// Synthetic values only: 123-45-6789 is not a real number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFields } from '../src/utils/sectionFields.js';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';

const SSN = '123-45-6789';
const DOB = '1961-03-14';

test('splitFields withholds identifiers from the fields and the custom fields', () => {
  const { clean, extra, withheld } = splitFields('licenses',
    { type: 'State Medical License', state: 'TX', dateOfBirth: DOB, notes: `SSN ${SSN}`, licenseNumber: 'SYN-0000' },
    { SSN, 'Tax ID': '12-3456789', Board: 'Synthetic Board', 'Medical Record #': '00481234' });
  assert.deepEqual(clean, { type: 'State Medical License', state: 'TX', licenseNumber: 'SYN-0000' });
  assert.deepEqual(extra, { Board: 'Synthetic Board' });
  assert.deepEqual(withheld.map(w => w.reason).sort(), [
    'a Social Security number', 'a Social Security number', 'a Social Security number', 'a full date of birth', 'a medical record number',
  ].sort());
  assert.ok(!JSON.stringify({ clean, extra }).includes(SSN) && !JSON.stringify({ clean, extra }).includes(DOB));
  // Ordinary credential numbers are not identifiers.
  assert.deepEqual(splitFields('insurance', { policyNumber: 'POL-123456789' }, { 'Certificate #': 'C-555' }).withheld, []);
});

function proposalsClient() {
  const inserts = [];
  const supabase = {
    from: (table) => ({ insert: (row) => { inserts.push([table, row]); return { then: (ok) => ok({}) }; } }),
    functions: { invoke: async () => ({ data: null }) },
  };
  return { inserts, modules: { supabase: { supabase } } };
}

async function approve(action, data = {}) {
  const client = proposalsClient();
  const v = await mountVera({ data, modules: client.modules, turn: async () => ({ reply: 'Here it is.', actions: [action] }) });
  await v.ask('file this W-9');
  await v.button('Approve').props.onClick();
  await settle();
  v.render();
  return { v, inserts: client.inserts, card: () => v.store.chat.at(-1).actions[0] };
}

test('a new built-in record keeps the SSN and the date of birth out of the record and the field proposals', async () => {
  const { v, inserts, card } = await approve({
    kind: 'create_record', section: 'licenses', summary: 'Texas license',
    fields: { type: 'State Medical License', state: 'TX', dateOfBirth: DOB },
    customFields: { SSN, Board: 'Synthetic Board' },
  });
  const written = v.rec.of('addItem').filter(c => c[1] === 'licenses').map(c => c[2]);
  assert.equal(written.length, 1);
  assert.equal(written[0].type, 'State Medical License');
  assert.deepEqual(JSON.parse(JSON.stringify(written[0].customFields)), { Board: 'Synthetic Board' });
  assert.ok(!JSON.stringify(written).includes(SSN) && !JSON.stringify(written).includes(DOB), JSON.stringify(written));
  const proposals = inserts.filter(([t]) => t === 'field_proposals').map(([, row]) => row);
  assert.deepEqual(proposals.map(p => p.label), ['Board']);
  assert.ok(!JSON.stringify(proposals).includes(SSN) && !JSON.stringify(proposals).includes(DOB));
  assert.equal(card().done, true);
  assert.match(card().note, /Not saved, on purpose: a Social Security number, a full date of birth\./);
});

test('the card says what will not be saved before Approve', async () => {
  const client = proposalsClient();
  const v = await mountVera({ modules: client.modules, turn: async () => ({ reply: 'Here it is.', actions: [{
    kind: 'create_record', section: 'workHistory', summary: 'Synthetic Hospital',
    fields: { employer: 'Synthetic Hospital' }, customFields: { SSN, 'Department': 'Surgery' },
  }] }) });
  await v.ask('add my job');
  const card = v.nodes().filter(n => n.type === 'div').map(n => v.text(n)).find(t => t.startsWith('Will not be saved'));
  assert.ok(card, 'the warning line is on the card');
  assert.match(card, /Will not be saved: a Social Security number\./);
  assert.ok(v.nodes().some(n => n.type === 'div' && v.text(n).trim() === '+1 extra detail kept as custom fields'), 'the count is what will be kept');
});

test('an edit of a built-in record keeps identifiers out and leaves the stored details alone', async () => {
  const existing = { id: 'lic-1', type: 'State Medical License', state: 'CO', customFields: { Board: 'Synthetic Board' } };
  const { v, inserts, card } = await approve({
    kind: 'update_record', section: 'licenses', id: 'lic-1', summary: 'Add details',
    fields: { notes: `DOB ${'3/14/61'}` }, customFields: { 'Tax ID': '12-3456789', Specialty: 'Neurosurgery' },
  }, { licenses: [existing] });
  const written = v.rec.of('editItem').filter(c => c[1] === 'licenses').map(c => c[2]);
  assert.equal(written.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(written[0].customFields)), { Board: 'Synthetic Board', Specialty: 'Neurosurgery' });
  assert.equal(written[0].notes, undefined, 'a note carrying a date of birth is not saved');
  assert.ok(!JSON.stringify(written).includes('12-3456789') && !JSON.stringify(written).includes('3/14/61'));
  assert.deepEqual(inserts.filter(([t]) => t === 'field_proposals').map(([, row]) => row.label), ['Specialty']);
  assert.match(card().note, /Not saved, on purpose: a Social Security number, a full date of birth\./);
});

test('a card whose every detail is an identifier writes nothing and says so', async () => {
  const { v, inserts, card } = await approve({
    kind: 'create_record', section: 'licenses', summary: 'W-9', fields: {}, customFields: { SSN, 'Date of Birth': DOB },
  });
  assert.equal(v.rec.of('addItem').filter(c => c[1] === 'licenses').length, 0);
  assert.deepEqual(inserts.filter(([t]) => t === 'field_proposals'), []);
  assert.notEqual(card().done, true);
  assert.match(card().error, /^Nothing was saved: every detail on this card is one this app does not keep \(a Social Security number, a full date of birth\)\.$/);
});
