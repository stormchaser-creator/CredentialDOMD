#!/usr/bin/env python3
"""Exact signup migration in disposable PG17, private Unix socket, no TCP/provider."""
import concurrent.futures, hashlib, json, os, subprocess, tempfile
from pathlib import Path
BIN=Path('/opt/homebrew/opt/postgresql@17/bin'); ROOT=Path(__file__).resolve().parents[2]
ENV={k:v for k,v in os.environ.items() if not k.startswith('PG')}; checks=[]
def check(name,ok):
 if not ok:raise AssertionError(name)
 checks.append(name)
def lit(value):return "'"+json.dumps(value,separators=(',',':')).replace("'","''")+"'::jsonb"
def digest(value):return hashlib.sha256(json.dumps(value,separators=(',',':')).encode()).hexdigest()
ids={key:f'10000000-0000-4000-8000-{index:012d}' for index,key in enumerate('abcdefg',1)}
with tempfile.TemporaryDirectory(prefix='signup-test-',dir='/private/tmp') as temp:
 root=Path(temp);sock=root/'socket';sock.mkdir()
 def run(*args,**kw):return subprocess.run([str(a) for a in args],text=True,capture_output=True,env=ENV,**kw)
 r=run(BIN/'initdb','-D',root/'data','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8');assert r.returncode==0,r.stderr
 r=run(BIN/'pg_ctl','-D',root/'data','-l',root/'log','-o',f"-k {sock} -p 56435 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off",'-w','start');assert r.returncode==0,r.stderr+(root/'log').read_text()
 def sql(query,ok=True):
  r=run(BIN/'psql','-X','-v','ON_ERROR_STOP=1','-qAt','-h',sock,'-p','56435','-U','postgres','-d','postgres',input=query)
  if ok and r.returncode:raise RuntimeError(r.stderr)
  return r
 def role(query,who='service_role',subject='user_a',ok=True):return sql('begin;set local role '+who+";set local request.jwt.claims='"+json.dumps({'role':who,'sub':subject})+"';"+query+';commit;',ok)
 def enroll(key,email=None,subject=None,live=True,who='service_role',ok=True):
  r=role(f"select bootstrap_limited_signup('{ids[key]}','{subject or 'user_'+key}',{str(live).lower()},'{email or key+'@example.invalid'}')",who,ok=ok)
  return json.loads(r.stdout) if ok else r
 def snap(key):return json.loads(role('select credentialdo_access_snapshot()','authenticated','user_'+key).stdout)
 try:
  sql("""create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create schema auth;grant usage on schema auth to authenticated,service_role;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(current_setting('request.jwt.claims',true),'{}')::jsonb$$;
   create table profiles(id uuid primary key,auth_user_id text unique,email text,access_status text,founding_number integer,created_at timestamptz default now(),deleted_at timestamptz);
   grant select on profiles to authenticated,service_role;
   create table licenses(id uuid primary key,user_id uuid references profiles(id),note text);alter table licenses enable row level security;
   grant select,insert,update,delete on licenses to authenticated;
   create policy owner_rows on licenses for all to authenticated using(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub')) with check(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub'));
   -- Contract fixture only: the real continuity journal/claim is tested by its
   -- own suite. No client or service role may create these synthetic proofs.
   create table fixture_continuity(profile_id uuid primary key,current_subject text,source_subject text,lifetime boolean default false);
   create function continuity_owns_subject(p_profile uuid,p_current text,p_evidence text) returns boolean language sql security definer as $$
    select exists(select 1 from profiles p where p.id=p_profile and p.auth_user_id=p_current and
      (p_current=p_evidence or exists(select 1 from fixture_continuity c where c.profile_id=p.id and c.current_subject=p_current and c.source_subject=p_evidence))) $$;
   create function continuity_lifetime_source(p_profile uuid,p_current text) returns jsonb language sql security definer as $$
    select jsonb_build_object('profileId',c.profile_id,'sourceKey','clerk-registered-before-20260919','sourceSubject',c.source_subject,'cutoffAt','2026-09-19T15:56:26.238Z')
     from fixture_continuity c join profiles p on p.id=c.profile_id where p.id=p_profile and p.auth_user_id=p_current and c.current_subject=p_current and c.lifetime $$;
   revoke all on function continuity_owns_subject(uuid,text,text),continuity_lifetime_source(uuid,text) from public;
   grant execute on function continuity_owns_subject(uuid,text,text),continuity_lifetime_source(uuid,text) to service_role;
  """)
  for key in 'abcdeg':sql(f"insert into profiles(id,auth_user_id,email,access_status,deleted_at) values('{ids[key]}','user_{key}','untrusted-{key}@example.invalid','{'revoked' if key=='d' else 'pending'}',{'now()' if key=='e' else 'null'})")
  migrations=['20260918_founding_billing_readiness.sql','20260919183000_access_policy_foundation.sql','20260919213000_limited_launch_billing.sql','20260919233000_limited_paid_purchase_history.sql','20260920220000_self_service_signup.sql','20260920221000_continuity_access_evidence.sql']
  for name in migrations:sql((ROOT/'supabase/migrations'/name).read_text())
  for name in migrations[-2:]:sql((ROOT/'supabase/migrations'/name).read_text())
  check('migration reruns leave signup and other gates OFF',enroll('a')['state']=='disabled' and sql('select enforcement_enabled or limited_checkout_enabled or limited_invitation_enabled or limited_self_service_enabled from access_policy_settings').stdout.strip()=='f')
  for who in ['anon','authenticated']:
   check(who+' cannot enroll directly',enroll('a',who=who,ok=False).returncode!=0)
   check(who+' cannot read enrollment mailbox/provenance',role('select * from limited_signup_enrollments',who,ok=False).returncode!=0)
  check('service cannot directly edit signup provenance',role('delete from limited_signup_enrollments',ok=False).returncode!=0)
  sql('update access_policy_settings set limited_self_service_enabled=true,limited_checkout_enabled=true,enforcement_enabled=true')
  a=enroll('a');check('fresh verified account is paid earlybird and stays pending',a['kind']=='paid' and a['price_phase']=='earlybird' and a['access_status']=='pending' and a['free_beta']['state']=='none')
  v=json.loads(role(f"select create_limited_billing_preview('{ids['a']}','user_a',true,'core')").stdout)
  bundle=json.loads(role(f"select create_limited_billing_preview('{ids['a']}','user_a',true,'core_locum')").stdout)
  check('fresh quote is149 and package245 with immutable consent',v['annual_cents']==14900 and bundle['annual_cents']==24500 and len(v['consent_hash'])==64)
  check('bootstrap creates no billing customer or subscription',sql('select (select count(*) from billing_accounts)+(select count(*) from billing_subscriptions)').stdout.strip()=='0')
  emails=['b@example.invalid','g@example.invalid'];role(f"select seal_limited_free_beta_cohort('historical_no_card','{digest(emails)}',{lit(emails)},'Reviewed pre-change opt-in primary mailbox cohort')")
  b=enroll('b');check('sealed historical mailbox starts720h no-card beta and keeps99 phase',b['kind']=='grandfathered_beta' and b['price_phase']=='founding' and b['access_status']=='active' and b['free_beta']['state']=='active' and sql(f"select extract(epoch from ends_at-starts_at) from limited_beta_grants where profile_id='{ids['b']}'").stdout.strip()=='2592000.000000')
  end=b['free_beta']['endsAt']
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(lambda _:enroll('b'),range(8)))
  check('concurrent bootstrap retries never extend beta',all(r['free_beta']['endsAt']==end for r in results) and sql(f"select count(*) from limited_beta_grants where profile_id='{ids['b']}'").stdout.strip()=='1')
  check('grant owner primary mailbox change cannot restart trial',enroll('b','new-primary@example.invalid')['free_beta']['endsAt']==end)
  role(f"insert into licenses values(gen_random_uuid(),'{ids['b']}','saved before expiry')",'authenticated','user_b')
  sql(f"update limited_beta_grants set starts_at=now()-interval '31 days',ends_at=now()-interval '1 day' where profile_id='{ids['b']}'")
  expired=enroll('b');s=snap('b')
  check('expired beta stays expired and preserves read/export only',expired['free_beta']['state']=='expired' and s['capabilities']['credential']=={'read':True,'write':False,'export':True})
  check('expired beta owner can still read saved rows',role('select count(*) from licenses','authenticated','user_b').stdout.strip()=='1')
  check('expired beta owner cannot write new rows',role(f"insert into licenses values(gen_random_uuid(),'{ids['b']}','new')",'authenticated','user_b',ok=False).returncode!=0)
  vb=json.loads(role(f"select create_limited_billing_preview('{ids['b']}','user_b',true,'core')").stdout)
  check('historical beta has explicit paid99 opt-in after expiry',vb['annual_cents']==9900 and 'USD 99 due now' in vb['consent_text'])
  lifetime=[[ids['c'],'user_c']];role(f"select seal_lifetime_access_cohort('registered_accounts',now()-interval '1 day','{digest(lifetime)}',{lit(lifetime)})")
  before=sql('select count(*) from limited_billing_invitations').stdout
  c=enroll('c');check('exact registered lifetime identity activates pending without card/invitation',c['kind']=='lifetime' and c['price_phase'] is None and c['access_status']=='active' and before==sql('select count(*) from limited_billing_invitations').stdout)
  check('lifetime preserves both feature scopes without expiry',snap('c')['lifetime']=={'credential':True,'practice':True})
  check('revoked, deleted, absent and mismatched profiles never enroll',all(enroll(key)['state']=='membership_unavailable' for key in 'def') and enroll('a',subject='user_b')['state']=='membership_unavailable')
  testmode=enroll('g',live=False);check('test-mode beta cannot activate shared live profile',testmode['kind']=='grandfathered_beta' and testmode['access_status']=='pending')
  sql(f"update profiles set auth_user_id='user_relinked' where id='{ids['b']}'")
  check('relink cannot transfer/restart grant without protected continuity proof',enroll('b',subject='user_relinked')['state'] in ('identity_changed','enrollment_unavailable'))
  sql(f"insert into fixture_continuity values('{ids['b']}','user_relinked','user_b',false)")
  moved=enroll('b',subject='user_relinked')
  moved_snapshot=json.loads(role('select credentialdo_access_snapshot()','authenticated','user_relinked').stdout)
  check('bound continuity preserves expired beta, original99 phase and source evidence',moved['free_beta']['endsAt']==expired['free_beta']['endsAt'] and moved['price_phase']=='founding' and moved_snapshot['freeBeta']['state']=='expired' and sql(f"select clerk_subject from limited_beta_grants where profile_id='{ids['b']}'").stdout.strip()=='user_b')
  check('old subject no longer reads profile entitlement',role('select credentialdo_access_snapshot()','authenticated','user_b',ok=False).returncode!=0)
  sql(f"update profiles set auth_user_id='user_b' where id='{ids['b']}'")
  sql(f"delete from fixture_continuity where profile_id='{ids['b']}'")
  legacy='30000000-0000-4000-8000-000000000001'
  sql(f"insert into profiles(id,auth_user_id,access_status) values('{legacy}','user_newprod','pending');insert into fixture_continuity values('{legacy}','user_newprod','user_olddev',true)")
  new_lifetime=json.loads(role(f"select bootstrap_limited_signup('{legacy}','user_newprod',true,'legacy-new-profile@example.invalid')").stdout)
  check('legacy registered account without old profile gets both lifetime scopes from bound proof',new_lifetime['kind']=='lifetime' and new_lifetime['access_status']=='active' and sql(f"select count(*) from access_grants where profile_id='{legacy}' and clerk_subject='user_olddev' and kind='lifetime' and ends_at is null").stdout.strip()=='2')
  legacy_snapshot=json.loads(role('select credentialdo_access_snapshot()','authenticated','user_newprod').stdout)
  check('legacy lifetime alias is readable and cannot enter paid checkout',legacy_snapshot['lifetime']=={'credential':True,'practice':True} and not legacy_snapshot['checkoutEligible'])
  sql(f"update access_grants set revoked_at=now() where profile_id='{legacy}' and scope='practice'")
  denied=json.loads(role(f"select bootstrap_limited_signup('{legacy}','user_newprod',true,'legacy-new-profile@example.invalid')").stdout)
  check('continuity proof cannot resurrect a revoked grant',denied['state']=='enrollment_unavailable' and sql(f"select count(*) from access_grants where profile_id='{legacy}' and revoked_at is not null").stdout.strip()=='1')
  sql(f"update limited_billing_invitations set revoked_at=now() where profile_id='{ids['a']}'")
  check('revoked enrollment is not replaced by fresh self-service grant',enroll('a')['state']=='enrollment_unavailable')
  for index in range(12):
   pid=f'20000000-0000-4000-8000-{index+1:012d}';sql(f"insert into profiles(id,auth_user_id,access_status) values('{pid}','user_public{index}','pending')")
   role(f"select bootstrap_limited_signup('{pid}','user_public{index}',true,'public{index}@example.invalid')")
  check('public paid signup is not limited by manual ten-invitation safeguard',sql("select count(*) from limited_billing_invitations where origin='self_service' and livemode").stdout.strip()=='14')
  expires=sql("select now()+interval '20 days'").stdout.strip()
  rows=[{'email':f'manual{i}@example.invalid','tokenHash':hashlib.sha256(f'manual{i}'.encode()).hexdigest(),'pricePhase':'founding','expiresAt':expires,'reviewReason':'Reviewed explicit manual founder eligibility'} for i in range(10)]
  check('ten reviewed manual invitations remain allowed alongside public enrollments',role(f"select prepare_limited_billing_invitations('manual',true,{lit(rows)})").stdout.strip()=='10')
  row={**rows[0],'email':'manual11@example.invalid','tokenHash':'f'*64}
  check('manual invitation safeguard still rejects eleventh manual row',role(f"select prepare_limited_billing_invitations('manual_more',true,{lit([row])})",ok=False).returncode!=0)
  for name in migrations[-2:]:sql((ROOT/'supabase/migrations'/name).read_text())
  check('rerun preserves deliberate signup enablement and grants',sql('select limited_self_service_enabled from access_policy_settings').stdout.strip()=='t' and snap('c')['lifetime']['credential'])
  print(json.dumps({'count':len(checks),'checks':checks},indent=2))
 finally:
  r=run(BIN/'pg_ctl','-D',root/'data','-m','fast','-w','stop');assert r.returncode==0,r.stderr
