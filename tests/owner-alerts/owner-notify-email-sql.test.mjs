// The owner notifier by email, in the database
// (20261014110000_owner_notify_email.sql), on a real PostgreSQL with the
// iMessage notifier's synthetic tables (notifierSchema.mjs).
//
// What it proves:
//   its rows are the iMessage notifier's own SQL: the function body is
//     scripts/signup-notify.py query_sql() regenerated, compared as text;
//   rows that existed when it was installed are not emailed (the iMessage
//     notifier reported them);
//   funnel steps and page_discarded events are left out, the owner's own
//     ticket stays quiet, money events keep their keys;
//   each row is claimed once (the ledger), a retry gets the same stored text,
//     backs off, and stops at 5 attempts; a claim whose text was never stored
//     gives its rows back;
//   the cron dispatcher posts with the vault secret, only while it is on;
//   members cannot call any of it; the rollback removes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { BASE, OPTIONAL } from './notifierSchema.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATION = fs.readFileSync(path.join(root, 'supabase/migrations/20261014110000_owner_notify_email.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(root, 'docs/rollback/20261014110000_owner_notify_email.rollback.sql'), 'utf8');
const python = (() => {
  const r = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || 'python3' : null;
})();
const PORT = '58771';
const exec = promisify(execFile);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MEMBER = id(1), ADMIN = id(2), BUYER = id(4);

const SUPABASE = `
do $$ begin
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
exception when duplicate_object then null; end $$;
create schema vault; create table vault.decrypted_secrets(name text primary key, decrypted_secret text);
insert into vault.decrypted_secrets values ('welcome_hook_secret', 'synthetic-vault-secret');
create schema net; create table net.calls(url text, headers jsonb, body jsonb, timeout integer);
create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer) returns bigint language sql as
  $$ insert into net.calls values (url, headers, body, timeout_milliseconds); select 1::bigint $$;
`;
const EXISTING = `
insert into profiles(id, auth_user_id, name, email, created_at) values
  ('${MEMBER}', 'user_member', 'Synthetic Member', 'member@example.test', now() - interval '2 days'),
  ('${ADMIN}', 'user_owner', 'Synthetic Owner', 'owner@example.test', now() - interval '2 days'),
  ('${BUYER}', 'user_buyer', 'Synthetic Buyer', 'buyer@example.test', now() - interval '1 hour');
insert into app_admins values ('${ADMIN}');
insert into client_errors(auth_user_id, kind, message, created_at) values ('user_member', 'error', 'An old error', now() - interval '30 minutes');
`;

