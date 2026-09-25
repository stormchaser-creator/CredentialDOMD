// admin-member-view, driven end to end with fake I/O (ticket d45e857c, phase
// 2). The SQL half (grants, visits, the log) is proven in sql.test.mjs; this
// proves what the function does with it: who is refused, what is read, what
// the snapshot can and cannot carry, and when a file is served and logged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMemberViewHandler, MEMBER_VIEW_INLINE_TYPES } from '../../supabase/functions/_shared/memberViewHandler.mjs';
import {
  MEMBER_VIEW_POLICY, MEMBER_VIEW_SECTIONS, MEMBER_VIEW_NEVER, MEMBER_VIEW_NEVER_FIELDS, PROFILE_COLUMNS, DOCUMENT_COLUMNS,
  sectionColumns, camelToSnake, keyPaths, shapeSnapshot, normalizeReason, cleanValue,
} from '../../supabase/functions/_shared/memberView.mjs';

const PRODUCTION = JSON.parse(fs.readFileSync(new URL('./production-columns.json', import.meta.url), 'utf8')).tables;
const ORIGIN = MEMBER_VIEW_POLICY.origin;
const ADMIN = { profileId: '00000000-0000-4000-8000-0000000000ad', clerkSubject: 'user_Admin', isAdmin: true };
const MEMBER = '00000000-0000-4000-8000-00000000000a';
const SUBJECT = 'user_MemberA';
const REASON = 'Ticket 4411: CME hours on Home look wrong';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REQUEST = '20000000-0000-4000-8000-000000000001';
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

// Tables the function must never read, whatever happens.
const NEVER_TABLES = ['travel_docs', 'travel_expenses', 'tax_payments', 'invoices', 'deductibles', 'encounters'];
const marker = (table, column) => `v:${table}.${column}`;

