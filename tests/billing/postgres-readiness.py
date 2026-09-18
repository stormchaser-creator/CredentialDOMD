#!/usr/bin/env python3
"""Exact migration tests in a disposable PostgreSQL 17 DB; local Unix socket only."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading

BIN = Path('/opt/homebrew/opt/postgresql@17/bin')
MIGRATION = Path(__file__).resolve().parents[2] / 'supabase/migrations/20260918_founding_billing_readiness.sql'
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
results = []

def check(name, value):
    if not value: raise AssertionError(name)
    results.append({'name': name, 'pass': True})

with tempfile.TemporaryDirectory(prefix='billing-readiness-') as temp:
    root = Path(temp)
    socket = root / 'socket'
    socket.mkdir()
    def run(*args, **kwargs):
        return subprocess.run([str(x) for x in args], text=True, capture_output=True, env=ENV, **kwargs)
    init = run(BIN/'initdb', '-D', root/'data', '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8')
    if init.returncode: raise RuntimeError(init.stderr)
    start = run(BIN/'pg_ctl', '-D', root/'data', '-l', root/'postgres.log', '-o', f"-k {socket} -p 56428 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off", '-w', 'start')
    if start.returncode: raise RuntimeError(start.stderr + start.stdout)
    def sql(query, okay=True):
        r = run(BIN/'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-h', socket, '-p', '56428', '-U', 'postgres', '-d', 'postgres', input=query)
        if okay and r.returncode: raise RuntimeError(r.stderr)
        return r
    def role(query, who='service_role', subject=None, okay=True):
        claims = json.dumps({'role': who, 'sub': subject}).replace("'", "''")
        return sql(f"BEGIN; SET LOCAL ROLE {who}; SET LOCAL request.jwt.claims='{claims}'; {query}; COMMIT;", okay)
    member_a = '10000000-0000-4000-8000-000000000001'
    member_b = '10000000-0000-4000-8000-000000000002'
    def event(event_id, created, status='active', subscription='sub_a', profile=member_a, customer='cus_a', live=True, token='00000000-0000-4000-8000-000000000000', eligible=True):
        return f"select public.apply_billing_subscription('{profile}',{str(live).lower()},'{customer}','{subscription}','core','{status}','2030-01-01T00:00:00Z','{event_id}',{created},'{token}',{str(eligible).lower()})"
    def claim(event_id,profile=member_a,customer='cus_a',live=True):
        return json.loads(role(f"select public.claim_billing_reconcile('{profile}',{str(live).lower()},'{customer}','{event_id}')").stdout)
    def apply(event_id,created,status='active',subscription='sub_a',profile=member_a,customer='cus_a',live=True,eligible=True):
        lease=claim(event_id,profile,customer,live)
        if lease['state']!='claimed': return lease['state']
        return role(event(event_id,created,status,subscription,profile,customer,live,lease['token'],eligible)).stdout.strip()
    def checkout(profile=member_a,offer='core',live=True):
        return json.loads(role(f"select public.claim_billing_checkout('{profile}',{str(live).lower()},'{offer}')").stdout)
    def save(attempt,session='cs_test_a',profile=member_a,live=True):
        return role(f"select public.save_billing_checkout('{profile}',{str(live).lower()},'{attempt['attempt_id']}','{attempt['token']}','{session}')").stdout.strip()
    try:
        sql("""
          create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
          create schema auth; grant usage on schema auth to authenticated, service_role;
          create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb $$;
          create table public.profiles(id uuid primary key, auth_user_id text unique, access_status text, founding_number integer);
          alter table public.profiles enable row level security;
          grant select on public.profiles to authenticated, service_role;
          create policy profile_owner on public.profiles for select to authenticated using(auth_user_id=auth.jwt()->>'sub');
          insert into public.profiles values('10000000-0000-4000-8000-000000000001','user_a','active',1),('10000000-0000-4000-8000-000000000002','user_b','active',2);
        """)
        sql(MIGRATION.read_text()); sql(MIGRATION.read_text())
        check('exact migration applies and is repeatable', True)
        role(f"insert into public.billing_accounts(profile_id,livemode,stripe_customer_id) values('{member_a}',true,'cus_a'),('{member_a}',false,'cus_a_test'),('{member_b}',true,'cus_b')")
        check('service fulfillment applies', apply('evt_initial',100)=='applied')
        check('replayed event is idempotent', claim('evt_initial')['state']=='duplicate')
        check('mismatched Stripe customer cannot claim reconciliation', role(f"select public.claim_billing_reconcile('{member_a}',true,'cus_b','evt_forged')",okay=False).returncode != 0)
        check('current owner reads their subscription', role('select count(*) from public.billing_subscriptions', 'authenticated','user_a').stdout.strip()=='1')
        check('another Clerk user cannot read it', role('select count(*) from public.billing_subscriptions', 'authenticated','user_b').stdout.strip()=='0')
        for who in ['anon','authenticated']:
            check(f'{who} cannot execute billing RPC', role(event('evt_denied',102), who,'user_a',okay=False).returncode != 0)
            check(f'{who} cannot claim checkout', role(f"select public.claim_billing_checkout('{member_a}',true,'core')", who,'user_a',okay=False).returncode != 0)
            check(f'{who} cannot claim reconciliation', role(f"select public.claim_billing_reconcile('{member_a}',true,'cus_a','evt_denied')", who,'user_a',okay=False).returncode != 0)
            check(f'{who} cannot write billing accounts', role("update public.billing_accounts set stripe_customer_id='cus_injected'",who,'user_a',okay=False).returncode != 0)
            check(f'{who} cannot truncate billing tables', role('truncate public.billing_subscriptions',who,'user_a',okay=False).returncode != 0)
        check('same-second restrictive state applies',apply('evt_due',100,'past_due')=='applied')
        check('same-second paid recovery reconciles current state',apply('evt_recovered',100)=='applied')
        check('older event timestamp still reconciles current unpaid state',apply('evt_delayed',99,'unpaid')=='applied')
        old=claim('evt_slow_reader')
        check('other deliveries wait while provider read holds lease',claim('evt_busy')['state']=='busy')
        sql(f"update public.billing_accounts set reconcile_until=clock_timestamp()-interval '1 second' where profile_id='{member_a}' and livemode")
        new=claim('evt_new_reader')
        check('new reader takes over expired lease',new['state']=='claimed' and new['token']!=old['token'])
        check('new reader settles cancellation',role(event('evt_new_reader',110,'canceled',token=new['token'])).stdout.strip()=='applied')
        check('late old provider response cannot restore access',role(event('evt_slow_reader',109,'active',token=old['token'])).stdout.strip()=='fenced')
        check('old event retry reconciles fresh canceled state',apply('evt_slow_reader',109,'canceled')=='applied')
        check('new subscription can replace terminal subscription',apply('evt_repurchase',120,subscription='sub_new')=='applied')
        check('historical cancellation cannot replace current subscription',apply('evt_historical',121,'canceled',subscription='sub_a')=='applied' and sql("select subscription_id from public.billing_subscriptions where livemode").stdout.strip()=='sub_new')
        check('second active subscription is flagged for reconciliation',apply('evt_second',122,subscription='sub_extra')=='conflict')
        sql(f"update public.billing_accounts set reconcile_until=null,reconcile_token=null where profile_id='{member_a}'")
        check('revocation preserves payment state separately',apply('evt_revoked',123,subscription='sub_new',eligible=False)=='applied' and sql("select status||'|'||membership_active from public.billing_subscriptions where livemode").stdout.strip()=='active|false')
        apply('evt_test',140,customer='cus_a_test',live=False)
        check('test entitlements never leak to live account reads',role('select count(*) from public.billing_subscriptions','authenticated','user_a').stdout.strip()=='1')
        lease=claim('evt_profile_bound')
        check('reconciliation token cannot settle another profile',role(event('evt_profile_bound',150,profile=member_b,customer='cus_b',subscription='sub_b',token=lease['token'])).stdout.strip()=='fenced')
        check('reconciliation token cannot cross test/live modes',role(event('evt_profile_bound',150,live=False,customer='cus_a_test',token=lease['token'])).stdout.strip()=='fenced')
        role(f"select public.release_billing_reconcile('{member_a}',true,'{lease['token']}')")
        barrier=threading.Barrier(12)
        def contend(_):
            barrier.wait()
            return claim('evt_concurrent',member_b,'cus_b')
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool: outcomes=list(pool.map(contend,range(12)))
        winner=next(x for x in outcomes if x['state']=='claimed')
        check('12 concurrent deliveries admit one provider reader',sum(x['state']=='claimed' for x in outcomes)==1 and sum(x['state']=='busy' for x in outcomes)==11)
        role(event('evt_concurrent',200,profile=member_b,customer='cus_b',subscription='sub_b',token=winner['token']))
        check('settled delivery is duplicate for every retry',all(claim('evt_concurrent',member_b,'cus_b')['state']=='duplicate' for _ in range(3)))
        barrier=threading.Barrier(12)
        def checkout_contend(_):
            barrier.wait()
            return checkout()
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool: attempts=list(pool.map(checkout_contend,range(12)))
        first=next(x for x in attempts if x['state']=='claimed')
        check('12 concurrent checkouts reserve one durable attempt',sum(x['state']=='claimed' for x in attempts)==1 and sum(x['state']=='busy' for x in attempts)==11)
        check('competing bundle cannot reserve a second attempt',checkout(offer='core_locum')['state']=='offer_conflict')
        sql(f"update public.billing_checkout_attempts set lease_until=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '2 hours' where profile_id='{member_a}'")
        second=checkout()
        check('expired worker reuses durable attempt instead of a day key',first['attempt_id']==second['attempt_id'] and first['token']!=second['token'])
        check('old checkout worker is fenced from saving',save(first)=='f')
        check('checkout token cannot save another profile',save(second,profile=member_b)=='f')
        check('checkout token cannot cross modes',save(second,live=False)=='f')
        check('current checkout worker persists its Stripe session',save(second)=='t')
        check('saved open session reused after elapsed days',checkout()['state']=='existing')
        role(f"select public.close_billing_checkout('{member_a}',true,'{second['attempt_id']}','expired')")
        third=checkout(offer='core_locum')
        check('only confirmed expiry permits a new checkout attempt',third['state']=='claimed' and third['attempt_id']!=second['attempt_id'])
        sql(f"update public.billing_checkout_attempts set lease_until=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '25 hours' where profile_id='{member_a}'")
        check('uncertain attempt beyond Stripe idempotency retention fails closed',checkout(offer='core_locum')['state']=='reconciliation_required')
        print(json.dumps({'migrationSHA256':hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),'tests':results},indent=2))
    finally:
        stopped = run(BIN/'pg_ctl','-D',root/'data','-m','fast','-w','stop')
        if stopped.returncode: raise RuntimeError(stopped.stderr)
