// Migration 20261031010000 (owner, 2026-10-30: "this app needs to self heal
// ... i dont want emails telling me what is wrong, i want emails telling me
// what was fixed"). On a disposable PostgreSQL:
//   - an app error becomes one owner ticket for the ticket agent, one open
//     ticket per message, under a daily cap; it is never emailed;
//   - what the app fixed by itself, a resolved ticket and a reply verified
//     done are emailed as fixes; fixes from before the install are not.
// Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { BASE, OPTIONAL } from './notifierSchema.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const NOTIFY = fs.readFileSync(path.join(root, 'supabase/migrations/20261014110000_owner_notify_email.sql'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(root, 'supabase/migrations/20261031010000_self_heal_alerts.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(root, 'docs/rollback/20261031010000_self_heal_alerts.rollback.sql'), 'utf8');
const PORT = '58787';
const exec = promisify(execFile);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MEMBER = id(1), OWNER = id(2);

const SUPABASE = `
do $$ begin
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
exception when duplicate_object then null; end $$;
create schema vault; create table vault.decrypted_secrets(name text primary key, decrypted_secret text);
create schema net; create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer) returns bigint language sql as $$ select 1::bigint $$;
`;
const PEOPLE = `
insert into profiles(id, auth_user_id, name, email, created_at) values
  ('${MEMBER}', 'user_member', 'Synthetic Member', 'member@example.test', now() - interval '2 days'),
  ('${OWNER}', 'user_owner', 'Synthetic Owner', 'owner@example.test', now() - interval '3 days');
insert into app_admins values ('${OWNER}');
-- A fix made before the install: already known, never emailed.
insert into support_tickets(id, user_id, subject, status, resolved_at) values ('${id(90)}', '${MEMBER}', 'Synthetic old fix', 'resolved', now() - interval '1 day');
`;

