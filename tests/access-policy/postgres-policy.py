#!/usr/bin/env python3
"""Exact unapplied migrations in a disposable PostgreSQL17 DB, private socket only."""
import concurrent.futures, hashlib, json, os, subprocess, tempfile
from pathlib import Path
BIN=Path('/opt/homebrew/opt/postgresql@17/bin')
ROOT=Path(__file__).resolve().parents[2]
ENV={k:v for k,v in os.environ.items() if not k.startswith('PG')}
checks=[]
def check(name,truth):
 if not truth: raise AssertionError(name)
 checks.append(name)
with tempfile.TemporaryDirectory(prefix='access-policy-',dir='/private/tmp') as temp:
 root=Path(temp); socket=root/'socket';socket.mkdir()
 def run(*args,**kw):return subprocess.run([str(a) for a in args],text=True,capture_output=True,env=ENV,**kw)
 r=run(BIN/'initdb','-D',root/'data','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8');assert r.returncode==0,r.stderr
 r=run(BIN/'pg_ctl','-D',root/'data','-l',root/'log','-o',f"-k {socket} -p 56429 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off",'-w','start');assert r.returncode==0,r.stderr+(root/'log').read_text()
 def sql(q,ok=True):
  r=run(BIN/'psql','-X','-v','ON_ERROR_STOP=1','-qAt','-h',socket,'-p','56429','-U','postgres','-d','postgres',input=q)
  if ok and r.returncode:raise RuntimeError(r.stderr)
  return r
 def role(q,who='service_role',sub='user_a',ok=True):
  return sql("begin;set local role "+who+";set local request.jwt.claims='"+json.dumps({'role':who,'sub':sub})+"';"+q+';commit;',ok)
 def lit(obj):return "'"+json.dumps(obj,separators=(',',':')).replace("'","''")+"'::jsonb"
 A='10000000-0000-4000-8000-000000000001';B='10000000-0000-4000-8000-000000000002';C='10000000-0000-4000-8000-000000000003'
 def snap(sub='user_a'):return json.loads(role('select public.credentialdo_access_snapshot()','authenticated',sub).stdout)
 def manifest(members):return hashlib.sha256(json.dumps(sorted(members),separators=(',',':')).encode()).hexdigest()
 def seal(members,cid='existing_registered',digest=None,cutoff='2026-09-19T00:00:00Z'):
  return f"select public.seal_lifetime_access_cohort('{cid}','{cutoff}','{digest or manifest(members)}',{lit(members)})"
 try:
  sql("""create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create schema auth;grant usage on schema auth to authenticated,service_role;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(current_setting('request.jwt.claims',true),'{}')::jsonb$$;
   create table profiles(id uuid primary key,auth_user_id text unique,access_status text,founding_number integer,created_at timestamptz default now());
   grant select on profiles to authenticated,service_role;
   create table work_log(id uuid primary key,user_id uuid references profiles(id),note text);
   alter table work_log enable row level security;
   grant select,insert,update,delete on work_log to authenticated;
   create policy owner_rows on work_log for all to authenticated using(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub')) with check(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub'));
  """)
  sql(f"insert into profiles(id,auth_user_id,access_status) values('{A}','user_a','active'),('{B}','user_b','pending'),('{C}','user_c','active')")
  sql((ROOT/'supabase/migrations/20260918_founding_billing_readiness.sql').read_text())
  migration=(ROOT/'supabase/migrations/20260919183000_access_policy_foundation.sql').read_text()
  failed=migration.replace('commit;',"select 1/0;commit;")
  check('injected migration failure rolls back all new objects',sql(failed,False).returncode!=0 and sql("select to_regclass('public.access_grants') is null").stdout.strip()=='t')
  sql(migration);sql(migration);check('exact migration applies twice without changing rollout gate',not snap()['enforcementEnabled'])
  check('disabled gate preserves beta writes',snap()['capabilities']['practice']['write'])
  role(f"insert into work_log values('20000000-0000-4000-8000-000000000001','{A}','saved beta work')",'authenticated')
  for who in ['anon','authenticated']:
   check(who+' cannot seal cohort',role(seal([[A,'user_a']]),who,ok=False).returncode!=0)
   check(who+' cannot write grants',role(f"insert into access_grants values('{A}','user_a',true,'practice','lifetime','forged',now(),null,null)",who,ok=False).returncode!=0)
   check(who+' cannot read cohort membership',role('select * from access_cohort_members',who,ok=False).returncode!=0)
   check(who+' cannot record purchase',role("select record_credential_purchase_trial('{}')",who,ok=False).returncode!=0)
  check('service role cannot forge raw grant rows',role(f"insert into access_grants values('{A}','user_a',true,'practice','lifetime','forged',now(),null,null)",ok=False).returncode!=0)
  members=[[B,'user_b'],[A,'user_a']]
  result=json.loads(role(seal(members)).stdout);check('snapshot grants both scopes to exact registered pair',result['memberCount']==2 and snap()['lifetime']=={'credential':True,'practice':True})
  check('pending registration receives grant without activation',snap('user_b')['lifetime']['practice'] and not snap('user_b')['capabilities']['practice']['read'])
  check('same manifest rerun is idempotent',json.loads(role(seal(members)).stdout)['state']=='existing' and sql('select count(*) from access_grants').stdout.strip()=='4')
  check('sealed cohort cannot expand for later accounts',role(seal(members+[[C,'user_c']]),ok=False).returncode!=0)
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool: cohorts=list(pool.map(lambda _:json.loads(role(seal(members,'concurrent_cohort')).stdout)['state'],range(8)))
  check('concurrent cohort capture seals once without duplicating grants',cohorts.count('sealed')==1 and cohorts.count('existing')==7 and sql('select count(*) from access_grants').stdout.strip()=='4')
  check('nonfinite cohort cutoff is rejected',role(seal(members,'bad_time',cutoff='-infinity'),ok=False).returncode!=0)
  check('changed cutoff is rejected',role(seal(members,cutoff='2026-09-18T00:00:00Z'),ok=False).returncode!=0)
  check('manifest hash must match',role(seal([[C,'user_c']],'bad_hash','a'*64),ok=False).returncode!=0)
  check('duplicate identity rejected',role(seal([[C,'user_c'],[C,'user_c']],'duplicate'),ok=False).returncode!=0)
  check('forged Clerk binding rejected',role(seal([[C,'user_other']],'forged'),ok=False).returncode!=0)
  sql('update access_policy_settings set enforcement_enabled=true')
  check('lifetime retains full writes when enforcement starts',snap()['capabilities']['practice']['write'])
  check('new account has owner read/export but no paid writes',snap('user_c')['capabilities']['practice']=={'read':True,'write':False,'export':True})
  sql(f"update profiles set auth_user_id='user_changed' where id='{A}'")
  check('grant never transfers across Clerk identity relink',not snap('user_changed')['lifetime']['practice'])
  sql(f"update profiles set auth_user_id='user_a',access_status='revoked' where id='{A}'")
  check('revoked account cannot use lifetime access',not snap()['capabilities']['practice']['read'])
  sql(f"update profiles set access_status='active' where id='{A}'")
  # Synthetic settled purchases for C only. No provider call or external charge.
  sql(f"insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('{C}',true,'cus_c'),('{C}',false,'cus_ctest')")
  sql(f"insert into billing_subscriptions values('{C}',true,'sub_c','core','active',true,now()+interval '1 year','evt_c',1,now())")
  times=sql('select to_char(now()-interval \'1 day\',\'YYYY-MM-DD"T"HH24:MI:SS.USOF\'),period_end from billing_subscriptions').stdout.strip().split('|')
  proof={'profileId':C,'clerkSubject':'user_c','livemode':True,'customerId':'cus_c','subscriptionId':'sub_c','invoiceId':'in_c','pricePhase':'founding','annualCents':9900,'paidAt':times[0],'periodEnd':times[1],'policyVersion':'2026-09-19-credential-practice-v1'}
  def record(p):return 'select record_credential_purchase_trial('+lit(p)+')'
  check('paid core has no Practice write before trial is recorded',not snap('user_c')['capabilities']['practice']['write'])
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:outcomes=list(pool.map(lambda _:role(record(proof)).stdout.strip(),range(8)))
  check('concurrent paid deliveries record one receipt and trial',outcomes.count('recorded')==1 and outcomes.count('duplicate')==7)
  active=snap('user_c');check('verified purchase starts 30day Practice access',active['practiceTrial']['state']=='active' and active['capabilities']['practice']['write'] and not active['practiceTrial']['autoCharges'])
  check('strict720hour duration avoids daylight-saving extension',sql(f"select extract(epoch from ends_at-starts_at)=2592000 from access_grants where profile_id='{C}'").stdout.strip()=='t')
  for patch in [{'annualCents':14900},{'clerkSubject':'user_a'},{'customerId':'cus_a'},{'livemode':False},{'paidAt':'infinity'},{'periodEnd':'infinity'},{'annualCents':9900.4},{'invoiceId':None},{'invoiceId':'in_c','subscriptionId':'sub_other'}]:
   check('invalid proof rejected '+str(patch),role(record({**proof,**patch}),ok=False).returncode!=0)
  role(f"insert into work_log values('20000000-0000-4000-8000-000000000003','{C}','trial work')",'authenticated','user_c')
  sql(f"update access_grants set starts_at=now()-interval '31 days',ends_at=now()-interval '1 day' where profile_id='{C}'")
  expired=snap('user_c');check('expiry preserves paid Credential and Practice read/export',expired['capabilities']['credential']['write'] and expired['capabilities']['practice']=={'read':True,'write':False,'export':True})
  check('expired trial cannot insert Practice rows',role(f"insert into work_log values('20000000-0000-4000-8000-000000000004','{C}','new')",'authenticated','user_c',False).returncode!=0)
  role("update work_log set note='changed'",'authenticated','user_c');role('delete from work_log','authenticated','user_c')
  check('expired trial cannot update/delete but still reads original',role('select note from work_log','authenticated','user_c').stdout.strip()=='trial work')
  sql(f"update billing_subscriptions set offer_id='core_locum' where profile_id='{C}' and livemode")
  check('full package retains Practice writes after old trial expires',snap('user_c')['capabilities']['practice']['write'])
  sql(f"update billing_subscriptions set offer_id='core' where profile_id='{C}' and livemode")
  sql(f"insert into billing_subscriptions values('{C}',false,'sub_ctest','core','active',true,'{times[1]}','evt_ctest',1,now())")
  role(record({**proof,'livemode':False,'customerId':'cus_ctest','subscriptionId':'sub_ctest','invoiceId':'in_ctest'}))
  check('valid test-mode trial cannot unlock live entitlement',not snap('user_c')['capabilities']['practice']['write'])
  check('owner read remains isolated',role('select count(*) from work_log','authenticated','user_a').stdout.strip()=='1')
  old_end=expired['practiceTrial']['endsAt'];role(record(proof));check('replay never extends expired trial',snap('user_c')['practiceTrial']['endsAt']==old_end)
  sql(f"update billing_subscriptions set subscription_id='sub_rejoin' where profile_id='{C}' and livemode")
  role(record({**proof,'subscriptionId':'sub_rejoin','invoiceId':'in_rejoin','pricePhase':'standard','annualCents':19900}))
  check('cancel/rejoin cannot reset trial timer',snap('user_c')['practiceTrial']['endsAt']==old_end)
  check('receipts preserve original locked phase rather than rewriting it',sql("select string_agg(price_phase,',' order by invoice_id) from access_purchase_receipts where livemode").stdout.strip()=='founding,standard')
  sql(f"update profiles set auth_user_id='user_newc' where id='{C}'")
  role(record({**proof,'clerkSubject':'user_newc','subscriptionId':'sub_rejoin','invoiceId':'in_newidentity'}),ok=False)
  check('identity relink never restores old trial',snap('user_newc')['practiceTrial']['state']=='none')
  check('migration rerun never switches enforcement back off',sql(migration).returncode==0 and snap()['enforcementEnabled'])
  print(json.dumps({'checks':checks,'count':len(checks),'migrationSHA256':hashlib.sha256(migration.encode()).hexdigest()},indent=2))
 finally:
  r=run(BIN/'pg_ctl','-D',root/'data','-m','fast','-w','stop');assert r.returncode==0,r.stderr
