-- Rolled-back proof for supabase/migrations/20260915e and 20260915g.
--
-- Opens a transaction, applies BOTH reservation migrations inside it, creates
-- one synthetic profile, exercises reserve_ai_call at and past its limit,
-- checks the grants on both ledgers and on both reserve functions, prints the
-- table and rolls the whole thing back. Nothing here touches a real account,
-- and neither migration is left applied: this file proves them, it does not
-- deploy them.
--
-- Run:
--   TOKEN=$(security find-generic-password -l "Supabase CLI" -w)
--   python3 -c 'import json,sys; print(json.dumps({"query": open(sys.argv[1]).read()}))' \
--     scripts/sql/ai-and-send-ledger-dryrun.sql > /tmp/q.json
--   curl -s -X POST \
--     "https://api.supabase.com/v1/projects/hkpnnsjcwprrwobmpqyy/database/query" \
--     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @/tmp/q.json
--
-- Result on 2026-09-15: 15 passed, 0 failed.
--
-- One of these was written after a first run FAILED, and it is the reason the
-- grant checks are here: service_role arrives holding SELECT, INSERT, UPDATE,
-- DELETE, TRUNCATE, REFERENCES and TRIGGER on a new table in this schema, from
-- the project's default privileges. DELETE on a ledger, held by the role the
-- edge function runs as, is the same defect one layer up. Both migrations now
-- revoke and re-grant exactly SELECT and INSERT, and these two checks are what
-- noticed.

begin;
create temp table probe_out(name text, expected text, actual text, verdict text) on commit drop;
insert into public.profiles (id, auth_user_id, email, access_status) values
  ('cccc0000-0000-4000-8000-000000000001','probe_ai_user','probe-ai@example.invalid','active');
-- An admission ledger for the AI proxy, so the limits are decided in one
-- statement instead of two (2026-09-15, review of item 7).
--
-- WHAT WAS WRONG
--
-- ai-proxy's daily Anthropic cap read:
--
--   const used = await usedToday("anthropic");
--   if (used >= ANTHROPIC_DAILY_LIMIT) return 429;
--
-- which is a count, then a decision, then eventually an insert. Two calls
-- arriving together both read 59 and both go upstream. The same shape as the
-- send throttle before 20260915e: count-then-trust. It also had no answer at
-- all for a count that FAILED: the query error was discarded, `count` came
-- back undefined, `used` became 0, and the call went through. The cheapest way
-- to an unlimited Opus budget on the operator's key was to make the count
-- fail.
--
-- Gemini had the opposite problem and it is deliberate: no volume limit,
-- because Gemini is the floor the whole app falls back to and a daily cutoff
-- there stops a physician working for the rest of the UTC day. That stays. But
-- "no daily cap" was also "no bound at all", and a runaway client loop can
-- make thousands of calls a minute. The answer is a SHORT window: a burst
-- ceiling measured in seconds, which a person using the app never reaches and
-- a loop hits immediately, and which clears itself a minute later without
-- anybody being locked out of anything.
--
-- WHAT THIS IS
--
-- One table, one function, the same shape as public.send_reservations and
-- public.reserve_send. The table has RLS on, no policy and no grants beyond an
-- explicit one to service_role, so the account the limits bound cannot read or
-- delete the evidence they are read from. ai_usage is NOT touched: it stays
-- the cost and visibility ledger, written after the call with the provider's
-- own usage numbers, and the physician may keep reading it.
--
-- Additive: one new table, one new function, no existing object altered, no
-- data touched. NOT yet applied to hkpnnsjcwprrwobmpqyy.
--
-- APPLY THIS BEFORE DEPLOYING ai-proxy. Until it is applied the proxy answers
-- 503 with code ai_accounting_unavailable and a Retry-After, and sends
-- nothing. That is the deliberate direction after review: an earlier draft of
-- the send throttle let an unavailable ledger through, and "break the ledger"
-- must not be the cheapest route to an unmetered budget. In the right order
-- there is no window at all.

-- ─── The ledger ──────────────────────────────────────────────────────────────
create table if not exists public.ai_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- 'anthropic' for the daily cap, 'gemini_burst' for the short window. One
  -- column so a third limit needs no migration.
  scope text not null,
  created_at timestamptz not null default now()
);

