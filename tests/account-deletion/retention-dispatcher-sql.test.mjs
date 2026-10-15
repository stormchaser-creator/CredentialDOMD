// Real PostgreSQL, private Unix socket and disposable synthetic rows only.
// The old production function must enqueue due profiles before the retirement
// is applied, so an inert/misconfigured fixture cannot produce a false pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';

const exec = promisify(execFile);
const read = name => fs.readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const old = (await read('20260925140000_hook_secret_vault.sql')).match(/create or replace function public\.dispatch_account_deletions\(\)[\s\S]*?\n\$\$;/)?.[0];
assert.ok(old, 'the historical dispatcher was found');
const migration = await read('20261001010000_retire_cancellation_deletion.sql');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('retired dispatcher never queues account deletion, retains data, and keeps privileged-only execution', { skip: pgSkip(), timeout: withSlotWait(60000) }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-dispatcher-'));
  const socket = path.join(root, 'socket'), data = path.join(root, 'data'); await fs.mkdir(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG'))), LC_ALL: 'C' };
  const run = (name, args) => exec(path.join(pgBin(), name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  let slot, running = false;
  try {
    slot = await acquirePgSlot(data);
    await run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    await run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket} -p 58347 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off -c timezone=UTC`, '-w', 'start']); running = true;
    const sql = async query => (await run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '58347', '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
    await sql(`
      create role anon; create role authenticated; create role service_role;
      create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text);
      insert into vault.decrypted_secrets values ('welcome_hook_secret','synthetic-only');
      create schema net; create table net.http_request_queue(id bigint generated always as identity, url text, body jsonb, headers jsonb, timeout_milliseconds integer);
      create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds integer) returns bigint language plpgsql as $$
      declare queued bigint; begin insert into net.http_request_queue(url,body,headers,timeout_milliseconds)
        values(url,body,headers,timeout_milliseconds) returning id into queued; return queued; end $$;
      create table public.profiles(id uuid primary key, auth_user_id text, access_status text not null, cancelled_at timestamptz, data_deletion_date timestamptz, deleted_at timestamptz);
      create table public.billing_subscriptions(profile_id uuid references public.profiles(id), status text);
      create table public.licenses(id uuid primary key, user_id uuid references public.profiles(id), name text);
      create schema storage; create table storage.objects(id uuid primary key, bucket_id text, name text, metadata jsonb);
      insert into profiles values
        ('${id(1)}','user_Paid','active',null,now()-interval '1 hour',null),
        ('${id(2)}','user_Archive','active',now()-interval '10 days',now()-interval '3 days',null),
        ('${id(3)}','user_Legacy','pending',now()-interval '10 days',now()-interval '3 days',null),
        ('${id(4)}','user_NoDate','active',null,null,null),
        ('${id(5)}','user_Future','pending',now(),now()+interval '7 days',null),
        ('${id(6)}','user_Consumed','pending',now()-interval '10 days',now()-interval '3 days',now()-interval '2 days');
      insert into billing_subscriptions values ('${id(1)}','active'),('${id(2)}','canceled');
      insert into licenses select id,id,'Synthetic credential retained' from profiles;
      insert into storage.objects select id,'documents',auth_user_id||'/retained.pdf','{"size":14,"mimetype":"application/pdf"}' from profiles;
      ${old}
    `);
    const snapshot = () => sql(`select jsonb_build_object('profiles',(select jsonb_agg(p order by id) from profiles p),'licenses',(select jsonb_agg(l order by id) from licenses l),'objects',(select jsonb_agg(o order by id) from storage.objects o))::text`);
    const before = await snapshot();
    await t.test('counterfactual old dispatcher queues a paid active, retained archive and legacy due account', async () => {
      assert.equal(await sql('select public.dispatch_account_deletions()'), '3');
      const ids = JSON.parse(await sql(`select json_agg(body->>'profile_id' order by body->>'profile_id') from net.http_request_queue`));
      assert.deepEqual(ids, [id(1), id(2), id(3)]);
      assert.equal(await sql(`select bool_and(body->>'requested_by'='scheduled' and body->>'dry_run'='false') from net.http_request_queue`), 't');
      await sql('truncate net.http_request_queue');
    });
    await sql(migration); await sql(migration);
    await t.test('service and cron-owner calls return zero and enqueue nothing regardless of legacy schedule', async () => {
      assert.equal(await sql('set role service_role; select public.dispatch_account_deletions()'), '0');
      assert.equal(await sql('select public.dispatch_account_deletions()'), '0');
      assert.equal(await sql('select count(*) from net.http_request_queue'), '0');
      assert.equal(await snapshot(), before, 'no rows, dates, files or deletion stamps are changed');
    });
    await t.test('reactivation, stale dates and missing scheduling prerequisites cannot restart deletion', async () => {
      await sql(`update profiles set access_status='active',data_deletion_date=null where id='${id(3)}'; drop table vault.decrypted_secrets;`);
      const reactivated = await snapshot();
      assert.equal(await sql('select public.dispatch_account_deletions()'), '0');
      assert.equal(await snapshot(), reactivated);
      assert.equal(await sql('select count(*) from net.http_request_queue'), '0');
    });
    await t.test('anon and authenticated roles cannot call the definer function', async () => {
      for (const role of ['anon', 'authenticated']) await assert.rejects(sql(`set role ${role}; select public.dispatch_account_deletions()`), /permission denied/);
      assert.equal(await sql(`select has_function_privilege('service_role','public.dispatch_account_deletions()','EXECUTE')`), 't');
    });
  } finally {
    if (running) await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    slot?.release(); await fs.rm(root, { recursive: true, force: true });
  }
});