// One member file with every production column of every table filled with a
// marker naming it, plus the tables that must never be read. A marker for a
// column that is not allowlisted must never appear in the snapshot.
function memberFile() {
  const db = {};
  const tables = { ...PRODUCTION };
  for (const table of NEVER_TABLES) tables[table] = ['id', 'user_id', 'name', 'number', 'amount', 'created_at'];
  let n = 100;
  for (const [table, columns] of Object.entries(tables)) {
    if (table === 'profiles') continue;
    const row = {};
    for (const column of columns) row[column] = marker(table, column);
    row.id = uuid(++n); row.user_id = MEMBER; row.created_at = '2026-09-01T12:00:00.000Z'; row.updated_at = '2026-09-02T12:00:00.000Z';
    if ('favorite' in row) row.favorite = true;
    if ('custom_fields' in row) row.custom_fields = { badge: 'B-1', loginPassword: 'hunter2', patientName: 'John Doe', pin: 'enc1:AAAA', mrn: '12345', cptDetail: [{ code: '61519', desc: 'Craniotomy' }] };
    if ('notes' in row) row.notes = `Notes for ${table}`;
    db[table] = [row];
  }
  // A second licence whose note is secretBox ciphertext: dropped, not shown.
  db.licenses.push({ ...db.licenses[0], id: uuid(900), notes: 'enc1:c2VjcmV0', license_number: 'enc1:bnVtYmVy' });
  db.custom_records[0].field_values = { badgeNumber: 'PX-1182', pin: 'enc1:eHl6' };
  db.locum_contracts[0].coverage_periods = [{ start: '2026-10-01', end: '2026-10-07', rate: 3200, dayRate: 2800 }];
  db.duty_days[0].call_periods = [{ start: '2026-10-02T07:00', end: '2026-10-03T07:00', hospital: 'Mercy', amount: 1500 }];
  const licence = db.licenses[0].id, travel = db.travel_docs[0].id, contract = db.locum_contracts[0].id;
  const doc = (id, linked, extra = {}) => ({ id, user_id: MEMBER, name: `File ${id.slice(-3)}.pdf`, mime_type: 'application/pdf', type: 'application/pdf', size_bytes: PDF.byteLength, size: PDF.byteLength,
    storage_path: `${SUBJECT}/${id}`, linked_to: linked, uploaded_at: '2026-09-03T12:00:00.000Z', created_at: '2026-09-03T12:00:00.000Z', updated_at: null, favorite: false, ...extra });
  db.documents = [
    doc(uuid(1), `licenses:${licence}`),
    doc(uuid(2), `travelDocs:${travel}`, { name: 'Passport scan.pdf' }),
    doc(uuid(3), '', { name: 'Unfiled upload.pdf' }),
    doc(uuid(4), `locumContracts:${contract}`, { name: 'Contract with rates.pdf' }),
    doc(uuid(5), `identityVault:${uuid(77)}`, { name: 'SSN card.pdf' }),
    doc(uuid(6), `licenses:${licence}`, { name: 'License photo.png', mime_type: 'image/png', type: 'image/png' }),
    doc(uuid(7), `licenses:${licence}`, { name: 'Letter.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    doc(uuid(8), `licenses:${uuid(999)}`, { name: 'Filed to a deleted record.pdf' }),
    doc(uuid(9), `licenses:${licence}`, { name: 'Someone else path.pdf', storage_path: `user_Someone/${uuid(9)}` }),
    doc(uuid(10), `licenses:${licence}`, { name: 'Not really a pdf.pdf' }),
  ];
  const profile = {};
  for (const column of PRODUCTION.profiles) profile[column] = marker('profiles', column);
  Object.assign(profile, { id: MEMBER, name: 'Dana Reyes', degree_type: 'MD', api_key: 'AIzaSyFAKE', anthropic_api_key: 'sk-ant-FAKE', tax_prep: { w2: 1 } });
  return { db, profile };
}

function setup({ grant = 'active', admin = true, enabled = true, files = {} } = {}) {
  const { db, profile } = memberFile();
  const calls = { rows: [], start: [], check: [], recordFile: [], end: [], readFile: [], profile: [] };
  const state = { grant, session: null, afterRead: null };
  const sessionState = () => {
    if (state.grant !== 'active') return { state: state.grant === 'ended' ? 'grant_ended' : state.grant === 'expired' ? 'grant_expired' : 'no_grant' };
    if (!state.session) return { state: 'not_found' };
    return { state: 'active', now: new Date().toISOString(),
      session: { id: state.session, profile_id: MEMBER, grant_id: uuid(50), started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 15 * 60000).toISOString() },
      grant: { id: uuid(50), expires_at: new Date(Date.now() + 3600000).toISOString() }, member: { name: 'Dana Reyes', degree_type: 'MD' } };
  };
  const deps = {
    enabled: () => enabled,
    authenticate: async req => {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
      if (token === 'admin') return { ...ADMIN, isAdmin: admin };
      if (token === 'member') return { profileId: MEMBER, clerkSubject: SUBJECT, isAdmin: false };
      return null;
    },
    readFile: async (path, limit) => { calls.readFile.push(path); const id = path.split('/')[1]; const bytes = files[id] ?? (id === uuid(6) ? PNG : id === uuid(10) ? new TextEncoder().encode('<html>not a pdf') : PDF); assert.ok(limit <= MEMBER_VIEW_POLICY.maxFileBytes); return bytes; },
    store: {
      start: async p => { calls.start.push(p); if (state.grant !== 'active') return { state: 'no_grant' }; state.session = uuid(60); return sessionState(); },
      check: async p => { calls.check.push(p); if (state.afterRead && calls.rows.length) { state.grant = state.afterRead; } return sessionState(); },
      recordFile: async p => { calls.recordFile.push(p); if (state.endBeforeRecord) state.grant = 'ended'; return sessionState(); },
      end: async p => { calls.end.push(p); return { state: 'ended' }; },
      profile: async (member, columns) => { calls.profile.push(columns); return member === MEMBER ? profile : null; },
      rows: async (table, columns, member) => { calls.rows.push({ table, columns }); return { rows: member === MEMBER ? (db[table] || []) : [], truncated: false }; },
      document: async (member, id) => (db.documents.find(d => d.id === id && d.user_id === member) || null),
      recordExists: async (table, member, id) => (db[table] || []).some(row => row.id === id && row.user_id === member),
      storageSubjects: async member => (member === MEMBER ? [SUBJECT] : []),
    },
  };
  const handler = createMemberViewHandler(deps);
  const call = async (body, { token = 'admin', origin = ORIGIN, method = 'POST' } = {}) => {
    const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) };
    const response = await handler(new Request('https://fn.test/admin-member-view', { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }));
    const type = response.headers.get('content-type') || '';
    return { status: response.status, headers: response.headers, body: type.startsWith('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer()) };
  };
  return { call, calls, state, db };
}
const startBody = (over = {}) => ({ action: 'start', profileId: MEMBER, reason: REASON, requestId: REQUEST, ...over });

test('off unless enabled; POST from the app origin only', async () => {
  const off = setup({ enabled: false });
  assert.deepEqual((await off.call(startBody())).body, { error: 'support_view_disabled' });
  assert.equal(off.calls.start.length, 0);
  const f = setup();
  assert.equal((await f.call(null, { method: 'GET' })).status, 405);
  assert.equal((await f.call(startBody(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.call({ ...startBody(), extra: 1 })).status, 400, 'unknown keys are refused');
  assert.equal((await f.call({ action: 'delete', profileId: MEMBER })).status, 400, 'no other actions exist');
});

test('no sign-in is 401; a signed-in member who is not an admin is refused before any read', async () => {
  const f = setup();
  assert.equal((await f.call(startBody(), { token: null })).status, 401);
  const member = await f.call(startBody(), { token: 'member' });
  assert.equal(member.status, 403);
  assert.deepEqual(member.body, { error: 'admin_required' });
  const flagged = setup({ admin: false });
  assert.deepEqual((await flagged.call(startBody())).body, { error: 'admin_required' });
  for (const g of [f, flagged]) { assert.equal(g.calls.start.length, 0); assert.equal(g.calls.rows.length, 0); }
});

test('no active grant: refused, and not one record is read', async () => {
  const f = setup({ grant: 'none' });
  const r = await f.call(startBody());
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: 'no_active_grant' });
  assert.equal(f.calls.rows.length, 0);
  assert.equal(f.calls.profile.length, 0);
});

test('a reason is required: 10 to 500 characters of ordinary text', async () => {
  const f = setup();
  for (const reason of ['', 'too short', 'x'.repeat(501), null, 42]) {
    const r = await f.call(startBody({ reason }));
    assert.equal(r.status, 400, String(reason));
    assert.deepEqual(r.body, { error: 'invalid_reason' });
  }
  assert.equal(f.calls.start.length, 0);
  assert.equal(normalizeReason('  Ticket\n4411:\tCME hours  '), 'Ticket 4411: CME hours');
  const own = await f.call(startBody({ profileId: ADMIN.profileId }));
  assert.deepEqual(own.body, { error: 'cannot_view_own_account' });
});

test('the start passes the verified admin, subject, member, trimmed reason and request id to the database', async () => {
  const f = setup();
  const r = await f.call(startBody({ reason: `  ${REASON}  ` }));
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls.start[0], { actor: ADMIN.profileId, subject: ADMIN.clerkSubject, member: MEMBER, reason: REASON, requestId: REQUEST });
  assert.equal(r.body.session.id, uuid(60));
  assert.ok(r.body.session.expiresInSeconds > 0 && r.body.session.expiresInSeconds <= 15 * 60);
  assert.equal(r.body.member.name, 'Dana Reyes');
  assert.equal(r.headers.get('cache-control'), 'no-store, max-age=0');
});

