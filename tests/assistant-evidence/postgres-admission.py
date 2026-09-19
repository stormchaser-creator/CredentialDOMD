#!/usr/bin/env python3
"""Exact migration, disposable PostgreSQL 17; private socket, no TCP or live DB."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

BIN = Path('/opt/homebrew/opt/postgresql@17/bin')
MIGRATION = Path(__file__).resolve().parents[2] / 'supabase/migrations/20260919193000_vera_source_admission.sql'
ENV = {k:v for k,v in os.environ.items() if not k.startswith('PG')}
A='10000000-0000-4000-8000-000000000001'
B='10000000-0000-4000-8000-000000000002'
checks=[]
def check(name, value):
    if not value: raise AssertionError(name)
    checks.append(name)

with tempfile.TemporaryDirectory(prefix='vera-pg-',dir='/private/tmp') as temporary:
    root=Path(temporary); sock=root/'s'; sock.mkdir()
    def run(*args,**kw): return subprocess.run([str(a) for a in args],text=True,capture_output=True,env=ENV,**kw)
    result=run(BIN/'initdb','-D',root/'db','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8')
    if result.returncode: raise RuntimeError(result.stderr)
    result=run(BIN/'pg_ctl','-D',root/'db','-l',root/'server.log','-o',f"-k {sock} -p 56539 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off",'-w','start')
    if result.returncode: raise RuntimeError(result.stderr+result.stdout)
    def sql(text,okay=True):
        result=run(BIN/'psql','-X','-v','ON_ERROR_STOP=1','-qAt','-h',sock,'-p','56539','-U','postgres','-d','postgres',input=text)
        if okay and result.returncode: raise RuntimeError(result.stderr)
        return result
    def admit(profile=A,subject='user_a',source='oh-cme-general',role='service_role',okay=True):
        return sql(f"begin;set local role {role}; select public.admit_vera_source('{profile}','{subject}','{source}');commit;",okay).stdout.strip()
    try:
        sql(f"create role anon;create role authenticated;create role service_role bypassrls;create table profiles(id uuid primary key,auth_user_id text unique,access_status text);insert into profiles values('{A}','user_a','active'),('{B}','user_b','active');")
        migration=MIGRATION.read_text()
        failure=migration.replace('\ncommit;', '\nselect missing_vera_function();\ncommit;')
        check('migration failure rolls back all objects', sql(failure,False).returncode != 0 and sql("select to_regclass('public.vera_source_settings') is null").stdout.strip()=='t')
        sql(migration);sql(migration)
        check('disabled by default',admit()=='disabled')
        for role in ['anon','authenticated']:
            check(f'{role} cannot call admission',sql(f"set role {role};select public.admit_vera_source('{A}','user_a','oh-cme-general');",False).returncode!=0)
        for table in ['vera_source_settings','vera_source_admission']:
            for role in ['anon','authenticated','service_role']:
                check(f'{role} cannot directly read {table}',sql(f'set role {role};select * from {table};',False).returncode!=0)
        check('service role cannot activate',sql('set role service_role;update vera_source_settings set enabled=true;',False).returncode!=0)
        sql('update vera_source_settings set enabled=true;');sql(migration)
        check('migration rerun preserves reviewed activation',admit()=='allowed')
        check('profile-subject mismatch denied',admit(A,'user_b')=='denied')
        check('unknown source denied',admit(source='untrusted')=='denied')
        check('null identity denied',sql(f"set role service_role;select admit_vera_source('{A}',null,'oh-cme-general')").stdout.strip()=='denied')
        sql(f"update profiles set access_status='revoked' where id='{B}'")
        check('revoked profile denied even with genuine subject',admit(B,'user_b')=='denied')
        sql(f"update profiles set access_status='active' where id='{B}';delete from vera_source_admission;")
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool: results=list(pool.map(lambda _:admit(), range(45)))
        check('45 concurrent requests admit exactly30',results.count('allowed')==30 and results.count('quota')==15)
        check('quota persisted atomically',sql("select requests from vera_source_admission where subject='user_a'").stdout.strip()=='30')
        check('source selection does not reset quota',admit(source='dea-mate')=='quota')
        sql("delete from vera_source_admission;insert into vera_source_admission values((clock_timestamp() at time zone 'UTC')::date,'fixture_preexisting',980)")
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results=list(pool.map(lambda i:admit(A,'user_a') if i%2 else admit(B,'user_b'),range(40)))
        check('global ceiling shared across concurrent accounts',results.count('allowed')==20 and results.count('quota')==20)
        check('global admission never exceeds1000',sql('select sum(requests) from vera_source_admission').stdout.strip()=='1000')
        sql("delete from vera_source_admission;insert into vera_source_admission values((clock_timestamp() at time zone 'UTC')::date-1,'user_a',30)")
        check('new UTC day gets independent quota',admit()=='allowed')
        sql(f"update profiles set auth_user_id='user_relinked' where id='{A}'")
        check('old subject cannot use relinked profile',admit()=='denied')
        check('current subject can access active profile',admit(A,'user_relinked')=='allowed')
        sql('update vera_source_settings set enabled=false')
        check('runtime gate rechecked per call',admit(B,'user_b')=='disabled')
        print(json.dumps({'checks':checks,'passed':len(checks),'migrationSha256':hashlib.sha256(MIGRATION.read_bytes()).hexdigest()},indent=2))
    finally:
        run(BIN/'pg_ctl','-D',root/'db','-m','immediate','-w','stop')
