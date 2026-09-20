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
