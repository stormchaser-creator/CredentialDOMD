#!/usr/bin/env python3
"""Additive billing SQL in disposable local PostgreSQL, private socket/no network."""
import concurrent.futures, hashlib, json, os, subprocess, tempfile
from pathlib import Path
BIN=Path('/opt/homebrew/opt/postgresql@17/bin'); ROOT=Path(__file__).resolve().parents[2]
ENV={k:v for k,v in os.environ.items() if not k.startswith('PG')}; checks=[]
def check(name,ok):
 if not ok: raise AssertionError(name)
 checks.append(name)
with tempfile.TemporaryDirectory(prefix='limited-billing-',dir='/private/tmp') as temp:
 root=Path(temp); socket=root/'socket';socket.mkdir()
 def run(*args,**kw):return subprocess.run([str(a) for a in args],text=True,capture_output=True,env=ENV,**kw)
 r=run(BIN/'initdb','-D',root/'data','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8');assert r.returncode==0,r.stderr
 r=run(BIN/'pg_ctl','-D',root/'data','-l',root/'log','-o',f"-k {socket} -p 56430 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off",'-w','start');assert r.returncode==0,r.stderr+(root/'log').read_text()
 def sql(q,ok=True):
  r=run(BIN/'psql','-X','-v','ON_ERROR_STOP=1','-qAt','-h',socket,'-p','56430','-U','postgres','-d','postgres',input=q)
  if ok and r.returncode:raise RuntimeError(r.stderr)
  return r
 def role(q,who='service_role',sub='user_a',ok=True):return sql("begin;set local role "+who+";set local request.jwt.claims='"+json.dumps({'role':who,'sub':sub})+"';"+q+';commit;',ok)
 def lit(o):return "'"+json.dumps(o,separators=(',',':')).replace("'","''")+"'::jsonb"
 A='10000000-0000-4000-8000-000000000001';B='10000000-0000-4000-8000-000000000002';C='10000000-0000-4000-8000-000000000003';D='10000000-0000-4000-8000-000000000004'
 def eligibility(pid=A,subject='user_a',live=True):return json.loads(role(f"select limited_billing_eligibility('{pid}','{subject}',{str(live).lower()})").stdout)
 def bind(pid=A,subject='user_a',hash='a'*64,emails="array['a@example.invalid']",live=True,ok=True):return role(f"select bind_limited_billing_invitation('{pid}','{subject}',{str(live).lower()},'{hash}',{emails})",ok=ok)
 def preview(pid=A,subject='user_a',offer='core'):return json.loads(role(f"select create_limited_billing_preview('{pid}','{subject}',true,'{offer}')").stdout)
 def checkout(v,pid=A,subject='user_a'):return json.loads(role(f"select claim_limited_billing_checkout('{pid}','{subject}',true,'{v['offer_id']}','{v['id']}','{v['consent_hash']}')").stdout)
 def snap(subject='user_a'):return json.loads(role('select credentialdo_access_snapshot()','authenticated',subject).stdout)
 try:
  sql("""create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create schema auth;grant usage on schema auth to authenticated,service_role;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(current_setting('request.jwt.claims',true),'{}')::jsonb$$;
   create table profiles(id uuid primary key,auth_user_id text unique,access_status text,founding_number integer,created_at timestamptz default now(),deleted_at timestamptz);
   grant select on profiles to authenticated,service_role;
   create table work_log(id uuid primary key,user_id uuid references profiles(id),note text);
   create table licenses(id uuid primary key,user_id uuid references profiles(id),note text);
   alter table work_log enable row level security;alter table licenses enable row level security;
   grant select,insert,update,delete on work_log,licenses to authenticated;
   create policy owner_rows on work_log for all to authenticated using(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub')) with check(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub'));
   create policy owner_rows on licenses for all to authenticated using(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub')) with check(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub'));
  """)
  sql(f"insert into profiles(id,auth_user_id,access_status) values('{A}','user_a','pending'),('{B}','user_b','pending'),('{C}','user_c','pending'),('{D}','user_d','active')")
  for file in ['20260918_founding_billing_readiness.sql','20260919183000_access_policy_foundation.sql','20260919213000_limited_launch_billing.sql','20260919233000_limited_paid_purchase_history.sql']:sql((ROOT/'supabase/migrations'/file).read_text())
  sql((ROOT/'supabase/migrations/20260919213000_limited_launch_billing.sql').read_text())
  sql((ROOT/'supabase/migrations/20260919233000_limited_paid_purchase_history.sql').read_text())
  check('migration repeatable and enforcement remains OFF',not snap()['enforcementEnabled'])
  emails=['a@example.invalid'];digest=hashlib.sha256(json.dumps(emails,separators=(',',':')).encode()).hexdigest()
  seal=f"select seal_limited_free_beta_cohort('old_no_card','{digest}',{lit(emails)},'Reviewed earlier opt-in cohort at wording cutover')"
  check('reviewed no-card mailbox cohort is immutable',role(seal).stdout.strip()=='sealed' and role(seal).stdout.strip()=='existing')
  expires=sql("select clock_timestamp()+interval '20 days'").stdout.strip()
  rows=[{'email':'a@example.invalid','tokenHash':'a'*64,'pricePhase':'founding','expiresAt':expires,'reviewReason':'Owner reviewed exact invitation','freeBetaCohortId':'old_no_card'}, {'email':'b@example.invalid','tokenHash':'b'*64,'pricePhase':'earlybird','expiresAt':expires,'reviewReason':'Owner reviewed paid opt-in invitation'}]
  rows.append({'email':'d@example.invalid','tokenHash':'d'*64,'pricePhase':'founding','expiresAt':expires,'reviewReason':'Owner reviewed package-first invitation'})
  prep=f"select prepare_limited_billing_invitations('first_batch',true,{lit(rows)})"
  for who in ['anon','authenticated']:
   check(who+' cannot prepare invitations',role(prep,who,ok=False).returncode!=0)
   check(who+' cannot seal earlier-mailbox cohort',role(seal,who,ok=False).returncode!=0)
   check(who+' cannot read token hashes',role('select * from limited_billing_invitations',who,ok=False).returncode!=0)
   check(who+' cannot read private paid purchase history',role('select * from limited_paid_purchase_history',who,ok=False).returncode!=0)
  check('service cannot directly rewrite paid purchase history',role('delete from limited_paid_purchase_history',ok=False).returncode!=0)
  check('service cannot directly overwrite protected invitations',role("insert into limited_beta_cohorts values('forged','x','reason','[]',now())",ok=False).returncode!=0)
  role(prep)
  check('invitation preparation sends nothing and does not activate account',sql('select count(*) from limited_beta_grants').stdout.strip()=='0' and sql(f"select access_status from profiles where id='{A}'").stdout.strip()=='pending')
  check('database rollout switch also blocks invitation activation',bind(ok=False).returncode!=0)
  sql('update access_policy_settings set limited_invitation_enabled=true,limited_checkout_enabled=true')
  check('token without verified matching mailbox refused',bind(emails="array['wrong@example.invalid']",ok=False).returncode!=0)
  check('matching verified mailbox binds and starts exactly720h beta',bind().stdout.strip()=='bound' and sql('select extract(epoch from ends_at-starts_at) from limited_beta_grants').stdout.strip()=='2592000.000000')
  check('free beta activates pending without billing account/card/subscription',sql(f"select access_status from profiles where id='{A}'").stdout.strip()=='active' and sql('select count(*) from billing_accounts').stdout.strip()=='0')
  before=sql('select ends_at from limited_beta_grants').stdout
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:list(pool.map(lambda _:bind().stdout,range(8)))
  check('concurrent replay never extends beta',sql('select ends_at from limited_beta_grants').stdout==before and sql('select count(*) from limited_beta_grants').stdout.strip()=='1')
  check('another account cannot reuse verified invitation',bind(pid=C,subject='user_c',ok=False).returncode!=0)
  check('test mode cannot claim live invitation',bind(live=False,ok=False).returncode!=0)
  sql('update access_policy_settings set enforcement_enabled=true')
  check('free beta grants both feature scopes',snap()['capabilities']['credential']['write'] and snap()['capabilities']['practice']['write'])
  check('active free beta cannot begin paid checkout',role(f"select create_limited_billing_preview('{A}','user_a',true,'core')",ok=False).returncode!=0 and not snap()['checkoutEligible'])
  role(f"insert into work_log values(gen_random_uuid(),'{A}','practice saved');insert into licenses values(gen_random_uuid(),'{A}','credential saved')",'authenticated')
  sql("update limited_beta_grants set starts_at=now()-interval '31 days',ends_at=now()-interval '1 day'")
  expired=snap();check('beta expiry retains read/export while both writes stop',expired['freeBeta']['state']=='expired' and expired['capabilities']['credential']=={'read':True,'write':False,'export':True} and expired['capabilities']['practice']=={'read':True,'write':False,'export':True})
  for table in ['licenses','work_log']:check('expired beta blocks new '+table,role(f"insert into {table} values(gen_random_uuid(),'{A}','new')",'authenticated',ok=False).returncode!=0)
  bind();check('rebinding expired beta never restarts',snap()['freeBeta']['state']=='expired')
  sql(f"update profiles set auth_user_id='user_changed' where id='{A}'")
  check('identity relink cannot transfer or restart beta',not snap('user_changed')['capabilities']['credential']['write'] and bind(subject='user_changed',ok=False).returncode!=0)
  sql(f"update profiles set auth_user_id='user_a' where id='{A}'")
  bind(pid=B,subject='user_b',hash='b'*64,emails="array['b@example.invalid']")
  check('paid-only invitation does not activate pending account',sql(f"select access_status from profiles where id='{B}'").stdout.strip()=='pending')
  role(f"insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('{A}',true,'cus_A'),('{B}',true,'cus_B')")
  v=preview();check('quote is exact99 with consent hash and deadline',v['annual_cents']==9900 and len(v['consent_hash'])==64 and 'USD 99 due now' in v['consent_text'])
  bundle=preview(offer='core_locum');check('bundle is245 regardless founding eligibility',bundle['annual_cents']==24500)
  c=checkout(v);check('durable checkout pins preview price',c['state']=='claimed' and c['quote']['annual_cents']==9900)
  sql(f"update billing_checkout_attempts set lease_until=clock_timestamp()-interval '1 second' where profile_id='{A}'")
  check('retry reuses one durable attempt',checkout(v)['attempt_id']==c['attempt_id'])
  sql(f"update limited_billing_previews set expires_at=clock_timestamp()-interval '1 second' where id='{v['id']}'")
  check('expired quote requires fresh display/consent',checkout(v)['state']=='quote_expired')
  vb=preview(B,'user_b');cb=checkout(vb,B,'user_b')
  role(f"select pin_limited_billing_price('{cb['attempt_id']}','{B}','user_b',true,'prod_Credential','price_Annual')")
  check('pinned price cannot change',role(f"select pin_limited_billing_price('{cb['attempt_id']}','{B}','user_b',true,'prod_Credential','price_Other')",ok=False).returncode!=0)
  times=sql("select clock_timestamp(),clock_timestamp()+interval '1 year'").stdout.strip().split('|')
  proof={'profileId':B,'clerkSubject':'user_b','livemode':True,'customerId':'cus_B','subscriptionId':'sub_B','invoiceId':'in_B','pricePhase':'earlybird','annualCents':14900,'paidAt':times[0],'periodEnd':times[1],'policyVersion':'2026-09-19-credential-practice-v1','initial':True}
  def claim(event):return json.loads(role(f"select claim_billing_reconcile('{B}',true,'cus_B','{event}')").stdout)
  def settle(event,token,p=proof):
   args={'p_profile_id':B,'p_livemode':True,'p_customer_id':'cus_B','p_subscription_id':'sub_B','p_offer_id':'core','p_status':'active','p_period_end':times[1],'p_event_id':event,'p_event_created':123,'p_reconcile_token':token}
   return f"select settle_limited_billing_subscription({lit(args)},'{cb['attempt_id']}',{lit(p)})"
  lease=claim('evt_B')
  check('bad trial proof rolls back subscription,event and pending activation',role(settle('evt_B',lease['token'],{**proof,'invoiceId':'invalid'}),ok=False).returncode!=0 and sql(f"select access_status from profiles where id='{B}'").stdout.strip()=='pending' and sql('select count(*) from billing_events').stdout.strip()=='0' and sql('select count(*) from billing_subscriptions').stdout.strip()=='0')
  check('verified first payment atomically activates and records Practice trial',role(settle('evt_B',lease['token'])).stdout.strip()=='applied' and snap('user_b')['practiceTrial']['state']=='active' and snap('user_b')['capabilities']['credential']['write'])
  trialend=sql(f"select ends_at from access_grants where profile_id='{B}'").stdout
  check('duplicate settlement never extends paid Practice trial',role(settle('evt_B',lease['token'])).stdout.strip()=='duplicate' and sql(f"select ends_at from access_grants where profile_id='{B}'").stdout==trialend)
  lease=claim('evt_Renewal');role(settle('evt_Renewal',lease['token'],{**proof,'invoiceId':'in_Renewal','initial':False}))
  check('renewal keeps annual locked phase and never starts another trial',sql('select count(*) from access_purchase_receipts').stdout.strip()=='1' and sql(f"select ends_at from access_grants where profile_id='{B}'").stdout==trialend)
  check('new purchase after a consumed promotion quotes standard199',preview(B,'user_b')['annual_cents']==19900)
  bind(pid=D,subject='user_d',hash='d'*64,emails="array['d@example.invalid']")
  role(f"insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('{D}',true,'cus_D')")
  old_promo=preview(D,'user_d','core');vd=preview(D,'user_d','core_locum');cd=checkout(vd,D,'user_d')
  role(f"select pin_limited_billing_price('{cd['attempt_id']}','{D}','user_d',true,'prod_Bundle','price_Bundle')")
  role(f"select save_billing_checkout('{D}',true,'{cd['attempt_id']}','{cd['token']}','cs_D')")
  pd={**proof,'profileId':D,'clerkSubject':'user_d','customerId':'cus_D','subscriptionId':'sub_D','invoiceId':'in_D','pricePhase':'standard','annualCents':24500}
  ld=json.loads(role(f"select claim_billing_reconcile('{D}',true,'cus_D','evt_Dpending')").stdout)
  ad={'p_profile_id':D,'p_livemode':True,'p_customer_id':'cus_D','p_subscription_id':'sub_D','p_offer_id':'core_locum','p_status':'incomplete','p_period_end':times[1],'p_event_id':'evt_Dpending','p_event_created':123,'p_reconcile_token':ld['token']}
  def package_settle(args,payment):return f"select settle_limited_billing_subscription({lit(args)},'{cd['attempt_id']}',{payment})"
  role(package_settle(ad,'null'))
  resume=snap('user_d');check('incomplete subscription exposes only its saved-session resume capability',resume['checkoutResumeAvailable'] and resume['checkoutResumeOfferId']=='core_locum' and not resume['checkoutEligible'])
  ld=json.loads(role(f"select claim_billing_reconcile('{D}',true,'cus_D','evt_D')").stdout)
  ad={**ad,'p_status':'active','p_event_id':'evt_D','p_reconcile_token':ld['token']}
  check('package underpayment cannot settle or create purchase history',role(package_settle(ad,lit({**pd,'annualCents':24400})),ok=False).returncode!=0 and sql(f"select count(*) from limited_paid_purchase_history where profile_id='{D}'").stdout.strip()=='0')
  check('verified package records exact245 purchase without a Core receipt or trial',role(package_settle(ad,lit(pd))).stdout.strip()=='applied' and sql(f"select annual_cents from limited_paid_purchase_history where profile_id='{D}'").stdout.strip()=='24500' and sql(f"select count(*) from access_purchase_receipts where profile_id='{D}'").stdout.strip()=='0' and sql(f"select count(*) from access_grants where profile_id='{D}'").stdout.strip()=='0')
  ld=json.loads(role(f"select claim_billing_reconcile('{D}',true,'cus_D','evt_Dcancel')").stdout)
  role(package_settle({**ad,'p_status':'canceled','p_event_id':'evt_Dcancel','p_reconcile_token':ld['token']},'null'))
  role(f"select close_billing_checkout('{D}',true,'{cd['attempt_id']}','complete')")
  check('unexpired old promotional quote cannot bypass rejoin price',checkout(old_promo,D,'user_d')['state']=='quote_expired' and sql(f"select state from billing_checkout_attempts where profile_id='{D}'").stdout.strip()=='complete')
  check('ended package membership consumes first-purchase eligibility without erasing invite provenance',preview(D,'user_d')['annual_cents']==19900 and eligibility(D,'user_d')['price_phase']=='founding' and sql(f"select count(*) from limited_paid_purchase_history where profile_id='{D}'").stdout.strip()=='1')
  lifetime=[[C,'user_c']]; lifetime_hash=hashlib.sha256(json.dumps(lifetime,separators=(',',':')).encode()).hexdigest()
  role(f"select seal_lifetime_access_cohort('existing_registered',now()-interval '1 day','{lifetime_hash}',{lit(lifetime)})")
  check('more generous lifetime entitlement prevents new paid checkout',eligibility(C,'user_c')['state']=='lifetime_access_already_granted')
  # First ten is a rollout guard, not a public 100/200 scarcity promise.
  many=[{'email':f'x{i}@example.invalid','tokenHash':hashlib.sha256(str(i).encode()).hexdigest(),'pricePhase':'standard','expiresAt':expires,'reviewReason':'Reviewed batch'} for i in range(9)]
  check('initial invitation cap cannot be bypassed with another batch',role(f"select prepare_limited_billing_invitations('second_batch',true,{lit(many)})",ok=False).returncode!=0 and sql('select count(*) from limited_billing_invitations').stdout.strip()=='3')
  print(json.dumps({'count':len(checks),'checks':checks},indent=2))
 finally:
  r=run(BIN/'pg_ctl','-D',root/'data','-m','fast','-w','stop');assert r.returncode==0,r.stderr
