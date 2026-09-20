#!/usr/bin/env python3
"""Compile staged migrations against production column/constraint/policy metadata.
Private disposable DB only. This excludes data, cron, outbound notification
triggers and unreviewed function bodies. It is not a production restore.
"""
import argparse,json,os,subprocess,tempfile
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--inventory',required=True);parser.add_argument('--continuity',required=True);parser.add_argument('--founding',required=True);args=parser.parse_args()
ROOT=Path(args.root); BIN=Path('/opt/homebrew/opt/postgresql@17/bin')
data={r['section']:r['records'] for r in json.loads(Path(args.inventory).read_text())['rows']}
def q(s):return '"'+s.replace('"','""')+'"'
def fq(s,t):return q(s)+'.'+q(t)
def selected(s,t):return s=='public' or s=='storage' and t in ('buckets','objects')
parts=['create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;',
 'create role supabase_storage_admin nologin;create schema auth;create schema storage;create schema extensions;grant usage on schema auth,storage,extensions to anon,authenticated,service_role;',
 'create type storage.buckettype as enum (\'STANDARD\',\'ANALYTICS\',\'VECTOR\');',
 'create table auth.users(id uuid primary key);',
 "create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;",
 "create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;",
 "create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;",
 'create sequence user_events_id_seq;']
for table in data['tables']:
 s,t=table['schema'],table['table']
 if not selected(s,t):continue
 cols=[]
 for c in data['columns']:
  if c['schema']!=s or c['table']!=t:continue
  default=c['default']; decl=q(c['column'])+' '+c['type']
  # Generated path tokens are reconstructed as a stored expression.
  if c['column']=='path_tokens' and t=='objects':decl+=" generated always as (string_to_array(name, '/')) stored"
  elif default:decl+=' default '+default
  if c['notNull']:decl+=' not null'
  cols.append(decl)
 parts.append('create table '+fq(s,t)+'('+','.join(cols)+');')
 if table['rls']:parts.append('alter table '+fq(s,t)+' enable row level security;')
 if table['forceRls']:parts.append('alter table '+fq(s,t)+' force row level security;')
 # Reproduce observed table grants, not service-role ownership.
 for acl in (table['acl'] or '{}')[1:-1].split(','):
  who,permissions=acl.split('=',1);permissions=permissions.split('/')[0];who=who or 'public'
  if who=='postgres':continue
  names={'a':'insert','r':'select','w':'update','d':'delete','D':'truncate','x':'references','t':'trigger','m':'maintain'}
  grants=[names[c] for c in permissions if c in names]
  if grants:parts.append('grant '+','.join(grants)+' on '+fq(s,t)+' to '+q(who)+';')
constraints=[c for c in data['constraints'] if selected(c['schema'],c['table'])]
for c in sorted(constraints,key=lambda c:c['definition'].startswith('FOREIGN KEY')):
 parts.append('alter table '+fq(c['schema'],c['table'])+' add constraint '+q(c['name'])+' '+c['definition']+';')
con_names={(c['schema'],c['name']) for c in constraints}
for index in data['indexes']:
 if selected(index['schemaname'],index['tablename']) and (index['schemaname'],index['indexname']) not in con_names:parts.append(index['indexdef']+';')
for helper in data['reviewed_helper_definitions']:parts.append(helper['definition']+';')
for p in data['policies']:
 if not selected(p['schemaname'],p['tablename']):continue
 sql='create policy '+q(p['policyname'])+' on '+fq(p['schemaname'],p['tablename'])+' as '+p['permissive']+' for '+p['cmd']+' to '+','.join(q(r) for r in p['roles'])
 if p['qual']:sql+=' using('+p['qual']+')'
 if p['with_check']:sql+=' with check('+p['with_check']+')'
 parts.append(sql+';')
for helper in json.loads(Path(args.founding).read_text())['rows']:parts.append(helper['definition']+';')
# Only reviewed non-outbound identity/founding trigger bodies are restored.
for trigger in data['triggers']:
 if trigger['function'] in ('lock_profile_identity()','lock_profile_founding()','founding_number_on_profile()','founding_number_on_beta_access()'):parts.append(trigger['definition']+';')