test('only allowlisted tables and columns are ever selected', async () => {
  const f = setup();
  await f.call(startBody());
  const tables = f.calls.rows.map(c => c.table);
  for (const never of NEVER_TABLES) assert.ok(!tables.includes(never), `${never} must never be read`);
  for (const { table, columns } of f.calls.rows) {
    assert.ok(!columns.includes('*'), `${table} selects named columns only`);
    for (const column of columns) assert.ok(PRODUCTION[table]?.includes(column), `${table}.${column} is a real production column`);
  }
  const selected = new Map(f.calls.rows.map(c => [c.table, c.columns]));
  const forbidden = { licenses: ['renewal_cost'], privileges: ['portal_url', 'login_username', 'login_secret'], health_records: ['specimen_id'],
    malpractice_history: ['settlement_amount'], professional_memberships: ['cost'],
    locum_contracts: ['hourly_rate', 'call_hourly_rate', 'call_stipend', 'overage_hourly_rate', 'orientation_fee', 'orientation_billed', 'orientation_hourly_rate', 'day_rate', 'call_rate_grid', 'scholarly_rate', 'clinical_day_rate', 'custom_fields'],
    work_log: ['invoice_id', 'private_note'], duty_days: ['amount', 'invoice_id', 'custom_fields'], schedule_days: ['expected', 'source_key'], documents: ['storage_path'] };
  for (const [table, columns] of Object.entries(forbidden)) for (const column of columns) assert.ok(!selected.get(table).includes(column), `${table}.${column} is never selected`);
  for (const column of ['api_key', 'anthropic_api_key', 'tax_prep', 'device_id', 'profile_photo']) assert.ok(!f.calls.profile[0].includes(column), `profiles.${column} is never selected`);
  // The documented exclusions and the selects agree.
  for (const section of MEMBER_VIEW_SECTIONS) {
    for (const key of MEMBER_VIEW_NEVER_FIELDS[section.key] || []) assert.ok(!sectionColumns(section).includes(camelToSnake(key)), `${section.key}.${key}`);
    assert.ok(!MEMBER_VIEW_NEVER.includes(section.key), `${section.key} is both shown and never shown`);
  }
  for (const key of MEMBER_VIEW_NEVER_FIELDS.profile) assert.ok(!PROFILE_COLUMNS.includes(camelToSnake(key)), `profile.${key}`);
  assert.ok(!DOCUMENT_COLUMNS.includes('storage_path'));
});