-- The only query this table serves: rows for one user and one scope inside a
-- window. Descending so the window scan stops early.
create index if not exists ai_reservations_user_scope_created_idx
  on public.ai_reservations (user_id, scope, created_at desc);

alter table public.ai_reservations enable row level security;
revoke all on table public.ai_reservations from public;
revoke all on table public.ai_reservations from anon;
revoke all on table public.ai_reservations from authenticated;

-- Named explicitly rather than left to inheritance, for the same reason the
-- grant on send_reservations is: BYPASSRLS is about policies, not privileges,
-- reserve_ai_call is SECURITY INVOKER so it runs with exactly service_role's
-- own rights, and the revokes above strip PUBLIC.
-- Append-only for the role that writes it. service_role arrives holding ALL
-- privileges on a new table in this schema, from the project's default
-- privileges (measured: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
-- TRIGGER), and DELETE on a ledger is the whole defect this table exists to
-- close, one layer up: the edge function runs as service_role, so a bug there
-- could clear the evidence the limit is read from exactly the way the
-- physician used to be able to. It only ever inserts and counts, so it is
-- given only those two. Pruning is public.prune_ai_reservations, which is
-- SECURITY DEFINER owned by postgres and is unaffected.
revoke all on table public.ai_reservations from service_role;
grant select, insert on table public.ai_reservations to service_role;

comment on table public.ai_reservations is
  'Admission ledger for ai-proxy. One row per call that passed a limit, written by reserve_ai_call() with the service role. RLS on, no policy, no grants to anon or authenticated: the account the limits bound can neither read nor delete it. ai_usage stays the cost ledger and the physician-facing history.';

-- ─── The reservation: count and insert in one statement ──────────────────────
-- Returns the new reservation id when the caller was under the limit, NULL
-- when they were at or over it. An exception is the caller's problem to
-- handle; ai-proxy turns it into a retryable 503 and makes no upstream call.
--
-- The advisory lock is what makes the pair atomic under READ COMMITTED, where
-- two concurrent transactions each take a snapshot at statement start and
-- neither sees the other's uncommitted row. It is keyed per user AND per
-- scope, so a physician's Opus call never waits on their own Gemini burst
-- check, and one physician never waits on another.
create or replace function public.reserve_ai_call(
  p_user uuid, p_scope text, p_limit integer, p_since timestamptz
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('public.reserve_ai_call:' || p_scope), hashtext(p_user::text));

  insert into public.ai_reservations (user_id, scope)
  select p_user, p_scope
  where (
    select count(*)
      from public.ai_reservations r
     where r.user_id = p_user
       and r.scope = p_scope
       and r.created_at >= p_since
  ) < p_limit
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.reserve_ai_call(uuid, text, integer, timestamptz) from public;
revoke all on function public.reserve_ai_call(uuid, text, integer, timestamptz) from anon;
revoke all on function public.reserve_ai_call(uuid, text, integer, timestamptz) from authenticated;
grant execute on function public.reserve_ai_call(uuid, text, integer, timestamptz) to service_role;

comment on function public.reserve_ai_call(uuid, text, integer, timestamptz) is
  'Atomically reserve one AI call for p_user under p_scope if fewer than p_limit reservations exist since p_since. Returns the reservation id, or NULL at or over the limit. Count and insert are one statement behind a per-user, per-scope transaction advisory lock, so two concurrent calls at the boundary cannot both pass. Service role only; called by ai-proxy.';

-- ─── Pruning ─────────────────────────────────────────────────────────────────
-- The burst scope writes a row per Gemini call and nothing reads a row older
-- than a minute, so this table grows where send_reservations trickles. It is
-- pruned on the same schedule and in the same way as the other prune_* jobs
-- rather than by letting the edge function delete rows, which would hand the
-- writer a way to clear its own ledger.
create or replace function public.prune_ai_reservations()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.ai_reservations where created_at < now() - interval '3 days';
$$;
revoke all on function public.prune_ai_reservations() from public;
revoke all on function public.prune_ai_reservations() from anon;
revoke all on function public.prune_ai_reservations() from authenticated;
grant execute on function public.prune_ai_reservations() to postgres, service_role;

