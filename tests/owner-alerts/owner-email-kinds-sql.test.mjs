// Migration 20261031200000 (owner, 2026-10-30: emails say what was fixed;
// 2026-10-31: texts are for people who sign up and get guides, the technical
// side is the scheduled agents'). On a disposable PostgreSQL, the owner's
// email claims signups, guides, payments and fixes, and never a ticket, a
// member reply, a failed signup attempt, feedback or an invitation; those
// are not written to the ledger. The kinds match the iMessage's TEXT_KINDS
// plus the fixes, and the rollback emails every kind again. Synthetic rows only.
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
const SELF_HEAL = fs.readFileSync(path.join(root, 'supabase/migrations/20261031010000_self_heal_alerts.sql'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(root, 'supabase/migrations/20261031200000_owner_email_kinds.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(root, 'docs/rollback/20261031200000_owner_email_kinds.rollback.sql'), 'utf8');
const PORT = '58789';
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
`;

async function startPostgres() {
  const bin = pgBin();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-email-kinds-')));
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

const PY = path.join(root, 'scripts/signup-notify.py');

test('the owner email claims signups, guides, payments and fixes only', { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(SUPABASE + BASE + OPTIONAL + PEOPLE);
  await pg.sql(NOTIFY);
  await pg.sql(SELF_HEAL);
  await pg.sql(MIGRATION);
  await pg.sql(MIGRATION); // idempotent
  const claim = () => pg.value('public.owner_notify_claim(100)');
  const ledgered = () => pg.value(`(select count(*) from public.owner_notify_ledger)`);
  const before = await ledgered();

  await t.test('the kinds are the iMessage\'s TEXT_KINDS plus the fixes', async () => {
    const py = JSON.parse((await exec('python3', ['-c', `import importlib.util,json
spec=importlib.util.spec_from_file_location('sn', ${JSON.stringify(PY)}); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(list(m.TEXT_KINDS)))`])).stdout);
    assert.deepEqual(await pg.value('public.owner_notify_email_kinds()'), [...py, 'FIXED', 'FIXED BY ITSELF']);
  });

  await t.test('technical rows are not claimed or ledgered; a guide and a fix are', async () => {
    await pg.sql(`
      insert into support_tickets(id, user_id, subject) values ('${id(91)}', '${MEMBER}', 'Synthetic question');
      insert into support_messages(id, ticket_id, author_id, body) values ('${id(92)}', '${id(91)}', '${MEMBER}', 'Synthetic member reply');
      insert into waitlist_attempts(name, email, stage, created_at) values ('Synthetic', 'attempt@example.test', 'submit', now() - interval '10 minutes');
      insert into feedback(user_id, rating, message) values ('${MEMBER}', 4, 'Synthetic feedback');`);
    assert.deepEqual(await claim(), { state: 'none' }, 'nothing the owner asked for');
    assert.equal(await ledgered(), before, 'and nothing written to the ledger');
    await pg.sql(`
      insert into early_access_leads(email, name, source, waitlist) values ('lead@example.test', 'Synthetic Lead', '/states/texas', false);
      update support_tickets set status = 'resolved', resolved_at = now() where id = '${id(91)}';`);
    const c = await claim();
    assert.equal(c.state, 'new');
    assert.deepEqual(c.rows.map(r => r.kind).sort(), ['FIXED', 'guide only']);
    assert.deepEqual(await claim(), { state: 'none' }, 'each once');
  });

  await t.test('the job runs only as its owner', async () => {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await pg.value(`has_function_privilege('${role}', 'public.owner_notify_claim(integer)', 'execute')`), false, role);
    }
    assert.equal(await pg.value(`has_function_privilege('service_role', 'public.owner_notify_claim(integer)', 'execute')`), true);
  });

  await t.test('the rollback claims every kind again', async () => {
    await pg.sql(ROLLBACK);
    assert.equal(await pg.value(`to_regprocedure('public.owner_notify_email_kinds()') is null`), true);
    const c = await claim();
    assert.equal(c.state, 'new');
    assert.ok(c.rows.some(r => r.kind === 'TICKET'), JSON.stringify(c.rows.map(r => r.kind)));
    await pg.sql(MIGRATION); // and it applies again
  });
});
