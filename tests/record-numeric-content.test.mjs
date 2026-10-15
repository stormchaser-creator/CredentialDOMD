import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './limited-launch/persistence-fixture.mjs';
import { isAcknowledgedRecordCopy } from '../src/utils/recordAcknowledgements.js';

const catalog = JSON.parse(readFileSync(new URL('./helpers/record-numeric-catalog.json', import.meta.url)));
const A = 'user_syntheticA', profile = 'profileA';
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const clone = value => JSON.parse(JSON.stringify(value));
const scope = { accountId: A, fence: null };
const content = fixture().api.recordContent;
const cost = value => content('licenses', { id: 'row', renewalCost: value });
const accepted = async (f, collection, item) => isAcknowledgedRecordCopy(
  await f.acknowledgements.acknowledgedRecordCopies({ [collection]: [item] }, scope), collection, item.id);

// This bounded server fixture handles only the small finite values in these
// receipt cases. Exact decimal/precision controls below use explicit answers,
// not this fixture's Number conversion as an oracle.
function server(f, c) {
  let row = null;
  const version = '2026-10-01T05:11:26.075+00:00';
  const typed = v => v == null ? v : Number(v);
  const matches = op => op.filters.every(([kind, key, value]) => kind === 'is'
    ? row?.[key] == null : (key === c.column ? row?.[key] === typed(value) : row?.[key] === value));
  f.onRequest = async op => {
    if (op.method === 'insert') {
      row = { ...clone(op.value), [c.column]: typed(op.value[c.column]), updated_at: version };
      return { data: [clone(row)], error: null };
    }
    if (op.method === 'select') return { data: matches(op) ? clone(row) : null, error: null };
    if (op.method === 'update') {
      if (!matches(op)) return { data: [], error: null };
      row = { ...row, ...clone(op.value) };
      if (Object.hasOwn(op.value, c.column)) row[c.column] = typed(op.value[c.column]);
      return { data: [clone(row)], error: null };
    }
    throw Error(`Unexpected ${op.method}`);
  };
  return { get: () => clone(row), change: patch => { row = { ...row, ...patch }; } };
}

test('all 20 schema-confirmed numeric columns compare equivalent decimal strings and JSON numbers', () => {
  assert.equal(catalog.columns.length, 20);
  for (const c of catalog.columns) {
    const field = camel(c.column), record = value => content(c.collection, { id: 'row', [field]: value });
    assert.equal(record('0450.00'), record(450), `${c.table}.${c.column}`);
    assert.notEqual(record('450.01'), record(450), `${c.column}: genuinely changed amount`);
    assert.notEqual(record(null), record(0), `${c.column}: NULL is not zero`);
  }
});

test('decimal normalization is exact across signs, leading/trailing zeros, exponents and negative zero', () => {
  for (const [expected, forms] of [
    [450, ['450', '450.00', '+00450.000', '4.5e2', '45E+1', '45000e-2', ' 450.00\t']],
    [0.5, ['.5', '0.500', '+5e-1', '0050e-2']],
    [-12.25, ['-12.2500', '-001225e-2']],
    [0, ['0', '-0', '-0.000', '+0e20', '000.00', -0]],
    [1e-7, ['0.0000001', '1e-7', '100e-9']],
  ]) for (const value of forms) assert.equal(cost(value), cost(expected), String(value));
  assert.equal(cost('123456789012345678901234567890.123400'), cost('1234567890123456789012345678901234e-4'), 'string precision is retained without expanding a decimal');
});

test('invalid, unsafe, rounded or genuinely different decimals never become an accepted exact value', () => {
  for (const value of ['450x', '$450', '4,50', '0x1c2', 'Infinity', '-Infinity', 'NaN', ' ', '\u00a0450', '450\u00a0', '\ufeff450', '\u2003450', true, false,
    [], { value: 450 }, ['numeric', '', '45', '1'], Infinity, -Infinity, NaN]) assert.notEqual(cost(value), cost(450));
  for (const [a, b] of [
    ['0.10000000000000001', 0.1], ['9007199254740993', 9007199254740992],
    ['9007199254740992', 9007199254740992], ['1000000000000000100', 1000000000000000100],
    ['1e-999999999', 0], ['1e-400', 0], ['1.234', 1.23], ['1.2301', 1.23],
    ['-0.00000000000000001', 0], ['123456789012345678901.001', '123456789012345678901.002'],
  ]) assert.notEqual(cost(a), cost(b), `${String(a)} must not collapse into ${String(b)}`);
  assert.notEqual(cost(null), cost(0));
  assert.notEqual(content('dutyDays', { id: 'row', amount: null }), content('dutyDays', { id: 'row' }), 'explicit NULL stays distinct from the omitted numeric default');
});

