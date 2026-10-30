import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from './credential-portal/postgresFixture.mjs';

// Automatic release of member tickets to the ticket agent
// (20261030120000_ticket_auto_approval.sql), against a real, disposable
// PostgreSQL with the production approval lock (lock_ticket_agent_approval
// from 20260916a). Proves: routine categories are released, billing,
// compliance, refund-ledger, archived, closed and owner tickets are not; the
// switch turns it off; a physician still cannot approve their own ticket;
// a second run changes nothing; the rollback removes it. Synthetic rows only.
const PORT = '58251';
const run = promisify(execFile);
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const APPROVAL = read('../supabase/migrations/20260916a_ticket_agent_approval.sql');
const MIGRATION = read('../supabase/migrations/20261030120000_ticket_auto_approval.sql');
const ROLLBACK = read('../docs/rollback/20261030120000_ticket_auto_approval.rollback.sql');

// The production approval lock, exactly as 20260916a defines it.
const lockFn = APPROVAL.slice(APPROVAL.indexOf('create or replace function public.lock_ticket_agent_approval()'),
  APPROVAL.indexOf('$$;', APPROVAL.indexOf('create or replace function public.lock_ticket_agent_approval()')) + 3);

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-auto-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const psql = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres'];
  const sql = async (query) => (await exec('psql', [...psql, '-c', query])).stdout.trim();
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, close };
}

const MEMBER = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000b1';
const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
  grant usage on schema auth to authenticated; grant execute on function auth.jwt() to authenticated;
  create table public.profiles (id uuid primary key, auth_user_id text unique);
  create table public.app_admins (profile_id uuid primary key);
  create function public.current_profile_id() returns uuid language sql stable security definer
    as $$ select id from public.profiles where auth_user_id = (auth.jwt() ->> 'sub') $$;
  create function public.is_admin(user_id uuid) returns boolean language sql stable security definer
    as $$ select exists (select 1 from public.app_admins a where a.profile_id = user_id) $$;
  grant execute on function public.current_profile_id() to authenticated;
  grant execute on function public.is_admin(uuid) to authenticated;
  create table public.support_tickets (
    id uuid primary key, user_id uuid references public.profiles(id), subject text, category text,
    status text default 'open', archived_at timestamptz, context_payload jsonb default '{}'::jsonb,
    agent_approved_at timestamptz, agent_approved_by uuid references public.profiles(id));
  grant select, insert, update on public.support_tickets to authenticated;
  insert into public.profiles values ('${MEMBER}', 'user_member'), ('${OWNER}', 'user_owner');
  insert into public.app_admins values ('${OWNER}');
  ${lockFn}
  create trigger support_tickets_lock_agent_approval before insert or update on public.support_tickets
    for each row execute function public.lock_ticket_agent_approval();
`;
const ticket = (n, fields) => `insert into public.support_tickets (id, user_id, subject, category, status, archived_at, context_payload)
  values ('00000000-0000-4000-8000-00000000c0${String(n).padStart(2, '0')}', ${fields});`;
const approvedIds = (pg) => pg.sql(`select coalesce(string_agg(right(id::text, 2), ',' order by id), '') from public.support_tickets where agent_approved_at is not null`);

test('ticket auto-approval: routine member tickets released, the rest held, switch, self-approval blocked, rollback', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);
  await pg.sql([
    ticket(1, `'${MEMBER}', 'Bug', 'bug', 'open', null, '{}'`),
    ticket(2, `'${MEMBER}', 'Idea', 'feature_request', 'in_progress', null, '{}'`),
    ticket(3, `'${MEMBER}', 'Charge', 'billing', 'open', null, '{}'`),
    ticket(4, `'${MEMBER}', 'Legal', 'compliance', 'open', null, '{}'`),
    ticket(5, `'${MEMBER}', 'Refund', 'other', 'open', null, '{"source":"limited_refund"}'`),
    ticket(6, `'${MEMBER}', 'Old', 'bug', 'open', now(), '{}'`),
    ticket(7, `'${MEMBER}', 'Done', 'bug', 'resolved', null, '{}'`),
    ticket(8, `'${OWNER}', 'Mine', 'bug', 'open', null, '{}'`),
    ticket(9, `'${MEMBER}', 'Data', 'data_issue', 'open', null, '{}'`),
  ].join('\n'));

  // A physician cannot approve their own ticket, before or after this migration.
  await pg.sql(`begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"user_member","role":"authenticated"}', true);
    update public.support_tickets set agent_approved_at = now() where id = '00000000-0000-4000-8000-00000000c003'; commit;`);
  assert.equal(await approvedIds(pg), '');

  await pg.sql(MIGRATION);
  await pg.sql(MIGRATION); // idempotent
  assert.equal(await pg.sql('select public.auto_approve_member_tickets()'), '3');
  assert.equal(await approvedIds(pg), '01,02,09');
  assert.equal(await pg.sql(`select count(*) from public.support_tickets where agent_approved_at is not null and agent_approved_by is not null`), '0');
  assert.equal(await pg.sql('select count(*) from public.ticket_auto_approvals'), '3');
  assert.equal(await pg.sql('select public.auto_approve_member_tickets()'), '0');

  // Not callable by a signed-in member.
  const denied = await pg.sql(`select has_function_privilege('authenticated', 'public.auto_approve_member_tickets()', 'execute')`);
  assert.equal(denied, 'f');

  // The switch.
  await pg.sql(ticket(10, `'${MEMBER}', 'Later', 'bug', 'open', null, '{}'`));
  await pg.sql('update public.ticket_auto_approval_settings set enabled = false');
  assert.equal(await pg.sql('select public.auto_approve_member_tickets()'), '0');
  await pg.sql('update public.ticket_auto_approval_settings set enabled = true');
  assert.equal(await pg.sql('select public.auto_approve_member_tickets()'), '1');

  // Still locked against self-approval after the migration.
  await pg.sql(`begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"user_member","role":"authenticated"}', true);
    update public.support_tickets set agent_approved_at = now() where id = '00000000-0000-4000-8000-00000000c004'; commit;`);
  assert.equal(await pg.sql(`select agent_approved_at is null from public.support_tickets where id = '00000000-0000-4000-8000-00000000c004'`), 't');

  await pg.sql(ROLLBACK);
  await pg.sql(ROLLBACK);
  assert.equal(await pg.sql(`select to_regprocedure('public.auto_approve_member_tickets()') is null and to_regclass('public.ticket_auto_approval_settings') is null`), 't');
});
