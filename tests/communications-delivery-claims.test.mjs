import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startPostgres } from './ops/pg.mjs';
import { pgSkip, withSlotWait } from './credential-portal/postgresFixture.mjs';
import { reminderSnoozed } from '../supabase/functions/_shared/reminderCadence.mjs';
const read = p => readFileSync(new URL('../'+p, import.meta.url),'utf8');
const migration=read('supabase/migrations/20260930223000_communications_delivery_claims.sql');
const snoozeMigration=read('supabase/migrations/20260930224500_reminder_snooze_text.sql');
const itemizedMigration=read('supabase/migrations/20261002001000_reminder_itemized_delivery.sql');
const rollback=read('docs/rollback/20260930223000_communications_delivery_claims.rollback.sql');
const parse=v=>v?JSON.parse(v):null;
const quote=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
const email={from:'Synthetic <sender@example.test>',to:['guide@example.test'],subject:'Synthetic guide',text:'Frozen guide\n\nOriginal body',html:'<p>Original</p>'};

test('communication claims use real PostgreSQL: concurrent callers, immutable retry and current requests', {skip:pgSkip(),timeout:withSlotWait(120000)},async t=>{
  const pg=await startPostgres(58965,'communication-claims');t.after(()=>pg.close());
  // Every SQL call opens a fresh connection. Force this disposable database's
  // civil day away from UTC so UTC queue keys cannot accidentally depend on
  // the developer's timezone. Select an offset whose civil date differs at
  // setup; queue keys below always use UTC, including near either midnight.
  const timezone=await pg.sql("select case when extract(hour from now() at time zone 'UTC')<11 then 'Etc/GMT+12' else 'Etc/GMT-14' end");
  await pg.sql(`alter database postgres set timezone='${timezone}'`);
  assert.equal(await pg.sql("select (current_date<>(now() at time zone 'UTC')::date)::text"),'true','fixture civil day deliberately differs from the UTC queue day');
  await pg.sql(`
    create role anon; create role authenticated; create role service_role;
    create schema vault; create schema net; create schema cron;
    create table vault.decrypted_secrets(name text primary key, decrypted_secret text);
    insert into vault.decrypted_secrets values ('welcome_hook_secret','synthetic-hook-only');
    -- Real profiles.snoozed_until is TEXT. A timestamptz fixture hid the
    -- old delivery claim's text > timestamptz failure for every due email.
    create table public.profiles(id uuid primary key, access_status text, notify_email boolean, email text,notify_freq_days integer,snoozed_until text,alerts_fingerprint text,reminder_email_fingerprint text,reminder_emailed_at timestamptz,updated_at timestamptz);
    create table public.notification_log(id bigserial primary key,user_id uuid,method text,alert_count integer,date timestamptz);
    create table net.queued(id bigserial primary key,url text,headers jsonb,body jsonb,timeout_ms integer);
    create function net.http_post(url text,body jsonb default '{}'::jsonb,params jsonb default '{}'::jsonb,headers jsonb default '{}'::jsonb,timeout_milliseconds integer default 5000)
      returns bigint language plpgsql as $$ declare n bigint; begin insert into net.queued(url,headers,body,timeout_ms) values(url,headers,body,timeout_milliseconds) returning id into n; return n; end $$;
    create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text);
    create function cron.schedule(text,text,text) returns bigint language plpgsql as $$ declare n bigint; begin insert into cron.job(jobname,schedule,command) values($1,$2,$3) returning jobid into n; return n; end $$;
    create function cron.unschedule(bigint) returns boolean language plpgsql as $$ begin delete from cron.job where jobid=$1; return found; end $$;
    insert into cron.job(jobname,schedule,command) values('send-reminders-daily','0 13 * * *','select public.dispatch_daily_reminders()');
    insert into public.profiles(id,access_status,notify_email,email) values
      ('00000000-0000-4000-8000-000000000001','active',true,'synthetic@example.test');
    create table public.early_access_leads(id uuid primary key default gen_random_uuid(),email text,name text,source text,note text,status text,
      created_at timestamptz default now(),guide_sent_at timestamptz,guide_attempts integer not null default 0);
  `);
  await pg.sql(read('supabase/migrations/20260902_guide_waitlist_optin.sql'));
  await pg.sql(read('supabase/migrations/20260930220000_reminder_delivery_queue.sql'));
  await pg.sql(migration);await pg.sql(migration);
  await t.test('the previously applied claim fails on the real TEXT snooze schema, including null', async () => {
    assert.equal(await pg.sql("select data_type from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='snoozed_until'"),'text');
    const job=parse(await pg.sql(`insert into reminder_email_queue(profile_id,reminder_day,status,lease_token,lease_until)
      values('00000000-0000-4000-8000-000000000001',(now() at time zone 'UTC')::date,'leased',gen_random_uuid(),now()+interval '90 seconds')
      returning jsonb_build_object('id',id,'lease_token',lease_token)`));
    const payload={email:{...email,to:['synthetic@example.test']},fingerprint:'a'.repeat(24),count:1};
    const broken=await pg.tryRun(`select reminder_queue_payload('${job.id}','${job.lease_token}',${quote(payload)})`);
    assert.equal(broken.ok,false);
    assert.match(broken.err,/operator does not exist: text > timestamp with time zone/);
    assert.equal(await pg.sql('select count(*) from reminder_email_uncertainty'),'0');
    await pg.sql(`delete from reminder_email_queue where id='${job.id}'`);
  });
  await pg.sql(snoozeMigration);await pg.sql(snoozeMigration);
  await pg.sql(itemizedMigration);await pg.sql(itemizedMigration);
  assert.equal(await pg.sql('select count(*) from net.queued'),'0');
  await pg.sql('select dispatch_guide_emails()');
  assert.equal(await pg.sql("select timeout_ms from net.queued where url like '%send-guide'"),'60000');
  await pg.sql('truncate net.queued');
  let lead, claim;
  const refresh=async()=>lead=(await pg.rows("select * from early_access_leads where email='guide@example.test'"))[0];
  const attempt=async(payload=email)=>parse(await pg.sql(`select public.guide_delivery_claim('${lead.id}','${lead.guide_request_id}','${lead.email}','${lead.note}',${quote(payload)})`));
  const finish=(job,outcome='sent')=>pg.sql(`select public.guide_delivery_finish('${job.request_id}','${job.lease_token}','${outcome}','send_unconfirmed')`);

  await t.test('TEXT snoozes handle null, empty, invalid, past and future dates without losing leased work', async () => {
    const pid='00000000-0000-4000-8000-000000000005';
    const payload={email:{...email,to:['snooze@example.test']},fingerprint:'e'.repeat(24),count:1};
    await pg.sql(`insert into profiles(id,access_status,notify_email,email,notify_freq_days) values('${pid}','active',true,'snooze@example.test',7)`);
    const values=[null,'','   ','not-a-date','2099-99-99T12:00:00Z','infinity','-infinity','tomorrow','tomorrow 12:00',
      '2000-01-02T12:00:00.000Z','2099-01-02T12:00:00.000Z','2099-01-02T08:00:00-04:00','2099-01-02'];
    for(const value of values){
      const literal=value===null?'null':"'"+value.replaceAll("'","''")+"'";
      await pg.sql(`delete from reminder_email_uncertainty where profile_id='${pid}';delete from reminder_email_queue where profile_id='${pid}';update profiles set snoozed_until=${literal} where id='${pid}'`);
      const job=parse(await pg.sql(`insert into reminder_email_queue(profile_id,reminder_day,status,lease_token,lease_until)
        values('${pid}',(now() at time zone 'UTC')::date,'leased',gen_random_uuid(),now()+interval '90 seconds') returning jsonb_build_object('id',id,'lease_token',lease_token)`));
      const frozen=parse(await pg.sql(`set timezone='Pacific/Honolulu';select reminder_queue_payload('${job.id}','${job.lease_token}',${quote(payload)})`));
      const snoozed=reminderSnoozed(value);
      assert.deepEqual(frozen,snoozed?{suppressed:true,reason:'snoozed'}:payload,`snooze ${JSON.stringify(value)} matches the JS sender`);
      assert.equal(await pg.sql(`select status from reminder_email_queue where id='${job.id}'`),'leased','checking a preference does not drop its lease');
      assert.equal(await pg.sql(`select (payload is null)::text from reminder_email_queue where id='${job.id}'`),String(snoozed),'only an admitted delivery freezes provider payload');
      assert.equal(await pg.sql(`select count(*) from reminder_email_uncertainty where profile_id='${pid}'`),snoozed?'0':'1');
      assert.equal(await pg.sql(`select (reminder_emailed_at is null)::text from profiles where id='${pid}'`),'true','admission never invents successful delivery');
    }
    await pg.sql(`delete from profiles where id='${pid}'`);
  });

  await t.test('a new valid TEXT snooze suppresses a previously frozen retry, and clearing it keeps the same intent', async () => {
    const pid='00000000-0000-4000-8000-000000000006';
    const payload={email:{...email,to:['retry-snooze@example.test']},fingerprint:'f'.repeat(24),count:1};
    await pg.sql(`insert into profiles(id,access_status,notify_email,email) values('${pid}','active',true,'retry-snooze@example.test')`);
    const job=parse(await pg.sql(`insert into reminder_email_queue(profile_id,reminder_day,status,lease_token,lease_until)
      values('${pid}',(now() at time zone 'UTC')::date,'leased',gen_random_uuid(),now()+interval '90 seconds') returning jsonb_build_object('id',id,'lease_token',lease_token)`));
    const freeze=p=>pg.sql(`select reminder_queue_payload('${job.id}','${job.lease_token}',${quote(p)})`).then(parse);
    assert.deepEqual(await freeze(payload),payload);
    const started=await pg.sql(`select intent_started_at from reminder_email_uncertainty where profile_id='${pid}'`);
    await pg.sql(`update profiles set snoozed_until='2099-01-02T12:00:00.000Z' where id='${pid}'`);
    assert.deepEqual(await freeze(payload),{suppressed:true,reason:'snoozed'});
    await pg.sql(`update profiles set snoozed_until='' where id='${pid}'`);
    assert.deepEqual(await freeze({...payload,email:{...payload.email,text:'New draft must not replace frozen retry'}}),payload);
    assert.equal(await pg.sql(`select intent_started_at from reminder_email_uncertainty where profile_id='${pid}'`),started);
    assert.equal(await pg.sql('select count(*) from notification_log'),'0');
    await pg.sql(`delete from profiles where id='${pid}'`);
  });

  await t.test('manual and daily enqueues share one job and preserve the existing send times',async()=>{
    await Promise.all([pg.sql('select public.reminder_queue_enqueue()'),pg.sql('select public.dispatch_daily_reminders()')]);
    assert.equal(await pg.sql('select count(*) from reminder_email_queue'),'1');
    const [a,b]=await Promise.all([pg.rows('select * from reminder_queue_claim(20)'),pg.rows('select * from reminder_queue_claim(20)')]);
    assert.deepEqual([a.length,b.length].sort(),[0,1]);
    await pg.sql('select public.reminder_queue_enqueue()');
    assert.equal(await pg.sql('select count(*) from reminder_email_queue'),'1');
    assert.equal(await pg.sql("select schedule from cron.job where jobname='send-reminders-daily'"),'0 13 * * *');
  });
  await t.test('an uncertain prior-day reminder cannot overlap a new manual or scheduled job',async()=>{
    await pg.sql("delete from reminder_email_queue;update reminder_email_drain set lease_token=null,lease_until=null;insert into reminder_email_queue(profile_id,reminder_day) select id,(now() at time zone 'UTC')::date-1 from profiles");
    const job=(await pg.rows('select * from reminder_queue_claim(1)'))[0];
    const payload={email:{...email,to:['synthetic@example.test']},fingerprint:'a'.repeat(24),count:1};
    assert.deepEqual(parse(await pg.sql(`select reminder_queue_payload('${job.id}','${job.lease_token}',${quote(payload)})`)),payload);
    await Promise.all([pg.sql('select reminder_queue_enqueue()'),pg.sql('select dispatch_daily_reminders()')]);
    assert.equal(await pg.sql('select count(*) from reminder_email_queue'),'1','the partial unique index applies to both enqueue paths across dates');
    const duplicate=await pg.tryRun("insert into reminder_email_queue(profile_id,reminder_day) select id,(now() at time zone 'UTC')::date from profiles");
    assert.equal(duplicate.ok,false);assert.match(duplicate.err,/reminder_email_one_active_profile/);
    await pg.sql(`select reminder_queue_finish('${job.id}','${job.lease_token}','retry','send_unconfirmed');select reminder_queue_release('${job.lease_token}');
      update reminder_email_queue set created_at=now()-interval '24 hours' where id='${job.id}';
      update reminder_email_uncertainty set intent_started_at=now()-interval '1 day';
      select reminder_queue_enqueue();`);
    assert.equal(await pg.sql('select count(*) from reminder_email_queue'),'2','expired old work is terminal before new enqueue');
    const next=(await pg.rows('select * from reminder_queue_claim(1)'))[0];
    assert.notEqual(next.id,job.id);
    const held=parse(await pg.sql(`select reminder_queue_payload('${next.id}','${next.lease_token}',${quote(payload)})`));
    assert.deepEqual(held,{suppressed:true,reason:'unconfirmed_delivery_within_cadence'});
    await pg.sql(`select reminder_queue_finish('${next.id}','${next.lease_token}','skipped');select reminder_queue_release('${next.lease_token}');`);
    assert.equal(await pg.sql(`select status||':'||last_error from reminder_email_queue where id='${next.id}'`),'skipped:unconfirmed_delivery_within_cadence');
    assert.equal(await pg.sql('select (reminder_emailed_at is null)::text from profiles'),'true','unknown acceptance never becomes a confirmed stamp');
    assert.equal(await pg.sql('select count(*) from notification_log'),'0');
    // Prune both provider payload and its old job row: the minimal identity remains.
    await pg.sql(`update reminder_email_queue set finished_at=now()-interval '31 days' where id='${job.id}';select dispatch_daily_reminders();`);
    const pending=(await pg.rows('select * from reminder_email_uncertainty'))[0];
    assert.equal(pending.source_job,null);assert.equal(pending.resolved_at,null);
    assert.match(pending.recipient_hash,/^[0-9a-f]{32}$/);assert.equal('email' in pending,false);
    // Seven whole UTC days makes a legitimate new weekly intent, not a retry.
    await pg.sql("update reminder_email_queue set reminder_day=(now() at time zone 'UTC')::date-1;update reminder_email_uncertainty set intent_started_at=now()-interval '7 days';select reminder_queue_enqueue()");
    const weekly=(await pg.rows('select * from reminder_queue_claim(1)'))[0];
    assert.deepEqual(parse(await pg.sql(`select reminder_queue_payload('${weekly.id}','${weekly.lease_token}',${quote(payload)})`)),payload);
    await pg.sql(`select reminder_queue_finish('${weekly.id}','${weekly.lease_token}','sent');select reminder_queue_release('${weekly.lease_token}');`);
    assert.equal(await pg.sql('select count(*) from notification_log'),'1');
    assert.equal(await pg.sql("select resolution from reminder_email_uncertainty"),'confirmed_sent');
    assert.equal(await pg.sql('select (resolved_at is not null)::text from reminder_email_uncertainty'),'true');
  });
  await t.test('reconciliation needs explicit evidence and a settled intent; confirmed-not-sent does not invent a send',async()=>{
    const profile='00000000-0000-4000-8000-000000000001',fp='b'.repeat(24);
    await pg.sql(`insert into reminder_email_queue(profile_id,reminder_day) values('${profile}',(now() at time zone 'UTC')::date+1)`);
    const job=(await pg.rows('select * from reminder_queue_claim(1)'))[0];
    const payload={email:{...email,to:['synthetic@example.test']},fingerprint:fp,count:1};
    await pg.sql(`select reminder_queue_payload('${job.id}','${job.lease_token}',${quote(payload)})`);
    const rec=(await pg.rows(`select * from reminder_email_uncertainty where fingerprint='${fp}'`))[0];
    const call=(resolution,reason)=>`select reminder_delivery_reconcile('${profile}','${fp}','${rec.recipient_hash}','${resolution}','${reason}')`;
    assert.equal((await pg.tryRun(call('confirmed_not_sent','Verified synthetic provider evidence'))).ok,false,'an active intent cannot be reconciled out from under its sender');
    await pg.sql(`select reminder_queue_finish('${job.id}','${job.lease_token}','retry','send_unconfirmed');select reminder_queue_release('${job.lease_token}');update reminder_email_queue set attempts=10 where id='${job.id}';select reminder_queue_expire()`);
    assert.equal((await pg.tryRun(call('confirmed_not_sent',''))).ok,false,'a reason is mandatory');
    assert.equal(await pg.sql(call('confirmed_not_sent','Verified synthetic provider evidence')),'t');
    assert.equal(await pg.sql(`select resolution from reminder_email_uncertainty where fingerprint='${fp}'`),'confirmed_not_sent');
    assert.equal(await pg.sql('select count(*) from notification_log'),'1','reconciliation is not an email send');
  });
  await t.test('a profile update or reconciliation after the JS snapshot is rechecked before freezing',async()=>{
    const pid='00000000-0000-4000-8000-000000000003';
    await pg.sql(`insert into profiles(id,access_status,notify_email,email) values('${pid}','active',true,'atomic@example.test');select reminder_queue_enqueue('${pid}')`);
    const job=(await pg.rows('select * from reminder_queue_claim(1)'))[0];
    const payload={email:{...email,to:['atomic@example.test']},fingerprint:'c'.repeat(24),count:1};
    const freeze=()=>pg.sql(`select reminder_queue_payload('${job.id}','${job.lease_token}',${quote(payload)})`).then(parse);
    await pg.sql(`update profiles set reminder_email_fingerprint='${payload.fingerprint}',reminder_emailed_at=now() where id='${pid}'`);
    assert.deepEqual(await freeze(),{suppressed:true,reason:'recently_notified_unchanged'});
    await pg.sql(`update profiles set reminder_emailed_at=null,snoozed_until=now()+interval '1 day' where id='${pid}'`);
    assert.deepEqual(await freeze(),{suppressed:true,reason:'snoozed'});
    await pg.sql(`update profiles set snoozed_until=null,notify_email=false where id='${pid}'`);
    assert.deepEqual(await freeze(),{suppressed:true,reason:'recipient_ineligible'});
    assert.equal(await pg.sql(`select count(*) from reminder_email_uncertainty where profile_id='${pid}'`),'0');
    await pg.sql(`select reminder_queue_finish('${job.id}','${job.lease_token}','skipped');select reminder_queue_release('${job.lease_token}')`);
    await pg.sql(`delete from profiles where id='${pid}'`);
  });
  await t.test('an unresolved daily intent permits the next UTC day while same-day intent remains held',async()=>{
    const pid='00000000-0000-4000-8000-000000000004';
    await pg.sql(`insert into profiles(id,access_status,notify_email,email,notify_freq_days) values('${pid}','active',true,'daily@example.test',1);
      insert into reminder_email_queue(profile_id,reminder_day) values('${pid}',(now() at time zone 'UTC')::date-1)`);
    const old=(await pg.rows('select * from reminder_queue_claim(1)'))[0];
    const payload={email:{...email,to:['daily@example.test']},fingerprint:'d'.repeat(24),count:1};
    await pg.sql(`select reminder_queue_payload('${old.id}','${old.lease_token}',${quote(payload)});select reminder_queue_finish('${old.id}','${old.lease_token}','retry','send_unconfirmed');select reminder_queue_release('${old.lease_token}');
      update reminder_email_queue set attempts=10 where id='${old.id}';select reminder_queue_enqueue('${pid}')`);
    const fresh=(await pg.rows('select * from reminder_queue_claim(1)'))[0];
    const freeze=()=>pg.sql(`select reminder_queue_payload('${fresh.id}','${fresh.lease_token}',${quote(payload)})`).then(parse);
    assert.equal((await freeze()).reason,'unconfirmed_delivery_within_cadence');
    await pg.sql(`update reminder_email_uncertainty set intent_started_at=(date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')-interval '1 second' where profile_id='${pid}'`);
    assert.deepEqual(await freeze(),payload,'the next UTC day is a new daily intent, with no invented confirmed timestamp');
    assert.equal(await pg.sql(`select (reminder_emailed_at is null)::text from profiles where id='${pid}'`),'true');
    await pg.sql(`select reminder_queue_finish('${fresh.id}','${fresh.lease_token}','sent');select reminder_queue_release('${fresh.lease_token}');delete from profiles where id='${pid}'`);
  });
  await t.test('two concurrent guide sweeps acquire only one lease',async()=>{
    await pg.sql("select public.waitlist_signup(p_email=>'guide@example.test',p_note=>'guide-email CA',p_waitlist=>false)");
    await refresh();
    const tries=await Promise.all([attempt(),attempt()]);
    assert.equal(tries.filter(Boolean).length,1);claim=tries.find(Boolean);
    assert.equal(await pg.sql('select attempts from guide_email_deliveries'),'1');
    assert.equal(await pg.sql('select guide_attempts from early_access_leads'),'1');
  });
  await t.test('a lost provider answer retries the identical payload and request key after lease recovery',async()=>{
    await pg.sql("update guide_email_deliveries set lease_until=now()-interval '1 second'");
    const retry=await attempt({...email,text:'Changed source must not change the retry'});
    assert.equal(retry.request_id,claim.request_id);assert.notEqual(retry.lease_token,claim.lease_token);
    assert.deepEqual(retry.payload,email);
    assert.equal(await finish(claim),'f','stale acknowledgement is rejected');
    claim=retry;
  });
  await t.test('an old accepted send cannot stamp a newer state request',async()=>{
    await pg.sql("select public.waitlist_signup(p_email=>'guide@example.test',p_note=>'guide-email NY',p_waitlist=>false)");
    await refresh();assert.notEqual(lead.guide_request_id,claim.request_id);
    assert.equal(await finish(claim),'t');
    assert.equal(await pg.sql('select (guide_sent_at is null)::text from early_access_leads'),'true');
    const next=await attempt({...email,text:'New York requested guide'});
    assert.notEqual(next.request_id,claim.request_id);assert.equal(next.payload.text,'New York requested guide');
    assert.equal(await finish(next),'t');
    assert.equal(await finish(next),'f');
    await refresh();assert.ok(lead.guide_sent_at);
  });
  await t.test('the one-hour guide repeat throttle and legitimate later requests retain their policy',async()=>{
    const prior=lead.guide_request_id;
    await pg.sql("select public.waitlist_signup(p_email=>'guide@example.test',p_note=>'guide-email NY',p_waitlist=>false)");
    await refresh();assert.equal(lead.guide_request_id,prior);assert.ok(lead.guide_sent_at);
    await pg.sql("update early_access_leads set guide_sent_at=now()-interval '2 hours'; select public.waitlist_signup(p_email=>'guide@example.test',p_note=>'guide-email NY',p_waitlist=>false)");
    await refresh();assert.notEqual(lead.guide_request_id,prior);assert.equal(lead.guide_sent_at,null);
    claim=await attempt();assert.ok(claim);
    assert.equal(await finish(claim,'retry'),'t');
    assert.equal(await attempt(),null,'a retry waits for its next sweep');
  });
  await t.test('exhausted ambiguous sends cannot restart when form submission resets guide_attempts',async()=>{
    await pg.sql(`update guide_email_deliveries set created_at=now()-interval '24 hours',available_at=now() where request_id='${claim.request_id}'; select guide_delivery_cleanup();`);
    await pg.sql("select public.waitlist_signup(p_email=>'guide@example.test',p_note=>'guide-email NY',p_waitlist=>false)");
    await refresh();assert.equal(lead.guide_request_id,claim.request_id);assert.equal(lead.guide_attempts,0);
    assert.equal(await attempt(),null);
    assert.equal(await pg.sql(`select status||':'||(payload is null)::text from guide_email_deliveries where request_id='${claim.request_id}'`),'failed:true');
    assert.equal(await pg.sql('select guide_attempts from early_access_leads'),'5');
    await pg.sql(`update guide_email_deliveries set finished_at=now()-interval '31 days' where request_id='${claim.request_id}';select guide_delivery_cleanup();`);
    assert.equal(await pg.sql(`select count(*) from guide_email_deliveries where request_id='${claim.request_id}'`),'1','terminal identity for the current request survives payload/audit cleanup');
  });
  await t.test('changed address or request invalidates stale candidates before provider sending',async()=>{
    const old={...lead};
    await pg.sql("update early_access_leads set email='new-guide@example.test',guide_attempts=0");
    assert.equal(parse(await pg.sql(`select guide_delivery_claim('${old.id}','${old.guide_request_id}','${old.email}','${old.note}',${quote(email)})`)),null);
    lead=(await pg.rows('select * from early_access_leads'))[0];
    const fresh=await attempt({...email,to:[lead.email]});assert.ok(fresh);assert.notEqual(fresh.request_id,old.guide_request_id);
    assert.deepEqual(fresh.payload.to,['new-guide@example.test']);
    await finish(fresh);
  });
  await t.test('role boundaries deny normal users all delivery controls and payload access',async()=>{
    for(const role of ['anon','authenticated'])for(const sql of ['select reminder_queue_enqueue()','select guide_delivery_cleanup()','select * from guide_email_deliveries','select * from reminder_email_uncertainty','select reminder_queue_expire()']){
      const result=await pg.tryRun(`set role ${role};${sql}`);assert.equal(result.ok,false);assert.match(result.err,/permission denied/);
    }
  });
  await t.test('rollback removes only this addition and reapplication sends nothing',async()=>{
    const before=await pg.sql('select count(*) from reminder_email_queue');
    await pg.sql(rollback);assert.equal(await pg.sql('select count(*) from reminder_email_queue'),before);
    assert.equal(await pg.sql("select count(*) from cron.job where jobname in('send-reminders-daily','drain-reminder-emails')"),'2');
    await pg.sql('truncate net.queued');await pg.sql(migration);await pg.sql(snoozeMigration);await pg.sql(itemizedMigration);
    assert.equal(await pg.sql('select count(*) from net.queued'),'0');
  });
});
