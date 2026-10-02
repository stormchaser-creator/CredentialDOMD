// Review of 9484782c. The owner keeps the installed iPhone app and desktop
// Chrome open on one account at once. Three ways a phone's write still put
// its stale copy over the desk's:
//  - an edit that failed, or was held for a membership answer, was queued as
//    the whole record and replayed as an upsert of every column, so the queue
//    sent when the signal came back reverted the desk's renewal and star;
//  - a custom record's field values (one jsonb column) went up whole, so a
//    change to one field put back the phone's stale copy of the others, and
//    a field added to a category on the phone dropped one added at the desk;
//  - a load's self-heal push landing before the add's own insert made the add
//    fail with 23505, shown as "it duplicates another record" though saved.
// The real src/lib/supabase.js over an in-memory server. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './persistence-fixture.mjs';
import { applyHeldQueue } from '../../src/utils/heldChanges.js';
import { ACCOUNT, settle, active, fixture as appFixture, replayOnAnswer } from './no-answer-harness.mjs';
import { readFileSync } from 'node:fs';

// Values made in the vm realm, compared as plain JSON.
const plain = v => JSON.parse(JSON.stringify(v));
const idOf = op => op.filters.find(([m, c]) => m === 'eq' && c === 'id')?.[2];
// One table of rows, as PostgREST answers this client's calls.
function server(f, table, rows, { offline = () => false, uniqueOther = null } = {}) {
  const db = new Map(rows.map(r => [r.id, { ...r }]));
  f.onRequest = async (op) => {
    if (op.table !== table) return { error: null, data: [] };
    if (offline()) return { error: { message: 'Failed to fetch', code: '' }, data: null };
    const id = idOf(op);
    if (op.method === 'select') {
      const row = db.get(id);
      if (!row) return { error: null, data: null };
      return { error: null, data: Object.fromEntries(String(op.value).split(',').map(c => [c, row[c]])) };
    }
    if (op.method === 'update') {
      if (!db.has(id)) return { error: null, data: [] };
      db.set(id, { ...db.get(id), ...op.value });
      return { error: null, data: [{ id }] };
    }
    if (op.method === 'upsert') { db.set(op.value.id, { ...(db.get(op.value.id) || {}), ...op.value }); return { error: null }; }
    if (op.method === 'insert') {
      if (db.has(op.value.id) || (uniqueOther && [...db.values()].some(r => r[uniqueOther] === op.value[uniqueOther]))) return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      db.set(op.value.id, { ...op.value });
      return { error: null };
    }
    return { error: null };
  };
  return db;
}

const license = { id: 'lic-1', name: 'QA license', state: 'TX', number: 'Q-100', notes: '', expirationDate: '2026-12-31', favorite: false, updatedAt: '2026-09-01T00:00:00.000Z' };
const licenseRow = { id: 'lic-1', user_id: 'profileA', name: 'QA license', state: 'TX', number: 'Q-100', notes: null, expiration_date: '2026-12-31', favorite: false, updated_at: '2026-09-01T00:00:00.000Z' };

test('a failed edit is queued as what it changed, and its replay leaves the desk\'s renewal and star in place', async () => {
  const f = fixture();
  let offline = true;
  const db = server(f, 'licenses', [licenseRow], { offline: () => offline });
  // The phone changes Notes in a dead zone.
  await f.api.updateItem('profileA', 'licenses', { ...license, notes: 'phone note', updatedAt: '2026-10-01T10:00:00.000Z' }, license, 'user_syntheticA');
  const [queued] = f.queue();
  assert.equal(queued.op, 'upsert');
  assert.deepEqual(queued.changed, ['notes'], 'queued as the one field it changed');
  // The desk renews and stars it meanwhile.
  db.set('lic-1', { ...db.get('lic-1'), expiration_date: '2028-12-31', favorite: true, updated_at: '2026-10-01T11:00:00.000Z' });
  offline = false;
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  const sent = f.requests.filter(r => r.table === 'licenses' && r.method !== 'select').at(-1);
  assert.equal(sent.method, 'update', 'an UPDATE, not an upsert of every column');
  assert.deepEqual(Object.keys(sent.value).sort(), ['id', 'notes', 'updated_at']);
  const row = db.get('lic-1');
  assert.equal(row.notes, 'phone note');
  assert.equal(row.expiration_date, '2028-12-31', 'the desk renewal stands');
  assert.equal(row.favorite, true, 'the desk star stands');
  assert.ok(row.updated_at > '2026-10-01T11:00:00.000Z', 'dated as it lands, so no device takes it for older than the desk copy');
  assert.deepEqual(f.queue(), []);
});

