// An expired Checkout's recovery link, and a payment through it
// (20261014100000_checkout_recovery.sql), on a real PostgreSQL. Synthetic
// sessions and links only; nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATION = fs.readFileSync(path.join(root, 'supabase/migrations/20261014100000_checkout_recovery.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(root, 'docs/rollback/20261014100000_checkout_recovery.rollback.sql'), 'utf8');
const PORT = '58779';
const exec = promisify(execFile);
const ATTEMPT = '00000000-0000-4000-8000-000000000301', PROFILE = '00000000-0000-4000-8000-000000000004';
const LINK = 'https://buy.stripe.com/r/test_synthetic123';

test('no top-level transaction in the migration', () => {
  assert.doesNotMatch(MIGRATION, /^\s*(begin|commit|rollback)\s*;/im);
});

test('checkout recovery SQL on PostgreSQL', { skip: pgSkip(), timeout: withSlotWait(180000) }, async t => {
  const bin = pgBin();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-recovery-')));
  const socket = fs.mkdtempSync(path.join(os.tmpdir(), 'pgs-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const run = (name, args) => exec(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(base, 'data'));
  await run('initdb', ['-D', path.join(base, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await run('pg_ctl', ['-D', path.join(base, 'data'), '-l', path.join(base, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  t.after(async () => {
    await run('pg_ctl', ['-D', path.join(base, 'data'), '-m', 'fast', '-w', 'stop']);
    slot.release();
    fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(socket, { recursive: true, force: true });
  });
  const file = path.join(base, 'input.sql');
  const sql = async query => { fs.writeFileSync(file, query); return (await run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-f', file])).stdout.trim(); };
  const value = async expression => JSON.parse(await sql(`select to_jsonb((${expression}))`));

  await sql(`do $$ begin create role anon nologin; create role authenticated nologin; create role service_role nologin; exception when duplicate_object then null; end $$;
    create table public.billing_checkout_attempts(profile_id uuid, livemode boolean, attempt_id uuid unique, offer_id text, state text, primary key(profile_id, livemode));
    create table public.limited_billing_quotes(attempt_id uuid primary key, profile_id uuid, livemode boolean, offer_id text, price_phase text, annual_cents integer);
    insert into public.billing_checkout_attempts values ('${PROFILE}', true, '${ATTEMPT}', 'core', 'open');
    insert into public.limited_billing_quotes values ('${ATTEMPT}', '${PROFILE}', true, 'core', 'earlybird', 14900);`);
  await sql(MIGRATION);
  await sql(MIGRATION);

  const record = (session, url = LINK, live = true, attempt = ATTEMPT) => value(`public.record_checkout_recovery('${session}', ${live}, '${attempt}', '${url}', now() + interval '30 days')`);
  assert.equal(await record('cs_Expired1'), true);
  assert.equal(await record('cs_Expired1'), true, 'a second delivery changes nothing');
  assert.equal(await value(`(select count(*) from public.billing_checkout_recoveries)`), 1);
  assert.deepEqual(await value(`(select jsonb_build_object('profile', profile_id, 'url', recovery_url) from public.billing_checkout_recoveries)`), { profile: PROFILE, url: LINK });
  // Not Stripe's link, another mode, an unknown attempt, a malformed session: nothing kept.
  assert.equal(await record('cs_Expired2', 'https://evil.example/r/x'), false);
  assert.equal(await record('cs_Expired3', LINK, false), false);
  assert.equal(await record('cs_Expired4', LINK, true, '00000000-0000-4000-8000-000000000999'), false);
  assert.equal(await record('not_a_session'), false);
  assert.equal(await value(`(select count(*) from public.billing_checkout_recoveries)`), 1);

  assert.equal(await value(`public.record_checkout_recovered('cs_Expired1', true, 'cs_Paid1')`), true);
  assert.equal(await value(`public.record_checkout_recovered('cs_Expired1', true, 'cs_Paid1')`), true, 'the same payment again');
  assert.equal(await value(`public.record_checkout_recovered('cs_Expired1', true, 'cs_Paid2')`), false, 'counted once');
  assert.equal(await value(`public.record_checkout_recovered('cs_Unknown', true, 'cs_Paid3')`), false);
  assert.deepEqual(await value('public.checkout_recovery_counts(true)'), { links: 1, usable: 0, recovered: 1 });

  for (const role of ['anon', 'authenticated']) {
    assert.equal(await value(`has_table_privilege('${role}', 'public.billing_checkout_recoveries', 'select')`), false);
    assert.equal(await value(`has_function_privilege('${role}', 'public.record_checkout_recovery(text,boolean,uuid,text,timestamptz)', 'execute')`), false);
  }
  assert.equal(await value(`has_function_privilege('service_role', 'public.record_checkout_recovered(text,boolean,text)', 'execute')`), true);

  await sql(ROLLBACK);
  await sql(ROLLBACK);
  assert.equal(await value(`to_regclass('public.billing_checkout_recoveries') is null`), true);
  assert.equal(await value(`(select count(*) from pg_proc where proname in ('record_checkout_recovery', 'record_checkout_recovered', 'checkout_recovery_counts'))`), 0);
});