test('the snapshot never carries an excluded collection, column, secret or file path, even if the database returned one', async () => {
  const f = setup();
  const r = await f.call(startBody());
  const snapshot = r.body.snapshot;
  const text = JSON.stringify(r.body);
  // Collections: exactly the allowlisted sections.
  assert.deepEqual(Object.keys(snapshot.sections).sort(), MEMBER_VIEW_SECTIONS.map(s => s.key).sort());
  for (const key of MEMBER_VIEW_NEVER) assert.ok(!(key in snapshot.sections), key);
  for (const table of NEVER_TABLES) assert.ok(!text.includes(`v:${table}.`), `nothing from ${table}`);
  // Columns: a marker from any column a section does not name never appears.
  for (const section of MEMBER_VIEW_SECTIONS) {
    const allowed = new Set(sectionColumns(section));
    for (const column of PRODUCTION[section.table]) {
      if (allowed.has(column)) continue;
      assert.ok(!text.includes(marker(section.table, column)), `${section.table}.${column} leaked`);
    }
  }
  for (const column of PRODUCTION.profiles) if (!PROFILE_COLUMNS.includes(column)) assert.ok(!text.includes(marker('profiles', column)), `profiles.${column} leaked`);
  for (const secret of ['AIzaSyFAKE', 'sk-ant-FAKE', 'hunter2', 'John Doe', '12345', 'enc1:', 'storage_path', `${SUBJECT}/`, 'w2']) assert.ok(!text.includes(secret), `${secret} leaked`);
  // Every key path is one the catalog names.
  const allowedKeys = new Set(['schemaVersion', 'member', 'sections', 'documents', 'truncated', 'withheld']);
  const recordKeys = new Map(MEMBER_VIEW_SECTIONS.map(s => [s.key, new Set(['id', 'createdAt', 'updatedAt', 'favorite', ...s.fields.map(x => x.key)])]));
  const memberKeys = new Set(PROFILE_COLUMNS.map(c => c.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase())));
  const documentKeys = new Set(['id', 'name', 'mimeType', 'sizeBytes', 'linkedTo', 'uploadedAt']);
  for (const p of keyPaths(snapshot)) {
    const parts = p.split('.').map(part => part.replace(/\[\]$/, ''));
    assert.ok(allowedKeys.has(parts[0]), p);
    // The record-level keys: exactly what the section, the profile and the document list name.
    if (parts[0] === 'sections' && parts.length >= 3) assert.ok(recordKeys.get(parts[1])?.has(parts[2]), p);
    if (parts[0] === 'member' && parts.length >= 2) assert.ok(memberKeys.has(parts[1]), p);
    if (parts[0] === 'documents' && parts.length >= 2) assert.ok(documentKeys.has(parts[1]), p);
  }
  // Notes are shown (the member consented); ciphertext is dropped wherever it sits.
  assert.equal(snapshot.sections.licenses.find(l => l.id === uuid(900)).notes, undefined);
  assert.equal(snapshot.sections.licenses.find(l => l.id === uuid(900)).licenseNumber, undefined);
  assert.equal(snapshot.sections.cme[0].notes, 'Notes for cme');
  assert.deepEqual(snapshot.sections.cme[0].customFields, { badge: 'B-1', cptDetail: [{ code: '61519', desc: 'Craniotomy' }] });
  assert.deepEqual(snapshot.sections.customRecords[0].fieldValues, { badgeNumber: 'PX-1182' });
  // Rates riding inside the period lists are dropped too.
  assert.deepEqual(snapshot.sections.locumContracts[0].coveragePeriods, [{ start: '2026-10-01', end: '2026-10-07' }]);
  assert.deepEqual(snapshot.sections.dutyDays[0].callPeriods, [{ start: '2026-10-02T07:00', end: '2026-10-03T07:00', hospital: 'Mercy' }]);
});

