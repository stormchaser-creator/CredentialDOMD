#!/usr/bin/env python3
"""Execute the actual admin migration against disposable local PostgreSQL.

Synthetic contract tables plus real identity-lock/closed-account SQL. No production
connection, credentials, TCP listener, provider, mail, deployment, or billing write.
"""
import concurrent.futures
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
BIN = Path(os.environ.get('ADMIN_TEST_PG_BIN') or os.environ.get('PG_BIN') or '/opt/homebrew/opt/postgresql@17/bin')
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
ENV['LC_ALL'] = 'C'
checks = []


def check(name, value):
    if not value:
        raise AssertionError(name)
    checks.append(name)


def pid(n): return f'00000000-0000-4000-8000-{n:012d}'
def quoted(value): return 'null' if value is None else "'" + str(value).replace("'", "''") + "'"
def run(*args, **kw): return subprocess.run([str(a) for a in args], text=True, capture_output=True, env=ENV, **kw)


if not (BIN / 'initdb').is_file():
    located = shutil.which('initdb')
    if not located:
        raise SystemExit('PostgreSQL initdb is required; set ADMIN_TEST_PG_BIN to its bin directory.')
    BIN = Path(located).parent

with tempfile.TemporaryDirectory(prefix='admin-ops-', dir='/tmp') as temp:
    base = Path(temp); sock = base / 's'; sock.mkdir()
    started = False
    initialized = run(BIN / 'initdb', '-D', base / 'data', '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8')
    assert initialized.returncode == 0, initialized.stderr
    try:
        result = run(BIN / 'pg_ctl', '-D', base / 'data', '-l', base / 'log', '-o',
                     f"-k {sock} -p 56457 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off", '-w', 'start')
        assert result.returncode == 0, result.stderr + (base / 'log').read_text()
        started = True

        def sql(statement, ok=True):
            result = run(BIN / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', '56457',
                         '-U', 'postgres', input=statement, timeout=45)
            if ok and result.returncode:
                raise RuntimeError(result.stderr)
            return result

        def role(statement, who='authenticated', subject='user_Admin1', ok=True, suffix='commit;', email=None):
            claims = json.dumps({'role': who, 'sub': subject, **({'email': email} if email else {})}, separators=(',', ':'))
            return sql("begin;set local statement_timeout='30s';set local timezone='America/Los_Angeles';set local role " + who
                       + ';set local request.jwt.claims=' + quoted(claims) + ';' + statement + ';' + suffix, ok)

        def value(expression, **kw):
            return json.loads(role('select to_jsonb((' + expression + '))', **kw).stdout.strip())

        def profile_state(n):
            return json.loads(sql(f"select jsonb_build_object('status',access_status,'updated',updated_at,'subject',auth_user_id) from profiles where id='{pid(n)}'").stdout)

        def invite_state(n):
            return json.loads(sql(f"select jsonb_build_object('status',status,'updated',updated_at,'profile',profile_id) from beta_access where id='{pid(n)}'").stdout)

        def profile_call(n, status, state=None, request=None, reason='Reviewed administrative account restriction'):
            state = state or profile_state(n)
            return 'admin_change_profile_access(' + ','.join(quoted(v) for v in [pid(n), status, state['status'], state['updated'], state['subject'], reason, request or uuid.uuid4()]) + ')'

        def invite_call(n, action, status=None, state=None, request=None, reason='Reviewed invitation administrative restriction'):
            state = state or invite_state(n)
            return 'admin_change_invite(' + ','.join(quoted(v) for v in [pid(n), action, status, state['status'], state['updated'], state['profile'], reason, request or uuid.uuid4()]) + ')'

        sql("""
        create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
        create schema auth; grant usage on schema auth to anon,authenticated,service_role;
        create function auth.jwt() returns jsonb language sql stable as $$
          select nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
        create table profiles(id uuid primary key,auth_user_id text unique,email text,name text,
          access_status text not null default 'pending' check(access_status in ('pending','active','revoked')),
          created_at timestamptz not null default now(),updated_at timestamptz not null default now(),deleted_at timestamptz,
          is_founding_member boolean not null default false,admin_inbox_seen_at timestamptz,admin_errors_seen_at timestamptz);
        create table app_admins(profile_id uuid primary key references profiles(id));
        create table account_tombstones(profile_id uuid primary key);
        create function public.current_profile_id() returns uuid language sql stable security definer set search_path=public as $$
          select id from profiles where auth_user_id=auth.jwt()->>'sub' limit 1 $$;
        create function public.is_admin(p_id uuid) returns boolean language sql stable security definer set search_path=public as $$
          select exists(select 1 from app_admins where profile_id=p_id) $$;
        alter table profiles enable row level security;
        create policy profile_owner on profiles for all to authenticated using(id=current_profile_id()) with check(id=current_profile_id());
        create policy profiles_admin_read on profiles for select to authenticated using(is_admin(current_profile_id()));
        create policy profiles_admin_access_update on profiles for update to authenticated using(is_admin(current_profile_id())) with check(is_admin(current_profile_id()));
        create table beta_access(id uuid primary key,email text not null,name text,status text not null default 'invited'
          check(status in ('invited','active','revoked')),profile_id uuid references profiles(id),activated_at timestamptz,
          created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
          invited_at timestamptz not null default now(),invited_by uuid,invite_sent_at timestamptz,lead_id uuid,note text);
        alter table beta_access enable row level security;
        create policy beta_access_admin_all on beta_access for all to authenticated using(is_admin(current_profile_id())) with check(is_admin(current_profile_id()));
        create table support_tickets(id uuid primary key default gen_random_uuid(),user_id uuid,status text,priority text,
          archived_at timestamptz,agent_approved_at timestamptz,created_at timestamptz not null default now());
        create table client_errors(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now());
        create table page_views(day date,path text,hits integer,referrer_domain text not null default 'direct');
        create table page_visits(created_at timestamptz,path text,referrer text default '');
        -- Production shapes the attention counts and reply idempotency read.
        create table admin_messages(id uuid primary key default gen_random_uuid(),sender_id uuid not null,recipient_id uuid,
          subject text,body text not null default 'Synthetic message',created_at timestamptz not null default now());
        create table admin_message_replies(id uuid primary key default gen_random_uuid(),message_id uuid not null,user_id uuid not null,
          author_id uuid not null,body text not null default 'Synthetic reply',is_admin_reply boolean not null default false,
          created_at timestamptz not null default now());
        create table field_proposals(id uuid primary key default gen_random_uuid(),section text not null default 'licenses',
          label text not null default 'Synthetic field',status text not null default 'pending',created_at timestamptz not null default now());
        create table early_access_leads(id uuid primary key default gen_random_uuid(),email text not null,name text,
          waitlist boolean not null default true,created_at timestamptz not null default now());
        create table support_messages(id uuid primary key default gen_random_uuid(),ticket_id uuid not null,author_id uuid,
          body text not null,is_admin_reply boolean,created_at timestamptz default now());
        -- Deliberately permissive legacy ACLs: the migration must close them.
        grant select,insert,update,delete on profiles,beta_access to authenticated,service_role;
        grant select on app_admins to authenticated;
        alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
        -- Sentinels establish that status controls preserve financial/entitlement state.
        create table access_grants(id uuid primary key,profile_id uuid,kind text);
        create table billing_subscriptions(id uuid primary key,profile_id uuid,status text);
        create table access_policy_settings(singleton boolean primary key,checkout_enabled boolean,outbound_enabled boolean);
        insert into access_policy_settings values(true,false,false);
        """)
        source = (ROOT / 'supabase/migrations/20260918a_mailbox_account_events.sql').read_text()
        start = source.index('create or replace function public.account_is_closed(p_profile uuid)')
        ending = 'grant execute on function public.account_is_closed(uuid) to postgres, service_role;'
        sql(source[start:source.index(ending, start) + len(ending)])
        sql((ROOT / 'supabase/migrations/20260902h_access_grant_flag.sql').read_text())
        sql('create trigger profiles_lock_identity before update on profiles for each row execute function public.lock_profile_identity()')
        sql((ROOT / 'supabase/migrations/20260902g_founding_members.sql').read_text())
        # Exercise the real profile guard alongside the real legacy founding
        # triggers. Scope predicate denies target edits absent the narrow flag.
        sql("create function credentialdo_access_enforced() returns boolean language sql stable as $$select true$$; create function credentialdo_profile_scope_write_allowed(uuid,text,text) returns boolean language sql stable as $$select false$$")
        enforcement = (ROOT / 'supabase/migrations/20260920230000_access_write_enforcement.sql').read_text()
        guard_start = enforcement.index('create or replace function public.credentialdo_guard_profile_preferences()')
        guard_end = enforcement.index('\ncommit;', guard_start)
        sql(enforcement[guard_start:guard_end])
        for n in range(1, 14):
            status = 'pending' if n == 3 else 'active'
            email = ' ' if n == 7 else None if n == 13 else f'person{n}@example.invalid'
            subject = None if n == 8 else f'user_Admin{n}'
            when = "now()-interval '100 days'" if n == 9 else "now()+interval '1 day'" if n == 10 else (
                "date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'-interval '6 days'" if n == 11 else (
                    "date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'-interval '6 days 1 microsecond'" if n == 12 else 'now()'))
            sql(f"insert into profiles(id,auth_user_id,email,access_status,created_at,deleted_at) values('{pid(n)}',{quoted(subject)},{quoted(email)},{quoted(status)},{when},{'now()' if n == 4 else 'null'})")
        sql(f"insert into app_admins values('{pid(1)}'),('{pid(6)}');insert into account_tombstones values('{pid(5)}')")
        sql("""insert into profiles(id,auth_user_id,email,access_status,created_at)
          select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'user_Seed'||n,'seed'||n||'@example.invalid','active',now()-interval '2 days'
          from generate_series(100,799) n""")
        sql(f"insert into beta_access(id,email,status,profile_id) values('{pid(1001)}','target@example.invalid','invited','{pid(3)}'),('{pid(1002)}','unlinked@example.invalid','invited',null),('{pid(1003)}','remove@example.invalid','invited',null)")
        sql(f"insert into access_grants values(gen_random_uuid(),'{pid(3)}','lifetime');insert into billing_subscriptions values(gen_random_uuid(),'{pid(2)}','active')")
        sql(f"""insert into support_tickets(user_id,status,priority,archived_at,agent_approved_at,created_at) values
          ('{pid(2)}','open','urgent',null,null,now()-interval '4 days'),
          ('{pid(2)}','waiting_user','normal',null,now(),now()-interval '3 days'),
          ('{pid(1)}','in_progress','high',null,null,now()-interval '2 days'),
          ('{pid(2)}','open','urgent',now(),null,now()),
          ('{pid(2)}','resolved','urgent',null,null,now()),
          ('{pid(2)}','closed','normal',null,null,now());
          insert into client_errors(created_at) values(now()),(now()-interval '2 days'),(now()-interval '8 days'),(now()+interval '1 day');
          insert into page_views values((now() at time zone 'UTC')::date,'/',1200),((now() at time zone 'UTC')::date,'/states/ca',20);
          insert into page_visits values(now()-interval '1 day','/'),(now(),'/');
        """)
        migration = (ROOT / 'supabase/migrations/20260924020000_admin_operations.sql').read_text()
        sql(migration); sql(migration)
        # The 2026-09-25 follow-ups apply on top, twice each, and every check
        # below runs against the final definitions.
        for name in ['20260925110000_admin_access_regrant_guard.sql', '20260925111000_admin_operations_followups.sql',
                     '20260925112000_support_reply_idempotency.sql']:
            followup = (ROOT / 'supabase/migrations' / name).read_text()
            sql(followup); sql(followup)
        check('migration is rerunnable and creates no audit actions', sql('select count(*) from admin_operations_audit').stdout.strip() == '0')

        # Authorization: privilege denials, real current-profile NULL, and real membership.
        for who, subject in [('anon', ''), ('authenticated', 'user_Admin2'), ('authenticated', 'user_missing')]:
            label = who + ':' + (subject or 'anonymous')
            check(label + ' cannot report', role('select admin_operations_report(7)', who, subject, False).returncode != 0)
            check(label + ' cannot change account access', role('select ' + profile_call(3, 'active'), who, subject, False).returncode != 0)
            check(label + ' cannot change invitation', role('select ' + invite_call(1002, 'set_status', 'revoked'), who, subject, False).returncode != 0)
        check('unknown current profile fails closed', value('admin_operations_can_read()', subject='user_missing') is False)
        check('non-admin cannot read audit rows', value('(select count(*) from admin_operations_audit)', subject='user_Admin2') == 0)
        for n in [1, 6, 4, 5]:
            check(f'admin or closed target {n} is protected', role('select ' + profile_call(n, 'revoked'), ok=False).returncode != 0)
        sql(f"insert into app_admins values('{pid(4)}'),('{pid(5)}')")
        check('deleted admin cannot report', role('select admin_operations_report(7)', subject='user_Admin4', ok=False).returncode != 0)
        check('tombstoned admin cannot mutate', role('select ' + profile_call(3, 'active'), subject='user_Admin5', ok=False).returncode != 0)
        sql(f"update profiles set access_status='revoked' where id='{pid(6)}'")
        check('paused administrator cannot report', role('select admin_operations_report(7)',subject='user_Admin6',ok=False).returncode != 0)
        check('paused administrator cannot mutate', role('select '+profile_call(3,'active'),subject='user_Admin6',ok=False).returncode != 0)
        sql(f"update profiles set access_status='active' where id='{pid(6)}'")

        # Dense UTC date boundaries and exact aggregates independent of a 500-row list.
        report = value('admin_operations_report(7)')
        check('exact snapshot exceeds 500-list cap', report['accounts'] == {'total': 711, 'active': 710, 'new_in_period': 703})
        check('dense seven-day UTC report', report['days'] == len(report['daily']) == 7 and report['daily'][0]['day'] == report['period_start'][:10])
        check('start is midnight UTC and end is generated time', report['period_start'].endswith('T00:00:00+00:00') and report['period_end'] == report['generated_at'])
        check('day rollup reconciles exactly', sum(d['signups'] for d in report['daily']) == report['accounts']['new_in_period'])
        check('start boundary included and just-before excluded', report['daily'][0]['signups'] == 1)
        check('future errors excluded and existing history counted', report['errors']['in_period'] == 2 and sum(d['errors'] for d in report['daily']) == 2)
        check('ticket snapshot excludes archive and terminal statuses', {k:v for k,v in report['support'].items() if k != 'oldest_open_at'} == {'open':3,'urgent':1,'waiting_approval':1})
        check('oldest unresolved age has real timestamp', report['support']['oldest_open_at'] is not None)
        # Raw rows count through the counter's first day: the two never
        # recorded the same load (the /api/pv beacon replaced the raw write).
        check('pageview cutover counts legacy rows through the cutover day', sum(d['page_views'] for d in report['daily']) == 1222)
        check('cutover day sums both sources', report['daily'][-1]['page_views'] == 1221 and report['daily'][-2]['page_views'] == 1)
        check('daily includes all created tickets independently of current status', sum(d['tickets'] for d in report['daily']) == 6)
        for days in [30,90]:
            r = value(f'admin_operations_report({days})')
            check(f'{days}-day report is dense with complete signup aggregate', len(r['daily']) == days and r['accounts']['new_in_period'] == 704)
        for invalid in ['null','0','8','10000']:
            check('invalid report window '+invalid+' denied', role('select admin_operations_report('+invalid+')', ok=False).returncode != 0)

        # Direct writes/legacy RPC must not bypass reason and audit requirements.
        check('old unaudited admin_set_access is denied', role(f"select admin_set_access('{pid(3)}','active')", ok=False).returncode != 0)
        check('direct invite update denied to admin', role(f"update beta_access set status='revoked' where id='{pid(1002)}'", ok=False).returncode != 0)
        check('direct invite delete denied to admin', role(f"delete from beta_access where id='{pid(1002)}'", ok=False).returncode != 0)
        role(f"update profiles set access_status='revoked' where id='{pid(3)}'")
        check('direct customer profile edit touches nothing', profile_state(3)['status'] == 'pending')
        role(f"update profiles set access_status='revoked' where id='{pid(2)}'", subject='user_Admin2', ok=False)
        check('member cannot self-promote through owner policy', profile_state(2)['status'] == 'active')
        check('short reason denied', role('select ' + profile_call(3,'active',reason='short'), ok=False).returncode != 0)
        bad = dict(profile_state(3)); bad['subject'] = 'user_Wrong'
        check('changed identity denied', role('select '+profile_call(3,'active',bad), ok=False).returncode != 0)

        # Success is atomic, auditable, and repeatable with the same immutable request.
        financial_before = sql('select jsonb_build_array((select jsonb_agg(t) from access_grants t),(select jsonb_agg(t) from billing_subscriptions t),(select jsonb_agg(t) from access_policy_settings t))').stdout
        original = profile_state(3); request = uuid.uuid4(); expression = profile_call(3,'active',original,request)
        changed = value(expression)
        check('profile action returns persisted status', changed['profile']['access_status'] == profile_state(3)['status'] == 'active')
        check('returned version includes later legacy trigger writes', datetime.fromisoformat(changed['profile']['updated_at']) == datetime.fromisoformat(profile_state(3)['updated']))
        check('legacy founding trigger compatibility preserved', sql(f"select founding_number is not null from profiles where id='{pid(3)}'").stdout.strip() == 't')
        check('linked invitation changes in same transaction', invite_state(1001)['status'] == 'active')
        check('one durable actor/reason audit', value('(select count(*) from admin_operations_audit)') == 1 and value(f"(select actor_profile_id from admin_operations_audit where id='{changed['audit_id']}')") == pid(1))
        check('identical retry returns same receipt without duplicate audit', value(expression)['duplicate'] is True and value('(select count(*) from admin_operations_audit)') == 1)
        check('request ID cannot change payload', role('select '+profile_call(3,'revoked',original,request), ok=False).returncode != 0)
        check('stale expected state denied', role('select '+profile_call(3,'revoked',original), ok=False).returncode != 0)
        check('linked invitation control denied', role('select '+invite_call(1001,'set_status','revoked'), ok=False).returncode != 0)
        check('linked invitation removal denied', role('select '+invite_call(1001,'remove'), ok=False).returncode != 0)
        for verb in ["delete from admin_operations_audit", "update admin_operations_audit set reason='tampered audit evidence'", "insert into admin_operations_audit select * from admin_operations_audit"]:
            check('admin cannot tamper: '+verb.split()[0], role(verb,ok=False).returncode != 0)
        check('service cannot tamper with audit', role('delete from admin_operations_audit',who='service_role',ok=False).returncode != 0)
        check('ordinary user still sees zero audit rows', value('(select count(*) from admin_operations_audit)', subject='user_Admin2') == 0)

        # Failed audit insertion rolls the profile AND linked invite back.
        sql("create function reject_test_audit() returns trigger language plpgsql as $$begin raise exception 'synthetic audit failure';end$$; create trigger fail_audit before insert on admin_operations_audit for each row execute function reject_test_audit()")
        state_before = profile_state(3); linked_before = invite_state(1001)
        check('audit failure refuses whole operation', role('select '+profile_call(3,'revoked'),ok=False).returncode != 0)
        check('audit failure rolls back profile and linked invite', profile_state(3) == state_before and invite_state(1001) == linked_before)
        sql('drop trigger fail_audit on admin_operations_audit;drop function reject_test_audit()')

        # Independent requests race on the same expected version; only one commits.
        snapshot = profile_state(3)
        # Two independent reviewed Pauses of the same version (pending is no longer an administrator decision).
        expressions = [profile_call(3,'revoked',snapshot,reason=reason) for reason in ['Reviewed administrative account restriction','Second reviewer paused the same account']]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            races = list(pool.map(lambda q: role('select '+q,ok=False),expressions))
        check('concurrent conflicting writes have one winner', sum(r.returncode == 0 for r in races) == 1)
        check('conflict creates no second audit', value('(select count(*) from admin_operations_audit)') == 2)
        # Concurrent replay races must return the same receipt.
        snapshot = profile_state(3); next_status = 'active'; req = uuid.uuid4(); same = profile_call(3,next_status,snapshot,req)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            repeated = list(pool.map(lambda _:value(same),range(4)))
        check('concurrent retries are idempotent', len({r['audit_id'] for r in repeated}) == 1 and sum(not r['duplicate'] for r in repeated) == 1)

        inv_original = invite_state(1002)
        paused = value(invite_call(1002,'set_status','revoked'))
        check('unlinked invitation pause is audited', paused['invite']['status'] == invite_state(1002)['status'] == 'revoked')
        check('stale invitation action denied', role('select '+invite_call(1002,'set_status','invited',inv_original),ok=False).returncode != 0)
        check('unlinked invitation cannot grant active access', role('select '+invite_call(1002,'set_status','active'),ok=False).returncode != 0)
        remove = invite_call(1003,'remove'); receipt = value(remove)
        check('unlinked invitation removal and replay retain audit', receipt['invite'] is None and value(remove)['duplicate'] is True
              and sql(f"select count(*) from beta_access where id='{pid(1003)}'").stdout.strip() == '0')
        sql(f"update beta_access set activated_at=now() where id='{pid(1002)}'")
        check('historically activated unlinked invitation cannot be removed', role('select '+invite_call(1002,'remove'),ok=False).returncode != 0)
        financial_after = sql('select jsonb_build_array((select jsonb_agg(t) from access_grants t),(select jsonb_agg(t) from billing_subscriptions t),(select jsonb_agg(t) from access_policy_settings t))').stdout
        check('billing, lifetime grants and rollout flags are unchanged', financial_before == financial_after)
        check('service-role invite provisioning stays available', role(f"update beta_access set status='invited' where id='{pid(1002)}'",who='service_role').returncode == 0)
        # The pre-existing definer self-claim still owns its write capability.
        check('self-claim RPC execute preserved', value("has_function_privilege('authenticated','public.claim_beta_access()','EXECUTE')") is True)
        check('access grant escape flag is restored after operation', role('select '+profile_call(3,'revoked')+";select coalesce(current_setting('credentialdomd.access_grant',true),'')='1'").stdout.strip().endswith('f'))
        check('unlinked invitation removal names whose invitation it was', value(f"(select before_state->>'email' from admin_operations_audit where id='{receipt['audit_id']}')") == 'remove@example.invalid'
              and value(f"(select before_state ?& array['name','lead_id','invited_by','invited_at','invite_sent_at'] from admin_operations_audit where id='{receipt['audit_id']}')") is True)

        # An administrator decides Approve or Pause, never pending (2026-09-25).
        # Pending is the state every activation path finishes (the self-claim
        # below, clerk-webhook, send-invite, bootstrap_limited_signup and the
        # billing functions), so an administrator's pending never held.
        for n, status in [(14, 'active'), (15, 'active'), (16, 'active'), (17, 'pending'), (18, 'pending'), (19, 'pending')]:
            sql(f"insert into profiles(id,auth_user_id,email,access_status) values('{pid(n)}','user_Member{n}','member{n}@example.invalid','{status}')")
        sql(f"""insert into beta_access(id,email,status,profile_id,activated_at) values
          ('{pid(1014)}','member14@example.invalid','active','{pid(14)}',now()),
          ('{pid(1015)}','member15@example.invalid','invited',null,null),
          ('{pid(1016)}','member16@example.invalid','active','{pid(16)}',now()),('{pid(1116)}','second16@example.invalid','invited',null,null),
          ('{pid(1017)}','member17@example.invalid','active','{pid(17)}',now()),
          ('{pid(1018)}','member18@example.invalid','invited',null,null)""")
        def claim(n, email=None):
            return value('claim_beta_access()', subject=f'user_Member{n}', email=email or f'member{n}@example.invalid')
        def audit_count():
            return value('(select count(*) from admin_operations_audit)')
        audits = audit_count()
        for n in [14, 15]:
            before = (profile_state(n), invite_state(1000 + n))
            refused = role('select ' + profile_call(n, 'pending'), ok=False)
            check(f'active account {n} cannot be sent to pending', refused.returncode != 0 and 'Pending is not an administrator decision' in refused.stderr
                  and (profile_state(n), invite_state(1000 + n)) == before and audit_count() == audits)
        value(profile_call(14, 'revoked'))
        check('pause revokes the linked invitation', profile_state(14)['status'] == 'revoked' and invite_state(1014)['status'] == 'revoked')
        paused = (profile_state(14), invite_state(1014)); audits = audit_count()
        check('a paused account cannot be sent to pending either', role('select ' + profile_call(14, 'pending'), ok=False).returncode != 0
              and (profile_state(14), invite_state(1014)) == paused and audit_count() == audits)
        check('a paused member cannot claim access back', claim(14) == 'revoked' and (profile_state(14), invite_state(1014)) == paused)
        # The unlinked invitation send-invite leaves for an address whose
        # account is already active: pausing does not touch it, and the self-
        # claim still refuses, because the account itself is revoked.
        value(profile_call(15, 'revoked'))
        unlinked = (profile_state(15), invite_state(1015))
        check('an unlinked invitation for the address cannot re-grant a paused account', unlinked[1]['status'] == 'invited' and unlinked[1]['profile'] is None
              and claim(15) == 'revoked' and (profile_state(15), invite_state(1015)) == unlinked and audit_count() == audits + 1)
        # A second verified address with its own unlinked invitation.
        value(profile_call(16, 'revoked'))
        second = (profile_state(16), invite_state(1016), invite_state(1116))
        check('pause revokes the linked invitation and leaves the other address unlinked', second[1]['status'] == 'revoked' and second[2]['status'] == 'invited')
        check('an invitation for another verified address cannot re-grant a paused account', claim(16, 'second16@example.invalid') == 'revoked'
              and (profile_state(16), invite_state(1016), invite_state(1116)) == second)
        # A half-applied activation (invitation stamped, profile write failed)
        # completes on the next claim instead of stranding the invitee.
        check('a consumed invitation whose profile write failed finishes activating', claim(17) == 'active' and profile_state(17)['status'] == 'active'
              and invite_state(1017)['status'] == 'active' and invite_state(1017)['profile'] == pid(17))
        check('a fresh invitation still activates on first claim', claim(18) == 'active' and profile_state(18)['status'] == 'active'
              and invite_state(1018)['status'] == 'active' and invite_state(1018)['profile'] == pid(18))
        approved = value(profile_call(14, 'active'))
        check('only an audited Approve restores access and its invitation', approved['profile']['access_status'] == 'active' and invite_state(1014)['status'] == 'active'
              and value(f"(select action from admin_operations_audit where id='{approved['audit_id']}')") == 'profile_access')
        after = value(f"(select after_state from admin_operations_audit where id='{approved['audit_id']}')")
        check('audit after_state matches the final state', after['profile']['access_status'] == profile_state(14)['status'] == 'active'
              and [i['status'] for i in after['invites']] == [invite_state(1014)['status']])
        # An account an administrator set to pending under 20260924020000 and
        # left unpaused stops the migration until someone decides it again.
        synthetic = uuid.uuid4()
        sql(f"""insert into admin_operations_audit(id,request_id,actor_profile_id,target_profile_id,action,reason,before_state,after_state,request_hash,result)
          values('{synthetic}',gen_random_uuid(),'{pid(1)}','{pid(19)}','profile_access','Synthetic legacy pending decision',
          '{{"profile":{{"access_status":"revoked"}}}}','{{"profile":{{"access_status":"pending"}}}}','synthetic','{{}}')""")
        regrant = (ROOT / 'supabase/migrations/20260925110000_admin_access_regrant_guard.sql').read_text()
        blocked = sql(regrant, ok=False)
        check('the migration refuses to apply over an administrator pending that was never re-decided', blocked.returncode != 0 and '1 account(s) were set to pending' in blocked.stderr)
        sql(f"update profiles set access_status='revoked' where id='{pid(19)}'")
        check('once that account is paused the migration applies again', sql(regrant, ok=False).returncode == 0)
        sql(f"delete from admin_operations_audit where id='{synthetic}'")

        # Attention counts behind the tab labels and the Overview cards.
        sql(f"""update profiles set admin_inbox_seen_at=now()-interval '1 hour',admin_errors_seen_at=now()-interval '1 day' where id='{pid(1)}';
          insert into admin_messages(id,sender_id,recipient_id) values('{pid(2001)}','{pid(1)}','{pid(2)}'),('{pid(2002)}','{pid(1)}',null),('{pid(2003)}','{pid(1)}','{pid(2)}');
          insert into admin_message_replies(message_id,user_id,author_id,is_admin_reply,created_at) values
            ('{pid(2001)}','{pid(2)}','{pid(2)}',false,now()),('{pid(2001)}','{pid(2)}','{pid(2)}',false,now()-interval '3 hours'),
            ('{pid(2002)}','{pid(2)}','{pid(2)}',false,now()-interval '2 hours'),('{pid(2003)}','{pid(2)}','{pid(1)}',true,now());
          insert into early_access_leads(email,waitlist) values(' Person2@Example.invalid ',true),('waiting@example.invalid',true),
            ('person4@example.invalid',true),('guide@example.invalid',false);
          insert into field_proposals(status) values('pending'),('pending'),('approved'),('dismissed');""")
        attention = value('admin_attention_counts()')
        check('attention counts unread replies, new errors, waiting leads and pending fields', attention == {'unread_replies': 1, 'new_errors_since_seen': 2, 'waitlist_waiting': 2, 'fields_pending': 2})
        check('a seen stamp the client just wrote clears the unread counts', value("admin_attention_counts(now()+interval '2 days',now()+interval '2 days')") == {'unread_replies': 0, 'new_errors_since_seen': 0, 'waitlist_waiting': 2, 'fields_pending': 2})
        check('an older client stamp never re-opens counts the profile marked seen', value("admin_attention_counts(now()-interval '30 days',now()-interval '30 days')") == attention)
        check('report carries the same attention block and stays schema 1', value('admin_operations_report(7)')['attention'] == attention and value('admin_operations_report(7)')['schema_version'] == 1)
        for who, subject in [('anon', ''), ('authenticated', 'user_Admin2')]:
            check(f'{who}:{subject or "anonymous"} cannot read attention counts', role('select admin_attention_counts()', who, subject, False).returncode != 0)
        check('attention snapshot is internal only', value("has_function_privilege('authenticated','public.admin_attention_snapshot(uuid,timestamptz,timestamptz)','EXECUTE')") is False)

        # Traffic drill-down: one row per day, raw rows through the cutover day.
        # PostgREST sessions run in UTC, which is how the view dates raw rows.
        sql('grant select on page_views,page_visits to authenticated')
        visits = json.loads(role("set local timezone='UTC';select jsonb_agg(v order by v.day desc) from admin_visits_daily v").stdout.strip())
        check('visits view counts the cutover day from both sources in one row', len({v['day'] for v in visits}) == len(visits) and visits[0]['visits'] == 1221 and visits[1]['visits'] == 1)
        check('visits view stays admin only', value("(select count(*) from admin_visits_daily)", subject='user_Admin2') == 0)

        # Reply idempotency key: one row per (ticket, key); legacy null keys unconstrained.
        ticket = sql("select id from support_tickets limit 1").stdout.strip(); key = uuid.uuid4()
        sql(f"insert into support_messages(ticket_id,body,client_request_id) values('{ticket}','first','{key}'),('{ticket}','legacy',null),('{ticket}','legacy',null)")
        check('a retried reply key cannot insert a second row', sql(f"insert into support_messages(ticket_id,body,client_request_id) values('{ticket}','again','{key}')", ok=False).returncode != 0)
        check('the same key on another ticket is independent', sql(f"insert into support_messages(ticket_id,body,client_request_id) values(gen_random_uuid(),'other','{key}')", ok=False).returncode == 0)
        print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
    finally:
        if started:
            run(BIN / 'pg_ctl', '-D', base / 'data', '-m', 'immediate', '-w', 'stop')
