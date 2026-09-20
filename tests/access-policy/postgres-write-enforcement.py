#!/usr/bin/env python3
"""Exact new migration on a synthetic schema, PostgreSQL17/private socket only.

No provider configuration or production database is read. Continuity's sealed
relation is a contract fixture here; the combined integration suite must also
apply the separately owned real identity migration.
"""
import hashlib, json, os, subprocess, tempfile
from pathlib import Path
BIN=Path('/opt/homebrew/opt/postgresql@17/bin')
ROOT=Path(__file__).resolve().parents[2]
ENV={k:v for k,v in os.environ.items() if not k.startswith('PG')}
MIGRATION=ROOT/'supabase/migrations/20260920230000_access_write_enforcement.sql'
checks=[]
def check(name,truth):
    if not truth: raise AssertionError(name)
    checks.append(name)
A='10000000-0000-4000-8000-000000000001'
B='10000000-0000-4000-8000-000000000002'
C='10000000-0000-4000-8000-000000000003'
D='10000000-0000-4000-8000-000000000004'
DOC='20000000-0000-4000-8000-000000000001'
NEW='20000000-0000-4000-8000-000000000002'
ALIAS='20000000-0000-4000-8000-000000000003'
COLLECTIONS=['screenings','follow_ups','professional_photos','publications','travel_docs','professional_memberships','peer_references','document_requests','share_log','notification_log','alert_acks']
with tempfile.TemporaryDirectory(prefix='write-enforcement-',dir='/private/tmp') as temp:
    root=Path(temp); socket=root/'socket'; socket.mkdir()
    def run(*args,**kw): return subprocess.run([str(x) for x in args],text=True,capture_output=True,env=ENV,**kw)
    r=run(BIN/'initdb','-D',root/'data','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8'); assert r.returncode==0,r.stderr
    r=run(BIN/'pg_ctl','-D',root/'data','-l',root/'log','-o',f"-k {socket} -p 56431 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off",'-w','start'); assert r.returncode==0,r.stderr
    def sql(q,ok=True):
        r=run(BIN/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-p','56431','-U','postgres','-d','postgres',input=q)
        if ok and r.returncode: raise RuntimeError(r.stderr)
        return r
    def role(q,who='authenticated',sub='user_a',ok=True,claim_role=None):
        claims={'sub':sub}
        if claim_role is not None: claims['role']=claim_role
        return sql("begin;set local role "+who+";set local request.jwt.claims='"+json.dumps(claims)+"';"+q+';commit;',ok)
    def denied(name,q,who='authenticated',sub='user_b',claim_role=None):
        check(name,role(q,who,sub,False,claim_role).returncode!=0)
    def snapshot(pid,sub):
        return json.loads(role(f"select credentialdo_service_write_snapshot('{pid}','{sub}')",'service_role',sub).stdout)
    def paths(sub='user_a',doc=DOC): return f'{sub}/{doc}'
    try:
        sql("""create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
        create schema auth;create schema storage;grant usage on schema auth,storage to authenticated,service_role;
        create function auth.jwt() returns jsonb language sql stable as $$select coalesce(current_setting('request.jwt.claims',true),'{}')::jsonb$$;
        create table profiles(id uuid primary key,auth_user_id text unique,access_status text,deleted_at timestamptz,name text,theme text,tax_prep jsonb,setup_state jsonb);
        grant select,insert,update,delete on profiles to authenticated,service_role;
        alter table profiles enable row level security;
        create policy owner_rows on profiles for all to authenticated using(auth_user_id=auth.jwt()->>'sub') with check(auth_user_id=auth.jwt()->>'sub');
        create table access_policy_settings(singleton boolean primary key,enforcement_enabled boolean);
        insert into access_policy_settings values(true,false);
        create table access_grants(profile_id uuid,clerk_subject text,livemode boolean,scope text,kind text,starts_at timestamptz,ends_at timestamptz,revoked_at timestamptz);
        create table limited_beta_grants(profile_id uuid,clerk_subject text,livemode boolean,starts_at timestamptz,ends_at timestamptz,revoked_at timestamptz);
        create table billing_subscriptions(profile_id uuid,livemode boolean,status text,membership_active boolean,period_end timestamptz,offer_id text);
        create table test_continuity(profile_id uuid,current_subject text,evidence_subject text);
        create function continuity_owns_subject(p uuid,c text,e text) returns boolean language sql stable security definer as $$select c=e or exists(select 1 from test_continuity where profile_id=p and current_subject=c and evidence_subject=e)$$;
        revoke all on function continuity_owns_subject(uuid,text,text) from public;
        grant execute on function continuity_owns_subject(uuid,text,text) to service_role;
        create table documents(id uuid primary key,user_id uuid references profiles(id) on delete cascade,storage_path text not null,linked_to text,note text);
        alter table documents enable row level security;
        grant all on documents to authenticated,service_role;
        create policy documents_owner on documents for all to authenticated using(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub')) with check(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub'));
        create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,content text,unique(bucket_id,name));
        alter table storage.objects enable row level security;
        grant all on storage.objects to authenticated,service_role;
        create policy documents_owner on storage.objects for all to authenticated using(bucket_id='documents' and split_part(name,'/',1)=auth.jwt()->>'sub') with check(bucket_id='documents' and split_part(name,'/',1)=auth.jwt()->>'sub');
        create policy ticket_support on storage.objects for all to authenticated using(bucket_id='documents' and split_part(name,'/',1)='tickets' and split_part(name,'/',2)=auth.jwt()->>'sub') with check(bucket_id='documents' and split_part(name,'/',1)='tickets' and split_part(name,'/',2)=auth.jwt()->>'sub');
        """)
        for table in COLLECTIONS:
            sql(f"""create table {table}(id uuid primary key default gen_random_uuid(),user_id uuid references profiles(id) on delete cascade,note text);
            alter table {table} enable row level security;grant all on {table} to authenticated,service_role;
            create policy owner_rows on {table} for all to authenticated using(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub')) with check(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub'));""")
        sql(f"insert into profiles(id,auth_user_id,access_status,name) values('{A}','user_a','active','A'),('{B}','user_b','active','B'),('{C}','user_c','active','C'),('{D}','user_d','pending','D')")
        sql(f"insert into billing_subscriptions values('{A}',true,'active',true,now()+interval '1 year','core')")
        sql(f"insert into limited_beta_grants values('{B}','user_b',true,now()-interval '31 days',now()-interval '1 day',null)")
        sql(f"insert into access_grants select '{C}','user_historical',true,s,'lifetime',now()-interval '1 year',null,null from unnest(array['credential','practice']) s")
        sql(f"insert into test_continuity values('{C}','user_c','user_historical')")
        sql(f"insert into documents values('{DOC}','{A}','{paths()}','locumContracts:old','original');insert into storage.objects(bucket_id,name,content) values('documents','{paths()}','original')")
        sql(f"insert into document_requests(user_id,note) values('{B}','existing export request')")
        before=sql("select jsonb_agg(row_to_json(p) order by schemaname,tablename,policyname) from pg_policies p where cmd in ('SELECT','DELETE','ALL')").stdout
        migration=MIGRATION.read_text(); sql(migration); sql(migration)
        after=sql("select jsonb_agg(row_to_json(p) order by schemaname,tablename,policyname) from pg_policies p where cmd in ('SELECT','DELETE','ALL')").stdout
        check('migration reruns preserve all existing read/delete/ownership policies',before==after)
        check('migration never enables enforcement',not snapshot(B,'user_b')['enforcementEnabled'])
        role(f"insert into screenings(user_id,note) values('{B}','off permits');update profiles set name='B off' where id='{B}'",sub='user_b')
        role(f"insert into peer_references(user_id,note) values('{B}','off intake')",'service_role','user_b')
        check('OFF admits browser and service behavior',sql("select count(*) from peer_references").stdout.strip()=='1')
        sql('update access_policy_settings set enforcement_enabled=true')
        check('Core permits Credential only',snapshot(A,'user_a')=={'enforcementEnabled':True,'credential':True,'practice':False})
        check('expired beta denies both writes',snapshot(B,'user_b')=={'enforcementEnabled':True,'credential':False,'practice':False})
        check('sealed historical subject retains both lifetime scopes',snapshot(C,'user_c')=={'enforcementEnabled':True,'credential':True,'practice':True})
        denied('current profile binding cannot be supplied as old subject',f"select credentialdo_service_write_snapshot('{C}','user_historical')",'service_role','user_c')
        for who in ['anon','authenticated']:
            denied(who+' cannot call privileged snapshot',f"select credentialdo_service_write_snapshot('{B}','user_b')",who)
        for who in ['anon','authenticated','service_role']:
            denied(who+' cannot forge path marker',f"insert into access_document_practice_paths values('{B}','user_b/forged')",who)
        for table in COLLECTIONS[:6]:
            denied('expired beta cannot insert '+table,f"insert into {table}(user_id,note) values('{B}','new')")
        for table in ['peer_references','document_requests']:
            denied('service intake cannot insert '+table,f"insert into {table}(user_id,note) values('{B}','new')",'service_role')
        for table in ['share_log','notification_log','alert_acks']:
            role(f"insert into {table}(user_id,note) values('{B}','read/export bookkeeping')",sub='user_b')
        check('export/notification/ack bookkeeping stays usable',sql('select (select count(*) from share_log)+(select count(*) from notification_log)+(select count(*) from alert_acks)').stdout.strip()=='3')
        role(f"update document_requests set note='export completed' where user_id='{B}'",'service_role','user_b')
        check('existing request export/status update remains usable',sql('select note from document_requests').stdout.strip()=='export completed')
        role(f"update profiles set theme='dark',setup_state='{{\"read\":true}}' where id='{B}'",sub='user_b')
        denied('no-role Clerk JWT cannot bypass substantive profile guard',f"update profiles set name='bypass' where id='{B}'")
        denied('forged JWT role cannot bypass actual database role',f"update profiles set name='bypass' where id='{B}'",claim_role='service_role')
        role(f"update profiles set name='A revised' where id='{A}'")
        denied('Core cannot change Practice tax settings',f"update profiles set tax_prep='{{}}' where id='{A}'",sub='user_a')
        role(f"insert into profiles(id,auth_user_id,access_status) values('10000000-0000-4000-8000-000000000005','user_new','pending')",sub='user_new')
        check('new pending signup profile INSERT requires no entitlement',sql("select count(*) from profiles where auth_user_id='user_new'").stdout.strip()=='1')
        role(f"update profiles set access_status='active' where id='{D}'",'service_role','user_d')
        check('trusted activation remains available',sql(f"select access_status from profiles where id='{D}'").stdout.strip()=='active')
        role(f"update documents set linked_to=null where id='{DOC}'")
        check('old Practice scope blocks Core metadata relabel',sql(f"select linked_to from documents where id='{DOC}'").stdout.strip()=='locumContracts:old')
        role(f"delete from documents where id='{DOC}'")
        check('metadata DELETE preserves private Practice path marker',sql(f"select count(*) from access_document_practice_paths where profile_id='{A}'").stdout.strip()=='1')
        denied('delete then same-ID Credential metadata cannot erase Practice scope',f"insert into documents values('{DOC}','{A}','{paths()}',null,'alias')",sub='user_a')
        role(f"update storage.objects set content='overwrite' where name='{paths()}'")
        check('deleted metadata cannot unlock old Practice bytes',sql(f"select content from storage.objects where name='{paths()}'").stdout.strip()=='original')
        denied('service object overwrite also sees retained Practice marker',f"update storage.objects set content='overwrite' where name='{paths()}'",'service_role','user_a')
        role(f"delete from storage.objects where name='{paths()}'",'service_role','user_a')
        check('service object DELETE remains allowed',sql(f"select count(*) from storage.objects where name='{paths()}'").stdout.strip()=='0')
        role(f"insert into storage.objects(bucket_id,name,content) values('documents','{paths(doc=NEW)}','new Credential bytes')")
        role(f"insert into documents values('{NEW}','{A}','{paths(doc=NEW)}',null,'new Credential metadata')")
        denied('new metadata cannot point at a different document object',f"insert into documents values('{ALIAS}','{A}','{paths(doc=NEW)}',null,'alias')",sub='user_a')
        sql(f"insert into documents values('{ALIAS}','{B}','{paths(doc=NEW)}',null,'historical foreign alias')")
        check('every matching alias is checked, including foreign owner',role(f"select credentialdo_own_storage_write_allowed('documents','{paths(doc=NEW)}')").stdout.strip()=='f')
        sql(f"delete from documents where id='{ALIAS}'")
        denied('expired beta cannot upload bytes',f"insert into storage.objects(bucket_id,name) values('documents','user_b/{NEW}')")
        denied('service upload needs same entitlement',f"insert into storage.objects(bucket_id,name) values('documents','user_b/{NEW}')",'service_role')
        role("insert into storage.objects(bucket_id,name) values('documents','tickets/user_b/support-file')",sub='user_b')
        check('expired account can still attach to support ticket',sql("select count(*) from storage.objects where name like 'tickets/%'").stdout.strip()=='1')
        check('saved rows remain readable',role('select count(*) from screenings',sub='user_b').stdout.strip()=='1')
        role(f"delete from peer_references where user_id='{B}';update profiles set deleted_at=now() where id='{B}'",'service_role','user_b')
        denied('deleted profile cannot obtain service snapshot',f"select credentialdo_service_write_snapshot('{B}','user_b')",'service_role')
        role(f"delete from profiles where id='{A}'",'service_role','user_a')
        check('whole-account deletion cascades retained markers',sql(f"select count(*) from access_document_practice_paths where profile_id='{A}'").stdout.strip()=='0')
        sql(migration)
        check('rerun never turns enforcement back off',snapshot(C,'user_c')['enforcementEnabled'])
        # Production currently has NOT NULL. This variant proves the trigger
        # also preserves metadata-only callers if a schema permits them.
        sql('alter table documents alter column storage_path drop not null')
        role(f"insert into documents values('{ALIAS}','{C}',null,'locumContracts:metadata','metadata only')",'service_role','user_c')
        role(f"update documents set note='partial update' where id='{ALIAS}'",'service_role','user_c')
        check('nullable-schema metadata-only Practice insert/update retain canonical provenance',sql(f"select count(*) from access_document_practice_paths where storage_path='user_c/{ALIAS}'").stdout.strip()=='1')
        denied('metadata-only path assignment still rejects aliases',f"update documents set storage_path='user_c/{NEW}' where id='{ALIAS}'",'service_role','user_c')
        role(f"delete from documents where id='{ALIAS}'",'service_role','user_c')
        role(f"insert into documents values('{DOC}','{C}','{paths('user_c')}','locumContracts:active','Practice lifetime')",'service_role','user_c')
        check('lifetime service Practice document records durable path',sql(f"select count(*) from access_document_practice_paths where profile_id='{C}'").stdout.strip()=='2')
        role(f"update profiles set deleted_at=now() where id='{C}'",'service_role','user_c')
        check('service tombstone clears retained markers',sql(f"select count(*) from access_document_practice_paths where profile_id='{C}'").stdout.strip()=='0')
        sql(migration)
        check('migration rerun cannot restore markers for a tombstone',sql(f"select count(*) from access_document_practice_paths where profile_id='{C}'").stdout.strip()=='0')
        role(f"delete from documents where user_id='{C}'",'service_role','user_c')
        check('cleanup retry after tombstone cannot recreate markers',sql(f"select count(*) from access_document_practice_paths where profile_id='{C}'").stdout.strip()=='0')
        print(json.dumps({'checks':checks,'count':len(checks),'migrationSHA256':hashlib.sha256(migration.encode()).hexdigest(),'continuity':'contract fixture; real identity migration tested separately'},indent=2))
    finally:
        r=run(BIN/'pg_ctl','-D',root/'data','-m','fast','-w','stop'); assert r.returncode==0,r.stderr