test('a queued edit whose row does not exist yet is created whole, as before', async () => {
  const f = fixture();
  let offline = true;
  const db = server(f, 'licenses', [], { offline: () => offline });
  await f.api.updateItem('profileA', 'licenses', { ...license, notes: 'phone note' }, license, 'user_syntheticA');
  offline = false;
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.deepEqual(f.requests.filter(r => r.table === 'licenses').slice(-2).map(r => r.method), ['update', 'upsert']);
  assert.equal(db.get('lic-1').name, 'QA license');
  assert.equal(db.get('lic-1').notes, 'phone note');
  assert.deepEqual(f.queue(), []);
});

test('a live edit made while an earlier one is queued sends both changes, and only those', async () => {
  const f = fixture();
  let offline = true;
  server(f, 'licenses', [licenseRow], { offline: () => offline });
  const first = { ...license, notes: 'phone note' };
  await f.api.updateItem('profileA', 'licenses', first, license, 'user_syntheticA');
  offline = false;
  await f.api.updateItem('profileA', 'licenses', { ...first, number: 'Q-200' }, first, 'user_syntheticA');
  const update = f.requests.filter(r => r.table === 'licenses' && r.method === 'update').at(-1);
  assert.deepEqual(Object.keys(update.value).sort(), ['id', 'notes', 'number', 'updated_at']);
  assert.deepEqual(f.queue(), [], 'the landed edit carried the queued one, which leaves the queue');
});

test('an edit held for a membership answer is queued as what it changed and goes up as that', async () => {
  const CME = '00000000-0000-4000-8000-00000000c001';
  const course = (extra = {}) => ({ id: CME, name: 'Synthetic Stroke Update', hours: 2, ...extra });
  const f = appFixture({ records: { cme: [course()] } });
  assert.notEqual(f.app.editItem('cme', course({ name: 'Synthetic Stroke Update 2026' })), false);
  f.checks[0].fail();
  await settle();
  assert.deepEqual(f.queue().map(op => [op.op, op.awaitingAccess, op.changed]), [['upsert', true, ['name']]]);
  f.authority.accept(ACCOUNT, active());
  await replayOnAnswer(f);
  const [sent] = f.writes();
  assert.equal(sent.method, 'update');
  assert.deepEqual(Object.keys(sent.value).sort(), ['id', 'name', 'updated_at'], 'never the hours the desk may have changed');
  assert.deepEqual(f.alerts, []);
});