-- Scheduled the way the other prunes are. Wrapped so applying this file on a
-- database without pg_cron is not an error.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('prune-ai-reservations')
      where exists (select 1 from cron.job where jobname = 'prune-ai-reservations');
    perform cron.schedule('prune-ai-reservations', '17 4 * * *', 'select public.prune_ai_reservations()');
  else
    raise notice 'pg_cron not installed; prune_ai_reservations() exists but is not scheduled';
  end if;
end $$;

notify pgrst, 'reload schema';
-- The email send throttle gets a ledger its subject cannot edit (2026-09-15).
--
-- send-packet-email limits a physician to 30 emailed packets per hour. It
-- counted the rows it had written to public.share_log:
--
--   select count(*) from share_log
--    where user_id = <caller> and method = 'email' and sent_at >= now() - 1 hour
--
-- share_log carries exactly one policy. Measured on this database before
-- writing any of this:
--
--   share_log_owner | polcmd '*' (FOR ALL) | to authenticated
--                   | using (user_id = current_profile_id())
--
-- FOR ALL includes DELETE, so the account the cap is meant to bound could
-- delete its own share_log rows straight through PostgREST and the next count
-- started again at zero. Thirty sends per hour became thirty sends per delete.
-- Sign-up is open on the dev Clerk instance, so "signed in" is not a trust
-- boundary and that is a stranger's send budget, over our sending domain,
-- with a physician's name in the From: header.
--
-- The rule this fixes: the subject of a limit must not be able to edit the
-- evidence the limit is read from. So the count moves off share_log onto a
-- table that has RLS on, no policy for anon or authenticated, and no grants,
-- which leaves the service role (rolbypassrls = true, checked above) as the
-- only writer and the only reader. share_log is NOT touched: it is the
-- physician's own sharing history, they should be able to prune it, and it is
-- no longer load bearing.
--
-- The second half is the race. A count followed by an insert is two
-- statements, and two taps arriving together both read 29 and both send. The
-- count and the insert are now ONE statement inside reserve_send(), behind a
-- per-user transaction advisory lock so the second caller waits for the first
-- to commit rather than reading around it. "No row returned" is the only
-- over-cap answer; there is no separate count for the caller to disagree with.
--
-- Additive: one new table, one new function, no existing object altered, no
-- data touched. NOT yet applied to hkpnnsjcwprrwobmpqyy.
--
-- Note for whoever applies it: until this is applied, send-packet-email
-- REFUSES, with 503 and code send_ledger_unavailable, and says to try again in
-- a minute. Nothing is fetched, claimed or mailed on that branch.
--
-- An earlier draft of this pair had the function send anyway when the ledger
-- was missing, on the reasoning that this is how a physician answers a
-- credentialer holding up a start date. Review was right that it inverted the
-- control: the throttle bounds how much mail one account can send over our
-- sending domain with a physician's name in the From: header, and the branch
-- fires on any RPC error, so "make the ledger unavailable" became the cheapest
-- route to an unmetered send budget. The ordering consequence is the real
-- point of this note: APPLY THIS MIGRATION BEFORE DEPLOYING THE FUNCTION. In
-- that order there is no window at all. In the other order, sends refuse
-- retryably until the migration lands.

-- ─── The ledger ──────────────────────────────────────────────────────────────
create table if not exists public.send_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- One column so a second throttled channel (SMS, fax) can share the table
  -- without a migration. Only 'email' is written today.
  method text not null default 'email',
  created_at timestamptz not null default now()
);

-- The only query this table serves: rows for one user, one method, inside the
-- window. Descending on created_at so the window scan stops early.
create index if not exists send_reservations_user_method_created_idx
  on public.send_reservations (user_id, method, created_at desc);

-- RLS on with NO policy at all. A table with RLS enabled and no policy returns
-- nothing and accepts nothing for every role that does not bypass RLS, which
-- is anon and authenticated. The grants go too, because in a stock Supabase
-- project PUBLIC already holds them and revoking from anon and authenticated
-- alone leaves the grant sitting on PUBLIC.
alter table public.send_reservations enable row level security;
revoke all on table public.send_reservations from public;
revoke all on table public.send_reservations from anon;
revoke all on table public.send_reservations from authenticated;

