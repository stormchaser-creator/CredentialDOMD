#!/usr/bin/env python3
"""Compile staged migrations against production column/constraint/policy metadata.
Private disposable DB only. Inert cron metadata adapter; no worker or outgoing
notification triggers. Synthetic gift/identity/billing records only.
"""
import argparse,json,os,subprocess,tempfile
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--inventory',required=True);parser.add_argument('--base-packet',required=True);parser.add_argument('--gift-packet');parser.add_argument('--founding',required=True);args=parser.parse_args()
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
 r=run(BIN/'pg_ctl','-D',base/'data','-l',base/'log','-o',f"-k {sock} -p 56439 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off",'-w','start');assert r.returncode==0,r.stderr
 def sql(s):
  r=run(BIN/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','56439','-U','postgres',input='set request.jwt.claims=\'{"role":"service_role"}\';'+s)
  assert r.returncode==0,r.stderr
  return r.stdout
 try:
  sql('\n'.join(parts))
  # Inert pg_cron metadata adapter: exercises reviewed schedule/unschedule SQL
  # without a scheduler worker, extension library, network or outgoing trigger.
  sql("""create schema cron;
   create table cron.job(jobid bigint generated always as identity primary key,jobname text unique not null,schedule text not null,command text not null,database text default current_database(),username text default current_user,active boolean default true);
   create function cron.schedule(p_name text,p_schedule text,p_command text) returns bigint language plpgsql as $$declare result bigint;begin insert into cron.job(jobname,schedule,command) values(p_name,p_schedule,p_command) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid into result;return result;end$$;
   create function cron.unschedule(p_name text) returns boolean language plpgsql as $$begin delete from cron.job where jobname=p_name;return found;end$$;
   insert into pg_catalog.pg_extension(oid,extname,extowner,extnamespace,extrelocatable,extversion) select 3999999999,'pg_cron',oid,'cron'::regnamespace,false,'1.6.4' from pg_roles where rolname=current_user;
   insert into profiles(id,auth_user_id,access_status) values('11111111-1111-4111-8111-111111111111','user_PacketFixture','active');
   insert into storage.buckets(id,name) values('documents','documents');
   insert into storage.objects(bucket_id,name) values('documents','user_PacketFixture/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
   insert into documents(id,user_id,name,mime_type,storage_path,linked_to) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Synthetic Practice PDF','application/pdf','user_PacketFixture/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','invoices:synthetic');
   insert into ai_usage(provider,path) values('gemini','synthetic-preexisting-usage');
  """)
  sql(Path(args.base_packet).read_text())
  migration=(ROOT/'supabase/migrations/20260921010000_admin_lifetime_access.sql').read_text()
  sql(Path(args.gift_packet).read_text() if args.gift_packet else migration);sql(migration)
  passed=0
  def check(label,condition):
   global passed
   assert condition,label
   passed+=1;print('PASS',label)
  def lit(value):return "'"+json.dumps(value,separators=(',',':')).replace("'","''")+"'::jsonb"
  def call(query,who='service_role',ok=True):
   result=run(BIN/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','56439','-U','postgres',input=f'set role {who};set request.jwt.claims=\'{{"role":"{who}"}}\';'+query)
   if ok:assert result.returncode==0,result.stderr
   return result
  def rpc(query):return json.loads(call('select '+query).stdout)
  def target(n,status='pending'):
   pid=f'33333333-3333-4333-8333-{n:012d}'
   sql(f"insert into profiles(id,auth_user_id,name,access_status) values('{pid}','user_Gift{n}','Synthetic Gift {n}','{status}')")
   return pid
  admin=target(1,'active');other=target(2,'active')
  sql(f"insert into app_admins(profile_id,note) values('{admin}','Synthetic authorized admin')")
  def context(pid,live=True,actor=admin,subject=None):
   sub=subject or 'user_Gift'+str(int(pid[-12:]))
   return rpc(f"admin_lifetime_context('{actor}','user_Gift{int(actor[-12:])}','{pid}','{sub}',{str(live).lower()})")
  def proof(c,live=True,age=0):
   now=sql(f"select to_char(clock_timestamp()-interval '{age} seconds','YYYY-MM-DD\"T\"HH24:MI:SS.USOF')").strip()
   return {'checkedAt':now,'customerId':c['accountCustomerId'],'livemode':live,'state':'clear','fingerprint':'f'*64,'reasonCode':None,'billing':{'hasExistingSubscription':False,'status':'none','notice':'Synthetic proof'}}
  def review(pid,live=True):
   c=context(pid,live);p=proof(c,live)
   r=rpc(f"save_admin_lifetime_review('{admin}','user_Gift1',{lit(c)},{str(live).lower()},'synthetic@example.invalid',{lit(p)})")
   assert r['state']=='ready',r
   return r,c,p
  def grant(r,c,p,request=None,email='synthetic@example.invalid',reason='Owner approved a lifetime gift',actor=admin):
   req=request or sql('select gen_random_uuid()').strip()
   result=rpc(f"grant_admin_lifetime_access('{actor}','user_Gift{int(actor[-12:])}','{r['reviewId']}','{req}','{reason}','{email}',{lit(p)})")
   return result,req
  check('base18 plus separate19 leaves all gates OFF and no actual gifts',sql('select not(enforcement_enabled or limited_checkout_enabled or limited_invitation_enabled or limited_self_service_enabled) and (select count(*)=0 from admin_lifetime_audit) from access_policy_settings').strip()=='t')
  for who in ['anon','authenticated']:
   check(who+' cannot invoke protected gift review',call(f"select admin_lifetime_context('{admin}','user_Gift1','{other}','user_Gift2',true)",who,False).returncode!=0)
   check(who+' cannot read review mailboxes or audit',call('select * from admin_lifetime_reviews',who,False).returncode!=0 and call('select * from admin_lifetime_audit',who,False).returncode!=0)
  check('service cannot directly manufacture or edit gift audit',call('delete from admin_lifetime_audit',ok=False).returncode!=0 and call('update access_grants set revoked_at=null',ok=False).returncode!=0)
  check('editable identity labels never authorize a nonadmin',context(other,actor=other)['state']=='admin_required')
  pid=target(3);r,c,p=review(pid);result,req=grant(r,c,p)
  check('normal gift atomically grants both scopes and activates pending live profile',result['state']=='granted' and result['lifetime']=={'credential':True,'practice':True} and sql(f"select access_status from profiles where id='{pid}'").strip()=='active' and sql(f"select count(*) from access_grants where profile_id='{pid}' and kind='lifetime' and ends_at is null").strip()=='2')
  check('gift creates no customer subscription invitation or trial',sql('select (select count(*) from billing_accounts)+(select count(*) from billing_subscriptions)+(select count(*) from limited_billing_invitations)+(select count(*) from access_grants where kind=\'trial\')').strip()=='0')
  again,_=grant(r,c,p,req)
  check('same request retry preserves original receipt and dates',again==result and sql('select count(*) from admin_lifetime_audit').strip()=='1')
  conflict,_=grant(r,c,p,req,reason='Different approved gift reason')
  check('changed request content cannot reuse prior gift consent',conflict['state']=='request_conflict')
  sql(f"insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('{pid}',true,'cus_Gift3')")
  check('a gifted account cannot enter historical or current checkout claim',call(f"select claim_billing_checkout('{pid}',true,'core')",ok=False).returncode!=0)
  pid4=target(4);r4,c4,p4=review(pid4)
  sql(f"delete from app_admins where profile_id='{admin}'")
  check('removed admin membership between review and grant denies',grant(r4,c4,p4)[0]['state']=='admin_required')
  sql(f"insert into app_admins(profile_id) values('{admin}')")
  check('review cannot be used by a different actor',grant(r4,c4,p4,actor=other)[0]['state']=='review_unavailable')
  check('fresh primary mailbox change requires a new review',grant(r4,c4,p4,email='changed@example.invalid')[0]['state']=='identity_changed')
  sql(f"update admin_lifetime_reviews set expires_at=now()-interval '1 second' where id='{r4['reviewId']}'")
  check('expired durable review cannot create access',grant(r4,c4,p4)[0]['state']=='review_expired')
  pid5=target(5);r5,c5,p5=review(pid5)
  sql(f"update profiles set access_status='revoked' where id='{pid5}'")
  check('revoked target never reactivates from a saved review',grant(r5,c5,p5)[0]['state']=='target_unavailable')
  pid6=target(6);r6,c6,p6=review(pid6)
  sql(f"update profiles set auth_user_id='user_Changed6' where id='{pid6}'")
  check('changed target subject never inherits gift review',grant(r6,c6,p6)[0]['state']=='target_unavailable')
  pid7=target(7);r7,c7,p7=review(pid7)
  sql(f"insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('{pid7}',true,'cus_Gift7')")
  check('customer created during provider reads invalidates review',grant(r7,c7,p7)[0]['state']=='review_changed')
  r7,c7,p7=review(pid7)
  rpc(f"claim_billing_checkout('{pid7}',true,'core')")
  check('checkout started during provider reads invalidates review',grant(r7,c7,p7)[0]['state']=='review_changed')
  c7=context(pid7);p7=proof(c7)
  blocked=rpc(f"save_admin_lifetime_review('{admin}','user_Gift1',{lit(c7)},true,'synthetic@example.invalid',{lit(p7)})")
  check('SQL rejects a purported clear provider proof over creating checkout',blocked['state']=='billing_state_unavailable')
  pid8=target(8);r8,c8,p8=review(pid8,False);grant(r8,c8,p8)
  check('sandbox gift cannot activate shared live profile or create live grants',sql(f"select access_status from profiles where id='{pid8}'").strip()=='pending' and sql(f"select count(*) from access_grants where profile_id='{pid8}' and livemode").strip()=='0')
  pid9=target(9)
  sql(f"insert into access_grants values('{pid9}','user_Gift9',true,'credential','lifetime','original-cohort',now(),null,null)")
  r9,c9,p9=review(pid9);grant(r9,c9,p9)
  check('partial grandfathered scope provenance survives additive gift',sql(f"select source_key from access_grants where profile_id='{pid9}' and scope='credential'").strip()=='original-cohort' and sql(f"select count(*) from access_grants where profile_id='{pid9}'").strip()=='2')
  pid10=target(10)
  sql(f"insert into access_grants values('{pid10}','user_Gift10',true,'credential','lifetime','revoked-cohort',now(),null,now())")
  r10,c10,p10=review(pid10)
  check('revoked lifetime cannot be silently resurrected',grant(r10,c10,p10)[0]['state']=='target_unavailable')
  pid11=target(11);r11,c11,p11=review(pid11)
  check('stale provider proof denies',grant(r11,c11,proof(c11,age=61))[0]['state']=='billing_state_unavailable')
  changed={**p11,'fingerprint':'a'*64}
  check('changed Stripe evidence requires renewed consent',grant(r11,c11,changed)[0]['state']=='review_changed')
  sql("create function fail_synthetic_gift_audit() returns trigger language plpgsql as $$begin raise exception 'synthetic audit unavailable';end$$;create trigger fail_synthetic_gift_audit before insert on admin_lifetime_audit for each row execute function fail_synthetic_gift_audit()")
  failure=call(f"select grant_admin_lifetime_access('{admin}','user_Gift1','{r11['reviewId']}','11111111-9999-4999-8999-999999999999','Owner approved a lifetime gift','synthetic@example.invalid',{lit(p11)})",ok=False)
  check('audit failure rolls back both grants and pending activation',failure.returncode!=0 and sql(f"select count(*) from access_grants where profile_id='{pid11}'").strip()=='0' and sql(f"select access_status from profiles where id='{pid11}'").strip()=='pending')
  sql('drop trigger fail_synthetic_gift_audit on admin_lifetime_audit;drop function fail_synthetic_gift_audit()')
  import concurrent.futures
  request=sql('select gen_random_uuid()').strip()
  with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
   results=list(pool.map(lambda _:grant(r11,c11,p11,request)[0],range(6)))
  check('six concurrent retries create one receipt and exactly two scopes',len({v['grantId'] for v in results})==1 and sql(f"select count(*) from admin_lifetime_audit where target_profile_id='{pid11}'").strip()=='1' and sql(f"select count(*) from access_grants where profile_id='{pid11}'").strip()=='2')
  pid12=target(12)
  sql(f"insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('{pid12}',true,'cus_Gift12')")
  r12,c12,p12=review(pid12)
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
   gift=pool.submit(lambda:grant(r12,c12,p12)[0]);checkout=pool.submit(lambda:call(f"select claim_billing_checkout('{pid12}',true,'core')",ok=False))
   g,ch=gift.result(),checkout.result()
  check('gift and new checkout cannot both win a concurrent account-lock race',(g['state']=='granted') != (ch.returncode==0))
  # Exercise freshness after a real profile lock wait, not only a stale input.
  pid13=target(13);r13,c13,p13=review(pid13);p13=proof(c13,age=59)
  holder=subprocess.Popen([str(BIN/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(sock),'-p','56439','-U','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
  holder.stdin.write(f"begin;select 1 from profiles where id='{pid13}' for update;select pg_sleep(2);rollback;");holder.stdin.close()
  assert holder.stdout.readline().strip()=='1'
  waited=grant(r13,c13,p13)[0]
  holder.wait(timeout=5)
  check('provider proof expiring during profile lock wait fails before writes',waited['state']=='billing_state_unavailable' and sql(f"select count(*) from access_grants where profile_id='{pid13}'").strip()=='0')
  pid14=target(14);r14,c14,p14=review(pid14)
  sql(f"insert into account_tombstones(profile_id) values('{pid14}')")
  check('target tombstone denies even while deleted_at remains NULL',grant(r14,c14,p14)[0]['state']=='target_unavailable')
  sql(f"insert into account_tombstones(profile_id) values('{admin}')")
  check('admin tombstone denies even while membership row remains',context(other)['state']=='admin_required')
  sql(f"delete from account_tombstones where profile_id='{admin}'")
  # The normal owner-facing snapshot sees gifted access; the trial ledger stays separate.
  snapshot=json.loads(sql(f"set role authenticated;set request.jwt.claims='{{\"sub\":\"user_Gift11\"}}';select credentialdo_access_snapshot()"))
  check('authoritative entitlement snapshot resolves the gift',snapshot['lifetime']=={'credential':True,'practice':True} and snapshot['practiceTrial']['state']=='none')
  check('profile triggers remain only reviewed identity/founding and no mail trigger',sql("select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='profiles' and not t.tgisinternal and t.tgname not in ('profiles_founding_number','profiles_lock_founding','profiles_lock_identity','profiles_lock_insert','profiles_continuity_insert_lock','profiles_lock_verified_email','access_deleted_document_scopes','access_profile_preferences')").strip()=='0')
  print(f'PASS {passed} admin lifetime SQL checks; exact18 base packet + separate19 on63-table fixture; zero provider/email operations.')
 finally:
  run(BIN/'pg_ctl','-D',base/'data','-m','immediate','-w','stop')
