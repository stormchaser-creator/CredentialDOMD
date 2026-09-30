// Migration 20260930010200 on a disposable PostgreSQL: the ticket owner's own
// message reopens a resolved, closed, waiting or archived ticket in the same
// statement as the insert, so a message is never saved on a ticket left closed
// (QA SUPPORT-002 follow-up, review 2026-09-30).
//
// Before it, reply-ticket and email-inbound reopened with a second UPDATE
// after the insert. A failure there, or a worker that stopped between the two
// writes, left the reply saved and the ticket resolved and archived, and no
// retry repaired it (reply-ticket's duplicate answer and email-inbound's
// redelivery both returned before the reopen).
//
// Synthetic ids and text only. Own port: node --test runs files in parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pgSkip } from '../credential-portal/postgresFixture.mjs';
import { startPostgres } from '../ops/pg.mjs';

const read = rel => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const MIGRATION = read('supabase/migrations/20260930010200_member_message_reopens_ticket.sql');
const ROLLBACK = read('docs/rollback/20260930010200_member_message_reopens_ticket.rollback.sql');

const MEMBER = '00000000-0000-4000-8000-0000000000a1';
const ADMIN = '00000000-0000-4000-8000-0000000000a2';
const OTHER = '00000000-0000-4000-8000-0000000000a3';
const T = n => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const KEY = '00000000-0000-4000-8000-00000000c0de';
const EARLIER = '2026-09-20 00:00:00+00';

// The support tables as production has them, reduced to what the trigger and
// its neighbours touch, with the production bump trigger. A test-only BEFORE
// UPDATE trigger fails a ticket update that changes its status, on demand,
// standing in for the transient error that used to strand a saved reply (the
// bump trigger's updated_at-only write still goes through).
const SCHEMA = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key);
  insert into public.profiles values ('${MEMBER}'), ('${ADMIN}'), ('${OTHER}');
  create table public.support_tickets (id uuid primary key, user_id uuid not null references public.profiles(id),
    subject text not null default 'Synthetic', body text not null default 'Synthetic', status text default 'open',
    created_at timestamptz default now(), updated_at timestamptz default now(), resolved_at timestamptz, archived_at timestamptz);
  create table public.support_messages (id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.support_tickets(id) on delete cascade,
    author_id uuid not null references public.profiles(id), body text not null,
    is_admin_reply boolean default false, created_at timestamptz default now(), client_request_id uuid);
  create unique index support_messages_client_request_uniq on public.support_messages (ticket_id, client_request_id) where client_request_id is not null;
  create function public.bump_ticket_updated_at() returns trigger language plpgsql set search_path = public as $$
    begin update support_tickets set updated_at = now() where id = new.ticket_id; return new; end $$;
  create trigger trg_bump_ticket_updated_at after insert on public.support_messages for each row execute function public.bump_ticket_updated_at();
  create function public.test_fail_ticket_update() returns trigger language plpgsql as $$
    begin if current_setting('test.fail_ticket_update', true) = 'on' and new.status is distinct from old.status then raise exception 'synthetic transient failure'; end if; return new; end $$;
  create trigger trg_test_fail_ticket_update before update on public.support_tickets for each row execute function public.test_fail_ticket_update();
