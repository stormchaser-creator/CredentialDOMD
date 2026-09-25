// The member-granted support view's database half (ticket d45e857c, phase 2),
// proven against a real PostgreSQL: the member creates and ends their own
// grant, nobody else can write it, a visit needs an administrator, an open
// grant and a reason, a visit never outlives the grant, ending or expiring the
// grant refuses the visit mid-session, and the member's log shows the view and
// every file opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';

// Own port: node --test runs files in parallel and the other PostgreSQL suites
// hold 55479, 56441, 57331, 57419 and 58213.
const PORT = '58677';
const run = promisify(execFile);
const read = name => fs.readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const MIGRATION = read('supabase/migrations/20260925130000_member_support_view.sql');
const ROLLBACK = read('docs/rollback/20260925130000_member_support_view.rollback.sql');
const extract = (source, pattern, label) => { const found = source.match(pattern); if (!found) throw new Error(`fixture could not find ${label}`); return found[0]; };
// The production definitions this migration leans on, read out of their own
// migrations so a change to either reaches this test.
const accountEvents = read('supabase/migrations/20260918a_mailbox_account_events.sql');
const adminOperations = read('supabase/migrations/20260924020000_admin_operations.sql');

const ADMIN = '00000000-0000-4000-8000-0000000000ad';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const DOC_A = '00000000-0000-4000-8000-0000000000d1';
const DOC_B = '00000000-0000-4000-8000-0000000000d2';
const REASON = 'Ticket 4411: CME hours on Home look wrong';

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-view-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async query => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const tryRun = async query => { try { return { ok: true, out: await sql(query) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, close };
}

// The browser: the authenticated role with the profile its token resolves to.
const as = (profile, body) => `begin; set local role authenticated; set local app.profile = '${profile}'; ${body}; commit;`;
// admin-member-view: the service role.
const service = body => `begin; set local role service_role; ${body}; commit;`;
const last = out => out.split('\n').pop();
const json = out => JSON.parse(last(out));

const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key, auth_user_id text unique, name text, degree_type text,
    access_status text not null default 'active', deleted_at timestamptz);
  create table public.app_admins (profile_id uuid primary key references public.profiles(id));
  create table public.documents (id uuid primary key, user_id uuid not null references public.profiles(id), name text);
  create function public.current_profile_id() returns uuid language sql stable
    as $$ select nullif(current_setting('app.profile', true), '')::uuid $$;
  grant execute on function public.current_profile_id() to authenticated;
  ${extract(accountEvents, /create table if not exists public\.account_tombstones \([\s\S]*?\n\);/, 'account_tombstones')}
  ${extract(accountEvents, /create or replace function public\.account_is_closed\(p_profile uuid\)[\s\S]*?\$\$;/, 'account_is_closed')}
  revoke all on function public.account_is_closed(uuid) from public; grant execute on function public.account_is_closed(uuid) to postgres, service_role;
  ${extract(adminOperations, /create or replace function public\.admin_operations_can_read\(\)[\s\S]*?\$\$;/, 'admin_operations_can_read')}
  revoke all on function public.admin_operations_can_read() from public, anon, authenticated, service_role;
  grant execute on function public.admin_operations_can_read() to authenticated;
  insert into public.profiles (id, auth_user_id, name, degree_type) values
    ('${ADMIN}', 'user_Admin', 'Eric Whitney', 'DO'), ('${A}', 'user_MemberA', 'Dana Reyes', 'MD'), ('${B}', 'user_MemberB', 'Sam Ortiz', 'DO');
  insert into public.app_admins values ('${ADMIN}');
  insert into public.documents values ('${DOC_A}', '${A}', 'DEA certificate.pdf'), ('${DOC_B}', '${B}', 'Other member.pdf');