async function startPostgres() {
  const bin = pgBin();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-alerts-')));
  const socket = fs.mkdtempSync(path.join(os.tmpdir(), 'pgs-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const run = (name, args) => exec(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(base, 'data'));
  await run('initdb', ['-D', path.join(base, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await run('pg_ctl', ['-D', path.join(base, 'data'), '-l', path.join(base, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const file = path.join(base, 'input.sql');
  const sql = async query => {
    fs.writeFileSync(file, query);
    return (await run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-f', file])).stdout.trim();
  };
  const value = async expression => JSON.parse(await sql(`select to_jsonb((${expression}))`));
  const close = async () => {
    await run('pg_ctl', ['-D', path.join(base, 'data'), '-m', 'fast', '-w', 'stop']);
    slot.release();
    fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(socket, { recursive: true, force: true });
  };
  return { sql, value, close };
}

test('self-heal alerts on PostgreSQL', { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(SUPABASE + BASE + OPTIONAL + PEOPLE);
  await pg.sql(NOTIFY);
  await pg.sql(MIGRATION);
  await pg.sql(MIGRATION); // idempotent
  const tickets = () => pg.value(`(select coalesce(jsonb_agg(jsonb_build_object('user', user_id, 'subject', subject, 'category', category, 'status', status,
    'body', body, 'source', context_payload->>'source') order by subject), '[]') from support_tickets where context_payload->>'source' = 'client_error')`);
  const claimRows = async () => { const c = await pg.value('public.owner_notify_claim(100)'); return c.state === 'new' ? c.rows : []; };

  await t.test('the owner is the filer, and fixes made before the install are not emailed', async () => {
    assert.equal(await pg.value('(select owner_profile_id from public.client_error_ticket_settings)'), OWNER);
    assert.deepEqual(await claimRows(), []);
  });

  await t.test('an app error becomes one owner ticket per message, never an email', async () => {
    await pg.sql(`insert into client_errors(auth_user_id, kind, message, build, user_agent, extra) values
      ('user_member', 'error', 'Account records load stopped (DATA-LOAD-UNAVAILABLE).', '20261030T2225-abc', 'Synthetic iPhone', '{"event":"x"}'),
      ('user_member', 'error', 'Synthetic chunk 1192 failed.', '20261030T2225-abc', 'Synthetic iPhone', null),
      ('user_owner', 'error', 'Synthetic chunk 2210 failed.', '20261030T2225-abc', 'Synthetic Mac', null),
      ('user_member', 'info', 'Page discarded by the browser', null, null, null)`);
    assert.equal(await pg.value('public.file_client_error_tickets()'), 2, 'two messages (digits ignored)');
    const filed = await tickets();
    assert.equal(filed.length, 2);
    assert.ok(filed.every(x => x.user === OWNER && x.category === 'bug' && x.status === 'open'));
    assert.match(filed[0].subject, /^App error, not fixed by itself: Account records load stopped/);
    assert.match(filed[0].body, /Seen: 1 time\(s\), from 1 account\(s\) or device\(s\)/);
    assert.match(filed[1].body, /Seen: 2 time\(s\), from 2 account\(s\) or device\(s\)/);
    assert.deepEqual((await claimRows()).map(r => r.kind), [], 'no CLIENT ERROR, and the owner\'s own ticket is not a TICKET alert');
    // The same message again, while its ticket is open: counted, not filed again.
    await pg.sql(`insert into client_errors(auth_user_id, kind, message) values ('user_member', 'error', 'Synthetic chunk 7 failed.')`);
    assert.equal(await pg.value('public.file_client_error_tickets()'), 0);
    assert.equal((await tickets()).length, 2);
    assert.equal(await pg.value(`(select occurrences from public.client_error_tickets where message like 'Synthetic chunk%')`), 3);
  });

  await t.test('resolving the ticket is emailed as a fix; the error coming back files a new one', async () => {
    await pg.sql(`update support_tickets set status = 'resolved', resolved_at = now() where subject like '%Synthetic chunk%'`);
    const rows = await claimRows();
    assert.deepEqual(rows.map(r => r.kind), ['FIXED']);
    assert.match(rows[0].extra, /Synthetic chunk/);
    await pg.sql(`insert into client_errors(auth_user_id, kind, message) values ('user_member', 'error', 'Synthetic chunk 8 failed.')`);
    assert.equal(await pg.value('public.file_client_error_tickets()'), 1);
  });

  await t.test('at most max_new_per_day new tickets a day; off files none', async () => {
    await pg.sql(`update public.client_error_ticket_settings set max_new_per_day = 4`);
    await pg.sql(`insert into client_errors(auth_user_id, kind, message) values
      ('user_member', 'error', 'Synthetic fault alpha'), ('user_member', 'error', 'Synthetic fault beta')`);
    assert.equal(await pg.value('public.file_client_error_tickets()'), 1, 'three filed today already: one more');
    await pg.sql(`update public.client_error_ticket_settings set enabled = false;
      insert into client_errors(auth_user_id, kind, message) values ('user_member', 'error', 'Synthetic fault gamma')`);
    assert.equal(await pg.value('public.file_client_error_tickets()'), 0);
    await pg.sql(`update public.client_error_ticket_settings set enabled = true, max_new_per_day = 6`);
  });

  await t.test('what the app fixed by itself, and a reply verified done, are emailed as fixes; one not done is not', async () => {
    await pg.sql(`
      insert into client_errors(auth_user_id, kind, message) values ('user_member', 'info', 'Fixed by itself: the membership check answered after a connection problem.');
      insert into support_tickets(id, user_id, subject) values ('${id(91)}', '${MEMBER}', 'Synthetic CME question');
      insert into support_reply_verifications(ticket_id, report, used_at) values
        ('${id(91)}', '{"items":[{"id":"AC-1","state":"done"},{"id":"AC-2","state":"done"}]}', now()),
        ('${id(91)}', '{"items":[{"id":"AC-1","state":"done"},{"id":"AC-2","state":"not_done"}]}', now()),
        ('${id(91)}', '{"items":[]}', now());`);
    const rows = await claimRows();
    const shown = rows.map(r => [r.kind, r.extra]).sort();
    assert.deepEqual(shown, [
      ['FIXED BY ITSELF', 'the membership check answered after a connection problem.'],
      ['FIXED', 'Synthetic CME question'],
      ['TICKET', 'Synthetic CME question'],
    ]);
    assert.ok(rows.find(r => r.kind === 'FIXED').key.startsWith('fixed:'));
  });

  await t.test('the job runs only as its owner', async () => {
    const granted = await pg.value(`(select coalesce(jsonb_agg(r), '[]') from unnest(array['anon','authenticated','service_role']) r
      where has_function_privilege(r, 'public.file_client_error_tickets()', 'execute'))`);
    assert.deepEqual(granted, []);
  });

  await t.test('the rollback restores the old notifier rows and removes the job', async () => {
    await pg.sql(ROLLBACK);
    assert.equal(await pg.value(`to_regprocedure('public.file_client_error_tickets()') is null`), true);
    await pg.sql(`insert into client_errors(auth_user_id, kind, message) values ('user_member', 'error', 'Synthetic after rollback')`);
    // Errors held back while it was installed come too: they were never emailed.
    const rows = await claimRows();
    assert.ok(rows.some(r => r.kind === 'CLIENT ERROR' && r.extra === 'error: Synthetic after rollback'));
    assert.ok(!rows.some(r => r.kind === 'FIXED' || r.kind === 'FIXED BY ITSELF'));
    await pg.sql(MIGRATION); // and it applies again
  });
});
