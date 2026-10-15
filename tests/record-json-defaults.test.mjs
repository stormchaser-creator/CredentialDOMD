import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './limited-launch/persistence-fixture.mjs';

const A = 'user_syntheticA', profile = 'profileA';
const registry = {
  cme: { topics: [] }, healthRecords: { doses: [] }, customCategories: { fields: [], aliases: [] },
  customRecords: { fieldValues: {}, documentIds: [] }, dutyDays: { customFields: {}, callPeriods: [] },
  invoices: { entryIds: [], payments: [], dayOverMin: {} }, memberships: { customFields: {} },
  publications: { customFields: {} }, taskNotes: { customFields: {} },
};
test('only catalog-declared omitted JSON defaults compare with their server-filled values', () => {
  const { recordContent } = fixture().api;
  for (const [key, fields] of Object.entries(registry)) {
    assert.equal(recordContent(key, { id: 'row' }), recordContent(key, { id: 'row', ...fields }), key);
    for (const [field, value] of Object.entries(fields)) {
      assert.notEqual(recordContent(key, { id: 'row', [field]: null }), recordContent(key, { id: 'row' }), `${key}.${field}: explicit null`);
      assert.notEqual(recordContent(key, { id: 'row', [field]: Array.isArray(value) ? [1] : { other: 1 } }), recordContent(key, { id: 'row' }), `${key}.${field}: changed content`);
    }
  }
  for (const [key, field, value] of [['licenses', 'customFields', {}], ['invoices', 'lines', []], ['customCategories', 'customFields', {}], ['licenses', 'unknown', []]]) {
    assert.notEqual(recordContent(key, { id: 'row' }), recordContent(key, { id: 'row', [field]: value }), `${key}.${field}: no declared default`);
  }
});
test('same-record omitted array/object bases use exact empty predicates without adding omitted desired columns', async () => {
  for (const [key, field, column, value, expected] of [['invoices', 'payments', 'payments', [{ amount: 5 }], '[]'], ['customRecords', 'fieldValues', 'field_values', { label: 'new' }, '{}']]) {
    const f = fixture(), previous = { id: 'row' };
    f.onRequest = async op => ({ data: op.method === 'select' ? { id: 'row', [column]: key === 'customRecords' ? {} : [] } : [{ id: 'row', ...op.value }], error: null });
    await f.api.updateItem(profile, key, { ...previous, [field]: value }, previous, A);
    const request = f.requests.find(r => r.method === 'update');
    assert.ok(request.filters.some(([kind, name, old]) => kind === 'eq' && name === column && old === expected));
    assert.deepEqual(Object.keys(request.value).sort(), [column, 'updated_at'].sort());
  }
});
test('explicit null and absent/wrong-record predecessors never become an empty-array expectation', async () => {
  for (const previous of [{ id: 'row', payments: null }, null, { id: 'different' }]) {
    const f = fixture(); f.onRequest = async op => ({ data: [{ id: 'row', ...op.value }], error: null });
    await f.api.updateItem(profile, 'invoices', { id: 'row', payments: [{ amount: 5 }] }, previous, A);
    const request = f.requests.find(r => r.method === 'update');
    assert.ok(request.filters.some(([kind, expression]) => kind === 'or' && expression === 'payments.is.null,payments.eq.null'));
    assert.ok(!request.filters.some(([kind, name, old]) => kind === 'eq' && name === 'payments' && old === '[]'));
  }
});