`;

let requestSeq = 0;
const requestId = () => `10000000-0000-4000-8000-${String(++requestSeq).padStart(12, '0')}`;
const start = (pg, { actor = ADMIN, subject = 'user_Admin', member = A, reason = REASON, request = requestId() } = {}) =>
  pg.sql(service(`select public.member_view_session_start('${actor}', '${subject}', '${member}', '${reason.replaceAll("'", "''")}', '${request}')`)).then(json);
const check = (pg, session, actor = ADMIN, subject = 'user_Admin') =>
  pg.sql(service(`select public.member_view_session_check('${actor}', '${subject}', '${session}')`)).then(json);
const recordFile = (pg, session, document = DOC_A, name = 'DEA certificate.pdf') =>
  pg.sql(service(`select public.member_view_file_record('${ADMIN}', 'user_Admin', '${session}', '${document}', '${name}')`)).then(json);

test('member support view: grants, visits, refusals and the member log', { skip: pgSkip(), timeout: 120000 }, async t => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);

  await t.test('applies cleanly, twice', async () => {
    await pg.sql(MIGRATION);
    await pg.sql(MIGRATION);
  });

  await t.test('RLS on, no anon privileges, sessions reachable by no role, and the browser can only read', async () => {
    const rls = await pg.sql(`select string_agg(relname || ':' || relrowsecurity, ',' order by relname) from pg_class where relname in ('member_view_grants','member_view_sessions','member_view_events')`);
    assert.equal(rls, 'member_view_events:true,member_view_grants:true,member_view_sessions:true');
    const grants = await pg.sql(`select coalesce(string_agg(grantee || ':' || table_name || ':' || privilege_type, ',' order by grantee, table_name, privilege_type), '')
      from information_schema.role_table_grants where table_name like 'member_view_%' and grantee in ('anon','authenticated','service_role','PUBLIC')`);
    assert.equal(grants, 'authenticated:member_view_events:SELECT,authenticated:member_view_grants:SELECT,'
      + 'service_role:member_view_events:DELETE,service_role:member_view_events:SELECT,service_role:member_view_grants:DELETE,service_role:member_view_grants:SELECT');
    const callable = await pg.sql(`select string_agg(p.proname || ':' || r.rolname, ',' order by p.proname, r.rolname)
      from pg_proc p cross join pg_roles r where p.proname like '%member_view%' and r.rolname in ('anon','authenticated','service_role')
      and has_function_privilege(r.rolname, p.oid, 'execute')`);
    assert.equal(callable, 'admin_member_view_grants:authenticated,member_view_file_record:service_role,member_view_grant_end:authenticated,'
      + 'member_view_grant_open:authenticated,member_view_session_check:service_role,member_view_session_end:service_role,'
      + 'member_view_session_start:service_role,member_view_status:authenticated');
  });

  await t.test('no grant: the visit is refused and nothing is logged', async () => {
    assert.deepEqual(await start(pg), { state: 'no_grant' });
    assert.equal(await pg.sql('select count(*) from public.member_view_sessions'), '0');
    assert.equal(await pg.sql('select count(*) from public.member_view_events'), '0');
  });

  let grantId;
  await t.test('the member allows support access for 24 hours; a second tap returns the same grant', async () => {
    const opened = json(await pg.sql(as(A, 'select public.member_view_grant_open()')));
    assert.equal(opened.grant.state, 'active');
    grantId = opened.grant.id;
    const hours = await pg.sql(`select extract(epoch from expires_at - created_at) / 3600 from public.member_view_grants where id = '${grantId}'`);
    assert.equal(Number(hours), 24);
    const again = json(await pg.sql(as(A, 'select public.member_view_grant_open()')));
    assert.equal(again.grant.id, grantId);
    const status = json(await pg.sql(as(A, 'select public.member_view_status()')));
    assert.equal(status.grant.id, grantId);
  });

  await t.test('nobody writes the grant table directly, not even its member', async () => {
    for (const body of [
      `insert into public.member_view_grants (profile_id, expires_at) values ('${A}', now() + interval '1 year')`,
      `update public.member_view_grants set expires_at = now() + interval '1 year'`,
      `delete from public.member_view_grants`,
      `insert into public.member_view_events (profile_id, grant_id, session_id, actor_profile_id, actor_name, event, reason) values ('${A}', '${grantId}', '${grantId}', '${A}', 'x', 'view_started', 'forged entry here')`,
      `select * from public.member_view_sessions`,
    ]) {
      const r = await pg.tryRun(as(A, body));
      assert.equal(r.ok, false, body);
      assert.match(r.err, /permission denied/);
    }
  });

  await t.test('the browser cannot call the visit functions, and a member cannot start a visit', async () => {
    const r = await pg.tryRun(as(A, `select public.member_view_session_start('${ADMIN}', 'user_Admin', '${A}', '${REASON}', '${requestId()}')`));
    assert.equal(r.ok, false);
    assert.match(r.err, /permission denied/);
  });

  await t.test('a non-admin, or an admin with the wrong subject, is refused', async () => {
    assert.deepEqual(await start(pg, { actor: B, subject: 'user_MemberB' }), { state: 'admin_required' });
    assert.deepEqual(await start(pg, { subject: 'user_SomeoneElse' }), { state: 'admin_required' });
    await pg.sql(`update public.profiles set access_status = 'revoked' where id = '${ADMIN}'`);
    assert.deepEqual(await start(pg), { state: 'admin_required' });
    await pg.sql(`update public.profiles set access_status = 'active' where id = '${ADMIN}'`);
  });

  await t.test('a reason under 10 or over 500 characters is refused', async () => {
    assert.deepEqual(await start(pg, { reason: 'too short' }), { state: 'invalid_request' });
    assert.deepEqual(await start(pg, { reason: 'x'.repeat(501) }), { state: 'invalid_request' });
    assert.deepEqual(await start(pg, { member: ADMIN }), { state: 'invalid_request' }, 'not your own account');
  });

  let session;
  await t.test('with the grant: a visit of at most 15 minutes, logged for the member with the reason', async () => {
    const opened = await start(pg);
    assert.equal(opened.state, 'active');
    session = opened.session.id;
    assert.equal(opened.session.profile_id, A);
    assert.equal(opened.member.name, 'Dana Reyes');
    const minutes = await pg.sql(`select extract(epoch from expires_at - started_at) / 60 from public.member_view_sessions where id = '${session}'`);
    assert.equal(Number(minutes), 15);
    const events = await pg.sql(`select event || '|' || actor_name || '|' || reason from public.member_view_events where session_id = '${session}'`);
    assert.equal(events, `view_started|Eric Whitney|${REASON}`);
    assert.equal((await check(pg, session)).state, 'active');
  });

  await t.test('a retried start is the same visit; the same request id with other details is refused', async () => {
    const request = requestId();
    const first = await start(pg, { request });
    const second = await start(pg, { request });
    assert.equal(first.session.id, second.session.id);
    assert.deepEqual(await start(pg, { request, reason: `${REASON} (edited)` }), { state: 'request_conflict' });
    assert.equal(await pg.sql(`select count(*) from public.member_view_events where session_id = '${first.session.id}'`), '1');
    session = first.session.id;
    // Starting again ended the earlier visit: one open visit per admin and account.
    assert.equal(await pg.sql(`select count(*) from public.member_view_sessions where profile_id = '${A}' and ended_at is null`), '1');
  });

  await t.test('another administrator\'s session id is not found', async () => {
    assert.deepEqual(await check(pg, session, B, 'user_MemberB'), { state: 'admin_required' });
    await pg.sql(`insert into public.app_admins values ('${B}')`);
    assert.deepEqual(await check(pg, session, B, 'user_MemberB'), { state: 'not_found' });
    await pg.sql(`delete from public.app_admins where profile_id = '${B}'`);
  });

  await t.test('each file opened is logged with the reason; another account\'s file is refused', async () => {
    assert.equal((await recordFile(pg, session)).state, 'active');
    assert.deepEqual(await recordFile(pg, session, DOC_B, 'Other member.pdf'), { state: 'document_unavailable' });
    const rows = await pg.sql(`select event || '|' || coalesce(document_name, '') || '|' || reason from public.member_view_events where session_id = '${session}' order by created_at, event desc`);
    assert.deepEqual(rows.split('\n'), [`view_started||${REASON}`, `file_opened|DEA certificate.pdf|${REASON}`]);
  });

  await t.test('Settings reads the member\'s own log through member_view_status, newest first, even for an admin', async () => {
    const status = json(await pg.sql(as(A, 'select public.member_view_status()')));
    assert.deepEqual(status.events.map(e => e.event), ['file_opened', 'view_started', 'view_started']);
    assert.equal(status.events[0].document_name, 'DEA certificate.pdf');
    assert.equal(status.events[0].actor_name, 'Eric Whitney');
    assert.equal(status.events[0].reason, REASON);
    const adminOwn = json(await pg.sql(as(ADMIN, 'select public.member_view_status()')));
    assert.deepEqual(adminOwn.events, [], 'an admin\'s own Settings shows only views of the admin\'s own account');
    assert.deepEqual(json(await pg.sql(as(B, 'select public.member_view_status()'))).events, []);
  });

  await t.test('the member reads their own log; another member reads nothing; the admin reads all', async () => {
    const own = await pg.sql(as(A, `select string_agg(event, ',' order by created_at, event desc) from public.member_view_events`));
    assert.equal(last(own), 'view_started,view_started,file_opened');
    assert.equal(last(await pg.sql(as(B, 'select count(*) from public.member_view_events'))), '0');
    assert.equal(last(await pg.sql(as(B, 'select count(*) from public.member_view_grants'))), '0');
    assert.equal(last(await pg.sql(as(ADMIN, 'select count(*) from public.member_view_events'))), '3');
  });

  await t.test('admins see which accounts can be opened; a member cannot ask', async () => {
    const rows = await pg.sql(as(ADMIN, 'select profile_id from public.admin_member_view_grants()'));
    assert.equal(last(rows), A);
    const refused = await pg.tryRun(as(B, 'select * from public.admin_member_view_grants()'));
    assert.equal(refused.ok, false);
    assert.match(refused.err, /Administrator access required/);
  });

  await t.test('the member ends access mid-visit: the next check and the next file are refused, and nothing is logged', async () => {
    const ended = json(await pg.sql(as(A, 'select public.member_view_grant_end()')));
    assert.equal(ended.grant.state, 'ended');
    assert.equal(ended.grant.ended_by, 'member');
    assert.deepEqual(await check(pg, session), { state: 'grant_ended' });
    assert.deepEqual(await recordFile(pg, session), { state: 'grant_ended' });
    assert.equal(await pg.sql(`select count(*) from public.member_view_sessions where id = '${session}' and ended_at is not null`), '1', 'ending the grant ended the visit row too');
    assert.equal(await pg.sql(`select count(*) from public.member_view_events where event = 'file_opened'`), '1');
    assert.deepEqual(await start(pg), { state: 'no_grant' });
    assert.equal(last(await pg.sql(as(ADMIN, 'select count(*) from public.admin_member_view_grants()'))), '0');
  });

  await t.test('a grant that ended while a visit row stayed open reads as grant_ended', async () => {
    const grant = json(await pg.sql(as(A, 'select public.member_view_grant_open()'))).grant;
    const visit = await start(pg);
    // Simulate a visit row the end did not reach (a race the lock closes).
    await pg.sql(`update public.member_view_grants set ended_at = clock_timestamp(), ended_by = 'member' where id = '${grant.id}'`);
    assert.deepEqual(await check(pg, visit.session.id), { state: 'grant_ended' });
    assert.deepEqual(await recordFile(pg, visit.session.id), { state: 'grant_ended' });
  });

  await t.test('a visit never outlives the grant, and an expired grant is refused mid-visit', async () => {
    json(await pg.sql(as(A, 'select public.member_view_grant_open()')));
    // Five minutes left on the grant: the visit gets five minutes, not fifteen.
    await pg.sql(`update public.member_view_grants set created_at = now() - interval '23 hours 55 minutes', expires_at = now() + interval '5 minutes' where profile_id = '${A}' and ended_at is null`);
    const visit = await start(pg);
    const minutes = Number(await pg.sql(`select extract(epoch from s.expires_at - g.expires_at) from public.member_view_sessions s join public.member_view_grants g on g.id = s.grant_id where s.id = '${visit.session.id}'`));
    assert.equal(minutes, 0, 'the visit ends exactly when the grant does');
    // The grant runs out mid-visit.
    await pg.sql(`update public.member_view_grants set expires_at = now() - interval '1 second' where profile_id = '${A}' and ended_at is null`);
    assert.deepEqual(await check(pg, visit.session.id), { state: 'grant_expired' });
    assert.deepEqual(await recordFile(pg, visit.session.id), { state: 'grant_expired' });
    const status = json(await pg.sql(as(A, 'select public.member_view_status()')));
    assert.equal(status.grant.state, 'expired');
    // Allowing again after expiry opens a fresh 24 hours.
    const fresh = json(await pg.sql(as(A, 'select public.member_view_grant_open()')));
    assert.equal(fresh.grant.state, 'active');
    assert.notEqual(fresh.grant.id, status.grant.id);
  });

  await t.test('the 15 minutes running out refuses the visit, and an ended visit stays ended', async () => {
    const visit = await start(pg);
    await pg.sql(`update public.member_view_sessions set started_at = now() - interval '16 minutes', expires_at = now() - interval '1 minute' where id = '${visit.session.id}'`);
    assert.deepEqual(await check(pg, visit.session.id), { state: 'expired' });
    assert.deepEqual(await recordFile(pg, visit.session.id), { state: 'ended' });
    const next = await start(pg);
    await pg.sql(service(`select public.member_view_session_end('${ADMIN}', 'user_Admin', '${next.session.id}')`));
    assert.deepEqual(await check(pg, next.session.id), { state: 'ended' });
  });

  await t.test('a closed account can neither grant nor be viewed', async () => {
    await pg.sql(`insert into public.account_tombstones (profile_id) values ('${B}')`);
    const r = await pg.tryRun(as(B, 'select public.member_view_grant_open()'));
    assert.equal(r.ok, false);
    assert.deepEqual(await start(pg, { member: B }), { state: 'member_unavailable' });
  });

  await t.test('account deletion (service role) removes the log and the grants; visits cascade', async () => {
    await pg.sql(service(`delete from public.member_view_events where profile_id = '${A}'; delete from public.member_view_grants where profile_id = '${A}'`));
    assert.equal(await pg.sql(`select count(*) from public.member_view_sessions where profile_id = '${A}'`), '0');
    assert.equal(await pg.sql(`select count(*) from public.member_view_events`), '0');
  });

  await t.test('the rollback runs once the log is empty', async () => {
    await pg.sql(ROLLBACK);
    assert.equal(await pg.sql(`select count(*) from pg_class where relname like 'member_view_%' and relkind = 'r'`), '0');
    assert.equal(await pg.sql(`select count(*) from pg_proc where proname like '%member_view%'`), '0');
    await pg.sql(MIGRATION); // and the migration applies again after it
  });
});