test('a load lays a queued edit over the row it reads back by the fields it changed, and the self-heal never pushes it whole', () => {
  const ops = [{ op: 'upsert', collectionKey: 'licenses', payload: { ...license, notes: 'phone note', updatedAt: '2026-10-01T10:00:00.000Z' }, changed: ['notes'], ts: 1, queueId: 'q1' }];
  const cloud = { ...license, expirationDate: '2028-12-31', favorite: true, updatedAt: '2026-10-01T09:00:00.000Z' };
  const { data, edited } = applyHeldQueue({ settings: {}, licenses: [cloud] }, ops, ['licenses']);
  assert.deepEqual(data.licenses[0], { ...cloud, notes: 'phone note' }, 'the desk renewal and star, with the phone note');
  assert.ok(edited.has('licenses:lic-1'));
  const app = readFileSync(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
  assert.match(app, /if \(heldQueue\.edited\?\.has\(`\$\{key\}:\$\{x\.id\}`\)\) \{[\s\S]{0,400}?\n\s*continue;/, 'the self-heal skips it (a file given again aside)');
});

// ─── Packed columns ─────────────────────────────────────────────────────
const record = { id: 'rec-1', categoryId: 'cat-1', name: 'QA malpractice', fieldValues: { carrier: 'Old Carrier', policy_number: 'P1' }, fieldLabels: { carrier: 'Carrier', policy_number: 'Policy number' } };
const recordRow = { id: 'rec-1', user_id: 'profileA', category_id: 'cat-1', name: 'QA malpractice', field_values: { carrier: 'Desk Carrier', policy_number: 'P1' }, field_labels: { carrier: 'Carrier', policy_number: 'Policy number' } };

test('a change to one field of a custom record keeps the field the desk changed since', async () => {
  const f = fixture();
  const db = server(f, 'custom_records', [recordRow]);
  // The phone's screen still holds the old Carrier (its resume reload failed).
  await f.api.updateItem('profileA', 'customRecords', { ...record, fieldValues: { ...record.fieldValues, policy_number: 'P2' } }, record, 'user_syntheticA');
  const update = f.requests.find(r => r.method === 'update');
  assert.deepEqual(plain(update.value.field_values), { carrier: 'Desk Carrier', policy_number: 'P2' });
  assert.ok(!('field_labels' in update.value), 'an unchanged packed column is not sent');
  assert.deepEqual(plain(db.get('rec-1').field_values), { carrier: 'Desk Carrier', policy_number: 'P2' });
});

test('a field added to a category on the phone keeps one added at the desk', async () => {
  const category = { id: 'cat-1', name: 'Malpractice', fields: [{ key: 'carrier', label: 'Carrier', type: 'text' }] };
  const f = fixture();
  const db = server(f, 'custom_categories', [{ id: 'cat-1', user_id: 'profileA', name: 'Malpractice', fields: [{ key: 'carrier', label: 'Carrier', type: 'text' }, { key: 'desk_field', label: 'Desk field', type: 'text' }] }]);
  await f.api.updateItem('profileA', 'customCategories', { ...category, fields: [...category.fields, { key: 'phone_field', label: 'Phone field', type: 'text' }] }, category, 'user_syntheticA');
  assert.deepEqual(plain(db.get('cat-1').fields.map(x => x.key)), ['carrier', 'desk_field', 'phone_field']);
});

test('a queued change to one field is merged the same way when it replays', async () => {
  const f = fixture();
  let offline = true;
  const db = server(f, 'custom_records', [{ ...recordRow, field_values: { carrier: 'Old Carrier', policy_number: 'P1' } }], { offline: () => offline });
  await f.api.updateItem('profileA', 'customRecords', { ...record, fieldValues: { ...record.fieldValues, policy_number: 'P2' } }, record, 'user_syntheticA');
  assert.deepEqual(plain(f.queue()[0].base), { field_values: { carrier: 'Old Carrier', policy_number: 'P1' } }, 'the copy it started from rides with it');
  db.set('rec-1', { ...db.get('rec-1'), field_values: { carrier: 'Desk Carrier', policy_number: 'P1' } });
  offline = false;
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.deepEqual(plain(db.get('rec-1').field_values), { carrier: 'Desk Carrier', policy_number: 'P2' });
  assert.deepEqual(f.queue(), []);
});

// Review of 5cb89c90: custom_fields on every other table went up whole.
test('a change to one custom field of a license keeps the key the desk changed since', async () => {
  const f = fixture();
  const db = server(f, 'licenses', [{ ...licenseRow, custom_fields: { topicA: 'yes', topicB: 'no' } }]);
  const stale = { ...license, customFields: { topicA: 'no', topicB: 'no' } };
  await f.api.updateItem('profileA', 'licenses', { ...stale, customFields: { topicA: 'no', topicB: 'yes' } }, stale, 'user_syntheticA');
  assert.deepEqual(plain(db.get('lic-1').custom_fields), { topicA: 'yes', topicB: 'yes' }, 'the desk\'s topicA stands');
});

test('an archive of a locum contract queued offline keeps the note the desk changed since when it replays', async () => {
  const f = fixture();
  let offline = true;
  const contract = { id: 'lc-1', facility: 'QA Facility', customFields: { note: 'old' }, updatedAt: '2026-09-01T00:00:00.000Z' };
  const db = server(f, 'locum_contracts', [{ id: 'lc-1', user_id: 'profileA', facility: 'QA Facility', custom_fields: { note: 'old' }, updated_at: '2026-09-01T00:00:00.000Z' }], { offline: () => offline });
  // Contracts.jsx toggleArchived.
  await f.api.updateItem('profileA', 'locumContracts', { ...contract, customFields: { ...contract.customFields, archivedAt: '2026-10-01T10:00:00.000Z' } }, contract, 'user_syntheticA');
  db.set('lc-1', { ...db.get('lc-1'), custom_fields: { note: 'desk new' } });
  offline = false;
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.deepEqual(plain(db.get('lc-1').custom_fields), { note: 'desk new', archivedAt: '2026-10-01T10:00:00.000Z' });
  assert.deepEqual(f.queue(), []);
});

test('rebasePacked: per key, per field key, and as a set', () => {
  assert.deepEqual(plainRebase({ a: 1, b: 2, c: 3 }, { a: 1, b: 1 }, { a: 1, b: 5 }), { a: 1, b: 5, c: 3 });
  assert.deepEqual(plainRebase({ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1 }), { a: 1 }, 'a key the edit removed goes');
  assert.deepEqual(plainRebase(['x', 'y', 'z'], ['x', 'y'], ['y', 'w']), ['y', 'z', 'w']);
  assert.deepEqual(plainRebase([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], [{ key: 'a', label: 'A' }], [{ key: 'a', label: 'A2' }]).map(x => x.label), ['A2', 'B']);
});
let api = null;
const f2 = () => (api ??= fixture().api);
function plainRebase(...args) { return plain(f2().rebasePacked(...args)); }

// ─── An add whose row another write created first ───────────────────────
test('an add whose own row a self-heal push created first is saved, not "it duplicates another record"', async () => {
  const f = fixture();
  const db = server(f, 'licenses', []);
  // The resume reload's self-heal pushed it while the insert was on its way.
  db.set('lic-1', { ...licenseRow });
  await f.api.insertItem('profileA', 'licenses', license);
  assert.deepEqual(plain(f.api.syncIssuesFor('user_syntheticA')), [], 'no sync issue');
  assert.deepEqual(f.queue(), [], 'nothing queued to send again');
});

test('a real duplicate (another unique key) is still the refusal it was', async () => {
  const f = fixture();
  server(f, 'licenses', [{ ...licenseRow, id: 'lic-other' }], { uniqueOther: 'number' });
  await f.api.insertItem('profileA', 'licenses', { ...license, id: 'lic-new' });
  assert.deepEqual(plain(f.api.syncIssuesFor('user_syntheticA').map(i => [i.id, i.code])), [['lic-new', '23505']]);
});

test('an invoice whose number another invoice of the account carries (recorded on another device, 2026-10-02): one invoice stays, nothing is queued or retried, and the account is read again', async () => {
  const f = fixture();
  const db = server(f, 'invoices', [{ id: 'inv-other', user_id: 'profileA', number: 'INV-20260910-01' }], { uniqueOther: 'number' });
  let reads = 0;
  f.api.setInvoiceNumberConflictHandler(() => { reads += 1; });
  await f.api.insertItem('profileA', 'invoices', { id: 'inv-new', number: 'INV-20260910-01' });
  assert.equal(db.size, 1, 'one invoice under that number');
  assert.deepEqual(f.queue(), [], 'nothing queued to send again');
  assert.deepEqual(plain(f.api.syncIssuesFor('user_syntheticA')), [], 'not a sync issue to retry');
  assert.equal(f.requests.filter(r => r.table === 'invoices' && r.method === 'insert').length, 1, 'tried once');
  assert.equal(reads, 1, 'the account is read again');
  f.api.setInvoiceNumberConflictHandler(null);
});
