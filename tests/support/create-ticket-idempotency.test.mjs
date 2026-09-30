// QA SUPPORT-001: a member who retries a ticket after a lost response must
// not file it twice. Runs the real create-ticket handler with a synthetic
// database, then the migration that adds the key on a disposable PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { startPostgres } from '../ops/pg.mjs';

const OWNER = 'physician-profile';
const KEY = '33333333-3333-4333-8333-333333333333';
const handlerSource = transformSync((await readFile(new URL('../../supabase/functions/create-ticket/index.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;

// storeTicketAttachments records the files on the row as the real one does
// (the payload it is given plus the two path keys); `hold` keeps it
// uploading until the test releases it.
function server({ missingColumn = false, raceWinner = null, profileId = OWNER, hold = null, failSettle = false } = {}) {
  const tickets = [], uploads = [], lookups = [], settles = [];
  let raced = false;
  const db = {
    from(table) {
      assert.equal(table, 'support_tickets');
      const filters = {}; let row = null, op = 'select';
      const q = {
        select() { return q; },
        eq(column, value) { filters[column] = value; return q; },
        insert(value) { op = 'insert'; row = value; return q; },
        update(value) { op = 'update'; row = value; return q; },
        async maybeSingle() {
          lookups.push({ ...filters });
          if (missingColumn) return { data: null, error: { code: '42703', message: 'column support_tickets.client_request_id does not exist' } };
          if (raced && raceWinner) return { data: raceWinner, error: null };
          const found = tickets.find(t => t.user_id === filters.user_id && t.client_request_id === filters.client_request_id);
          return { data: found ? structuredClone(found) : null, error: null };
        },
        async single() {
          if (raceWinner && row.client_request_id) { raced = true; return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "support_tickets_client_request_uniq"' } }; }
          const saved = { id: `ticket-${tickets.length + 1}`, created_at: new Date().toISOString(), ...row, context_payload: { ...(row.context_payload || {}) } };
          tickets.push(saved); return { data: saved, error: null };
        },
        then(resolve) {
          if (op !== 'update') return resolve({ data: null, error: null });
          settles.push(row.context_payload);
          if (failSettle) return resolve({ error: { message: 'synthetic row failure' } });
          const t = tickets.find(x => x.id === filters.id);
          if (t) Object.assign(t, row);
          return resolve({ error: null });
        },
      };
      return q;
    },
  };
  let handler;
  const context = {
    Request, Response, Headers, URL, console: { ...console, warn() {}, error() {} }, crypto,
    serve: fn => { handler = fn; },
    clerkProfile: async () => ({ profileId, isAdmin: false, email: 'member@example.invalid', db }),
    admitActiveAccount: async () => ({ allowed: true }),
    parseAttachments: body => (body.attachments || []).map(() => ({ ext: 'png', mime: 'image/png', bytes: new Uint8Array(1) })),
    stripServerOnlyPayloadKeys: p => { const out = { ...(p || {}) }; for (const k of ['attachment_path', 'attachment_paths']) delete out[k]; return out; },
    storeTicketAttachments: async (_db, id, files, payload) => {
      if (hold) await hold.promise;
      const stored = files.map((_, i) => `tickets/${id}/screenshot-${i}.png`);
      uploads.push(...stored);
      const t = tickets.find(x => x.id === id);
      if (t) t.context_payload = { ...payload, attachment_path: stored[0], attachment_paths: stored };
      return { stored, failed: 0 };
    },
  };
  new vm.Script(handlerSource).runInNewContext(context);
  const call = async body => {
    const response = await handler(new Request('https://test.invalid/create-ticket', { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  return { call, tickets, uploads, lookups, settles };
}

const ticket = over => ({ subject: 'Export stopped', body: 'The export button does nothing on my phone.', category: 'bug', priority: 'normal', client_request_id: KEY, ...over });

test('a retry with the same request key returns the saved ticket and writes nothing else', async () => {
  const s = server();
  const first = await s.call(ticket({ attachments: [{}, {}] }));
  assert.equal(first.status, 200);
  assert.equal(s.tickets.length, 1);
  assert.equal(s.tickets[0].client_request_id, KEY);
  const again = await s.call(ticket({ attachments: [{}, {}] }));
  assert.equal(again.status, 200);
  assert.deepEqual({ id: again.body.id, ok: again.body.ok, duplicate: again.body.duplicate }, { id: first.body.id, ok: true, duplicate: true });
  assert.deepEqual({ stored: again.body.attachments_stored, failed: again.body.attachments_failed }, { stored: 2, failed: 0 }, 'the files the first request stored are reported, not uploaded again');
  assert.equal(s.tickets.length, 1, 'one ticket');
  assert.equal(s.uploads.length, 2, 'no second upload');
});

// Review 2026-09-30: a retry that arrives while the first request is still
// uploading used to be told every file failed, and the member was asked to
// add them again as a reply while they were landing.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const shortfall = r => ({ stored: r.body.attachments_stored, failed: r.body.attachments_failed, pending: r.body.attachments_pending });

test('a retry while the first request is still uploading says the files are still attaching, not failed', async () => {
  const hold = deferred();
  const s = server({ hold });
  const first = s.call(ticket({ attachments: [{}, {}, {}] }));
  await new Promise(r => setImmediate(r));
  assert.equal(s.tickets.length, 1, 'the row is in, the uploads are not');
  assert.equal(s.tickets[0].context_payload.attachments_expected, 3, 'the insert records how many files are coming');
  const retry = await s.call(ticket({ attachments: [{}, {}, {}] }));
  assert.equal(retry.body.duplicate, true);
  assert.deepEqual(shortfall(retry), { stored: 0, failed: 0, pending: 3 });
  hold.resolve();
  assert.deepEqual(shortfall(await first), { stored: 3, failed: 0, pending: undefined });
  assert.equal(typeof s.tickets[0].context_payload.attachments_settled_at, 'string', 'the first request says its uploads are over');
  assert.deepEqual(s.tickets[0].context_payload.attachment_paths, s.uploads, 'the stamp keeps the recorded files');
  const later = await s.call(ticket({ attachments: [{}, {}, {}] }));
  assert.deepEqual(shortfall(later), { stored: 3, failed: 0, pending: undefined });
  assert.equal(s.uploads.length, 3, 'nothing uploaded twice');
});

test('a retry after the first request finished counts what it could not store as failed', async () => {
  const s = server();
  await s.call(ticket({ attachments: [{}, {}, {}] }));
  // Only one of three landed, and the first request said it was done.
  Object.assign(s.tickets[0].context_payload, { attachment_path: 'tickets/ticket-1/screenshot-0.png', attachment_paths: ['tickets/ticket-1/screenshot-0.png'] });
  const retry = await s.call(ticket({ attachments: [{}, {}, {}] }));
  assert.deepEqual(shortfall(retry), { stored: 1, failed: 2, pending: undefined });
});

test('a first request that stopped mid-upload: once the row is past the upload window, the retry says failed', async () => {
  const s = server();
  await s.call(ticket({ attachments: [{}, {}] }));
  const row = s.tickets[0];
  row.context_payload = { attachments_expected: 2 }; // no files, no stamp: the worker died
  assert.deepEqual(shortfall(await s.call(ticket({ attachments: [{}, {}] }))), { stored: 0, failed: 0, pending: 2 }, 'young: it may still be running');
  row.created_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  assert.deepEqual(shortfall(await s.call(ticket({ attachments: [{}, {}] }))), { stored: 0, failed: 2, pending: undefined });
});

test('a caller cannot set the upload record, and a failed stamp does not fail the ticket', async () => {
  const s = server({ failSettle: true });
  const result = await s.call(ticket({ attachments: [{}], context_payload: { page: '/app', attachments_expected: 0, attachments_settled_at: '2026-01-01T00:00:00Z' } }));
  assert.equal(result.status, 200);
  assert.deepEqual(shortfall(result), { stored: 1, failed: 0, pending: undefined });
  assert.equal(s.settles.length, 1, 'the stamp was tried');
  assert.equal(s.tickets[0].context_payload.attachments_expected, 1);
  assert.equal(s.tickets[0].context_payload.page, '/app');
  assert.equal(s.tickets[0].context_payload.attachments_settled_at, undefined, "the caller's stamp was dropped");
});

test('the key is scoped to the sender; a request without one behaves as before', async () => {
  const s = server();
  await s.call(ticket());
  assert.deepEqual(s.lookups[0], { user_id: OWNER, client_request_id: KEY });
  await s.call(ticket({ client_request_id: undefined }));
  await s.call(ticket({ client_request_id: undefined }));
  assert.equal(s.tickets.length, 3);
  assert.equal(s.lookups.length, 1, 'no lookup without a key');
  assert.ok(!('client_request_id' in s.tickets[2]));
  for (const bad of ['not-a-uuid', 42, '']) assert.equal((await s.call(ticket({ client_request_id: bad }))).status, 400);
});

test('two racing copies settle on one ticket', async () => {
  const s = server({ raceWinner: { id: 'winner', context_payload: {} } });
  const result = await s.call(ticket());
  assert.equal(result.status, 200);
  assert.equal(result.body.id, 'winner');
  assert.equal(result.body.duplicate, true);
  assert.equal(s.uploads.length, 0);
});

test('deployed before the column exists: tickets still save, without the key', async () => {
  const s = server({ missingColumn: true });
  const result = await s.call(ticket());
  assert.equal(result.status, 200);
  assert.equal(s.tickets.length, 1);
  assert.ok(!('client_request_id' in s.tickets[0]));
});

test('on PostgreSQL: the migration adds a per-sender unique key, reruns cleanly and rolls back', { skip: pgSkip(), timeout: withSlotWait(60000) }, async (t) => {
  const pg = await startPostgres(58474, 'ticket-key');
  t.after(() => pg.close());
  const migration = fs.readFileSync(new URL('../../supabase/migrations/20260930010100_support_ticket_request_key.sql', import.meta.url), 'utf8');
  const rollback = fs.readFileSync(new URL('../../docs/rollback/20260930010100_support_ticket_request_key.rollback.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /^\s*(begin|commit)\s*;/im);
  await pg.sql(`create table public.support_tickets (id uuid primary key default gen_random_uuid(), user_id uuid not null, subject text not null, body text not null);`);
  await pg.sql(migration); await pg.sql(migration);
  const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b1';
  await pg.sql(`insert into public.support_tickets (user_id, subject, body, client_request_id) values ('${A}', 's', 'b', '${KEY}'), ('${B}', 's', 'b', '${KEY}'), ('${A}', 's', 'b', null), ('${A}', 's', 'b', null)`);
  const dup = await pg.tryRun(`insert into public.support_tickets (user_id, subject, body, client_request_id) values ('${A}', 's', 'b', '${KEY}')`);
  assert.equal(dup.ok, false);
  assert.match(dup.err, /support_tickets_client_request_uniq/);
  await pg.sql(rollback);
  assert.equal(await pg.sql(`select count(*) from information_schema.columns where table_name = 'support_tickets' and column_name = 'client_request_id'`), '0');
  await pg.sql(migration);
});