test('only a numeric default accepts an equivalent explicit decimal spelling', () => {
  assert.equal(content('dutyDays', { id: 'row', amount: '0.00' }), content('dutyDays', { id: 'row' }), 'the actual SQL numeric default has the same mathematical value');
  assert.notEqual(content('licenses', { id: 'row', dateUnknown: 'false' }), content('licenses', { id: 'row' }), 'boolean default is not a numeric spelling');
  assert.notEqual(content('locumContracts', { id: 'row', dayStartHour: '7' }), content('locumContracts', { id: 'row' }), 'integer normalization is outside this fix');
});

test('text, unknown columns, nested JSON and non-normalized integer columns retain literal types', () => {
  for (const [collection, field] of [['licenses', 'licenseNumber'], ['licenses', 'unknown'], ['insurance', 'coveragePerClaim'],
    ['malpracticeHistory', 'settlementAmount'], ['publications', 'year'], ['cme', 'certificateNumber'],
    ['locumContracts', 'dayStartHour'], ['documents', 'size'], ['workLog', 'durationMin']]) {
    assert.notEqual(content(collection, { id: 'row', [field]: '450' }), content(collection, { id: 'row', [field]: 450 }), `${collection}.${field}`);
  }
  for (const field of ['customFields', 'topics']) assert.notEqual(content('cme', { id: 'row', [field]: { hours: '5.00' } }), content('cme', { id: 'row', [field]: { hours: 5 } }));
});

test('the saved full6 license INSERT shape is acknowledged despite the server numeric transport representation', async () => {
  const f = fixture();
  const local = { id: 'synthetic-license', type: 'State Medical License', name: 'QA Texas Medical License', licenseNumber: 'QA-TX-1001', state: 'TX',
    issuedDate: '2024-01-15', expirationDate: '2027-11-05', renewalCost: '450', cmeCycleStart: '2025-01-01' };
  const cloud = { id: local.id, user_id: profile, type: local.type, name: local.name, license_number: local.licenseNumber, state: 'TX',
    issued_date: local.issuedDate, expiration_date: local.expirationDate, renewal_cost: 450, cme_cycle_start: local.cmeCycleStart,
    npi_imported: false, lifecycle_status: 'active', date_unknown: false, no_expiration: false, favorite: false,
    custom_fields: null, notes: null, superseded_by: null, status_source: null, updated_at: '2026-10-01T05:11:26.075+00:00' };
  f.onRequest = async () => ({ data: [cloud], error: null });
  await f.api.insertItem(profile, 'licenses', local);
  assert.equal(await accepted(f, 'licenses', local), true, 'the exact local snapshot receives its confirmed receipt');
  assert.equal(f.requests[0].value.renewal_cost, '450', 'write payload remains the original string');
  assert.equal(f.api.recordContent('licenses', local), f.api.recordContent('licenses', cloud), 'the reload comparison sees no recovery difference even without a receipt');
  assert.equal(f.recovery.readRecovery(A).length, 0);
});

test('each SQL numeric returning insert supplies a causal receipt and its immediate offline note edit replays without recovery', async () => {
  for (const c of catalog.columns) {
    const f = fixture(), db = server(f, c), original = { id: 'row', notes: 'Original', [camel(c.column)]: '450.00' };
    await f.api.insertItem(profile, c.collection, original);
    assert.equal(await accepted(f, c.collection, original), true, c.column);
    assert.equal(f.requests[0].value[c.column], '450.00');
    const desired = { ...original, notes: 'Offline edit' };
    await f.api.updateItem(null, c.collection, desired, original, A);
    assert.equal(f.queue().length, 1); assert.equal(f.queue()[0].expectedBase?.version, db.get().updated_at);
    await f.api.replayPendingOps(profile, A);
    assert.equal(db.get().notes, desired.notes); assert.equal(db.get()[c.column], 450);
    assert.equal(f.queue().length, 0); assert.equal(f.recovery.readRecovery(A).length, 0);
    assert.equal(await accepted(f, c.collection, desired), true);
  }
});

