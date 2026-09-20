#!/usr/bin/env python3
"""Actual additive SQL in disposable PostgreSQL17, synthetic rows/private socket.
No network listener, provider calls, credentials, live data, mail, or deployment.
The provider-backed identity-continuity helpers are explicit fixture stubs;
actual latest continuity eligibility/snapshot, billing, access and gift SQL run.
"""
import concurrent.futures, hashlib, json, os, subprocess, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
BIN=Path('/opt/homebrew/opt/postgresql@17/bin')
ENV={k:v for k,v in os.environ.items() if not k.startswith('PG')}
checks=[]
def check(name,value):
 if not value: raise AssertionError(name)
 checks.append(name)
def text(value): return "'"+str(value).replace("'","''")+"'"
def lit(value): return text(json.dumps(value,separators=(',',':')))+'::jsonb'

with tempfile.TemporaryDirectory(prefix='beta-deferred-',dir='/private/tmp') as temp:
 base=Path(temp); sock=base/'socket'; sock.mkdir()
 def run(*args,**kw): return subprocess.run([str(a) for a in args],text=True,capture_output=True,env=ENV,**kw)
 r=run(BIN/'initdb','-D',base/'data','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8'); assert r.returncode==0,r.stderr
 r=run(BIN/'pg_ctl','-D',base/'data','-l',base/'log','-o',f"-k {sock} -p 56441 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off",'-w','start'); assert r.returncode==0,r.stderr
 def sql(statement,ok=True):
  result=run(BIN/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','56441','-U','postgres',input=statement)
  if ok and result.returncode: raise RuntimeError(result.stderr)
  return result
 def service(statement,who='service_role',subject='user_One',ok=True):
  return sql('begin;set local role '+who+';set local request.jwt.claims='+text(json.dumps({'role':who,'sub':subject}))+';'+statement+';commit;',ok)
 def value(statement):
  output=service('select '+statement).stdout.strip()
  return json.loads(output) if output else None
 def pid(n): return f'10000000-0000-4000-8000-{n:012d}'
 def subject(n): return 'user_Test'+str(n)
 def preview(n,offer='core',sub=None,live=True): return value(f"create_limited_billing_preview('{pid(n)}','{sub or subject(n)}',{str(live).lower()},'{offer}')")
 def claim(n,v,sub=None,ok=True):
  r=service(f"select claim_limited_billing_checkout('{pid(n)}','{sub or subject(n)}',{str(v['livemode']).lower()},'{v['offer_id']}','{v['id']}','{v['consent_hash']}')",ok=ok)
  return json.loads(r.stdout) if r.returncode==0 else r
 def snap(n,sub=None): return json.loads(service('select credentialdo_access_snapshot()','authenticated',sub or subject(n)).stdout)
 def seed(n,remaining='1 day',phase='founding',beta=True,account=True,oldsub=None,live=True):
  mode=str(live).lower(); who=oldsub or subject(n)
  sql(f"insert into profiles(id,auth_user_id,access_status) values('{pid(n)}','{subject(n)}','active');")
  if oldsub: sql(f"insert into fixture_continuity values('{pid(n)}','{subject(n)}','{oldsub}')")
  token=hashlib.sha256(str(n).encode()).hexdigest()
  inv=sql(f"insert into limited_billing_invitations(batch_id,email,token_hash,livemode,price_phase,expires_at,profile_id,clerk_subject,claimed_at,review_reason,free_beta_cohort_id) values('synthetic','test{n}@example.invalid','{token}',{mode},'{phase}',now()+interval '1 year','{pid(n)}','{who}',now(),'Synthetic protected fixture',{'null' if not beta else text('synthetic')}) returning id").stdout.strip()
  if beta: sql(f"insert into limited_beta_grants(profile_id,clerk_subject,livemode,invitation_id,starts_at,ends_at) select '{pid(n)}','{who}',{mode},'{inv}',e-interval '720 hours',e from (select clock_timestamp()+interval '{remaining}' e)s")
  if account: service(f"insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('{pid(n)}',{mode},'cus_Test{n}')")
  return inv
 def pin(n,c): service(f"select pin_limited_billing_price('{c['attempt_id']}','{pid(n)}','{subject(n)}',true,'prod_Credential','price_Annual')")
 def save(n,c): service(f"select save_billing_checkout('{pid(n)}',true,'{c['attempt_id']}','{c['token']}','cs_Test{n}')")
 def lease(n,event): return value(f"claim_billing_reconcile('{pid(n)}',true,'cus_Test{n}','{event}')")
 def args(n,c,event,status='active',period=None,cancel=False,subscription=None):
  token=lease(n,event)['token']
  q=c['quote']; anchor=sql(f"select extract(epoch from '{q['billing_start_at']}'::timestamptz)::bigint").stdout.strip() if q['billing_start_at'] else None
  return {'p_profile_id':pid(n),'p_livemode':True,'p_customer_id':f'cus_Test{n}','p_subscription_id':subscription or f'sub_Test{n}','p_offer_id':q['offer_id'],'p_status':status,'p_period_end':period or q['billing_start_at'],'p_event_id':event,'p_event_created':123,'p_reconcile_token':token,'p_cancel_at_period_end':cancel,'p_billing_anchor':int(anchor) if anchor else None}
 def settle(c,a,proof=None,ok=True): return service(f"select settle_limited_billing_subscription({lit(a)},'{c['attempt_id']}',{lit(proof) if proof is not None else 'null'})",ok=ok)
 def release(n,a): service(f"select release_billing_reconcile('{pid(n)}',true,'{a['p_reconcile_token']}')")
 def proof(n,c,a,invoice,initial=True):
  q=c['quote']; paid=sql('select clock_timestamp()').stdout.strip()
  return {'profileId':pid(n),'clerkSubject':subject(n),'livemode':True,'customerId':a['p_customer_id'],'subscriptionId':a['p_subscription_id'],'invoiceId':invoice,'pricePhase':q['price_phase'],'annualCents':q['annual_cents'],'paidAt':paid,'periodEnd':a['p_period_end'],'policyVersion':q['policy_version'],'initial':initial}
 try:
  sql("""create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create schema auth;grant usage on schema auth to authenticated,service_role;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create table profiles(id uuid primary key,auth_user_id text unique,access_status text,founding_number integer,created_at timestamptz default now(),deleted_at timestamptz,name text,email text);
   grant select on profiles to authenticated,service_role;
   create table fixture_continuity(profile_id uuid,current_subject text,evidence_subject text);
   create function continuity_owns_subject(pid uuid,current_subject text,evidence_subject text) returns boolean language sql stable security definer set search_path=public,pg_temp as $$select exists(select 1 from profiles p where p.id=pid and p.auth_user_id=current_subject) and (current_subject=evidence_subject or exists(select 1 from fixture_continuity f where f.profile_id=pid and f.current_subject=$2 and f.evidence_subject=$3))$$;
   create function continuity_lifetime_source(uuid,text) returns jsonb language sql stable as $$select null::jsonb$$;
   create table account_tombstones(profile_id uuid primary key);
   create table app_admins(profile_id uuid primary key);
  """)
  # Reproduce the live direct-default EXECUTE grants and load the actual helper.
  sql('alter default privileges in schema public grant execute on functions to anon,authenticated,service_role')
  mailbox=(ROOT/'supabase/migrations/20260918a_mailbox_account_events.sql').read_text()
  start=mailbox.index('create or replace function public.account_is_closed(p_profile uuid)')
  end=mailbox.index('grant execute on function public.account_is_closed(uuid) to postgres, service_role;',start)+len('grant execute on function public.account_is_closed(uuid) to postgres, service_role;')
  sql(mailbox[start:end])
  original_probe=sql("select pg_get_functiondef('public.account_is_closed(uuid)'::regprocedure)").stdout
  for who in ['anon','authenticated']:
   check(who+' default direct EXECUTE reproduces the pre-fix closure probe',service(f"select account_is_closed('{pid(999)}')",who).stdout.strip()=='f')
  names=['20260918_founding_billing_readiness.sql','20260919183000_access_policy_foundation.sql','20260919213000_limited_launch_billing.sql','20260919233000_limited_paid_purchase_history.sql','20260920220000_self_service_signup.sql','20260920221000_continuity_access_evidence.sql','20260921010000_admin_lifetime_access.sql','20260921015000_restrict_closed_account_probe.sql','20260921020000_beta_deferred_billing.sql']
  for name in names[:-1]: sql((ROOT/'supabase/migrations'/name).read_text())
  for who in ['anon','authenticated']:
   check(who+' cannot directly execute the arbitrary-profile closure probe after hardening',service(f"select account_is_closed('{pid(999)}')",who,ok=False).returncode!=0)
  sql(f"insert into account_tombstones values('{pid(998)}');insert into profiles(id,auth_user_id,access_status,deleted_at) values('{pid(997)}','user_DeletedProbe','revoked',now())")
  check('service retains open, tombstoned and soft-deleted closure checks',service(f"select not account_is_closed('{pid(999)}') and account_is_closed('{pid(998)}') and account_is_closed('{pid(997)}')").stdout.strip()=='t')
  check('closure permission hardening preserves the exact helper body',sql("select pg_get_functiondef('public.account_is_closed(uuid)'::regprocedure)").stdout==original_probe)
  security_catalog="select jsonb_build_object('tables',(select jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'),'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname),'[]'::jsonb) from pg_policies p where schemaname='public'))"
  security_before=sql(security_catalog).stdout
  migration=(ROOT/'supabase/migrations/20260921020000_beta_deferred_billing.sql').read_text()
  sql(migration)
  sql(migration)
  check('existing table grants, RLS switches and policies are unchanged',sql(security_catalog).stdout==security_before)
  check('additive migration repeatable with all four rollout gates still OFF',sql('select not(enforcement_enabled or limited_checkout_enabled or limited_invitation_enabled or limited_self_service_enabled) from access_policy_settings').stdout.strip()=='t')
  sql("insert into limited_beta_cohorts values('synthetic','synthetic','Synthetic fixture','[]',now())")
  seed(1,account=False)
  check('checkout remains disabled before activation',service(f"select create_limited_billing_preview('{pid(1)}','{subject(1)}',true,'core')",ok=False).returncode!=0)
  sql('update access_policy_settings set limited_checkout_enabled=true,enforcement_enabled=true')
  before=sql(f"select ends_at from limited_beta_grants where profile_id='{pid(1)}'").stdout
  v=preview(1)
  check('active protected beta can preview without a billing account or subscription',v['beta_ends_at'] is not None and sql('select count(*) from billing_accounts').stdout.strip()=='0' and sql('select count(*) from billing_subscriptions').stdout.strip()=='0')
  check('preview and snapshot keep exact beta expiry and both original feature scopes',sql(f"select ends_at from limited_beta_grants where profile_id='{pid(1)}'").stdout==before and snap(1)['checkoutEligible'] and snap(1)['capabilities']['credential']['write'] and snap(1)['capabilities']['practice']['write'])
  check('rounded billing anchor is never earlier than original expiry',sql(f"select beta_ends_at<=billing_start_at and billing_start_at-beta_ends_at<interval '1 second' and extract(epoch from billing_start_at)=ceil(extract(epoch from beta_ends_at)) from limited_billing_previews where id='{v['id']}'").stdout.strip()=='t')
  check('deferred consent binds USD0 before exact UTC anchor, annual99, card, late completion and verified-payment Practice start',v['annual_cents']==9900 and 'USD 0 due before ' in v['consent_text'] and 'Z.' in v['consent_text'] and 'A card is required' in v['consent_text'] and 'when Checkout completes if later' in v['consent_text'] and 'first verified payment' in v['consent_text'] and v['consent_version'].endswith('-v2'))
  check('quote deadline cannot outlive original beta',sql(f"select expires_at<=beta_ends_at from limited_billing_previews where id='{v['id']}'").stdout.strip()=='t')
  service(f"insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('{pid(1)}',true,'cus_Test1')")
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool: results=list(pool.map(lambda _:claim(1,v),range(8)))
  won=[r for r in results if r['state']=='claimed']; check('eight concurrent claims produce one attempt and one pinned timing',len(won)==1 and all(r['state'] in ('claimed','busy') for r in results) and sql('select count(*) from limited_billing_quotes').stdout.strip()=='1')
  c=won[0]; pin(1,c); save(1,c)
  retry=claim(1,preview(1)); check('fresh consent preview resumes same open attempt without moving either date',retry['state']=='existing' and retry['attempt_id']==c['attempt_id'] and retry['quote']['billing_start_at']==v['billing_start_at'] and retry['quote']['beta_ends_at']==v['beta_ends_at'])
  for who in ['anon','authenticated']:
   check(who+' cannot invoke private preview/claim/settlement/resume',all(service(s,who,subject(1),ok=False).returncode!=0 for s in [f"select create_limited_billing_preview('{pid(1)}','{subject(1)}',true,'core')",f"select claim_limited_billing_checkout('{pid(1)}','{subject(1)}',true,'core','{v['id']}','{v['consent_hash']}')",f"select settle_limited_billing_subscription('{{}}','{c['attempt_id']}',null)",f"select limited_deferred_checkout_resume('{pid(1)}','{subject(1)}',true,null)"]))
   check(who+' cannot read private quote consent',service('select * from limited_billing_quotes',who,subject(1),ok=False).returncode!=0)
  check('service cannot directly rewrite protected timing',service(f"update limited_billing_quotes set billing_start_at=now() where attempt_id='{c['attempt_id']}'",ok=False).returncode!=0)
  check('paired dates and ceil anchor constraints reject partial or early timestamps',all(sql(s,ok=False).returncode!=0 for s in [f"update limited_billing_previews set beta_ends_at=null where id='{v['id']}'",f"update limited_billing_quotes set billing_start_at=beta_ends_at-interval '1 second' where attempt_id='{c['attempt_id']}'"]))

  a=args(1,c,'evt_Scheduled'); check('unpaid active subscription settles without paid entitlement/history/trial',settle(c,a).stdout.strip()=='applied' and snap(1)['purchasedOfferId'] is None and sql('select count(*) from limited_paid_purchase_history').stdout.strip()=='0' and sql('select count(*) from access_purchase_receipts').stdout.strip()=='0' and sql('select count(*) from access_grants').stdout.strip()=='0')
  scheduled=snap(1)['scheduledMembership']; check('scheduled membership carries original billing date and exact offer',scheduled['status']=='scheduled' and scheduled['startsAt']==v['billing_start_at'] and scheduled['annualCents']==9900 and not scheduled['cancelAtPeriodEnd'] and not scheduled['firstChargeCanceled'] and not snap(1)['checkoutEligible'])
  check('active unpaid scheduled subscription cannot create another attempt',claim(1,preview(1))['state']=='reconciliation_required')
  a=args(1,c,'evt_CancelFirst',cancel=True);settle(c,a)
  check('cancel at initial free-period end explicitly marks first charge stopped',snap(1)['scheduledMembership']['status']=='canceling' and snap(1)['scheduledMembership']['firstChargeCanceled'])
  check('duplicate cancellation event is inert',settle(c,a).stdout.strip()=='duplicate')
  for field,bad in [('p_billing_anchor',0),('p_billing_anchor','123'),('p_cancel_at_period_end','true')]:
   a=args(1,c,'evt_Bad'+str(len(checks))); invalid={**a,field:bad}
   check('invalid '+field+' is rejected atomically '+str(bad),settle(c,invalid,ok=False).returncode!=0 and sql(f"select count(*) from billing_events where event_id='{a['p_event_id']}'").stdout.strip()=='0');release(1,a)
  a=args(1,c,'evt_EarlyPaid',period=sql('select now()+interval \'1 year\'').stdout.strip())
  check('early payment cannot activate or mint a receipt',settle(c,a,proof(1,c,a,'in_Early'),ok=False).returncode!=0 and sql('select count(*) from limited_paid_purchase_history').stdout.strip()=='0');release(1,a)
  a=args(1,c,'evt_ChangedSub',subscription='sub_Wrong')
  check('accepted quote cannot bind a different subscription',settle(c,a,ok=False).returncode!=0);release(1,a)

  seed(2,beta=False,phase='earlybird'); p2=preview(2)
  check('ordinary new signup remains pay now149 with null dates',p2['beta_ends_at'] is None and p2['billing_start_at'] is None and p2['annual_cents']==14900 and 'USD 149 due now' in p2['consent_text'])
  seed(3,remaining='-1 day'); p3=preview(3)
  check('expired historical beta newly previews pay now99 without restarting',p3['billing_start_at'] is None and p3['annual_cents']==9900 and snap(3)['freeBeta']['state']=='expired')
  seed(4); p4=preview(4); sql(f"update limited_beta_grants set revoked_at=now() where profile_id='{pid(4)}'")
  check('revoked beta cannot reuse deferred consent as pay now',claim(4,p4)['state']=='quote_expired')
  seed(5); p5=preview(5); sql(f"update limited_billing_invitations set revoked_at=now() where profile_id='{pid(5)}'")
  check('revoked invitation blocks claim',claim(5,p5)['state']=='invitation_required')
  seed(6); p6=preview(6); sql(f"update profiles set auth_user_id='user_Rebound6' where id='{pid(6)}'")
  check('unprotected identity relink cannot transfer consent',claim(6,p6)['state']=='membership_unavailable')
  seed(7,oldsub='user_Legacy7'); p7=preview(7); c7=claim(7,p7)
  check('protected continuity preserves beta dates but new consent binds current subject',p7['clerk_subject']==subject(7) and c7['state']=='claimed' and snap(7)['freeBeta']['endsAt']==p7['beta_ends_at'] and snap(7)['capabilities']['practice']['write'])
  sql(f"delete from fixture_continuity where profile_id='{pid(7)}'")
  check('removing protected alias blocks subsequent quote use',claim(7,p7)['state']=='invitation_required')
  seed(8); p8=preview(8); sql(f"update limited_billing_previews set expires_at=clock_timestamp()-interval '1 second' where id='{p8['id']}'")
  check('expired preview never creates checkout',claim(8,p8)['state']=='quote_expired' and sql(f"select count(*) from billing_checkout_attempts where profile_id='{pid(8)}'").stdout.strip()=='0')
  seed(9); p9=preview(9); sql(f"update limited_billing_invitations set price_phase='earlybird' where profile_id='{pid(9)}'")
  check('changed current price phase requires new consent',claim(9,p9)['state']=='quote_expired')
  seed(10,live=False); p10=preview(10,live=False)
  check('test-mode beta dates do not grant live capabilities',p10['billing_start_at'] is not None and snap(10)['freeBeta']['state']=='none' and not snap(10)['capabilities']['credential']['write'])

  # Saved, still-open Checkout must remain recoverable under its original terms.
  # Crossing the real clock proves no database fixture rewrites consent or dates.
  seed(12,remaining='2 seconds');p12=preview(12);c12=claim(12,p12);pin(12,c12);save(12,c12)
  seed(13,remaining='2 seconds');p13=preview(13);c13=claim(13,p13);pin(13,c13)
  sql(f"select pg_sleep(greatest(0,extract(epoch from '{p13['billing_start_at']}'::timestamptz-clock_timestamp()))+0.05)")
  resumed=snap(12);v12=preview(12)
  check('expired beta with owned saved Checkout offers resume only and no writes',resumed['checkoutResumeAvailable'] and resumed['checkoutResumeOfferId']=='core' and not resumed['checkoutEligible'] and not resumed['capabilities']['credential']['write'])
  check('resume preview preserves original date, price, consent bytes and hash',all(v12[k]==p12[k] for k in ['beta_ends_at','billing_start_at','price_phase','annual_cents','consent_version','consent_text','consent_hash']) and sql(f"select expires_at>clock_timestamp() from limited_billing_previews where id='{v12['id']}'").stdout.strip()=='t')
  with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: recovered=list(pool.map(lambda _:claim(12,v12),range(4)))
  check('concurrent past-anchor resumes return exactly the original session without new attempt',all(r['state']=='existing' and r['attempt_id']==c12['attempt_id'] and r['session_id']=='cs_Test12' for r in recovered) and sql(f"select count(*) from limited_billing_quotes where profile_id='{pid(12)}'").stdout.strip()=='1')
  check('foreign subject or profile cannot resume another account session',claim(12,v12,sub='user_Foreign')['state']=='membership_unavailable' and claim(2,v12)['state']=='quote_expired' and value(f"limited_deferred_checkout_resume('{pid(12)}','user_Foreign',true,null)") is None)
  check('resume cannot switch offer under original consent',claim(12,preview(12,'core_locum'))['state']=='offer_conflict')
  a=args(12,c12,'evt_Incomplete',status='incomplete');settle(c12,a)
  check('exact bound incomplete subscription can resume its original session after anchor',claim(12,preview(12))['state']=='existing')
  incomplete12=snap(12)
  check('resumable incomplete Checkout never also advertises a scheduled membership',incomplete12['checkoutResumeAvailable'] and incomplete12['checkoutResumeOfferId']=='core' and incomplete12['scheduledMembership'] is None and not incomplete12['checkoutEligible'])
  sql(f"update billing_subscriptions set subscription_id='sub_Unknown12' where profile_id='{pid(12)}'")
  check('unrelated incomplete subscription cannot inherit deferred resume proof',value(f"limited_deferred_checkout_resume('{pid(12)}','{subject(12)}',true,null)") is None and not snap(12)['checkoutResumeAvailable'] and claim(12,v12)['state']=='quote_expired')
  sql(f"update billing_subscriptions set subscription_id='sub_Test12' where profile_id='{pid(12)}'")
  sql(f"update limited_beta_grants set revoked_at=now() where profile_id='{pid(12)}'")
  check('revoked beta removes saved deferred resume capability',value(f"limited_deferred_checkout_resume('{pid(12)}','{subject(12)}',true,null)") is None and claim(12,v12)['state']=='quote_expired')
  sql(f"update limited_beta_grants set revoked_at=null where profile_id='{pid(12)}'")
  a=args(12,c12,'evt_IncompleteExpired',status='incomplete_expired');settle(c12,a)
  service(f"select close_billing_checkout('{pid(12)}',true,'{c12['attempt_id']}','expired')")
  check('provider-confirmed expired Checkout cannot create from stale deferred resume consent',claim(12,v12)['state']=='quote_expired')
  fresh12=preview(12);new12=claim(12,fresh12)
  check('after exact expired attempt closure fresh pay-now consent creates a distinct attempt',fresh12['billing_start_at'] is None and new12['state']=='claimed' and new12['attempt_id']!=c12['attempt_id'])
  unsaved=claim(13,preview(13))
  check('uncertain unsaved creation after beta expiry never returns a new usable quote',not snap(13)['checkoutResumeAvailable'] and unsaved['state'] in ('busy','offer_conflict','reconciliation_required') and sql(f"select count(*) from limited_billing_quotes where profile_id='{pid(13)}'").stdout.strip()=='1')

  # A bounded real clock crossing, instead of rewriting accepted beta/quote dates.
  seed(11,remaining='1.2 seconds'); p11=preview(11); c11=claim(11,p11);pin(11,c11);save(11,c11)
  a=args(11,c11,'evt_Waiting');settle(c11,a)
  original=sql(f"select ends_at from limited_beta_grants where profile_id='{pid(11)}'").stdout
  sql(f"select pg_sleep(greatest(0,extract(epoch from '{p11['billing_start_at']}'::timestamptz-clock_timestamp()))+0.05)")
  check('crossing beta expiry rejects old consent without changing original dates',claim(11,p11)['state']=='quote_expired' and sql(f"select ends_at from limited_beta_grants where profile_id='{pid(11)}'").stdout==original)
  pending=snap(11)
  check('unpaid active after beta expiry stays payment_pending with read/export and no writes',pending['scheduledMembership']['status']=='payment_pending' and pending['freeBeta']['state']=='expired' and pending['capabilities']['credential']=={'read':True,'write':False,'export':True} and pending['capabilities']['practice']=={'read':True,'write':False,'export':True})
  yearend=sql(f"select '{p11['billing_start_at']}'::timestamptz+interval '1 year'").stdout.strip()
  a=args(11,c11,'evt_FailedFirst',status='past_due',period=yearend,cancel=True);settle(c11,a)
  check('failed first invoice plus next-year cancellation never claims first charge canceled',snap(11)['scheduledMembership']['status']=='canceling' and not snap(11)['scheduledMembership']['firstChargeCanceled'] and not snap(11)['capabilities']['credential']['write'])
  a=args(11,c11,'evt_FirstPaid',period=yearend); paid=proof(11,c11,a,'in_FirstPaid')
  check('first actual payment grants paid Credential and one Practice trial atomically',settle(c11,a,paid).stdout.strip()=='applied' and snap(11)['scheduledMembership'] is None and snap(11)['purchasedOfferId']=='core' and snap(11)['practiceTrial']['state']=='active')
  trial=sql(f"select starts_at,ends_at,extract(epoch from ends_at-starts_at) from access_grants where profile_id='{pid(11)}' and kind='trial'").stdout.strip()
  check('Practice trial starts at verified payment and lasts720h, not opt-in or original beta start',sql(f"select starts_at={text(paid['paidAt'])}::timestamptz and ends_at=starts_at+interval '720 hours' from access_grants where profile_id='{pid(11)}' and kind='trial'").stdout.strip()=='t')
  check('duplicate first invoice cannot extend Practice trial',settle(c11,a,paid).stdout.strip()=='duplicate' and sql(f"select starts_at,ends_at,extract(epoch from ends_at-starts_at) from access_grants where profile_id='{pid(11)}' and kind='trial'").stdout.strip()==trial)
  a=args(11,c11,'evt_SubsequentPaid',period=sql(f"select '{yearend}'::timestamptz+interval '1 year'").stdout.strip());settle(c11,a,proof(11,c11,a,'in_Subsequent',False))
  check('subsequent verified invoice retains first receipt and never creates another Practice trial',sql(f"select count(*) from access_purchase_receipts where profile_id='{pid(11)}'").stdout.strip()=='1' and sql(f"select starts_at,ends_at,extract(epoch from ends_at-starts_at) from access_grants where profile_id='{pid(11)}' and kind='trial'").stdout.strip()==trial)
  a=args(11,c11,'evt_Canceled',status='canceled',period=yearend,cancel=False);settle(c11,a)
  check('terminal cancellation removes schedule and ended paid subscription requires standard199 rejoin',snap(11)['scheduledMembership'] is None and preview(11)['annual_cents']==19900)
  # Install a synthetic newer current subscription, then replay an older terminal event.
  sql(f"update billing_subscriptions set subscription_id='sub_Newer11',status='active',cancel_at_period_end=false where profile_id='{pid(11)}'")
  a=args(11,c11,'evt_HistoricalTerminal',status='canceled',period=yearend,cancel=True);settle(c11,a)
  check('historical terminal event cannot overwrite current cancellation flag',sql(f"select subscription_id='sub_Newer11' and not cancel_at_period_end from billing_subscriptions where profile_id='{pid(11)}'").stdout.strip()=='t')
  print(json.dumps({'result':'PASS','count':len(checks),'migrationSHA256':hashlib.sha256(migration.encode()).hexdigest(),'checks':checks,'limits':'Synthetic private PostgreSQL only. Identity-continuity helpers are stubs; actual account-closure/billing/access/eligibility/snapshot SQL. No Stripe or live-provider behavior asserted.'},indent=2))
 finally:
  r=run(BIN/'pg_ctl','-D',base/'data','-m','fast','-w','stop');assert r.returncode==0,r.stderr