test('documents: listed only when filed to a shown record; never the path; never travel, contract, identity or unfiled', async () => {
  const f = setup();
  const { snapshot } = (await f.call(startBody())).body;
  const names = snapshot.documents.map(d => d.name).sort();
  assert.deepEqual(names, ['File 001.pdf', 'Letter.docx', 'License photo.png', 'Not really a pdf.pdf', 'Someone else path.pdf']);
  for (const d of snapshot.documents) assert.deepEqual(Object.keys(d).sort(), ['id', 'linkedTo', 'mimeType', 'name', 'sizeBytes', 'uploadedAt']);
});

test('the grant ending while the records are read: nothing is returned', async () => {
  const f = setup();
  f.state.afterRead = 'ended';
  const r = await f.call(startBody());
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: 'grant_ended' });
});

test('check: open while the grant is; refused once the member ends it or it expires', async () => {
  const f = setup();
  const { session } = (await f.call(startBody())).body;
  assert.equal((await f.call({ action: 'check', sessionId: session.id })).status, 200);
  f.state.grant = 'ended';
  assert.deepEqual((await f.call({ action: 'check', sessionId: session.id })).body, { error: 'grant_ended' });
  f.state.grant = 'expired';
  assert.deepEqual((await f.call({ action: 'check', sessionId: session.id })).body, { error: 'grant_expired' });
  assert.equal((await f.call({ action: 'check', sessionId: session.id }, { token: 'member' })).status, 403);
});

