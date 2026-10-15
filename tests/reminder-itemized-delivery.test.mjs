import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {startPostgres} from './ops/pg.mjs';
import {pgSkip,withSlotWait,quote as literal} from './credential-portal/postgresFixture.mjs';
import {reminderFingerprint,reminderEmailDecision,reminderToldStill} from '../supabase/functions/_shared/reminderCadence.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const quote=v=>literal(JSON.stringify(v))+'::jsonb';
const parse=v=>JSON.parse(v);
const migration=read('supabase/migrations/20260930223000_communications_delivery_claims.sql');
const itemized=read('supabase/migrations/20261002001000_reminder_itemized_delivery.sql');

test('merged reminder definitions accept the actual sender and preserve atomic delivery semantics',{skip:pgSkip(),timeout:withSlotWait(180000)},async t=>{
  const pg=await startPostgres(58969,'reminder-itemized');t.after(()=>pg.close());
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

  await pg.sql(migration);
  await pg.sql(read('supabase/migrations/20260930224500_reminder_snooze_text.sql'));
  await pg.sql(read('supabase/migrations/20261001080000_daily_reminders_timeout.sql'));
  await pg.sql(read('supabase/migrations/20261001230000_reminder_queue_dispatch_restore.sql'));
  const pid='00000000-0000-4000-8000-000000000001';
  const a={id:'synthetic-license-a',table:'licenses',exp:'2026-10-21'};
  const b={id:'synthetic-license-b',table:'licenses',exp:'2026-10-21'};
  const fp=await reminderFingerprint([a]);
  const payload={email:{from:'Synthetic <sender@example.test>',to:['synthetic@example.test'],subject:'Synthetic check',text:'Frozen body'},fingerprint:fp,count:1};
  const newJob=async()=>parse(await pg.sql(`insert into reminder_email_queue(profile_id,reminder_day,status,lease_token,lease_until)
    values('${pid}',(now() at time zone 'UTC')::date,'leased',gen_random_uuid(),now()+interval '90 seconds') returning jsonb_build_object('id',id,'lease_token',lease_token)`));
  let job=await newJob();
  const freeze=async(p=payload)=>parse(await pg.sql(`select reminder_queue_payload('${job.id}','${job.lease_token}',${quote(p)})`));
  await t.test('before: actual itemized sender payload fails the old database contract',async()=>{
    const result=await pg.tryRun(`select reminder_queue_payload('${job.id}','${job.lease_token}',${quote(payload)})`);
    assert.equal(result.ok,false);assert.match(result.err,/Invalid reminder payload/);
    assert.equal(await pg.sql('select count(*) from reminder_email_uncertainty'),'0');
  });
  await t.test('before: the restored dispatcher conflicts with an outstanding prior-day intent',async()=>{
    await pg.sql(`update reminder_email_queue set reminder_day=(now() at time zone 'UTC')::date-1 where id='${job.id}'`);
    const result=await pg.tryRun('select dispatch_daily_reminders()');
    assert.equal(result.ok,false);assert.match(result.err,/reminder_email_one_active_profile/);
  });
  const before=await pg.rows('select * from reminder_email_queue');
  await pg.sql(itemized);await pg.sql(itemized);
  assert.deepEqual(await pg.rows('select * from reminder_email_queue'),before,'applying twice changes no queued intent');
  assert.equal(await pg.sql('select count(*) from net.queued'),'0','migration sends nothing');
  await t.test('accept and retry the real fingerprint; immutable message and short uncertainty identity',async()=>{
    assert.deepEqual(await freeze(),payload);
    assert.deepEqual(await freeze({...payload,fingerprint:await reminderFingerprint([a,b]),email:{...payload.email,text:'Changed'}}),payload);
    const ledger=(await pg.rows('select fingerprint,intent_started_at from reminder_email_uncertainty'))[0];
    assert.equal(ledger.fingerprint,fp.split(';')[0]);
    assert.equal(await pg.sql(`select reminder_queue_finish('${job.id}','${job.lease_token}','sent')`),'t');
    assert.equal(await pg.sql(`select reminder_queue_finish('${job.id}','${job.lease_token}','sent')`),'f');
    assert.equal(await pg.sql('select count(*) from notification_log'),'1');
    assert.equal(await pg.sql(`select reminder_email_fingerprint from profiles where id='${pid}'`),fp);
  });
  await t.test('locked SQL decision matches the real JS sender across snoozes, narrowed lists, UTC cadence and legacy rows',async()=>{
    const now=Date.parse('2026-10-01T13:00:00Z'), day=86400000;
    const fingerprints=await Promise.all([[],[a],[a,b],[{...a,exp:'2026-10-12'}],[{...a,exp:'2026-11-10'}],[{...b,table:'travel_docs'}]].map(reminderFingerprint));
    const storedValues=[null,fp.split(';')[0],...fingerprints,reminderToldStill(fingerprints[2],fingerprints[1])];
    const currentValues=[fp.split(';')[0],...fingerprints];
    const cases=[];
    for(const stored of storedValues)for(const current of currentValues)for(const snooze of [null,'not-a-date','2026-10-10T00:00:00Z'])for(const last of [null,new Date(now-day).toISOString(),new Date(now-7*day+10000).toISOString()])for(const alerts of [null,'soon:licenses:2026-10-21','soon:licenses:2026-10-21|soon:licenses:2026-10-21','soon:travelDocs:2026-10-21']){
      const profile={reminder_email_fingerprint:stored,reminder_emailed_at:last,snoozed_until:snooze,alerts_fingerprint:alerts};
      const expected=reminderEmailDecision(profile,{fingerprint:current,freqDays:7,now}).reason.replace('recently notified, unchanged','recently_notified_unchanged');
      cases.push({profile,current,expected});
    }
    for(let offset=0;offset<cases.length;offset+=60){
      const batch=cases.slice(offset,offset+60);
      const values=batch.map((c,i)=>`(${i},${literal(c.profile.reminder_email_fingerprint)},${literal(c.current)},${literal(c.profile.alerts_fingerprint)},${literal(c.profile.reminder_emailed_at)}::timestamptz,${literal(c.profile.snoozed_until)})`).join(',');
      const rows=await pg.rows(`select n,reminder_delivery_decision(stored,current,alerts,last,snooze,7,'2026-10-01T13:00:00Z') decision from (values ${values}) c(n,stored,current,alerts,last,snooze) order by n`);
      for(const r of rows)assert.equal(r.decision,batch[r.n].expected,JSON.stringify(batch[r.n]));
    }
    assert.equal(cases.length,2268);
  });
  await t.test('overlapping days keep the outstanding intent, expire exhausted work before enqueue and prune resolved uncertainty',async()=>{
    await pg.sql(`delete from reminder_email_queue;delete from reminder_email_uncertainty;
      insert into reminder_email_queue(profile_id,reminder_day) values('${pid}',(now() at time zone 'UTC')::date-1);
      insert into reminder_email_uncertainty(profile_id,fingerprint,recipient_hash,intent_started_at,resolved_at,resolution)
        values('${pid}','aaaaaaaaaaaaaaaaaaaaaaaa','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',now()-interval '32 days',now()-interval '31 days','confirmed_sent'),
        ('${pid}','bbbbbbbbbbbbbbbbbbbbbbbb','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',now()-interval '32 days',null,null);
      select dispatch_daily_reminders();select dispatch_daily_reminders();`);
    assert.equal(await pg.sql('select count(*) from reminder_email_queue'),'1');
    assert.equal(await pg.sql('select count(*) from reminder_email_uncertainty where resolved_at is not null'),'0','old confirmed metadata is pruned');
    assert.equal(await pg.sql('select count(*) from reminder_email_uncertainty where resolved_at is null'),'1','old unresolved evidence stays available');
    await pg.sql(`update reminder_email_queue set attempts=10;select dispatch_daily_reminders()`);
    assert.equal(await pg.sql("select count(*) from reminder_email_queue where status='failed' and last_error='retry_window_exhausted'"),'1');
    assert.equal(await pg.sql("select count(*) from reminder_email_queue where status='pending'"),'1');
  });
  await t.test('legacy bare-hash pending retries and operator reconciliation remain compatible',async()=>{
    await pg.sql(`delete from reminder_email_queue;delete from reminder_email_uncertainty;update profiles set reminder_emailed_at=null,snoozed_until=null where id='${pid}'`);
    job=await newJob();
    const legacy={...payload,fingerprint:fp.split(';')[0]};
    assert.deepEqual(await freeze(legacy),legacy);
    assert.deepEqual(await freeze(payload),legacy,'upgrade cannot change an already frozen provider body or tracking value');
    await pg.sql(`select reminder_queue_finish('${job.id}','${job.lease_token}','retry','send_unconfirmed');update reminder_email_queue set attempts=10;select reminder_queue_expire();`);
    const record=(await pg.rows('select * from reminder_email_uncertainty'))[0];
    assert.equal(await pg.sql(`select reminder_delivery_reconcile('${pid}','${record.fingerprint}','${record.recipient_hash}','confirmed_sent','Verified synthetic legacy provider acceptance',now())`),'t');
    assert.equal(await pg.sql(`select reminder_email_fingerprint from profiles where id='${pid}'`),legacy.fingerprint);
  });
  await t.test('large item lists fit the ledger; reconciliation uses retained payload, then legacy digest after pruning',async()=>{
    await pg.sql(`delete from reminder_email_queue;delete from reminder_email_uncertainty;update profiles set reminder_emailed_at=null,snoozed_until=null where id='${pid}'`);
    job=await newJob();
    const large=await reminderFingerprint(Array.from({length:1205},(_,i)=>({...a,id:'synthetic-'+i})));
    assert.ok(large.length>30000);
    const big={...payload,fingerprint:large,count:1205};assert.deepEqual(await freeze(big),big);
    assert.equal(await pg.sql('select length(fingerprint) from reminder_email_uncertainty'),'24');
    await pg.sql(`select reminder_queue_finish('${job.id}','${job.lease_token}','retry','send_unconfirmed');update reminder_email_queue set attempts=10;select reminder_queue_expire();`);
    const record=(await pg.rows('select * from reminder_email_uncertainty'))[0];
    assert.equal(await pg.sql(`select reminder_delivery_reconcile('${pid}','${record.fingerprint}','${record.recipient_hash}','confirmed_sent','Verified synthetic provider acceptance',now())`),'t');
    assert.equal(await pg.sql(`select reminder_email_fingerprint from profiles where id='${pid}'`),large);
    assert.equal(await pg.sql('select count(*) from notification_log'),'1','reconciliation does not fabricate another send');
    await pg.sql(`delete from reminder_email_queue;delete from reminder_email_uncertainty;update profiles set reminder_emailed_at=null where id='${pid}'`);
    job=await newJob();assert.deepEqual(await freeze(big),big);
    await pg.sql(`select reminder_queue_finish('${job.id}','${job.lease_token}','retry','send_unconfirmed');update reminder_email_queue set attempts=10;select reminder_queue_expire();update reminder_email_queue set payload=null;`);
    const pruned=(await pg.rows('select * from reminder_email_uncertainty'))[0];
    assert.equal(await pg.sql(`select reminder_delivery_reconcile('${pid}','${pruned.fingerprint}','${pruned.recipient_hash}','confirmed_sent','Verified synthetic acceptance after content pruning',now())`),'t');
    assert.equal(await pg.sql(`select reminder_email_fingerprint from profiles where id='${pid}'`),large.split(';')[0],'retention does not preserve an extra unbounded item list');
    assert.equal(reminderEmailDecision({reminder_email_fingerprint:large.split(';')[0],reminder_emailed_at:new Date().toISOString()},{fingerprint:large,freqDays:7}).send,false,'legacy fallback still enforces confirmed cadence');
  });
  await t.test('new snooze and banner state are rechecked under lock; malformed fingerprints and unauthorized callers are refused',async()=>{
    await pg.sql(`delete from reminder_email_queue;delete from reminder_email_uncertainty;update profiles set reminder_emailed_at=now(),reminder_email_fingerprint=${literal(fp)},snoozed_until='2099-01-01',alerts_fingerprint='soon:licenses:2026-10-21|soon:licenses:2026-10-21' where id='${pid}'`);
    job=await newJob();const newer={...payload,fingerprint:await reminderFingerprint([a,b]),count:2};
    assert.deepEqual(await freeze(newer),{suppressed:true,reason:'snoozed'});
    await pg.sql(`update profiles set alerts_fingerprint='soon:licenses:2026-10-21' where id='${pid}'`);
    assert.deepEqual(await freeze(newer),newer,'second same-date record was not in the snoozed banner');
    await pg.sql(`update profiles set notify_email=false where id='${pid}'`);
    assert.deepEqual(await freeze(newer),{suppressed:true,reason:'recipient_ineligible'});
    for(const fingerprint of ['',null,'x'.repeat(24),fp+';extra',fp+',broken']){
      const result=await pg.tryRun(`select reminder_queue_payload('${job.id}','${job.lease_token}',${quote({...payload,fingerprint})})`);
      assert.equal(result.ok,false);assert.match(result.err,/Invalid reminder payload/);
    }
    for(const role of ['anon','authenticated']){
      const result=await pg.tryRun(`set role ${role};select reminder_queue_payload('${job.id}','${job.lease_token}',${quote(payload)})`);
      assert.equal(result.ok,false);assert.match(result.err,/permission denied/);
    }
  });
  await t.test('the final migration chain enqueues 1205 eligible members and admits only one paced sender',async()=>{
    await pg.sql(`delete from reminder_email_queue;delete from reminder_email_uncertainty;update reminder_email_drain set lease_token=null,lease_until=null;
      insert into profiles(id,access_status,notify_email,email)
        select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'active',case when n%2=0 then true else null end,'synthetic-'||n||'@example.test' from generate_series(1,1205)n;
      set role service_role;select dispatch_daily_reminders();select dispatch_daily_reminders();reset role;`);
    assert.equal(await pg.sql('select count(*) from reminder_email_queue'),'1205');
    const claims=await Promise.all([pg.rows('select * from reminder_queue_claim(1000)'),pg.rows('select * from reminder_queue_claim(1000)')]);
    assert.deepEqual(claims.map(a=>a.length).sort((a,b)=>a-b),[0,20]);
    const claimed=claims.find(a=>a.length);job=claimed[0];
    const to=await pg.sql(`select email from profiles where id='${job.profile_id}'`);
    const actual={...payload,email:{...payload.email,to:[to]}};
    assert.deepEqual(await freeze(actual),actual);
    await pg.sql(`select reminder_queue_finish('${job.id}','${job.lease_token}','sent');select reminder_queue_release('${job.lease_token}',array[${claimed.slice(1).map(x=>literal(x.id)).join(',')}]::uuid[])`);
    assert.equal(await pg.sql("select count(*) from reminder_email_queue where status='sent'"),'1');
    assert.equal(await pg.sql("select count(*) from reminder_email_queue where status='pending' and attempts=0"),'1204');
  });

});