test('equivalent queued numeric strings can be confirmed from the full cloud row without sending another update', async () => {
  const f = fixture(), c = catalog.columns.find(c => c.collection === 'cme'), db = server(f, c);
  const original = { id: 'row', category: 'Other', hours: '5.00', notes: 'Original' };
  await f.api.insertItem(profile, 'cme', original);
  f.values.delete(`acks:${A}`);
  f.values.set(`ops:${A}`, JSON.stringify([{ op: 'upsert', collectionKey: 'cme', payload: original, ts: 1 }]));
  await f.api.replayPendingOps(profile, A);
  assert.equal(db.get().hours, 5); assert.equal(f.requests.some(r => r.method === 'update'), false);
  assert.equal(f.queue().length, 0); assert.equal(f.recovery.readRecovery(A).length, 0);
  assert.equal(await accepted(f, 'cme', original), true);
});

test('a genuine same-version cloud numeric change or NULL blocks an offline edit and retains both copies', async () => {
  for (const remote of [450.01, null]) {
    const f = fixture(), c = catalog.columns.find(c => c.collection === 'licenses'), db = server(f, c);
    const original = { id: 'row', type: 'Other', renewalCost: '450.00', notes: 'Original' };
    await f.api.insertItem(profile, 'licenses', original);
    const desired = { ...original, notes: 'Offline edit' };
    await f.api.updateItem(null, 'licenses', desired, original, A);
    db.change({ renewal_cost: remote });
    await f.api.replayPendingOps(profile, A);
    assert.equal(db.get().notes, 'Original'); assert.equal(db.get().renewal_cost, remote);
    assert.equal(f.requests.some(r => r.method === 'update'), false);
    assert.ok(f.recovery.readRecovery(A).some(r => r.local.notes === desired.notes && r.cloud.renewalCost === remote));
  }
});

test('CME server scale rounding is not an exact receipt and remains recoverable', async () => {
  const f = fixture(), original = { id: 'row', category: 'Other', hours: '1.234', notes: 'Original' };
  const cloud = { id: 'row', user_id: profile, category: 'Other', hours: 1.23, notes: 'Original', updated_at: '2026-10-01T00:00:00Z' };
  f.onRequest = async op => ({ data: op.method === 'select' ? cloud : [cloud], error: null });
  await f.api.insertItem(profile, 'cme', original);
  assert.equal(await accepted(f, 'cme', original), false);
  await f.api.updateItem(null, 'cme', { ...original, notes: 'Offline edit' }, original, A);
  assert.equal(f.queue()[0].expectedBase, null);
  await f.api.replayPendingOps(profile, A);
  assert.equal(f.requests.some(r => r.method === 'update'), false);
  assert.ok(f.recovery.readRecovery(A).some(r => r.local.hours === '1.234' && r.cloud.hours === 1.23));
});

test('numeric comparison never rewrites direct PATCH values or their exact previous-value predicates', async () => {
  for (const c of catalog.columns) for (const previousValue of ['450.00', null]) {
    const field = camel(c.column), f = fixture(), db = server(f, c), previous = { id: 'row', [field]: previousValue };
    await f.api.insertItem(profile, c.collection, previous);
    const desired = { ...previous, [field]: '500.00' };
    await f.api.updateItem(profile, c.collection, desired, previous, A);
    const patch = f.requests.find(r => r.method === 'update');
    assert.equal(patch.value[c.column], '500.00');
    assert.ok(patch.filters.some(([kind, column, value]) => kind === (previousValue === null ? 'is' : 'eq') && column === c.column && value === previousValue));
    assert.equal(db.get()[c.column], 500); assert.equal(await accepted(f, c.collection, desired), true);
  }
});

test('a direct same-version concurrent numeric edit is refused by the unchanged atomic predicate', async () => {
  const c = catalog.columns.find(c => c.collection === 'licenses');
  for (const remote of [450.01, null]) {
    const f = fixture(), db = server(f, c), previous = { id: 'row', renewalCost: '450.00' };
    await f.api.insertItem(profile, 'licenses', previous);
    const version = db.get().updated_at;
    db.change({ renewal_cost: remote });
    await f.api.updateItem(profile, 'licenses', { ...previous, renewalCost: '500.00' }, previous, A);
    assert.equal(db.get().renewal_cost, remote); assert.equal(db.get().updated_at, version);
    const patch = f.requests.find(r => r.method === 'update');
    assert.ok(patch.filters.some(([kind, column, value]) => kind === 'eq' && column === 'renewal_cost' && value === '450.00'));
    assert.ok(f.recovery.readRecovery(A).some(r => r.local.renewalCost === '500.00' && r.cloud.renewalCost === remote));
  }
});
