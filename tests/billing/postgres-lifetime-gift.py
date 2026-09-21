#!/usr/bin/env python3
"""Lifetime gift reservations against the REAL signup/billing/cap SQL in disposable PostgreSQL 17.

Synthetic identities only; no credentials, network listener, provider request, live row,
email or deployment. Continuity helpers are explicit fixture stubs, as in the founding-cap test.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
BIN = Path('/opt/homebrew/opt/postgresql@17/bin')
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
checks = []


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    checks.append(name)


def pid(n): return f'00000000-0000-4000-8000-{n:012d}'
def subject(n): return f'user_Gift{n}'
def text(value): return "'" + str(value).replace("'", "''") + "'"


with tempfile.TemporaryDirectory(prefix='gift-', dir='/private/tmp') as tmp:
    base = Path(tmp); sock = base / 's'; sock.mkdir()
    run = lambda *a, **k: subprocess.run([str(x) for x in a], text=True, capture_output=True, env=ENV, **k)
    assert run(BIN / 'initdb', '-D', base / 'data', '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8').returncode == 0
    r = run(BIN / 'pg_ctl', '-D', base / 'data', '-l', base / 'log', '-o', f"-k {sock} -p 56451 -c listen_addresses='' -c fsync=off", '-w', 'start')
    assert r.returncode == 0, r.stderr

    def sql(statement, ok=True):
        result = run(BIN / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', '56451', '-U', 'postgres', input=statement, timeout=60)
        if ok and result.returncode:
            raise RuntimeError(result.stderr)
        return result

    def role(statement, who='service_role', ok=True):
        return sql("begin;set local statement_timeout='30s';set local role " + who + ';' + statement + ';commit;', ok)

    def value(expression, who='service_role'):
        return json.loads(role('select to_jsonb((' + expression + '))', who).stdout.strip())

    def profile(n, status='pending'):
        sql(f"insert into profiles(id,auth_user_id,access_status) values('{pid(n)}','{subject(n)}',{text(status)}) on conflict do nothing")

    def bootstrap(n, email):
        return value(f"bootstrap_limited_signup('{pid(n)}','{subject(n)}',true,{text(email)})")

    def reserve(email, reason='Founder gift to a colleague for review', actor=1):
        return value(f"reserve_lifetime_gift('{pid(actor)}','{subject(actor)}',{text(email)},{text(reason)},true)")

    def grants(n):
        return int(sql(f"select count(*) from access_grants where profile_id='{pid(n)}' and livemode and kind='lifetime' and revoked_at is null").stdout)

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
        create table subscriptions(id bigserial primary key,auth_user_id text,subscription_id text,status text);
        alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
        """)
        mailbox = (ROOT / 'supabase/migrations/20260918a_mailbox_account_events.sql').read_text()
        start = mailbox.index('create or replace function public.account_is_closed(p_profile uuid)')
        ending = 'grant execute on function public.account_is_closed(uuid) to postgres, service_role;'
        sql(mailbox[start:mailbox.index(ending, start) + len(ending)])
        for name in ['20260918_founding_billing_readiness.sql', '20260919183000_access_policy_foundation.sql',
                     '20260919213000_limited_launch_billing.sql', '20260919233000_limited_paid_purchase_history.sql',
                     '20260920220000_self_service_signup.sql', '20260920221000_continuity_access_evidence.sql',
                     '20260921010000_admin_lifetime_access.sql', '20260921015000_restrict_closed_account_probe.sql',
                     '20260921020000_beta_deferred_billing.sql', '20260922010000_public_founding_capacity.sql']:
            sql((ROOT / 'supabase/migrations' / name).read_text())
        before = sql("select pg_get_functiondef('bootstrap_limited_signup(uuid,text,boolean,text)'::regprocedure)").stdout
        sql((ROOT / 'supabase/migrations/20260923010000_lifetime_gift_reservations.sql').read_text())
        after = sql("select pg_get_functiondef('bootstrap_limited_signup_before_gift(uuid,text,boolean,text)'::regprocedure)").stdout
        check('the reviewed bootstrap body survives the wrapper rename byte for byte',
              after.replace('bootstrap_limited_signup_before_gift(', 'bootstrap_limited_signup(', 1) == before)
        check('migration stages no reservations and no grants', sql('select (select count(*) from lifetime_gift_reservations)+(select count(*) from access_grants)').stdout.strip() == '0')
        sql("update access_policy_settings set limited_self_service_enabled=true,enforcement_enabled=true,limited_checkout_enabled=true,public_founding_enabled=false")

        profile(1, 'active'); sql(f"insert into app_admins values('{pid(1)}')")      # the owner
        profile(2, 'active')                                                          # an ordinary member, not an admin

        # --- authority ---------------------------------------------------------------
        check('a non-admin cannot reserve', reserve('friend@example.invalid', actor=2)['state'] == 'admin_required')
        check('an unknown actor cannot reserve', value(f"reserve_lifetime_gift('{pid(99)}','{subject(99)}','x@example.invalid','A long enough reason',true)")['state'] == 'admin_required')
        for who in ('anon', 'authenticated'):
            check(f'{who} cannot call any gift RPC or read reservations', all(role(s, who, False).returncode != 0 for s in [
                f"select reserve_lifetime_gift('{pid(1)}','{subject(1)}','a@example.invalid','A long enough reason',true)",
                f"select list_lifetime_gift_reservations('{pid(1)}','{subject(1)}',true)",
                f"select revoke_lifetime_gift_reservation('{pid(1)}','{subject(1)}',gen_random_uuid())",
                'select count(*) from lifetime_gift_reservations']))
        check('service_role cannot call the preserved pre-gift bootstrap directly',
              role(f"select bootstrap_limited_signup_before_gift('{pid(2)}','{subject(2)}',true,'m@example.invalid')", ok=False).returncode != 0)
        check('service_role cannot write reservations directly', role("insert into lifetime_gift_reservations(email,livemode,reason,created_by,created_by_subject) values('z@example.invalid',true,'A long enough reason','" + pid(1) + "','" + subject(1) + "')", ok=False).returncode != 0)

        # --- input validation --------------------------------------------------------
        for bad in ['Friend@Example.invalid', ' friend@example.invalid', 'not-an-email', 'a@b']:
            check(f'unnormalized or malformed mailbox is refused: {bad!r}', reserve(bad)['state'] == 'invalid_request')
        check('a short reason is refused', reserve('friend@example.invalid', reason='too short')['state'] == 'invalid_request')

        # --- reserve, idempotence, revoke -------------------------------------------
        first = reserve('friend@example.invalid')
        check('the owner reserves a gift for a mailbox with no account', first['state'] == 'reserved')
        check('reserving the same mailbox again returns the same reservation', reserve('friend@example.invalid')['id'] == first['id'] and sql('select count(*) from lifetime_gift_reservations').stdout.strip() == '1')
        listed = value(f"list_lifetime_gift_reservations('{pid(1)}','{subject(1)}',true)")
        check('the owner can list pending reservations', listed['state'] == 'ready' and [r['email'] for r in listed['reservations']] == ['friend@example.invalid'])

        # --- the happy path: first verified sign-in claims the gift ------------------
        profile(10)
        result = bootstrap(10, 'friend@example.invalid')
        check('verified first sign-in claims the gift as a lifetime enrollment with no price', result['state'] == 'enrolled' and result['kind'] == 'lifetime' and result.get('price_phase') is None)
        check('both products are granted for life and the pending profile is activated', grants(10) == 2 and sql(f"select access_status from profiles where id='{pid(10)}'").stdout.strip() == 'active'
              and sorted(sql(f"select scope from access_grants where profile_id='{pid(10)}'").stdout.split()) == ['credential', 'practice'])
        check('the grant records which reservation produced it', sql(f"select distinct source_key from access_grants where profile_id='{pid(10)}'").stdout.strip() == 'admin-gift-reserved:' + first['id'])
        check('the reservation records who claimed it', sql(f"select claimed_profile_id||'|'||claimed_subject from lifetime_gift_reservations where id='{first['id']}'").stdout.strip() == f'{pid(10)}|{subject(10)}')
        check('signing in again is idempotent', bootstrap(10, 'friend@example.invalid')['kind'] == 'lifetime' and grants(10) == 2)
        check('a claimed gift cannot be withdrawn with the reservation button', value(f"revoke_lifetime_gift_reservation('{pid(1)}','{subject(1)}','{first['id']}')")['state'] == 'already_claimed' and grants(10) == 2)
        check('a gifted account can never be sent to paid checkout', role(f"insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('{pid(10)}',true,'cus_Gift10');insert into billing_checkout_attempts(profile_id,livemode,offer_id,state) values('{pid(10)}',true,'core','creating')", ok=False).returncode != 0)

        # --- a gift is bound to the mailbox, not to whoever signs up next ------------
        reserve('second@example.invalid')
        profile(11)
        stranger = bootstrap(11, 'stranger@example.invalid')
        check('a different verified mailbox never claims someone else\'s gift', stranger['kind'] == 'paid' and grants(11) == 0
              and sql("select count(*) from lifetime_gift_reservations where email='second@example.invalid' and claimed_at is null").stdout.strip() == '1')

        # --- revoke before claim -----------------------------------------------------
        rid = sql("select id from lifetime_gift_reservations where email='second@example.invalid'").stdout.strip()
        check('an unclaimed reservation can be revoked, idempotently', value(f"revoke_lifetime_gift_reservation('{pid(1)}','{subject(1)}','{rid}')")['state'] == 'revoked'
              and value(f"revoke_lifetime_gift_reservation('{pid(1)}','{subject(1)}','{rid}')")['state'] == 'revoked')
        profile(12)
        check('a revoked gift is never claimed', bootstrap(12, 'second@example.invalid')['kind'] == 'paid' and grants(12) == 0)
        check('once that mailbox has signed up, re-reserving is refused so the reviewed per-account gift is used', reserve('second@example.invalid')['state'] == 'account_exists')

        # --- existing accounts go through the reviewed per-account gift --------------
        check('a mailbox that already signed up is refused so billing state gets reviewed', reserve('stranger@example.invalid')['state'] == 'account_exists')

        # --- billing objects block an automatic claim --------------------------------
        for n, table, row in [(20, 'billing_accounts', "(profile_id,livemode,stripe_customer_id) values('{p}',true,'cus_Gift20')"),
                              (21, 'subscriptions', "(auth_user_id,subscription_id,status) values('{s}','sub_Legacy21','active')")]:
            mail = f'billing{n}@example.invalid'; reserve(mail); profile(n)
            sql(f"insert into {table}" + row.format(p=pid(n), s=subject(n)))
            out = bootstrap(n, mail)
            check(f'an existing {table} row leaves the gift unclaimed for reviewed handling', grants(n) == 0 and out['kind'] == 'paid'
                  and sql(f"select count(*) from lifetime_gift_reservations where email={text(mail)} and claimed_at is null").stdout.strip() == '1')

        # Three reviewers independently: an imported account keeps its legacy subscription under its ORIGINAL subject.
        reserve('alias@example.invalid'); profile(22)
        sql(f"insert into fixture_continuity values('{pid(22)}','{subject(22)}','user_OldDevSubject22')")
        sql("insert into subscriptions(auth_user_id,subscription_id,status) values('user_OldDevSubject22','sub_Alias22','active')")
        check('a legacy subscription under a bound old subject blocks the automatic claim', bootstrap(22, 'alias@example.invalid')['kind'] == 'paid' and grants(22) == 0)
        listed = value(f"list_lifetime_gift_reservations('{pid(1)}','{subject(1)}',true)")['reservations']
        by = {r['email']: r for r in listed}
        check('the list tells the owner who signed up without an automatic claim, and who claimed', by['alias@example.invalid']['signedUp'] is True
              and by['billing20@example.invalid']['signedUp'] is True and by['friend@example.invalid']['signedUp'] is False and by['friend@example.invalid']['claimedAt'] is not None)
        states = [(r['claimedAt'] is None and r['revokedAt'] is None) for r in listed]
        check('open gifts are listed before settled ones so a waiting gift cannot fall off the page', states == sorted(states, reverse=True))

        # --- closed, deleted or previously revoked identities ------------------------
        reserve('closed@example.invalid'); profile(30); sql(f"insert into account_tombstones values('{pid(30)}')")
        check('a closed account never claims a gift', grants(30) == 0 and (bootstrap(30, 'closed@example.invalid') or True) and grants(30) == 0)
        reserve('gone@example.invalid'); profile(31); sql(f"update profiles set deleted_at=now() where id='{pid(31)}'")
        check('a deleted profile never claims a gift', bootstrap(31, 'gone@example.invalid')['state'] == 'membership_unavailable' and grants(31) == 0)
        reserve('revoked@example.invalid'); profile(32)
        sql(f"insert into access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at,revoked_at) values('{pid(32)}','{subject(32)}',true,'credential','lifetime','old',now()-interval '1 day',now())")
        revoked = bootstrap(32, 'revoked@example.invalid')
        check('a previously revoked lifetime is never resurrected by a gift', revoked.get('kind') != 'lifetime'
              and sql(f"select count(*) from access_grants where profile_id='{pid(32)}' and revoked_at is null").stdout.strip() == '0'
              and sql("select count(*) from lifetime_gift_reservations where email='revoked@example.invalid' and claimed_at is null").stdout.strip() == '1')

        # --- test mode is separate ---------------------------------------------------
        check('a test-mode gift is refused outright instead of silently never working',
              value(f"reserve_lifetime_gift('{pid(1)}','{subject(1)}','modes@example.invalid','Founder gift to a colleague for review',false)")['state'] == 'test_mode_unsupported'
              and sql("select count(*) from lifetime_gift_reservations where not livemode").stdout.strip() == '0')
        reserve('modes@example.invalid'); profile(40)
        testmode = value(f"bootstrap_limited_signup('{pid(40)}','{subject(40)}',false,'modes@example.invalid')")
        check('a test-mode sign-in never claims a live gift', testmode.get('kind') != 'lifetime' and grants(40) == 0
              and sql("select count(*) from lifetime_gift_reservations where email='modes@example.invalid' and claimed_at is null").stdout.strip() == '1')

        # --- disabled signup claims nothing ------------------------------------------
        reserve('paused@example.invalid'); profile(41)
        sql('update access_policy_settings set limited_self_service_enabled=false')
        check('paused self-service signup claims nothing', bootstrap(41, 'paused@example.invalid')['state'] == 'disabled' and grants(41) == 0
              and sql("select count(*) from lifetime_gift_reservations where email='paused@example.invalid' and claimed_at is null").stdout.strip() == '1')
        sql('update access_policy_settings set limited_self_service_enabled=true')

        # --- red team CONC-1: a refusal from the reviewed body must never leave a committed claim ---
        reserve('refused@example.invalid'); profile(60)
        # The reviewed body refuses with an ordinary RETURN when this profile's enrollment belongs to another subject.
        sql(f"insert into limited_signup_enrollments(profile_id,clerk_subject,livemode,verified_primary_email,kind) values('{pid(60)}','user_SomeoneElse',true,'other60@example.invalid','lifetime')")
        refused = bootstrap(60, 'refused@example.invalid')
        check('a refusal from the reviewed signup body rolls the claim back', refused['state'] == 'identity_changed' and grants(60) == 0
              and sql("select count(*) from lifetime_gift_reservations where email='refused@example.invalid' and claimed_at is null and revoked_at is null").stdout.strip() == '1')
        reserve('switch@example.invalid'); profile(61)
        sql('update access_policy_settings set limited_self_service_enabled=false')
        off = bootstrap(61, 'switch@example.invalid')
        sql('update access_policy_settings set limited_self_service_enabled=true')
        check('the signup kill switch refuses without committing a gift', off['state'] == 'disabled' and grants(61) == 0
              and sql("select count(*) from lifetime_gift_reservations where email='switch@example.invalid' and claimed_at is null").stdout.strip() == '1')
        check('the same recipient still claims normally once signup is back on', bootstrap(61, 'switch@example.invalid')['kind'] == 'lifetime' and grants(61) == 2)

        # --- red team GIFT-ENT-1: a gift must not stay claimable forever -------------
        stale = reserve('stale@example.invalid'); profile(62)
        check('a new reservation expires in about 90 days', 89 <= float(sql(f"select extract(epoch from (expires_at-created_at))/86400 from lifetime_gift_reservations where id='{stale['id']}'").stdout) <= 91)
        sql(f"update lifetime_gift_reservations set created_at=now()-interval '100 days',expires_at=now()-interval '10 days' where id='{stale['id']}'")
        check('an expired gift is never claimed', bootstrap(62, 'stale@example.invalid')['kind'] == 'paid' and grants(62) == 0)
        reserve('stale2@example.invalid')
        sql("update lifetime_gift_reservations set created_at=now()-interval '100 days',expires_at=now()-interval '10 days' where email='stale2@example.invalid'")
        again = reserve('stale2@example.invalid')
        check('the owner can gift again after expiry; the stale row is retired, not left open', again['state'] == 'reserved'
              and sql("select count(*) from lifetime_gift_reservations where email='stale2@example.invalid' and claimed_at is null and revoked_at is null").stdout.strip() == '1'
              and sql("select count(*) from lifetime_gift_reservations where email='stale2@example.invalid' and revoked_at is not null").stdout.strip() == '1')
        # Someone already free for life another way must close the reservation, not leave it dangling.
        reserve('already@example.invalid'); profile(63)
        for scope in ('credential', 'practice'):
            sql(f"insert into access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at) values('{pid(63)}','{subject(63)}',true,'{scope}','lifetime','admin-gift:prior',now()-interval '1 day')")
        prior = bootstrap(63, 'already@example.invalid')
        check('a recipient already free for life closes the reservation without a second grant', prior['kind'] == 'lifetime' and grants(63) == 2
              and sql(f"select count(*) from access_grants where profile_id='{pid(63)}' and source_key like 'admin-gift-reserved:%'").stdout.strip() == '0'
              and sql("select count(*) from lifetime_gift_reservations where email='already@example.invalid' and claimed_at is not null").stdout.strip() == '1')

        # --- concurrency: reserve racing first sign-in, and a double sign-in ---------
        reserve('race@example.invalid'); profile(50)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            outs = list(pool.map(lambda _: bootstrap(50, 'race@example.invalid'), range(8)))
        check('eight concurrent sign-ins claim once and all agree', all(o['kind'] == 'lifetime' for o in outs) and grants(50) == 2
              and sql("select count(*) from lifetime_gift_reservations where email='race@example.invalid' and claimed_at is not null").stdout.strip() == '1')
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            ids = {r.get('id') for r in pool.map(lambda _: reserve('many@example.invalid'), range(8))}
        check('eight concurrent reservations create exactly one row', len(ids) == 1 and sql("select count(*) from lifetime_gift_reservations where email='many@example.invalid'").stdout.strip() == '1')

        # --- the shipped rollback must leave sign-in working for everyone -------------
        rollback = (ROOT / 'docs/rollback/20260923010000_lifetime_gift_reservations.rollback.sql').read_text()
        check('rollback refuses while a promised gift is still open', sql(rollback, ok=False).returncode != 0
              and sql("select to_regprocedure('public.bootstrap_limited_signup_before_gift(uuid,text,boolean,text)') is not null").stdout.strip() == 't')
        sql("update lifetime_gift_reservations set revoked_at=clock_timestamp(),revoked_by='" + pid(1) + "' where claimed_at is null and revoked_at is null")
        claimed_before = sql("select count(*) from access_grants where source_key like 'admin-gift-reserved:%' and revoked_at is null").stdout.strip()
        sql(rollback)
        restored = sql("select pg_get_functiondef('bootstrap_limited_signup(uuid,text,boolean,text)'::regprocedure)").stdout
        check('rollback restores the reviewed signup body byte for byte', restored == before)
        profile(70)
        check('after rollback the edge function role can still sign people up', bootstrap(70, 'after@example.invalid')['state'] == 'enrolled')
        check('after rollback no public role gained the signup function', all(role(f"select bootstrap_limited_signup('{pid(70)}','{subject(70)}',true,'after@example.invalid')", who, False).returncode != 0 for who in ('anon', 'authenticated')))
        check('rollback keeps already-claimed gifts and the audit table', sql("select count(*) from access_grants where source_key like 'admin-gift-reserved:%' and revoked_at is null").stdout.strip() == claimed_before
              and int(sql('select count(*) from lifetime_gift_reservations').stdout) > 0 and bootstrap(10, 'friend@example.invalid')['kind'] == 'lifetime')

        print(json.dumps({'passed': len(checks), 'checks': checks, 'realPostgreSQL': True, 'providerRequests': 0, 'productionChanges': False}, indent=1))
    finally:
        run(BIN / 'pg_ctl', '-D', base / 'data', '-m', 'immediate', 'stop')
