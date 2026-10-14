// email_opt_outs (20261014130000_email_opt_outs.sql) on a real PostgreSQL,
// with Supabase's roles and a trimmed profiles table. Synthetic ids only.
//
// What it proves:
//   the migration and its rollback have no top-level transaction and can each
//     run twice;
//   recording is idempotent: a replayed link, a double press or the one click
//     after the page leaves the first row exactly as it was;
//   an account that does not exist records nothing; deleting an account
//     removes its opt out; an unknown list or source is refused;
//   anon and authenticated cannot read, write or call any of it; RLS is on;
//   a sender that asks email_opted_out (through prepareFinishJoiningEmail)
//     makes no message for a profile that opted out, and does for one that
//     did not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { createEmailUnsubscribeHandler, unsubscribeUrl, SIGNUP_REMINDERS } from '../../supabase/functions/_shared/emailUnsubscribe.mjs';
import { prepareFinishJoiningEmail } from '../../supabase/functions/_shared/finishJoiningEmail.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const NAME = '20261014130000_email_opt_outs';
const MIGRATION = fs.readFileSync(path.join(root, `supabase/migrations/${NAME}.sql`), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(root, `docs/rollback/${NAME}.rollback.sql`), 'utf8');
const PORT = '58783';
const exec = promisify(execFile);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SECRET = 'synthetic-unsubscribe-secret-0123456789abcdef';

const SUPABASE = `
do $$ begin
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default privileges: every new table and function in public is open to these roles until revoked.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create table profiles(id uuid primary key, email text, name text);
insert into profiles values ('${id(1)}', 'one@example.test', 'Synthetic One'), ('${id(2)}', 'two@example.test', 'Synthetic Two'), ('${id(3)}', 'three@example.test', 'Synthetic Three');
`;

async function startPostgres() {
  const bin = pgBin();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'email-opt-outs-')));
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
  const as = async (role, query) => sql(`set role ${role}; ${query}`);
  const close = async () => {
    await run('pg_ctl', ['-D', path.join(base, 'data'), '-m', 'fast', '-w', 'stop']);
    slot.release();
    fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(socket, { recursive: true, force: true });
  };
  return { sql, value, as, close };
}

test('the migration has no top-level transaction and a rollback', () => {
  assert.doesNotMatch(MIGRATION, /^\s*(begin|commit|rollback)\s*;/im);
  assert.doesNotMatch(ROLLBACK, /^\s*(begin|commit|rollback)\s*;/im);
  assert.match(MIGRATION, /enable row level security/);
  assert.doesNotMatch(MIGRATION.replace(/--[^\n]*/g, ''), /cron\.|net\.http_post/, 'schedules and sends nothing');
});