-- Granted explicitly rather than left to inheritance. service_role does carry
-- rolbypassrls, but BYPASSRLS is about policies, not about privileges: a role
-- still needs a table grant to read or write. In a stock project that grant
-- arrives from the schema-wide "grant all ... to service_role" and the default
-- privileges that follow it, so this table would probably have been covered --
-- and "probably" is the problem, because the revokes above deliberately strip
-- PUBLIC, and reserve_send is SECURITY INVOKER, so it runs with exactly
-- service_role's own privileges and nothing else. If the inheritance were ever
-- not there, every send would fail closed with a permission error, which is
-- now a 503 rather than a silent send. Naming the grant removes the question.
-- Append-only for the role that writes it. service_role arrives holding ALL
-- privileges on a new table in this schema, from the project's default
-- privileges (measured: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
-- TRIGGER), and DELETE on a ledger is the whole defect this table exists to
-- close, one layer up: the edge function runs as service_role, so a bug there
-- could clear the evidence the limit is read from exactly the way the
-- physician used to be able to. It only ever inserts and counts, so it is
-- given only those two. Pruning is public.a scheduled job, which is
-- SECURITY DEFINER owned by postgres and is unaffected.
revoke all on table public.send_reservations from service_role;
grant select, insert on table public.send_reservations to service_role;

comment on table public.send_reservations is
  'Immutable send ledger for the send-packet-email hourly cap. One row per send attempt that passed the cap, written by reserve_send() with the service role. RLS on, no policy, no grants: the physician the cap bounds can neither read nor delete it. This exists because the cap used to count share_log, and share_log_owner is FOR ALL to authenticated, so its subject could delete the evidence and reset the hour. share_log stays as the physician-facing history.';

-- ─── The reservation: count and insert in one statement ──────────────────────
-- Returns the new reservation id when the caller was under the cap, NULL when
-- they were at or over it. The caller treats NULL as over the cap (429) and an
-- error as the ledger being unavailable (503, retryable). Neither answer
-- sends.
--
-- Why the advisory lock: the INSERT ... SELECT below is a single statement, but
-- under READ COMMITTED two concurrent transactions each take their snapshot at
-- statement start and neither sees the other's uncommitted row, so both can
-- read 29 and both can insert. pg_advisory_xact_lock serialises the pair for
-- this one user_id and is released when the transaction ends, so the second
-- caller counts 30 and gets NULL. It is keyed per user, so one physician's
-- sends never wait on another's.
--
-- security invoker, not definer: the only role with EXECUTE is service_role,
-- which already bypasses RLS on the table. A definer here would be an
-- escalation with nothing to gain.
create or replace function public.reserve_send(p_user uuid, p_limit integer, p_since timestamptz)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('public.reserve_send'), hashtext(p_user::text));

  insert into public.send_reservations (user_id, method)
  select p_user, 'email'
  where (
    select count(*)
      from public.send_reservations r
     where r.user_id = p_user
       and r.method = 'email'
       and r.created_at >= p_since
  ) < p_limit
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.reserve_send(uuid, integer, timestamptz) from public;
revoke all on function public.reserve_send(uuid, integer, timestamptz) from anon;
revoke all on function public.reserve_send(uuid, integer, timestamptz) from authenticated;
grant execute on function public.reserve_send(uuid, integer, timestamptz) to service_role;

comment on function public.reserve_send(uuid, integer, timestamptz) is
  'Atomically reserve one send for p_user if fewer than p_limit reservations exist since p_since. Returns the reservation id, or NULL when the caller is at or over the cap. Count and insert are one statement behind a per-user transaction advisory lock, so two concurrent sends at the boundary cannot both pass. Service role only; called by send-packet-email.';

-- Rows older than the window are dead weight, not evidence: nothing reads them
-- once the hour has passed. They are left in place on purpose for now so a
-- first look at abuse has something to look at. If this table ever grows
-- enough to matter, prune it the way prune_page_visits() is pruned rather than
-- letting the edge function delete rows, which would hand the writer a way to
-- clear its own ledger and put us back where we started.

notify pgrst, 'reload schema';

