#!/usr/bin/env python3
"""Actual founding-cap SQL in disposable PostgreSQL 17 on a private socket.

Synthetic identities and payment proofs only; no credentials, network listener,
provider requests, live rows, email, or deployment. Provider-backed continuity
helpers are explicit fixture stubs. The real prerequisite billing/access/signup
SQL and founding-cap migration implement every operation under test.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
BIN = Path('/opt/homebrew/opt/postgresql@17/bin')
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
checks = []
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--mutation', choices=['paid-gte-95'], help='Inject a test-only SQL mutation in memory; the suite must fail.')
mutation = parser.parse_args().mutation


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    checks.append(name)


def text(value):
    return "'" + str(value).replace("'", "''") + "'"


def lit(value):
    return text(json.dumps(value, separators=(',', ':'))) + '::jsonb'


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(',', ':')).encode()).hexdigest()


def pid(n):
    return f'40000000-0000-4000-8000-{n:012d}'


def subject(n):
    return f'user_Cap{n}'


def mode(live):
    return 'true' if live else 'false'


with tempfile.TemporaryDirectory(prefix='founding-cap-', dir='/private/tmp') as temp:
    base = Path(temp)
    sock = base / 'socket'
    sock.mkdir()

    def run(*args, **kwargs):
        return subprocess.run([str(a) for a in args], text=True, capture_output=True, env=ENV, **kwargs)

    result = run(BIN / 'initdb', '-D', base / 'data', '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8')
    assert result.returncode == 0, result.stderr
    result = run(BIN / 'pg_ctl', '-D', base / 'data', '-l', base / 'log', '-o',
                 f"-k {sock} -p 56442 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off", '-w', 'start')
    assert result.returncode == 0, result.stderr

    def sql(statement, ok=True):
        result = run(BIN / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock,
                     '-p', '56442', '-U', 'postgres', input=statement, timeout=45)
        if ok and result.returncode:
            raise RuntimeError(result.stderr)
        return result

    def role(statement, who='service_role', ok=True):
        return sql('begin;set local statement_timeout=\'30s\';set local role ' + who +
                   ';set local request.jwt.claims=' + text(json.dumps({'role': who, 'sub': 'user_Fixture'})) +
                   ';' + statement + ';commit;', ok)

    def value(expression):
        return json.loads(role('select to_jsonb((' + expression + '))').stdout.strip())

    def count(where='true'):
        return int(sql('select count(*) from limited_founding_slots where ' + where).stdout)

    def enroll(n, email=None, live=True, account=False):
        sql(f"insert into profiles(id,auth_user_id,access_status) values('{pid(n)}','{subject(n)}','pending') on conflict do nothing")
        result = value(f"bootstrap_limited_signup('{pid(n)}','{subject(n)}',{mode(live)},{text(email or f'cap{n}@example.invalid')})")
        if account:
            role(f"insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('{pid(n)}',{mode(live)},'cus_Cap{n}{'L' if live else 'T'}') on conflict do nothing")
        return result

    def preview(n, offer='core', live=True):
        return value(f"create_limited_billing_preview('{pid(n)}','{subject(n)}',{mode(live)},'{offer}')")

    def claim(n, v):
        return value(f"claim_limited_billing_checkout('{pid(n)}','{subject(n)}',{mode(v['livemode'])},'{v['offer_id']}','{v['id']}','{v['consent_hash']}')")

    def pin_save(n, c, live=True, suffix=''):
        role(f"select pin_limited_billing_price('{c['attempt_id']}','{pid(n)}','{subject(n)}',{mode(live)},'prod_Cap','price_Cap');select save_billing_checkout('{pid(n)}',{mode(live)},'{c['attempt_id']}','{c['token']}','cs_Cap{n}{suffix}')")

    def expired_proof(n, suffix='', live=True):
        return {'status': 'expired', 'payment_status': 'unpaid', 'subscription_id': None,
                'session_id': f'cs_Cap{n}{suffix}', 'customer_id': f"cus_Cap{n}{'L' if live else 'T'}"}

    def release(n, c, proof, live=True):
        return value(f"release_expired_founding_checkout('{pid(n)}','{subject(n)}',{mode(live)},'{c['attempt_id']}',{lit(proof)})")

    def settle(n, c, event, paid=True, status='active', live=True, cancel=False, subscription=None, ok=True):
        customer = f"cus_Cap{n}{'L' if live else 'T'}"
        lease = value(f"claim_billing_reconcile('{pid(n)}',{mode(live)},'{customer}','{event}')")
        q = c['quote']
        period = sql("select clock_timestamp()+interval '1 year'").stdout.strip()
        args = {'p_profile_id': pid(n), 'p_livemode': live, 'p_customer_id': customer,
                'p_subscription_id': subscription or f'sub_Cap{n}', 'p_offer_id': q['offer_id'],
                'p_status': status, 'p_period_end': period, 'p_event_id': event,
                'p_event_created': 1000, 'p_reconcile_token': lease['token'],
                'p_cancel_at_period_end': cancel, 'p_billing_anchor': None}
        proof = {'profileId': pid(n), 'clerkSubject': subject(n), 'livemode': live,
                 'customerId': customer, 'subscriptionId': args['p_subscription_id'],
                 'invoiceId': 'in_' + event[4:], 'pricePhase': q['price_phase'],
                 'annualCents': q['annual_cents'], 'paidAt': sql('select clock_timestamp()').stdout.strip(),
                 'periodEnd': period, 'policyVersion': q['policy_version'], 'initial': True} if paid else None
        result = role(f"select settle_limited_billing_subscription({lit(args)},'{c['attempt_id']}',{lit(proof) if proof else 'null'})", ok=ok)
        return result.stdout.strip() if ok else result

    try:
        sql("""create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
        create schema auth;grant usage on schema auth to authenticated,service_role;
        create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
        create table profiles(id uuid primary key,auth_user_id text unique,access_status text,founding_number integer,created_at timestamptz default now(),deleted_at timestamptz,name text,email text);
        grant select on profiles to authenticated,service_role;
        create table fixture_continuity(profile_id uuid,current_subject text,evidence_subject text);
        create function continuity_owns_subject(pid uuid,current_subject text,evidence_subject text) returns boolean language sql stable security definer set search_path=public,pg_temp as $$select exists(select 1 from profiles p where p.id=pid and p.auth_user_id=current_subject) and (current_subject=evidence_subject or exists(select 1 from fixture_continuity f where f.profile_id=pid and f.current_subject=$2 and f.evidence_subject=$3))$$;
        create function continuity_lifetime_source(uuid,text) returns jsonb language sql stable as $$select null::jsonb$$;
        create table clerk_continuity_accounts(verified_primary_email text primary key,lifetime_eligible boolean not null);
        create table account_tombstones(profile_id uuid primary key);
        create table app_admins(profile_id uuid primary key);
        alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
        """)
        mailbox = (ROOT / 'supabase/migrations/20260918a_mailbox_account_events.sql').read_text()
        start = mailbox.index('create or replace function public.account_is_closed(p_profile uuid)')
        ending = 'grant execute on function public.account_is_closed(uuid) to postgres, service_role;'
        sql(mailbox[start:mailbox.index(ending, start) + len(ending)])
        names = ['20260918_founding_billing_readiness.sql', '20260919183000_access_policy_foundation.sql',
                 '20260919213000_limited_launch_billing.sql', '20260919233000_limited_paid_purchase_history.sql',
                 '20260920220000_self_service_signup.sql', '20260920221000_continuity_access_evidence.sql',
                 '20260921010000_admin_lifetime_access.sql', '20260921015000_restrict_closed_account_probe.sql',
                 '20260921020000_beta_deferred_billing.sql']
        for name in names:
            sql((ROOT / 'supabase/migrations' / name).read_text())
        bodies = {name: sql(f"select pg_get_functiondef('{name}'::regprocedure)").stdout for name in [
            'limited_billing_eligibility(uuid,text,boolean)', 'bootstrap_limited_signup(uuid,text,boolean,text)',
            'claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text)', 'settle_limited_billing_subscription(jsonb,uuid,jsonb)']}
        migration = (ROOT / 'supabase/migrations/20260922010000_public_founding_capacity.sql').read_text()
        executed_migration = migration
        if mutation == 'paid-gte-95':
            original = "if paid=100 then return 'paid_out'; end if;"
            assert migration.count(original) == 1, 'mutation target changed; review the test'
            executed_migration = migration.replace(original, "if paid>=95 then return 'paid_out'; end if;", 1)
        sql(executed_migration)
        check('migration stages no programs, promises, quotes, beta grants or activation', count() == 0 and sql("select (select count(*) from limited_founding_programs)+(select count(*) from limited_billing_quotes)+(select count(*) from limited_beta_grants)").stdout.strip() == '0' and sql('select not(enforcement_enabled or limited_checkout_enabled or limited_invitation_enabled or limited_self_service_enabled or public_founding_enabled) from access_policy_settings').stdout.strip() == 't')
        check('four reviewed base routine bodies survive wrapper renames exactly', all(sql(f"select pg_get_functiondef('{name.replace('(', '_before_founding(', 1)}'::regprocedure)").stdout.replace(name.split('(')[0] + '_before_founding(', name.split('(')[0] + '(', 1) == body for name, body in bodies.items()))

        historical = [f'promise{n}@example.invalid' for n in range(1, 9)]
        promised = historical[:4]
        role(f"select seal_limited_free_beta_cohort('synthetic_cap','{digest(historical)}',{lit(historical)},'Synthetic reviewed historical consent cohort')")
        sql('insert into clerk_continuity_accounts values ' + ','.join(f"({text(email)},true)" for email in historical[4:]))
        stage = f"prepare_founding_program(true,'synthetic_cap','{digest(promised)}',4)"
        check('wrong promise hash is rejected without staging', role(f"select prepare_founding_program(true,'synthetic_cap','{'0'*64}',4)", ok=False).returncode != 0 and count() == 0)
        check('wrong reviewed promise count is rejected without staging', role(f"select prepare_founding_program(true,'synthetic_cap','{digest(promised)}',8)", ok=False).returncode != 0 and count() == 0)
        check('sealed cohort minus four protected lifetime mailboxes reserves exactly four of100', value(stage) == {'state': 'prepared', 'promised': 4, 'capacity': 100} and count("livemode and state='promised'") == 4 and json.loads(sql("select jsonb_agg(promise_email order by promise_email) from limited_founding_slots where livemode").stdout) == promised)
        check('same reviewed preparation is idempotent', value(stage)['state'] == 'already_prepared' and count() == 4)
        check('test program stages independently from live program', value(f"prepare_founding_program(false,'synthetic_cap','{digest(promised)}',4)")['promised'] == 4 and count('not livemode') == 4)
        sql("update access_policy_settings set limited_self_service_enabled=true,limited_checkout_enabled=true,enforcement_enabled=true,public_founding_enabled=true,limited_self_service_price_phase='founding'")
        check('preparation refuses an enabled program', role('select ' + stage, ok=False).returncode != 0)

        # Every new public identity takes the actual self-service path; no direct
        # invitation writes manufacture eligibility or bypass the capacity wrapper.
        enroll(1)
        core = preview(1)
        bundle = preview(1, 'core_locum')
        check('signup and preview consume no extra seat or paid membership', count('livemode') == 4 and sql('select (select count(*) from billing_accounts)+(select count(*) from billing_subscriptions)').stdout.strip() == '0')
        check('public Core is99, bundle245; preview binds consent without allocating', core['annual_cents'] == 9900 and bundle['annual_cents'] == 24500 and bundle['price_phase'] == 'standard' and core['consent_hash'] == hashlib.sha256(core['consent_text'].encode()).hexdigest())
        enroll(1, account=True)
        pending_previews = {1: core}
        for n in range(2, 111):
            enroll(n, account=True)
            pending_previews[n] = preview(n)
        check('110 signups and previews still leave only four promised seats', count('livemode') == 4 and sql('select count(*) from limited_billing_quotes').stdout.strip() == '0')
        sql("update access_policy_settings set limited_checkout_enabled=false;insert into clerk_continuity_accounts values('promise1@example.invalid',true)")
        check('paused checkout returns billing_disabled before lifetime cleanup or any allocation', claim(1, core)['state'] == 'billing_disabled' and count('livemode') == 4 and sql('select count(*) from limited_billing_quotes').stdout.strip() == '0')
        sql("delete from clerk_continuity_accounts where verified_primary_email='promise1@example.invalid';update access_policy_settings set limited_checkout_enabled=true")
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = dict(pool.map(lambda n: (n, claim(n, pending_previews[n])), pending_previews))
        winners = {n: c for n, c in results.items() if c['state'] == 'claimed'}
        losers = [n for n, c in results.items() if c['state'] == 'founding_capacity_pending']
        check('110 concurrent accounts claim exactly96 public seats and14 pending; totalnever exceeds100', len(winners) == 96 and len(losers) == 14 and count('livemode') == 100 and len({c['quote']['public_founding_slot'] for c in winners.values()}) == 96)
        public_offer = value('public_membership_offer()')
        check('100 occupied but zero paid stays99 temporarily full, never switches149', count("livemode and state='paid'") == 0 and public_offer['annualCents'] == 9900 and public_offer['availability'] == 'temporarily_full' and claim(losers[0], pending_previews[losers[0]])['state'] == 'founding_capacity_pending')
        check('capacity-denied accounts have no attempt or accepted quote', int(sql(f"select count(*) from billing_checkout_attempts where profile_id in ({','.join(text(pid(n)) for n in losers)})").stdout) == 0)
        enroll(600, account=True)
        bundle_claim = claim(600, preview(600, 'core_locum'))
        check('full Core capacity still accepts the245 bundle with no founding slot', bundle_claim['state'] == 'claimed' and bundle_claim['quote']['annual_cents'] == 24500 and bundle_claim['quote']['public_founding_slot'] is None and count('livemode') == 100)

        # Two real API paths at the full-capacity boundary, rolled back so the
        # original four promises remain available for the later100-paid test.
        lifetime_probe = sql(f"""begin;
          insert into profiles(id,auth_user_id,access_status) values('{pid(701)}','{subject(701)}','pending');
          select bootstrap_limited_signup('{pid(701)}','{subject(701)}',true,'promise1@example.invalid');
          insert into access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at)
            select '{pid(701)}','{subject(701)}',true,s,'lifetime','synthetic_protected_gift',now() from unnest(array['credential','practice']) s;
          set local role service_role;
          select public_membership_offer();
          select claim_limited_billing_checkout('{pid(losers[0])}','{subject(losers[0])}',true,'core','{pending_previews[losers[0]]['id']}','{pending_previews[losers[0]]['consent_hash']}');
          select not exists(select 1 from limited_founding_slots where livemode and promise_email='promise1@example.invalid') and (select count(*) from limited_founding_slots where livemode)=100;
          rollback;
        """).stdout.strip().splitlines()
        check('protected lifetime gift excludes its unused promise from public availability before cleanup', json.loads(lifetime_probe[1])['availability'] == 'available' and json.loads(lifetime_probe[1])['annualCents'] == 9900)
        check('next actual claim removes lifetime promise and uses only the freed capacity', json.loads(lifetime_probe[2])['state'] == 'claimed' and lifetime_probe[3] == 't' and count('livemode') == 100 and count("livemode and state='promised'") == 4)
        bundle_probe = sql(f"""begin;
          insert into profiles(id,auth_user_id,access_status) values('{pid(702)}','{subject(702)}','pending');
          select bootstrap_limited_signup('{pid(702)}','{subject(702)}',true,'promise2@example.invalid');
          update limited_beta_grants set starts_at=now()-interval '31 days',ends_at=now()-interval '1 day' where profile_id='{pid(702)}';
          insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('{pid(702)}',true,'cus_Cap702L');
          set local role service_role;
          do $probe$ declare v jsonb;c jsonb;lease jsonb;r text;annual_end text:=(now()+interval '1 year')::text;begin
            v:=create_limited_billing_preview('{pid(702)}','{subject(702)}',true,'core_locum');
            c:=claim_limited_billing_checkout('{pid(702)}','{subject(702)}',true,'core_locum',(v->>'id')::uuid,v->>'consent_hash');
            if c->>'state'<>'claimed' or (c->'quote'->>'annual_cents')::integer<>24500 or c->'quote'->'public_founding_slot'<>'null'::jsonb then raise exception 'bundle claim mismatch';end if;
            perform pin_limited_billing_price((c->>'attempt_id')::uuid,'{pid(702)}','{subject(702)}',true,'prod_Cap','price_Bundle');
            lease:=claim_billing_reconcile('{pid(702)}',true,'cus_Cap702L','evt_BundlePromise');
            r:=settle_limited_billing_subscription(jsonb_build_object('p_profile_id','{pid(702)}','p_livemode',true,'p_customer_id','cus_Cap702L','p_subscription_id','sub_BundlePromise','p_offer_id','core_locum','p_status','active','p_period_end',annual_end,'p_event_id','evt_BundlePromise','p_event_created',1000,'p_reconcile_token',lease->>'token','p_cancel_at_period_end',false),
              (c->>'attempt_id')::uuid,jsonb_build_object('profileId','{pid(702)}','clerkSubject','{subject(702)}','livemode',true,'customerId','cus_Cap702L','subscriptionId','sub_BundlePromise','invoiceId','in_BundlePromise','pricePhase','standard','annualCents',24500,'paidAt',now()::text,'periodEnd',annual_end,'policyVersion',v->>'policy_version','initial',true));
            if r<>'applied' then raise exception 'bundle settlement mismatch';end if;
          end $probe$;
          select not exists(select 1 from limited_founding_slots where livemode and promise_email='promise2@example.invalid') and (select count(*) from limited_founding_slots where livemode)=99 and not exists(select 1 from limited_founding_slots where livemode and state='paid') and exists(select 1 from limited_paid_purchase_history where profile_id='{pid(702)}' and offer_id='core_locum' and annual_cents=24500);
          rollback;
        """).stdout.strip().splitlines()
        check('protected holder paying245 bundle frees unused promise with zero paid99 seats', bundle_probe[-1] == 't' and count('livemode') == 100 and count("livemode and state='promised'") == 4)

        for n in range(201, 205):
            result = enroll(n, promised[n-201], account=True)
            check(f'protected holder{n} activates original no-card beta without an extra seat', result['kind'] == 'grandfathered_beta' and count('livemode') == 100)
            # Synthetic time travel before consent: these grants are expired to
            # exercise pay-now settlement without waiting30 real days.
            sql(f"update limited_beta_grants set starts_at=now()-interval '31 days',ends_at=now()-interval '1 day' where profile_id='{pid(n)}'")
            v = preview(n)
            c = claim(n, v)
            check(f'protected holder{n} keeps99 and its promised slot when public capacity is full', v['annual_cents'] == 9900 and c['state'] == 'claimed' and c['quote']['public_founding_slot'] in range(1, 5) and count('livemode') == 100)
            winners[n] = c

        for who in ['anon', 'authenticated', 'service_role']:
            calls = [f"select limited_billing_eligibility_before_founding('{pid(1)}','{subject(1)}',true)",
                     f"select bootstrap_limited_signup_before_founding('{pid(1)}','{subject(1)}',true,'cap1@example.invalid')",
                     f"select claim_limited_billing_checkout_before_founding('{pid(1)}','{subject(1)}',true,'core','{core['id']}','{core['consent_hash']}')",
                     "select settle_limited_billing_subscription_before_founding('{}',gen_random_uuid(),null)"]
            denied = [role(call, who, ok=False) for call in calls]
            check(who + ' cannot invoke any private pre-cap base RPC', all(r.returncode != 0 and 'permission denied for function' in r.stderr for r in denied))
        for who in ['anon', 'authenticated']:
            calls = ['select * from limited_founding_slots', 'select public_membership_offer()', 'select ' + stage,
                     f"select release_expired_founding_checkout('{pid(1)}','{subject(1)}',true,gen_random_uuid(),'{{}}')"]
            denied = [role(call, who, ok=False) for call in calls]
            check(who + ' cannot read private seats or invoke cap mutation RPCs', all(r.returncode != 0 and 'permission denied' in r.stderr for r in denied))
        check('service cannot directly delete or rewrite a protected founding seat', all(role(statement, ok=False).returncode != 0 for statement in ["delete from limited_founding_slots", "update limited_founding_slots set state='promised'"]))

        released_n = next(n for n in winners if n < 200)
        old = winners[released_n]
        pin_save(released_n, old)
        original_quote = sql(f"select to_jsonb(q) from limited_billing_quotes q where attempt_id='{old['attempt_id']}'").stdout
        valid = expired_proof(released_n)
        for key, bad in [('status', 'open'), ('payment_status', 'paid'), ('subscription_id', 'sub_Unexpected'), ('session_id', 'cs_Foreign'), ('customer_id', 'cus_Foreign')]:
            check('release rejects mismatched provider proof ' + key, not release(released_n, old, {**valid, key: bad}) and count('livemode') == 100)
        check('verified expired unpaid subscription-less session releases exactly one unpaid seat', release(released_n, old, valid) and count('livemode') == 99)
        fresh = claim(released_n, preview(released_n))
        check('same verified identity can claim a fresh attempt after release', fresh['state'] == 'claimed' and fresh['attempt_id'] != old['attempt_id'] and count('livemode') == 100)
        check('late old session cannot release the replacement attempt occupying its slot', not release(released_n, old, valid) and count('livemode') == 100 and sql(f"select attempt_id from limited_founding_slots where livemode and profile_id='{pid(released_n)}'").stdout.strip() == fresh['attempt_id'])
        check('release and fresh attempt preserve the complete original immutable quote', sql(f"select to_jsonb(q) from limited_billing_quotes q where attempt_id='{old['attempt_id']}'").stdout == original_quote)
        stale_settlement = settle(released_n, old, 'evt_StaleReleased', ok=False)
        check('late settlement for released quote cannot pay or mutate the reassigned seat', stale_settlement.returncode != 0 and 'founding allocation missing' in stale_settlement.stderr and sql(f"select attempt_id='{fresh['attempt_id']}' and state='reserved' from limited_founding_slots where livemode and profile_id='{pid(released_n)}'").stdout.strip() == 't' and sql("select count(*) from billing_events where event_id='evt_StaleReleased'").stdout.strip() == '0')
        role(f"select release_billing_reconcile('{pid(released_n)}',true,(select reconcile_token from billing_accounts where profile_id='{pid(released_n)}' and livemode))")
        winners[released_n] = fresh
        pin_save(released_n, fresh, suffix='New')
        check('a second identity cannot release somebody else\'s slot', not release(losers[0], fresh, expired_proof(released_n, 'New')) and count('livemode') == 100)

        # A protected promise is restored to its holder, not sold to the public.
        protected = winners[201]
        pin_save(201, protected)
        check('expired protected Checkout restores promised seat without returning public capacity', release(201, protected, expired_proof(201)) and count('livemode') == 100 and value('public_membership_offer()')['availability'] == 'temporarily_full')
        replacement = claim(201, preview(201))
        check('same protected holder reclaims original99 slot after expiry', replacement['state'] == 'claimed' and replacement['attempt_id'] != protected['attempt_id'] and replacement['quote']['public_founding_slot'] == protected['quote']['public_founding_slot'])
        winners[201] = replacement

        enroll(501, live=False, account=True)
        test_quote = claim(501, preview(501, live=False))
        check('full live program does not prevent a test-mode claim', test_quote['state'] == 'claimed' and test_quote['quote']['annual_cents'] == 9900 and count('not livemode') == 5 and count('livemode') == 100)
        pin_save(501, test_quote, live=False)
        check('test payment consumes only a test seat and does not advance live price', settle(501, test_quote, 'evt_TestPaid', live=False) == 'applied' and count("not livemode and state='paid'") == 1 and count("livemode and state='paid'") == 0 and value('public_membership_offer()')['annualCents'] == 9900)
        enroll(503, live=False, account=True)
        unsaved = claim(503, preview(503, live=False))
        test_count = count('not livemode')
        check('lost-local-save fixture is creating with no saved session', sql(f"select state='creating' and session_id is null from billing_checkout_attempts where profile_id='{pid(503)}' and not livemode").stdout.strip() == 't')
        check('expired unsaved session cannot release an unpinned quote', not release(503, unsaved, expired_proof(503, live=False), live=False) and count('not livemode') == test_count)
        role(f"select pin_limited_billing_price('{unsaved['attempt_id']}','{pid(503)}','{subject(503)}',false,'prod_Cap','price_Cap')")
        check('lost-local-save recovery rejects a different customer proof', not release(503, unsaved, {**expired_proof(503, live=False), 'customer_id': 'cus_Foreign'}, live=False) and count('not livemode') == test_count)
        check('verified expired unpaid session recovers a pinned creating attempt after save was lost', release(503, unsaved, expired_proof(503, live=False), live=False) and count('not livemode') == test_count-1 and sql(f"select state='expired' and session_id='cs_Cap503' from billing_checkout_attempts where profile_id='{pid(503)}' and not livemode").stdout.strip() == 't')

        for n, c in winners.items():
            if n != released_n:
                pin_save(n, c, suffix='Final')
        # A real SQL unpaid settlement commits a seat but proves no payment.
        unpaid_n = next(n for n in winners if n != released_n)
        check('unpaid active settlement commits a seat without marking it paid', settle(unpaid_n, winners[unpaid_n], 'evt_Unpaid', paid=False) == 'applied' and sql(f"select state from limited_founding_slots where livemode and profile_id='{pid(unpaid_n)}'").stdout.strip() == 'committed' and count("livemode and state='paid'") == 0)
        check('committed unpaid subscription cannot use the expired-session release', not release(unpaid_n, winners[unpaid_n], expired_proof(unpaid_n, 'Final')) and count('livemode') == 100)
        # Observe the real threshold between batches; checking only zero and100
        # missed an erroneous earlier transition such as paid>=95.
        paid_results = []
        ordered_winners = list(winners.items())
        previous = 0
        for threshold in [95, 96, 99, 100]:
            with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
                paid_results.extend(pool.map(lambda pair: settle(pair[0], pair[1], f'evt_Paid{pair[0]}'), ordered_winners[previous:threshold]))
            previous = threshold
            if threshold < 100:
                offer = value('public_membership_offer()')
                check(f'exactly{threshold} paid of100 occupied keeps public99 pending and protected holder99',
                      all(r == 'applied' for r in paid_results) and count("livemode and state='paid'") == threshold
                      and int(sql('select count(*) from limited_paid_purchase_history where livemode').stdout) == threshold
                      and count('livemode') == 100
                      and offer == {'schemaVersion': 1, 'phase': 'founding', 'annualCents': 9900, 'checkoutEnabled': True, 'availability': 'temporarily_full'}
                      and claim(losers[0], pending_previews[losers[0]])['state'] == 'founding_capacity_pending'
                      and preview(204)['annual_cents'] == 9900)
        check('100 actual validated paid settlements commit exactly100 permanent live places', all(r == 'applied' for r in paid_results) and count("livemode and state='paid'") == 100 and sql('select count(*) from limited_paid_purchase_history where livemode').stdout.strip() == '100')
        check('only paid-ever100 transitions public Core to149', value('public_membership_offer()') == {'schemaVersion': 1, 'phase': 'earlybird', 'annualCents': 14900, 'checkoutEnabled': True, 'availability': 'available'})
        stale_n = losers[0]
        check('previously displayed99 consent cannot silently accept149', claim(stale_n, pending_previews[stale_n])['state'] == 'quote_expired')
        new149 = preview(stale_n)
        c149 = claim(stale_n, new149)
        check('fresh149 consent creates checkout without consuming a101st founding seat', new149['annual_cents'] == 14900 and c149['state'] == 'claimed' and c149['quote']['public_founding_slot'] is None and count('livemode') == 100)
        before_paid = sql("select jsonb_agg(to_jsonb(s) order by slot) from limited_founding_slots s where livemode and state='paid'").stdout
        check('cancellation settles successfully but never returns a paid-ever place', settle(released_n, winners[released_n], 'evt_Canceled', paid=False, status='canceled', cancel=True) == 'applied' and count("livemode and state='paid'") == 100 and value('public_membership_offer()')['annualCents'] == 14900)
        check('cancellation preserves all first-payment evidence', sql("select jsonb_agg(to_jsonb(s) order by slot) from limited_founding_slots s where livemode and state='paid'").stdout == before_paid)
        check('refund/cancellation cannot release a paid-ever place through the expiry RPC', not release(released_n, winners[released_n], expired_proof(released_n, 'New')) and count("livemode and state='paid'") == 100)
        check('ended paid founder rejoins at standard199 without reusing first-purchase pricing', preview(released_n)['annual_cents'] == 19900)
        enroll(502, live=False)
        check('new test account still previews99 after live sellout; prior test purchaser has199 rejoin', preview(502, live=False)['annual_cents'] == 9900 and preview(501, live=False)['annual_cents'] == 19900 and sql("select founding_public_state(false)").stdout.strip() == 'available')
        print(json.dumps({'result': 'PASS', 'count': len(checks),
                          'migrationSHA256': hashlib.sha256(migration.encode()).hexdigest(),
                          'executedMigrationSHA256': hashlib.sha256(executed_migration.encode()).hexdigest(), 'mutation': mutation, 'checks': checks,
                          'limits': 'Disposable PostgreSQL17; actual billing/access/signup/deferred/cap SQL, synthetic payment proofs and identity-continuity stubs. No Stripe verification or refund operation simulated; the paid-seat persistence and release-denial contract is tested. No provider/live data/network listener.'}, indent=2))
    finally:
        result = run(BIN / 'pg_ctl', '-D', base / 'data', '-m', 'fast', '-w', 'stop')
        assert result.returncode == 0, result.stderr