test('opt outs: idempotent, service role only, respected by the sender', { skip: pgSkip(), timeout: withSlotWait(120000) }, async () => {
  const db = await startPostgres();
  const { sql, value, as } = db;
  try {
    await sql(SUPABASE);
    await sql(MIGRATION); await sql(MIGRATION);
    const record = (n, source = 'page', list = SIGNUP_REMINDERS) => value(`record_email_opt_out('${id(n)}', '${list}', '${source}')`);
    const optedOut = n => value(`email_opted_out('${id(n)}', '${SIGNUP_REMINDERS}')`);
    const rows = () => value(`(select coalesce(jsonb_agg(to_jsonb(o) order by profile_id), '[]') from email_opt_outs o)`);

    assert.equal(await optedOut(1), false);
    const first = await record(1);
    assert.equal(first.opted_out, true);
    assert.equal(first.recorded, true);
    const before = await rows();
    assert.equal(before.length, 1);

    // Replays: the same press, the one click after it, a later press.
    await sql(`select pg_sleep(0.01)`);
    for (const source of ['page', 'one_click', 'page']) {
      const again = await record(1, source);
      assert.equal(again.opted_out, true);
      assert.equal(again.recorded, false, 'nothing new is recorded');
      assert.equal(again.opted_out_at, first.opted_out_at);
    }
    assert.deepEqual(await rows(), before, 'the first row stands exactly as it was');
    assert.equal(await optedOut(1), true);
    assert.equal(await optedOut(2), false, 'only that profile');

    // No such account: nothing recorded, no error.
    const ghost = await record(99);
    assert.deepEqual([ghost.opted_out, ghost.recorded], [false, false]);
    assert.equal((await rows()).length, 1);

    // Unknown list, unknown source, missing values: refused.
    await assert.rejects(record(2, 'page', 'everything'), /check constraint/);
    await assert.rejects(record(2, 'admin'), /check constraint/);
    await assert.rejects(sql(`select record_email_opt_out(null, '${SIGNUP_REMINDERS}', 'page')`), /required/);

    // Members and the public: no read, no write, no call. RLS on with no policy.
    assert.equal(await value(`(select relrowsecurity from pg_class where oid = 'public.email_opt_outs'::regclass)`), true);
    assert.equal(await value(`(select count(*) from pg_policies where tablename = 'email_opt_outs')`), 0);
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(as(role, `select * from email_opt_outs`), /permission denied/, `${role} select`);
      await assert.rejects(as(role, `insert into email_opt_outs(profile_id, list, source) values ('${id(2)}', '${SIGNUP_REMINDERS}', 'page')`), /permission denied/, `${role} insert`);
      await assert.rejects(as(role, `delete from email_opt_outs`), /permission denied/, `${role} delete`);
      await assert.rejects(as(role, `select record_email_opt_out('${id(2)}', '${SIGNUP_REMINDERS}', 'page')`), /permission denied/, `${role} record`);
      await assert.rejects(as(role, `select email_opted_out('${id(1)}', '${SIGNUP_REMINDERS}')`), /permission denied/, `${role} read`);
    }
    assert.equal(await as('service_role', `select email_opted_out('${id(1)}', '${SIGNUP_REMINDERS}')`), 't');
    await assert.rejects(as('service_role', `delete from email_opt_outs`), /permission denied/, 'the service role cannot erase an opt out');
    assert.equal((await rows()).length, 1);

    // The function's handler against this database: the button, then a replay.
    const handle = createEmailUnsubscribeHandler({
      secrets: () => [SECRET],
      log: { error() {} },
      store: { record: (profileId, list, source) => value(`record_email_opt_out('${profileId}', '${list}', '${source}')`) },
    });
    const link = await unsubscribeUrl({ profileId: id(2), secret: SECRET });
    const press = () => handle(new Request(link, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }));
    assert.equal((await press()).status, 200);
    assert.equal((await press()).status, 200);
    assert.equal(await optedOut(2), true);
    assert.equal((await rows()).filter(r => r.profile_id === id(2)).length, 1);
    assert.equal((await rows()).find(r => r.profile_id === id(2)).source, 'one_click');

    // The sender asks the database and skips anyone opted out.
    const isOptedOut = (profileId, list) => value(`email_opted_out('${profileId}', '${list}')`);
    const send = n => prepareFinishJoiningEmail({ profileId: id(n), step: 2, annualCents: 9900, mailingAddress: '1 Synthetic Way, Testville, ST 00000', secret: SECRET, isOptedOut });
    assert.equal(await send(1), null, 'opted out on the page');
    assert.equal(await send(2), null, 'opted out by one click');
    const three = await send(3);
    assert.ok(three?.headers?.['List-Unsubscribe'], 'a profile that did not opt out gets its message');

    // Deleting the account removes its opt out with it.
    await sql(`delete from profiles where id = '${id(1)}'`);
    assert.equal(await optedOut(1), false);

    await sql(ROLLBACK); await sql(ROLLBACK);
    assert.equal(await value(`to_regclass('public.email_opt_outs') is null`), true);
    assert.equal(await value(`to_regprocedure('public.record_email_opt_out(uuid,text,text)') is null`), true);
    assert.equal(await value(`to_regprocedure('public.email_opted_out(uuid,text)') is null`), true);
    // And forward again after a rollback.
    await sql(MIGRATION);
    assert.equal(await value(`to_regclass('public.email_opt_outs') is not null`), true);
  } finally { await db.close(); }
});