`;

const ticket = (id, owner, status, archived) =>
  `insert into public.support_tickets (id, user_id, status, resolved_at, archived_at, updated_at) values ('${id}', '${owner}', '${status}', ${status === 'resolved' || status === 'closed' ? `'${EARLIER}'` : 'null'}, ${archived ? `'${EARLIER}'` : 'null'}, '${EARLIER}');`;
const message = (id, author, { admin = false, key = null } = {}) =>
  `insert into public.support_messages (ticket_id, author_id, body, is_admin_reply, client_request_id) values ('${id}', '${author}', 'It broke again.', ${admin}, ${key ? `'${key}'` : 'null'});`;

test('on PostgreSQL: the owner\'s own message reopens its ticket in the same write; nothing else does', { skip: pgSkip(), timeout: 60000 }, async (t) => {
  const pg = await startPostgres(58477, 'reopen-trigger');
  t.after(() => pg.close());
  assert.doesNotMatch(MIGRATION, /^\s*(begin|commit)\s*;/im);
  assert.doesNotMatch(ROLLBACK, /^\s*(begin|commit)\s*;/im);
  await pg.sql(SCHEMA);
  await pg.sql(MIGRATION);
  await pg.sql(MIGRATION); // rerunnable
  const state = async id => (await pg.rows(`select status, resolved_at, archived_at, updated_at > '${EARLIER}' as stamped from public.support_tickets where id = '${id}'`))[0];

  // Every settled shape reopens, clears both dates and stamps updated_at.
  const settled = [['resolved', true], ['resolved', false], ['closed', false], ['waiting_user', false], ['open', true], ['in_progress', true]];
  for (const [i, [status, archived]] of settled.entries()) {
    const id = T(10 + i);
    await pg.sql(ticket(id, MEMBER, status, archived));
    await pg.sql(message(id, MEMBER));
    assert.deepEqual(await state(id), { status: 'open', resolved_at: null, archived_at: null, stamped: true }, `${status}${archived ? ', archived' : ''}`);
  }

  // Open or in progress and not archived: the status stays as support set it.
  for (const [i, status] of ['open', 'in_progress'].entries()) {
    const id = T(20 + i);
    await pg.sql(ticket(id, MEMBER, status, false));
    await pg.sql(message(id, MEMBER));
    assert.equal((await state(id)).status, status);
  }

  // A support reply never reopens: on a member's ticket, or on an admin's own.
  await pg.sql(ticket(T(30), MEMBER, 'resolved', true));
  await pg.sql(message(T(30), ADMIN, { admin: true }));
  assert.equal((await state(T(30))).status, 'resolved');
  await pg.sql(ticket(T(31), ADMIN, 'resolved', true));
  await pg.sql(message(T(31), ADMIN, { admin: true }));
  assert.equal((await state(T(31))).status, 'resolved', "a support reply on the admin's own ticket");
  // The ticket agent signs its reply as the ticket owner with the support flag
  // set (scripts/ticket-agent-isolated.mjs): the flag wins, it does not reopen.
  await pg.sql(ticket(T(33), MEMBER, 'waiting_user', false));
  await pg.sql(message(T(33), MEMBER, { admin: true }));
  assert.equal((await state(T(33))).status, 'waiting_user', 'an automated support reply authored as the owner');
  // Someone other than the owner writing without the support flag does not either.
  await pg.sql(ticket(T(32), MEMBER, 'waiting_user', false));
  await pg.sql(message(T(32), OTHER));
  assert.equal((await state(T(32))).status, 'waiting_user');

  // The regression: when the reopen fails, the message is not saved either,
  // so the member's retry or the redelivery writes both together.
  await pg.sql(ticket(T(40), MEMBER, 'resolved', true));
  const failed = await pg.tryRun(`set test.fail_ticket_update = 'on'; ${message(T(40), MEMBER, { key: KEY })}`);
  assert.equal(failed.ok, false);
  assert.match(failed.err, /synthetic transient failure/);
  assert.equal(await pg.sql(`select count(*) from public.support_messages where ticket_id = '${T(40)}'`), '0', 'no message on a ticket left resolved');
  await pg.sql(message(T(40), MEMBER, { key: KEY }));
  assert.equal((await state(T(40))).status, 'open');
  // A second delivery of the same message is refused by the request key and
  // finds the ticket already open: there is no step left to skip.
  const again = await pg.tryRun(message(T(40), MEMBER, { key: KEY }));
  assert.equal(again.ok, false);
  assert.match(again.err, /support_messages_client_request_uniq/);
  assert.equal(await pg.sql(`select count(*) from public.support_messages where ticket_id = '${T(40)}'`), '1');
  assert.equal((await state(T(40))).status, 'open');

  // A member writing through PostgREST (messages_thread_insert) whose row
  // security lets no ticket row be updated (the table grant is Supabase's
  // default) still reopens it, and no API role can call the trigger function
  // directly.
  await pg.sql(`
    alter table public.support_tickets enable row level security;
    alter table public.support_messages enable row level security;
    grant select, update on public.support_tickets to authenticated;
    grant select, insert on public.support_messages to authenticated;
    create policy tickets_read on public.support_tickets for select to authenticated using (true);
    create policy messages_insert on public.support_messages for insert to authenticated with check (true);`);
  await pg.sql(ticket(T(50), MEMBER, 'resolved', true));
  await pg.sql(`set role authenticated; ${message(T(50), MEMBER)}`);
  assert.equal((await state(T(50))).status, 'open');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await pg.sql(`select has_function_privilege('${role}', 'public.reopen_ticket_on_member_message()', 'execute')`), 'f', role);
  }

  // Rollback removes the trigger and its function; the migration reapplies.
  await pg.sql(ROLLBACK);
  await pg.sql(ticket(T(60), MEMBER, 'resolved', true));
  await pg.sql(message(T(60), MEMBER));
  assert.equal((await state(T(60))).status, 'resolved', 'rolled back: nothing reopens');
  assert.equal(await pg.sql(`select count(*) from pg_proc where proname = 'reopen_ticket_on_member_message'`), '0');
  await pg.sql(MIGRATION);
  await pg.sql(message(T(60), MEMBER));
  assert.equal((await state(T(60))).status, 'open');
});