async function startPostgres() {
  const bin = pgBin();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-notify-email-')));
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

test('the function body is signup-notify.py query_sql(), the since literal made p_since', { skip: !python && 'python3 not found' }, () => {
  const code = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('sn', ${JSON.stringify(path.join(root, 'scripts/signup-notify.py'))})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
sys.stdout.write(m.query_sql('2000-01-01T00:00:00Z', list(m.OPTIONAL)))`;
  const r = spawnSync(python, ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.endsWith('\norder by created_at'));
  const expected = r.stdout.slice(0, -'\norder by created_at'.length).replaceAll("'2000-01-01T00:00:00Z'", 'p_since')
    .split('\n').map(line => `    ${line}`).join('\n');
  assert.ok(MIGRATION.includes(`  from (\n${expected}\n  ) as r(kind, name, email, extra, created_at, key)`),
    'regenerate the body from scripts/signup-notify.py when its query changes');
  assert.doesNotMatch(MIGRATION, /^\s*(begin|commit|rollback)\s*;/im, 'no top-level transaction');
});

test('owner notify email SQL on PostgreSQL', { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(SUPABASE + BASE + OPTIONAL + EXISTING);
  await pg.sql(MIGRATION);
  await pg.sql(MIGRATION); // idempotent

  await t.test('what existed at install is already reported; nothing is claimed', async () => {
    assert.ok(await pg.value(`select count(*) from public.owner_notify_ledger where send_id is null`) >= 2);
    assert.deepEqual(await pg.value('public.owner_notify_claim(100)'), { state: 'none' });
  });

  await t.test('new rows are claimed once; funnel steps, discarded pages and the owner\'s ticket are left out', async () => {
    await pg.sql(`
      insert into profiles(id, auth_user_id, name, email) values ('${id(7)}', 'user_new', 'Synthetic New', 'new@example.test');
      insert into client_errors(auth_user_id, kind, message) values
        ('user_member', 'info', 'Funnel: membership page shown'),
        ('user_member', 'info', 'Page discarded by the browser (the last page in this tab never said goodbye)'),
        ('user_member', 'unhandledrejection', 'Loading chunk 1192 failed.');
      insert into support_tickets(id, user_id, subject) values ('${id(101)}', '${MEMBER}', 'Synthetic export question'), ('${id(102)}', '${ADMIN}', 'Owner test');
      insert into billing_checkout_attempts(profile_id, livemode, attempt_id, offer_id, state) values ('${BUYER}', true, '${id(301)}', 'core', 'open');
      insert into limited_billing_quotes(attempt_id, profile_id, livemode, offer_id, price_phase, annual_cents) values ('${id(301)}', '${BUYER}', true, 'core', 'founding', 9900);
      insert into limited_paid_purchase_history(subscription_id, livemode, profile_id, first_verified_paid_at, offer_id, price_phase, annual_cents)
        values ('sub_synthetic1', true, '${BUYER}', now(), 'core', 'founding', 9900);`);
    const claim = await pg.value('public.owner_notify_claim(100)');
    assert.equal(claim.state, 'new');
    assert.equal(claim.attempt, 1);
    const shown = claim.rows.map(r => [r.kind, r.email, r.extra]);
    assert.deepEqual(shown.map(r => r[0]).sort(), ['CHECKOUT STARTED', 'CLIENT ERROR', 'PAID', 'TICKET', 'app profile']);
    assert.ok(shown.some(r => r[0] === 'CLIENT ERROR' && r[2] === 'unhandledrejection: Loading chunk 1192 failed.'));
    assert.ok(!JSON.stringify(claim.rows).includes('Funnel:'), 'no funnel step');
    assert.ok(!JSON.stringify(claim.rows).includes('Page discarded'), 'no discarded page');
    assert.ok(!JSON.stringify(claim.rows).includes('Owner test'), 'not the owner\'s ticket');
    assert.equal(claim.rows.find(r => r.kind === 'PAID').key, 'paid:sub_synthetic1:true');
    assert.equal(claim.rows.find(r => r.kind === 'CHECKOUT STARTED').key, `checkout:${id(301)}`);
    assert.ok(claim.rows.every(r => typeof r.key === 'string' && r.key.length > 0));
    // A member naming themselves later does not make their signup a new row.
    await pg.sql(`update profiles set name = 'Renamed Synthetic' where id = '${id(7)}'`);
    // Claimed rows are never claimed again, even before the email is sent.
    assert.deepEqual(await pg.value('public.owner_notify_claim(100)'), { state: 'none' });
    t.claim = claim;
  });

  await t.test('a member\'s address filled in or changed later does not report their rows again', async () => {
    // The app creates a profile with no email ({ id, auth_user_id }) and the
    // address arrives later; a member may also change it in Profile. Their
    // signup, ticket, reply, feedback and errors are the same rows.
    await pg.sql(`
      insert into profiles(id, auth_user_id, name, email) values ('${id(11)}', 'user_later', '', null);
      insert into support_tickets(id, user_id, subject) values ('${id(111)}', '${id(11)}', 'Synthetic later question');
      insert into support_messages(id, ticket_id, author_id, body) values ('${id(112)}', '${id(111)}', '${id(11)}', 'Synthetic follow up');
      insert into feedback(user_id, rating, message) values ('${id(11)}', 5, 'Synthetic praise');
      insert into client_errors(auth_user_id, kind, message) values ('user_later', 'error', 'Synthetic later error');`);
    const first = await pg.value('public.owner_notify_claim(100)');
    assert.equal(first.state, 'new');
    assert.deepEqual(first.rows.map(r => r.kind).sort(), ['CLIENT ERROR', 'FEEDBACK', 'TICKET', 'TICKET REPLY', 'app profile']);
    await pg.value(`public.owner_notify_prepare('${first.sendId}', 's', 'b')`);
    await pg.value(`public.owner_notify_finish('${first.sendId}', 1, 'sent', 'em_later', null)`);
    await pg.sql(`update profiles set email = 'later@example.test', name = 'Synthetic Later' where id = '${id(11)}'`);
    assert.deepEqual(await pg.value('public.owner_notify_claim(100)'), { state: 'none' }, 'the address filled in');
    await pg.sql(`update profiles set email = 'changed@example.test' where id = '${id(11)}'`);
    assert.deepEqual(await pg.value('public.owner_notify_claim(100)'), { state: 'none' }, 'the address changed');
  });

  await t.test('the text is stored once, the answer recorded, and an unsent email retried with the same text', async () => {
    const { sendId } = t.claim;
    assert.equal(await pg.value(`public.owner_notify_prepare('${sendId}', 'CredentialDOMD money: 1 paid', 'body text')`), true);
    assert.equal(await pg.value(`public.owner_notify_prepare('${sendId}', 'other', 'other text')`), false, 'stored once');
    assert.equal(await pg.value(`public.owner_notify_finish('${sendId}', 1, 'unknown', null, 'provider_503')`), true);
    assert.equal(await pg.value(`public.owner_notify_finish('${sendId}', 1, 'sent', 'em_x', null)`), false, 'an answer for an attempt no longer running');
    // Too soon for a retry (10 minutes after the first attempt).
    assert.deepEqual(await pg.value('public.owner_notify_claim(100)'), { state: 'none' });
    await pg.sql(`update public.owner_notify_sends set last_attempt_at = now() - interval '11 minutes' where id = '${sendId}'`);
    const retry = await pg.value('public.owner_notify_claim(100)');
    assert.deepEqual(retry, { state: 'retry', sendId, attempt: 2, subject: 'CredentialDOMD money: 1 paid', body: 'body text' });
    assert.equal(await pg.value(`public.owner_notify_finish('${sendId}', 2, 'sent', 'em_1', null)`), true);
    await pg.sql(`update public.owner_notify_sends set last_attempt_at = now() - interval '1 day' where id = '${sendId}'`);
    assert.deepEqual(await pg.value('public.owner_notify_claim(100)'), { state: 'none' }, 'a sent email is never sent again');
    assert.deepEqual(await pg.value(`(select jsonb_build_object('status', status, 'provider', provider_id, 'code', error_code) from public.owner_notify_sends where id = '${sendId}')`),
      { status: 'sent', provider: 'em_1', code: null });
  });

  await t.test('retries stop at 5 attempts and after 23 hours', async () => {
    await pg.sql(`insert into profiles(id, name, email) values ('${id(8)}', 'Synthetic Retry', 'retry@example.test')`);
    const claim = await pg.value('public.owner_notify_claim(100)');
    await pg.value(`public.owner_notify_prepare('${claim.sendId}', 'CredentialDOMD signup', 'b')`);
    let attempt = 1;
    await pg.value(`public.owner_notify_finish('${claim.sendId}', 1, 'failed', null, 'provider_422')`);
    for (;;) {
      await pg.sql(`update public.owner_notify_sends set last_attempt_at = now() - interval '3 hours' where id = '${claim.sendId}'`);
      const next = await pg.value('public.owner_notify_claim(100)');
      if (next.state !== 'retry') break;
      attempt = next.attempt;
      await pg.value(`public.owner_notify_finish('${claim.sendId}', ${attempt}, 'failed', null, 'provider_422')`);
    }
    assert.equal(attempt, 5);
    await pg.sql(`insert into profiles(id, name, email) values ('${id(9)}', 'Synthetic Late', 'late@example.test')`);
    const late = await pg.value('public.owner_notify_claim(100)');
    await pg.value(`public.owner_notify_prepare('${late.sendId}', 's', 'b')`);
    await pg.value(`public.owner_notify_finish('${late.sendId}', 1, 'unknown', null, null)`);
    await pg.sql(`update public.owner_notify_sends set created_at = now() - interval '24 hours', last_attempt_at = now() - interval '24 hours' where id = '${late.sendId}'`);
    assert.deepEqual(await pg.value('public.owner_notify_claim(100)'), { state: 'none' });
  });

  await t.test('a claim whose text was never stored gives its rows back after 5 minutes', async () => {
    await pg.sql(`insert into profiles(id, name, email) values ('${id(10)}', 'Synthetic Lost', 'lost@example.test')`);
    const lost = await pg.value('public.owner_notify_claim(100)');
    assert.equal(lost.state, 'new');
    assert.deepEqual(await pg.value('public.owner_notify_claim(100)'), { state: 'none' });
    await pg.sql(`update public.owner_notify_sends set created_at = now() - interval '6 minutes', last_attempt_at = now() - interval '6 minutes' where id = '${lost.sendId}'`);
    const again = await pg.value('public.owner_notify_claim(100)');
    assert.equal(again.state, 'new');
    assert.notEqual(again.sendId, lost.sendId);
    assert.deepEqual(again.rows.map(r => r.email), ['lost@example.test']);
  });

  await t.test('off sends nothing and the dispatcher posts only while on, with the vault secret', async () => {
    await pg.sql('select public.dispatch_owner_notify()');
    assert.deepEqual(await pg.value(`(select jsonb_agg(jsonb_build_object('url', url, 'secret', headers->>'x-hook-secret')) from net.calls)`),
      [{ url: 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/owner-notify', secret: 'synthetic-vault-secret' }]);
    await pg.sql('update public.owner_notify_settings set enabled = false');
    await pg.sql('select public.dispatch_owner_notify()');
    assert.equal(await pg.value('(select count(*) from net.calls)'), 1);
    assert.deepEqual(await pg.value('public.owner_notify_claim(100)'), { state: 'off' });
    await pg.sql('update public.owner_notify_settings set enabled = true');
    assert.doesNotMatch(MIGRATION, /synthetic-vault-secret/);
  });

  await t.test('members cannot read or call any of it', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const fn of ['public.owner_notify_claim(integer)', 'public.owner_notify_prepare(uuid,text,text)', 'public.owner_notify_finish(uuid,integer,text,text,text)',
        'public.owner_notify_rows(timestamptz)', 'public.dispatch_owner_notify()']) {
        assert.equal(await pg.value(`has_function_privilege('${role}', '${fn}', 'execute')`), false, `${role} ${fn}`);
      }
      for (const table of ['owner_notify_ledger', 'owner_notify_sends', 'owner_notify_settings']) {
        assert.equal(await pg.value(`has_table_privilege('${role}', 'public.${table}', 'select')`), false, `${role} ${table}`);
      }
    }
    assert.equal(await pg.value(`has_function_privilege('service_role', 'public.owner_notify_claim(integer)', 'execute')`), true);
    assert.equal(await pg.value(`has_function_privilege('service_role', 'public.owner_notify_rows(timestamptz)', 'execute')`), false);
  });

  await t.test('the rollback removes it all, twice over', async () => {
    await pg.sql(ROLLBACK);
    await pg.sql(ROLLBACK);
    assert.equal(await pg.value(`(select count(*) from pg_proc where proname like 'owner_notify%' or proname = 'dispatch_owner_notify')`), 0);
    assert.equal(await pg.value(`to_regclass('public.owner_notify_ledger') is null and to_regclass('public.owner_notify_sends') is null`), true);
  });
});