test('a file: served inline, one at a time, logged with its name, only after the read', async () => {
  const f = setup();
  const { session } = (await f.call(startBody())).body;
  const r = await f.call({ action: 'file', sessionId: session.id, documentId: uuid(1) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('content-disposition'), 'inline');
  assert.deepEqual([...r.body], [...PDF]);
  assert.deepEqual(f.calls.recordFile, [{ actor: ADMIN.profileId, subject: ADMIN.clerkSubject, session: session.id, document: uuid(1), name: 'File 001.pdf' }]);
  const png = await f.call({ action: 'file', sessionId: session.id, documentId: uuid(6) });
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(f.calls.recordFile.length, 2);
});

test('a file outside the view is refused before it is read, and not logged', async () => {
  const f = setup();
  const { session } = (await f.call(startBody())).body;
  const cases = [
    [uuid(2), 403, 'document_not_shown'], [uuid(3), 403, 'document_not_shown'], [uuid(4), 403, 'document_not_shown'],
    [uuid(5), 403, 'document_not_shown'], [uuid(8), 403, 'document_not_shown'], [uuid(7), 415, 'not_viewable'],
    [uuid(9), 404, 'document_unavailable'], [uuid(404), 404, 'document_unavailable'],
  ];
  for (const [id, status, error] of cases) {
    const r = await f.call({ action: 'file', sessionId: session.id, documentId: id });
    assert.equal(r.status, status, id);
    assert.deepEqual(r.body, { error }, id);
  }
  assert.deepEqual(f.calls.readFile, []);
  assert.deepEqual(f.calls.recordFile, []);
  // Bytes that are not what the file claims: read, refused, not logged.
  const fake = await f.call({ action: 'file', sessionId: session.id, documentId: uuid(10) });
  assert.deepEqual(fake.body, { error: 'not_viewable' });
  assert.deepEqual(f.calls.recordFile, []);
  assert.deepEqual([...MEMBER_VIEW_INLINE_TYPES].sort(), ['application/pdf', 'image/jpeg', 'image/png', 'text/plain']);
});

test('a file after the member ended access mid-visit is refused and never read', async () => {
  const f = setup();
  const { session } = (await f.call(startBody())).body;
  f.state.grant = 'ended';
  const r = await f.call({ action: 'file', sessionId: session.id, documentId: uuid(1) });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: 'grant_ended' });
  assert.deepEqual(f.calls.readFile, []);
});

test('access ending during the file read: the bytes are not sent', async () => {
  const f = setup();
  const { session } = (await f.call(startBody())).body;
  f.state.endBeforeRecord = true;
  const r = await f.call({ action: 'file', sessionId: session.id, documentId: uuid(1) });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: 'grant_ended' });
  assert.equal(f.calls.readFile.length, 1);
});

test('end: closes the visit for the verified admin', async () => {
  const f = setup();
  const { session } = (await f.call(startBody())).body;
  assert.equal((await f.call({ action: 'end', sessionId: session.id })).status, 200);
  assert.deepEqual(f.calls.end, [{ actor: ADMIN.profileId, subject: ADMIN.clerkSubject, session: session.id }]);
});

test('cleanValue drops ciphertext and secret-looking keys at any depth', () => {
  assert.equal(cleanValue('enc1:abc'), undefined);
  assert.equal(cleanValue('  enc1:abc'), undefined);
  assert.deepEqual(cleanValue({ a: { password: 'x', b: ['enc1:q', 'ok'], ssn: '1', note: 'fine' } }), { a: { b: ['ok'], note: 'fine' } });
  assert.deepEqual(shapeSnapshot({ collections: { travelDocs: [{ id: uuid(1), number: 'P1' }] } }).sections.travelDocs, undefined);
});

test('deployed like the other Clerk functions (gateway JWT off, the handler verifies the Clerk token)', async () => {
  const { listClerkFunctions } = await import('../../scripts/list-clerk-functions.mjs');
  const { fileURLToPath } = await import('node:url');
  assert.ok(listClerkFunctions(fileURLToPath(new URL('../../supabase/functions', import.meta.url))).includes('admin-member-view'));
  const deps = fs.readFileSync(new URL('../../supabase/functions/_shared/memberViewDependencies.ts', import.meta.url), 'utf8');
  assert.match(deps, /import \{ clerkProfile \} from '\.\/clerkAuth\.ts'/);
  assert.match(deps, /MEMBER_SUPPORT_VIEW_ENABLED'\) === 'true'/, 'off until the owner turns it on');
  assert.doesNotMatch(deps, /select\('\*'\)|select\("\*"\)/, 'never select *');
});