create function pg_temp.rec(p_name text, p_expected text, p_actual text) returns void language sql as $f$
  insert into pg_temp.probe_out values (p_name, p_expected, p_actual,
    case when p_expected = p_actual then 'PASS' else 'FAIL' end);
$f$;

-- Under the limit: three reservations of a limit of 3.
select pg_temp.rec('1st of 3 is reserved', 'reserved',
  case when public.reserve_ai_call('cccc0000-0000-4000-8000-000000000001','probe_scope',3, now() - interval '1 minute') is null then 'refused' else 'reserved' end);
select pg_temp.rec('2nd of 3 is reserved', 'reserved',
  case when public.reserve_ai_call('cccc0000-0000-4000-8000-000000000001','probe_scope',3, now() - interval '1 minute') is null then 'refused' else 'reserved' end);
select pg_temp.rec('3rd of 3 is reserved', 'reserved',
  case when public.reserve_ai_call('cccc0000-0000-4000-8000-000000000001','probe_scope',3, now() - interval '1 minute') is null then 'refused' else 'reserved' end);
select pg_temp.rec('4th is refused', 'refused',
  case when public.reserve_ai_call('cccc0000-0000-4000-8000-000000000001','probe_scope',3, now() - interval '1 minute') is null then 'refused' else 'reserved' end);

-- A different scope has its own budget: the burst window must not spend the daily cap.
select pg_temp.rec('a different scope is independent', 'reserved',
  case when public.reserve_ai_call('cccc0000-0000-4000-8000-000000000001','other_scope',1, now() - interval '1 minute') is null then 'refused' else 'reserved' end);

-- A window that starts after the rows were written sees none of them.
select pg_temp.rec('a fresh window starts empty again', 'reserved',
  case when public.reserve_ai_call('cccc0000-0000-4000-8000-000000000001','probe_scope',3, now() + interval '1 second') is null then 'refused' else 'reserved' end);

-- Rows landed, and only for this user and scope.
select pg_temp.rec('the ledger holds what was reserved', '4',
  (select count(*)::text from public.ai_reservations
    where user_id='cccc0000-0000-4000-8000-000000000001' and scope='probe_scope'));

-- Grants: anon and authenticated hold nothing on either ledger.
select pg_temp.rec('anon/authenticated hold no privilege on ai_reservations', '0',
  (select count(*)::text from information_schema.role_table_grants
    where table_schema='public' and table_name='ai_reservations' and grantee in ('anon','authenticated')));
select pg_temp.rec('anon/authenticated hold no privilege on send_reservations', '0',
  (select count(*)::text from information_schema.role_table_grants
    where table_schema='public' and table_name='send_reservations' and grantee in ('anon','authenticated')));
select pg_temp.rec('service_role can read and write ai_reservations', 'SELECT,INSERT',
  (select string_agg(privilege_type, ',' order by privilege_type='SELECT' desc) from information_schema.role_table_grants
    where table_schema='public' and table_name='ai_reservations' and grantee='service_role'));
select pg_temp.rec('service_role can read and write send_reservations', 'SELECT,INSERT',
  (select string_agg(privilege_type, ',' order by privilege_type='SELECT' desc) from information_schema.role_table_grants
    where table_schema='public' and table_name='send_reservations' and grantee='service_role'));
select pg_temp.rec('RLS is on with no policy at all (ai)', 'true|0',
  (select relrowsecurity::text from pg_class where oid='public.ai_reservations'::regclass) || '|' ||
  (select count(*)::text from pg_policies where schemaname='public' and tablename='ai_reservations'));
select pg_temp.rec('neither reserve function is granted to a user role', '0',
  (select count(*)::text from pg_proc p
    where p.pronamespace='public'::regnamespace and p.proname in ('reserve_ai_call','reserve_send')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));
select pg_temp.rec('both reserve functions are executable by service_role', '2',
  (select count(*)::text from pg_proc p
    where p.pronamespace='public'::regnamespace and p.proname in ('reserve_ai_call','reserve_send')
      and has_function_privilege('service_role', p.oid, 'execute')));
select pg_temp.rec('the prune job is not a user-callable function', '0',
  (select count(*)::text from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='prune_ai_reservations'
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));

select name, expected, actual, verdict from pg_temp.probe_out;
rollback;