env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
with tempfile.TemporaryDirectory(prefix='launch-baseline-',dir='/private/tmp') as temp:
 base=Path(temp);sock=base/'socket';sock.mkdir()
 def run(*cmd,**kw):return subprocess.run([str(c) for c in cmd],text=True,capture_output=True,env=env,**kw)
 r=run(BIN/'initdb','-D',base/'data','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8');assert r.returncode==0,r.stderr
 r=run(BIN/'pg_ctl','-D',base/'data','-l',base/'log','-o',f"-k {sock} -p 56437 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off",'-w','start');assert r.returncode==0,r.stderr
 def sql(s):
  r=run(BIN/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','56437','-U','postgres',input=s)
  assert r.returncode==0,r.stderr
  return r.stdout
 try:
  sql('\n'.join(parts))
  names=['20260915a_lock_profile_insert.sql','20260915b_ticket_attachment_paths.sql','20260915c_ticket_admission.sql','20260915d_verified_mailbox.sql','20260915e_send_reservations.sql','20260915f_ticket_update_and_attribution.sql','20260915g_ai_reservations.sql','20260916b_mailbox_claims.sql','20260916c_ai_spend_holds.sql','20260918a_mailbox_account_events.sql','20260918_founding_billing_readiness.sql','20260919183000_access_policy_foundation.sql','20260919213000_limited_launch_billing.sql','20260919233000_limited_paid_purchase_history.sql']
  for name in names:sql((ROOT/'supabase/migrations'/name).read_text());print('APPLIED',name)
  sql(Path(args.continuity).read_text());print('APPLIED identity continuity')
  for name in ['20260920220000_self_service_signup.sql','20260920221000_continuity_access_evidence.sql','20260920230000_access_write_enforcement.sql']:
   sql((ROOT/'supabase/migrations'/name).read_text());print('APPLIED',name)
  off=sql('select not(enforcement_enabled or limited_checkout_enabled or limited_invitation_enabled or limited_self_service_enabled) from access_policy_settings').strip()
  assert off=='t',off
  # Exercise the actual initializer/journal and actual bootstrap together.
  sql("""insert into profiles(id,auth_user_id,access_status) values('11111111-1111-4111-8111-111111111111','user_LegacyExisting','pending');
   insert into beta_access(email,status,activated_at,profile_id) values('existing@example.invalid','active',now(),'11111111-1111-4111-8111-111111111111');
   insert into storage.buckets(id,name) values('documents','documents');
   insert into storage.objects(bucket_id,name) values('documents','user_LegacyExisting/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
   insert into documents(id,user_id,name,mime_type,storage_path,linked_to) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Synthetic Practice PDF','application/pdf','user_LegacyExisting/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','invoices:example');
   create table synthetic_manifest(value jsonb);
   insert into synthetic_manifest values('[
     ["11111111-1111-4111-8111-111111111111","user_LegacyExisting","existing@example.invalid",1789820000000,1767225600000,true],
     [null,"user_LegacyNoProfile","legacy-new@example.invalid",1789820000000,1767225600000,true],
     [null,"user_Ineligible","excluded@example.invalid",1789820000000,1767225600000,false]
   ]');
   create function synthetic_hash() returns text language sql as $$select encode(sha256(convert_to('['||string_agg(e.value::text,',' order by (e.value->>1) collate "C")||']','UTF8')),'hex') from synthetic_manifest m,jsonb_array_elements(m.value)e$$;
   create function source_proof(sub text,mail text) returns jsonb language sql as $$select jsonb_build_object('subject',sub,'email',mail,'issuer','https://synthetic.clerk.accounts.dev','createdMs',1767225600000,'updatedMs',1789820000000,'checkedAt',clock_timestamp())$$;
   grant select on synthetic_manifest to service_role;
   update access_policy_settings set limited_self_service_enabled=true,limited_checkout_enabled=true,enforcement_enabled=true;
  """)
  def service(expression):
   return json.loads(sql("begin;set local role service_role;set local request.jwt.claims='{\"role\":\"service_role\"}';select "+expression+';commit;').strip())
  runid='99999999-9999-4999-8999-999999999999'
  service(f"stage_clerk_continuity('{runid}','https://synthetic.clerk.accounts.dev','https://clerk.credentialdomd.com','2026-09-19',synthetic_hash(),(select value from synthetic_manifest))")
  sql(f"select set_clerk_continuity_enabled('{runid}',synthetic_hash(),true)")
  def initialize(subject,email,source=None):
   proof='null' if source is None else f"source_proof('{source}','{email}')"
   return service(f"initialize_clerk_profile('{subject}','{email}','https://clerk.credentialdomd.com',1789920000000,clock_timestamp(),{proof})")
  def signup(profile,subject,email):return service(f"bootstrap_limited_signup('{profile}','{subject}',true,'{email}')")
  first=initialize('user_ProdExisting','existing@example.invalid','user_LegacyExisting')
  assert first['state']=='bound' and first['profileId']=='11111111-1111-4111-8111-111111111111',first
  one=signup(first['profileId'],'user_ProdExisting','existing@example.invalid')
  assert one['kind']=='lifetime' and one['access_status']=='active',one
  assert sql("select founding_number from profiles where id='11111111-1111-4111-8111-111111111111'").strip()=='1'
  owned_storage=sql("begin;set local role authenticated;set local request.jwt.claims='{\"sub\":\"user_ProdExisting\",\"iss\":\"https://clerk.credentialdomd.com\"}';update storage.objects set updated_at=now() where name='user_LegacyExisting/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' returning name;commit;").strip()
  assert owned_storage=='user_LegacyExisting/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owned_storage
  new=initialize('user_ProdNoProfile','legacy-new@example.invalid','user_LegacyNoProfile')
  assert new['state']=='bound',new
  new_signup=signup(new['profileId'],'user_ProdNoProfile','legacy-new@example.invalid')
  assert new_signup['kind']=='lifetime' and new_signup['access_status']=='active',new_signup
  assert initialize('user_ProdNoProfile','legacy-new@example.invalid')['profileId']==new['profileId']
  assert sql(f"select count(*) from access_grants where profile_id='{new['profileId']}' and clerk_subject='user_LegacyNoProfile' and ends_at is null").strip()=='2'
  excluded=initialize('user_ProdExcluded','excluded@example.invalid','user_Ineligible')
  excluded_signup=signup(excluded['profileId'],'user_ProdExcluded','excluded@example.invalid')
  assert excluded_signup['kind']=='paid' and excluded_signup['price_phase']=='earlybird',excluded_signup
  fresh=initialize('user_TrueNew','new-paid@example.invalid')
  fresh_signup=signup(fresh['profileId'],'user_TrueNew','new-paid@example.invalid')
  assert fresh['state']=='current' and fresh_signup['kind']=='paid' and fresh_signup['access_status']=='pending',fresh_signup
  beta_hash=sql("select encode(sha256(convert_to('[\"promised@example.invalid\"]','UTF8')),'hex')").strip()
  service(f"to_jsonb(seal_limited_free_beta_cohort('historical_nocard','{beta_hash}','[\"promised@example.invalid\"]'::jsonb,'Synthetic reviewed earlier no-card cohort'))")
  beta=initialize('user_Promised','promised@example.invalid')
  beta_signup=signup(beta['profileId'],'user_Promised','promised@example.invalid')
  assert beta_signup['kind']=='grandfathered_beta' and beta_signup['access_status']=='active' and beta_signup['price_phase']=='founding',beta_signup
  assert signup(beta['profileId'],'user_Promised','promised@example.invalid')['free_beta']['endsAt']==beta_signup['free_beta']['endsAt']
  assert sql('select count(*) from billing_accounts').strip()=='0'
  assert sql(f"select founding_number is null from profiles where id='{fresh['profileId']}'").strip()=='t'
  print('PASS joint actual continuity/bootstrap: existing lifetime, no-profile lifetime, excluded149, fresh149, historical720h99, retry, retained Storage write, founder trigger and no Stripe objects')
  print(json.dumps({'result':'PASS','tables':sum(selected(t['schema'],t['table']) for t in data['tables']),'constraints':len(constraints),'policies':sum(selected(t['schemaname'],t['tablename']) for t in data['policies']),'default_gates_off':True,'limits':'Metadata reconstruction only; no real data, outbound triggers, cron or provider requests.'}))
 finally:
  r=run(BIN/'pg_ctl','-D',base/'data','-m','fast','-w','stop');assert r.returncode==0,r.stderr
