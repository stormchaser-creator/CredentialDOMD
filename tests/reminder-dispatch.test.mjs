import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startPostgres } from './ops/pg.mjs';
import { pgSkip, withSlotWait } from './credential-portal/postgresFixture.mjs';
const migration = readFileSync(new URL('../supabase/migrations/20260930220000_reminder_delivery_queue.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../docs/rollback/20260930220000_reminder_delivery_queue.rollback.sql', import.meta.url), 'utf8');
const payload = { email: { from: 'Synthetic <sender@example.test>', to: ['member@example.test'], subject: 'Check', text: 'Original\n\nBody' }, fingerprint: 'a'.repeat(24), count: 1 };
const quote = v => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;

test('durable reminder queue: all members, one drain, frozen retries, recovery and rollback', { skip: pgSkip(), timeout: withSlotWait(120000) }, async t => {
  const pg = await startPostgres(58964, 'reminder-queue');
  t.after(() => pg.close());
  await pg.sql(`
    create role anon; create role authenticated; create role service_role;
    create schema vault; create schema net; create schema cron;
    create table vault.decrypted_secrets(name text primary key, decrypted_secret text);
    insert into vault.decrypted_secrets values ('welcome_hook_secret','synthetic-hook-only');
    create table public.profiles(id uuid primary key, access_status text, notify_email boolean, email text,reminder_email_fingerprint text,reminder_emailed_at timestamptz,updated_at timestamptz);
    create table public.notification_log(id bigserial primary key,user_id uuid,method text,alert_count integer,date timestamptz);
    create table net.queued(id bigserial primary key,url text,headers jsonb,body jsonb,timeout_ms integer);
    create function net.http_post(url text,body jsonb default '{}'::jsonb,params jsonb default '{}'::jsonb,headers jsonb default '{}'::jsonb,timeout_milliseconds integer default 5000)
      returns bigint language plpgsql as $$ declare n bigint; begin insert into net.queued(url,headers,body,timeout_ms) values(url,headers,body,timeout_milliseconds) returning id into n; return n; end $$;
    create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text);
    create function cron.schedule(text,text,text) returns bigint language plpgsql as $$ declare n bigint; begin insert into cron.job(jobname,schedule,command) values($1,$2,$3) returning jobid into n; return n; end $$;
    create function cron.unschedule(bigint) returns boolean language plpgsql as $$ begin delete from cron.job where jobid=$1; return found; end $$;
    insert into cron.job(jobname,schedule,command) values('send-reminders-daily','0 13 * * *','select public.dispatch_daily_reminders()');
    insert into public.profiles(id,access_status,notify_email,email)
      select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'active',case when n%2=0 then true else null end,'synthetic-'||n||'@example.test' from generate_series(1,1205)n;
    insert into public.profiles(id,access_status,notify_email,email) values
      ('10000000-0000-4000-8000-000000000001','active',false,'disabled@example.test'),
      ('10000000-0000-4000-8000-000000000002','pending',true,'pending@example.test'),
      ('10000000-0000-4000-8000-000000000003','active',true,null),
      ('10000000-0000-4000-8000-000000000004','active',true,'');
  `);
  await pg.sql(migration); await pg.sql(migration);
  // Exercise this historical queue/timeout restoration and its rollback.
  // reminder-itemized-delivery.test.mjs covers the complete current chain,
  // including the later delivery-claim schema and itemized fingerprints.
  const timeoutMigration = readFileSync(new URL('../supabase/migrations/20261001080000_daily_reminders_timeout.sql', import.meta.url), 'utf8');
  const restoreMigration = readFileSync(new URL('../supabase/migrations/20261001230000_reminder_queue_dispatch_restore.sql', import.meta.url), 'utf8');
  await pg.sql(timeoutMigration);
  await pg.sql(restoreMigration); await pg.sql(restoreMigration);
  assert.equal(await pg.sql('select count(*) from net.queued'),'0');
  assert.equal(await pg.sql("select schedule from cron.job where jobname='send-reminders-daily'"),'0 13 * * *');
  assert.equal(await pg.sql("select count(*) from cron.job where jobname='drain-reminder-emails'"),'1');

  await t.test('1205 eligible members enqueue once without a burst of provider calls', async () => {
    await pg.sql('set role service_role; select public.dispatch_daily_reminders(); select public.dispatch_daily_reminders();');
    assert.equal(await pg.sql('select count(*) from public.reminder_email_queue'),'1205');
    assert.deepEqual(await pg.rows('select body,timeout_ms from net.queued'),[{body:{drain:true},timeout_ms:120000},{body:{drain:true},timeout_ms:120000}]);
    assert.equal(await pg.sql("select count(*) from public.reminder_email_queue where profile_id::text like '10000000-%'"),'0');
  });
  let first;
  await t.test('concurrent drains have one global lease and claim no more than 20 jobs', async () => {
    const results=await Promise.all([pg.rows('select * from public.reminder_queue_claim(1000)'),pg.rows('select * from public.reminder_queue_claim(1000)')]);
    assert.deepEqual(results.map(r=>r.length).sort((a,b)=>a-b),[0,20]);
    first=results.find(r=>r.length);
    assert.equal(new Set(first.map(r=>r.id)).size,20);
    assert.equal(new Set(first.map(r=>r.lease_token)).size,1);
  });
  await t.test('payload is immutable and a sent acknowledgement atomically stamps cadence once', async () => {
    const job=first[0];
    const freeze=p=>pg.sql(`select public.reminder_queue_payload('${job.id}','${job.lease_token}',${quote(p)})`);
    assert.deepEqual(JSON.parse(await freeze(payload)),payload);
    assert.deepEqual(JSON.parse(await freeze({...payload,email:{...payload.email,text:'Changed after a lost response'}})),payload);
    assert.equal(await pg.sql(`select public.reminder_queue_finish('${job.id}','${job.lease_token}','sent',null)`),'t');
    assert.equal(await pg.sql(`select public.reminder_queue_finish('${job.id}','${job.lease_token}','sent',null)`),'f');
    assert.equal(await pg.sql('select count(*) from public.notification_log'),'1');
    assert.equal(await pg.sql(`select reminder_email_fingerprint from public.profiles where id='${job.profile_id}'`),'a'.repeat(24));
  });
  await t.test('network/rate-limit failures reschedule; unstarted jobs are returned without spending attempts', async () => {
    const job=first[1];
    assert.equal(await pg.sql(`select public.reminder_queue_finish('${job.id}','${job.lease_token}','retry','provider_refused')`),'t');
    assert.equal(await pg.sql(`select status||':'||(available_at>now())::text||':'||last_error from public.reminder_email_queue where id='${job.id}'`),'pending:true:provider_refused');
    await pg.sql(`select public.reminder_queue_release('${job.lease_token}',array[${first.slice(3).map(j=>"'"+j.id+"'").join(',')}]::uuid[])`);
    assert.equal(await pg.sql(`select status||':'||attempts from public.reminder_email_queue where id='${first[3].id}'`),'pending:0');
    assert.equal(await pg.sql(`select status||':'||attempts from public.reminder_email_queue where id='${first[2].id}'`),'leased:1','attempted unconfirmed job retains its attempt and lease');
    await pg.sql(`select public.reminder_queue_finish('${first[2].id}','${job.lease_token}','skipped',null)`);
  });
  await t.test('crashed leases recover with the same job ID and frozen payload; stale acknowledgements fail', async () => {
    await pg.sql('update public.reminder_email_queue set available_at=now()');
    const old=(await pg.rows('select * from public.reminder_queue_claim(1)'))[0];
    await pg.sql(`select public.reminder_queue_payload('${old.id}','${old.lease_token}',${quote(payload)})`);
    await pg.sql("update public.reminder_email_queue set lease_until=now()-interval '1 second' where status='leased'; update public.reminder_email_drain set lease_until=now()-interval '1 second'");
    const recovered=(await pg.rows('select * from public.reminder_queue_claim(1)'))[0];
    assert.equal(recovered.id,old.id); assert.notEqual(recovered.lease_token,old.lease_token); assert.deepEqual(recovered.payload,payload);
    assert.equal(await pg.sql(`select public.reminder_queue_finish('${old.id}','${old.lease_token}','sent',null)`),'f');
    await pg.sql(`update public.reminder_email_queue set attempts=10 where id='${recovered.id}'; select public.reminder_queue_finish('${recovered.id}','${recovered.lease_token}','retry','send_unconfirmed'); select public.reminder_queue_release('${recovered.lease_token}')`);
    assert.equal(await pg.sql(`select status||':'||last_error from public.reminder_email_queue where id='${old.id}'`),'failed:send_unconfirmed');
  });
  await t.test('expired retry windows are visible failures, never retried beyond provider idempotency retention', async () => {
    await pg.sql("update public.reminder_email_queue set created_at=now()-interval '24 hours' where status='pending'");
    assert.deepEqual(await pg.rows('select * from public.reminder_queue_claim(20)'),[]);
    assert.equal(await pg.sql("select count(*) from public.reminder_email_queue where status='pending'"),'0');
    assert.equal(await pg.sql("select count(*) from public.reminder_email_queue where last_error='retry_window_exhausted'"),'1202');
  });
  await t.test('ordinary accounts cannot dispatch, claim, freeze or read queued messages', async () => {
    for(const role of ['anon','authenticated'])for(const sql of ['select public.dispatch_daily_reminders()','select * from public.reminder_queue_claim(20)','select * from public.reminder_email_queue']) {
      const result=await pg.tryRun(`set role ${role}; ${sql}`); assert.equal(result.ok,false); assert.match(result.err,/permission denied/);
    }
  });
  await t.test('daily housekeeping clears expired terminal payloads and removes audit rows after thirty days', async () => {
    await pg.sql(`update public.reminder_email_queue set payload=${quote(payload)} where status='failed' and last_error='retry_window_exhausted';
      insert into public.reminder_email_queue(profile_id,reminder_day,status,created_at,finished_at,payload)
      values('${first[0].profile_id}',current_date-31,'sent',now()-interval '31 days',now()-interval '31 days',${quote(payload)});
      select public.dispatch_daily_reminders();`);
    assert.equal(await pg.sql("select count(*) from public.reminder_email_queue where status='failed' and created_at<now()-interval '23 hours' and payload is not null"),'0');
    assert.equal(await pg.sql("select count(*) from public.reminder_email_queue where finished_at<now()-interval '30 days'"),'0');
    assert.equal(await pg.sql("select count(*) from public.reminder_email_queue where last_error='retry_window_exhausted'"),'1202','minimal failure evidence remains');
  });
  await t.test('missing hook preserves durable jobs for a later repaired drain', async () => {
    await pg.sql('truncate public.reminder_email_queue; truncate net.queued; delete from vault.decrypted_secrets; select public.dispatch_daily_reminders();');
    assert.equal(await pg.sql('select count(*) from public.reminder_email_queue'),'1205'); assert.equal(await pg.sql('select count(*) from net.queued'),'0');
    await pg.sql("insert into vault.decrypted_secrets values('welcome_hook_secret','synthetic-hook-only'); select public.dispatch_reminder_queue();");
    assert.equal(await pg.sql('select count(*) from net.queued'),'1');
  });
  await t.test('rollback restores the old dispatcher; reapplication restores queue and does not send', async () => {
    await pg.sql(rollback); await pg.sql('truncate net.queued; select public.dispatch_daily_reminders();');
    assert.deepEqual(await pg.rows('select body,timeout_ms from net.queued'),[{body:{},timeout_ms:5000}]);
    assert.equal(await pg.sql("select count(*) from cron.job where jobname='drain-reminder-emails'"),'0');
    await pg.sql(migration); assert.equal(await pg.sql('select count(*) from public.reminder_email_queue'),'0');
  });
});
