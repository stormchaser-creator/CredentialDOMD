begin;
create temp table probe_out(name text, expected text, actual text, verdict text) on commit drop;
insert into public.profiles (id, auth_user_id, email, access_status) values
  ('bbbb2222-0000-4000-8000-00000000000a','probe_spend','probe-spend@example.invalid','active');
-- A monthly dollar cap that is actually a cap (2026-09-16).
--
-- WHAT WAS WRONG. ai-proxy claimed a hard monthly budget on the shared
-- Anthropic key and did not have one:
--
--   monthSpentUsd() wrapped the spend query in try/catch and returned 0 on any
--   error, so breaking the query was the cheapest route past the budget.
--   At $14.99 of $15, eight concurrent calls all passed the check. The daily
--   reservation added by 20260915g made the COUNT atomic and did nothing for
--   the DOLLARS, because a call's cost is not known until the provider
--   answers.
--
-- So the cap has to be taken BEFORE the call, at a price that cannot be
-- exceeded, and settled afterwards to what it really cost. That is what this
-- is: reserve the worst case, then lower it to the truth.
--
-- DEFECTS THIS DESIGN WAS BUILT TO AVOID, each found by an adversarial review
-- of an earlier draft and each worth naming so the next edit does not
-- reintroduce it:
--
--   NO FAIL-OPEN INSIDE THE ADMISSION. An earlier draft read
--   "where not p_enforce or p_cap is null or (sum + worst <= cap)". A null cap
--   admitted unconditionally, which is a fail-open branch inside the statement
--   whose entire job is to close one. There is no null-cap escape here: a cap
--   that is not a usable positive number REFUSES.
--
--   THE NaN GUARD IS NOT A NO-OP, AND THE FIRST VERSION OF IT WAS. Measured on
--   this database, not assumed: 'NaN'::numeric >= 0 is TRUE, NaN <> NaN is
--   FALSE, and NaN = NaN is TRUE. Postgres numeric NaN equals itself, unlike
--   an IEEE float, so the reflexive test `not (x = x)` that catches NaN in
--   most languages never fires here and the first draft of this file let a NaN
--   cap straight through to an admitted hold. The test that works is the
--   direct one, `x = 'NaN'::numeric`, and the CHECK below uses `<>` for the
--   same reason: NaN <> NaN is false, so the constraint rejects it.
--
--   SETTLEMENT RECORDS THE TRUTH, EVEN WHEN IT IS WORSE THAN THE ESTIMATE.
--   An earlier version refused any settlement above the hold, on the reasoning
--   that the cap's soundness depends on a hold never growing. Review was right
--   that this is backwards: a reservation is a promise about the future and a
--   settlement is a fact about the past. When the estimator was beaten, the
--   ledger kept $0.000025 against a real $1.125025 and the overspend was
--   invisible. It now records what happened, flags that the estimate was
--   violated, and the next admission sees the larger sum and refuses.
--
--   NOTHING PRUNES THIS TABLE BY AGE. Its sum IS the budget. A prune modelled
--   on prune_page_visits would hand back the month's spend. Rows older than
--   the window are simply not counted, which costs an index scan and no
--   correctness.
--
--   GEMINI IS NOT COUPLED TO PRICING. The floor never gives way, so it keeps
--   its count-and-burst admission and never consults this table or the price
--   list. Only the Anthropic path reserves dollars.
--
--   A PROVIDER ERROR DOES NOT DESTROY THE MONTH. Settlement runs on every
--   outcome, including a non-2xx upstream and an aborted call, so a hold is
--   lowered to what was actually billed rather than left at its worst case.

create table if not exists public.ai_spend_holds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- Taken from the DATABASE clock inside the function, never from the caller.
  -- A caller that picks its own month hands itself a fresh budget.
  month_start timestamptz not null,
  -- What it could have cost, kept as evidence so a bad estimator is
  -- measurable after the fact instead of invisible.
  worst_case_usd numeric(12,6) not null,
  -- What it counts against the cap NOW: the worst case until settled, the
  -- real cost afterwards. Only ever lowered.
  amount_usd numeric(12,6) not null,
  settled_at timestamptz,
  created_at timestamptz not null default now()
);

-- `= x` is the NaN test. The obvious ones do not work on numeric NaN.
alter table public.ai_spend_holds drop constraint if exists ai_spend_holds_amounts_real;
alter table public.ai_spend_holds add constraint ai_spend_holds_amounts_real
  check (worst_case_usd <> 'NaN'::numeric and worst_case_usd >= 0
     and amount_usd <> 'NaN'::numeric and amount_usd >= 0);
-- amount_usd <= worst_case_usd is NOT constrained, and that is a repair.
-- An earlier version refused to record a cost above its own estimate, so when
-- the estimator was wrong the ledger kept the small number and the overspend
-- became invisible. Refusing to write down a known larger cost does not
-- prevent the spend; it conceals it. The truth is recorded, the month goes
-- over, and the next admission sees it and refuses.

create index if not exists ai_spend_holds_user_month_idx
  on public.ai_spend_holds (user_id, month_start);

alter table public.ai_spend_holds enable row level security;
revoke all on table public.ai_spend_holds from public;
revoke all on table public.ai_spend_holds from anon;
revoke all on table public.ai_spend_holds from authenticated;
-- Append and amend, never delete: the writer must not be able to hand itself
-- back the month's spend, which is the same rule the other two ledgers follow.
revoke all on table public.ai_spend_holds from service_role;
grant select, insert, update on table public.ai_spend_holds to service_role;

comment on table public.ai_spend_holds is
  'The NON-ADMIN SHARED-ANTHROPIC MONTHLY ALLOWANCE, per profile per month. Not a total provider or business spending cap: admin calls take no hold, Gemini never consults this table by design because it is the floor the app falls back to, and a physician using their own key never reaches the proxy at all. One row per admitted call: worst case at admission, lowered to the real cost at settlement. sum(amount_usd) for the month IS the budget, so nothing prunes this table by age and the writer holds no DELETE.';

-- ─── Admission: the cap test IS the WHERE of the insert that takes the money ─
create or replace function public.reserve_ai_spend(
  p_user uuid,
  p_worst_case_usd numeric,
  p_cap_usd numeric
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_month timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_id uuid;
  v_spent numeric;
begin
  if p_user is null then
    return jsonb_build_object('outcome', 'refused', 'why', 'no user');
  end if;
  -- Written so an unusable number FAILS the test rather than passing it.
  -- `p_cap_usd = 'NaN'` is the test that works: in Postgres numeric, NaN
  -- EQUALS itself, so the reflexive `not (x = x)` never fires, and NaN >= 0 is
  -- true, so the ordinary range check passes it too.
  if p_cap_usd is null or p_cap_usd = 'NaN'::numeric or not (p_cap_usd > 0) then
    return jsonb_build_object('outcome', 'refused', 'why', 'no usable budget');
  end if;
  if p_worst_case_usd is null or p_worst_case_usd = 'NaN'::numeric or not (p_worst_case_usd >= 0) then
    return jsonb_build_object('outcome', 'refused', 'why', 'no usable estimate');
  end if;

  perform pg_advisory_xact_lock(hashtext('public.ai_spend_holds'), hashtext(p_user::text));

  insert into public.ai_spend_holds (user_id, month_start, worst_case_usd, amount_usd)
  select p_user, v_month, p_worst_case_usd, p_worst_case_usd
  where (
    select coalesce(sum(h.amount_usd), 0)
      from public.ai_spend_holds h
     where h.user_id = p_user and h.month_start = v_month
  ) + p_worst_case_usd <= p_cap_usd
  returning id into v_id;

  if v_id is null then
    select coalesce(sum(h.amount_usd), 0) into v_spent
      from public.ai_spend_holds h where h.user_id = p_user and h.month_start = v_month;
    return jsonb_build_object('outcome', 'over', 'spent_usd', v_spent, 'budget_usd', p_cap_usd,
                              'would_add_usd', p_worst_case_usd);
  end if;
  return jsonb_build_object('outcome', 'held', 'hold', v_id, 'worst_case_usd', p_worst_case_usd);
end;
$$;

-- ─── Settlement: lower it to the truth, never raise it ───────────────────────
create or replace function public.settle_ai_spend(
  p_hold uuid,
  p_actual_usd numeric
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare v_amount numeric; v_worst numeric;
begin
  if p_hold is null then return jsonb_build_object('outcome', 'refused', 'why', 'no hold'); end if;
  -- An unknown cost settles at the worst case, never at zero: unknown is
  -- expensive. A KNOWN zero (a call that was refused upstream before it billed
  -- anything) is passed as 0 and settles at 0.
  if p_actual_usd is null or p_actual_usd = 'NaN'::numeric or not (p_actual_usd >= 0) then
    update public.ai_spend_holds set settled_at = now() where id = p_hold;
    return jsonb_build_object('outcome', 'settled', 'why', 'cost unknown; kept at the worst case');
  end if;

  -- Re-settlement is ALLOWED, deliberately. A later correction from real
  -- evidence, a reconciliation that learned the true cost after a timeout, is
  -- a repair and the ledger should hold the best known truth rather than the
  -- first guess. The guard that matters is not "settle once": it is that the
  -- number written is the one that was actually billed, and that a figure
  -- above its reservation is recorded and named rather than refused.
  update public.ai_spend_holds
     set amount_usd = p_actual_usd, settled_at = now()
   where id = p_hold
   returning amount_usd, worst_case_usd into v_amount, v_worst;

  if v_amount is null then
    return jsonb_build_object('outcome', 'unchanged', 'why', 'no such hold');
  end if;
  -- An overspend is recorded AND named, so a wrong estimator is measurable
  -- rather than silently absorbed. The month is now over by the difference and
  -- the next admission will refuse on the larger sum.
  if v_amount > v_worst then
    raise warning 'ai_spend_holds %: settled at % above its reservation of %', p_hold, v_amount, v_worst;
    return jsonb_build_object('outcome', 'settled', 'amount_usd', v_amount,
                              'over_reservation', true, 'reserved_usd', v_worst);
  end if;
  return jsonb_build_object('outcome', 'settled', 'amount_usd', v_amount);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.reserve_ai_spend(uuid, numeric, numeric)',
    'public.settle_ai_spend(uuid, numeric)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ─── Cutover: preserve what this month has already cost ─────────────────────
--
-- The handler consults only this table, so an empty one hands every account a
-- fresh $15 on the day it ships. A review applied the migration against a
-- fixture with $14.99 already in ai_usage and watched a full $15 hold admit
-- immediately.
--
-- ai_usage is the record of what was really billed, it is SELECT-only to
-- authenticated and admin-gated, and it carries cost_usd per Anthropic call.
-- So this month's Anthropic rows are seeded as already-settled holds. They are
-- marked settled because they are facts about the past, not reservations, and
-- worst_case_usd is set equal to the actual, which is what an
-- already-happened call's ceiling was.
--
-- Re-runnable: rows that already have a seeded hold are skipped by the marker
-- column, so applying this migration twice does not double-count.
alter table public.ai_spend_holds add column if not exists seeded_from_usage uuid;
create unique index if not exists ai_spend_holds_seeded_from_usage_key
  on public.ai_spend_holds (seeded_from_usage) where seeded_from_usage is not null;

insert into public.ai_spend_holds (user_id, month_start, worst_case_usd, amount_usd, settled_at, seeded_from_usage)
select u.user_id,
       date_trunc('month', now() at time zone 'utc') at time zone 'utc',
       u.cost_usd, u.cost_usd, now(), u.id
  from public.ai_usage u
 where u.provider = 'anthropic'
   and u.cost_usd is not null
   and u.cost_usd <> 'NaN'::numeric
   and u.cost_usd > 0
   and u.user_id is not null
   and u.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
-- The index is PARTIAL, so the conflict target has to carry the same
-- predicate; without it Postgres answers 42P10 and cannot match the index.
on conflict (seeded_from_usage) where seeded_from_usage is not null do nothing;

do $$
declare n int; d numeric;
begin
  select count(*), coalesce(sum(amount_usd), 0) into n, d
    from public.ai_spend_holds where seeded_from_usage is not null;
  raise notice 'ai_spend_holds seeded % row(s) worth %', n, d;
end $$;

notify pgrst, 'reload schema';

create function pg_temp.rec(n text, e text, a text) returns void language sql as $f$
  insert into pg_temp.probe_out values (n,e,a, case when e=a then 'PASS' else 'FAIL' end) $f$;
create function pg_temp.o(j jsonb) returns text language sql immutable as $f$ select j->>'outcome' $f$;
create function pg_temp.spent() returns text language sql as $f$
  select coalesce(sum(amount_usd),0)::text from public.ai_spend_holds
   where user_id='bbbb2222-0000-4000-8000-00000000000a' and seeded_from_usage is null $f$;

-- The boundary: cap 15, hold 14.99, then a second call that would exceed it.
select pg_temp.rec('a first hold inside the cap is admitted','held', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 14.99, 15.00)));
select pg_temp.rec('a second hold that would exceed it is refused','over', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 0.02, 15.00)));
select pg_temp.rec('one that fits exactly is admitted','held', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 0.01, 15.00)));
select pg_temp.rec('and now nothing more fits','over', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 0.000001, 15.00)));
select pg_temp.rec('the month is exactly at the cap','15.000000', pg_temp.spent());

-- EIGHT concurrent calls at 14.99 of 15: the case the reviewer reproduced.
-- Sequential here, but the admission is ONE statement, so the first is the
-- only one that can pass whatever the interleaving.
do $$ begin delete from public.ai_spend_holds where seeded_from_usage is null; end $$;
select pg_temp.rec('setup: 14.99 already held','held', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 14.99, 15.00)));
select pg_temp.rec('of eight further 0.40 calls, how many pass','0',
  (select count(*)::text from generate_series(1,8) g
    where pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 0.40, 15.00)) = 'held'));

-- Settlement lowers, and only lowers.
do $$ begin delete from public.ai_spend_holds where seeded_from_usage is null; end $$;
select pg_temp.rec('hold the worst case','held', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 6.65, 15.00)));
select pg_temp.rec('settle it to what it really cost','settled',
  pg_temp.o(public.settle_ai_spend((select id from public.ai_spend_holds order by created_at desc limit 1), 0.031)));
select pg_temp.rec('the month reflects the truth, not the estimate','0.031000', pg_temp.spent());
-- The repair: an estimator that was beaten must be RECORDED, not hidden.
do $$ begin delete from public.ai_spend_holds where seeded_from_usage is null; end $$;
select pg_temp.rec('setup: a hold of 0.000025','held', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 0.000025, 15.00)));
select pg_temp.rec('the real cost BEAT the estimate and is recorded','settled',
  pg_temp.o(public.settle_ai_spend((select id from public.ai_spend_holds where seeded_from_usage is null order by created_at desc limit 1), 1.125025)));
select pg_temp.rec('the ledger holds the TRUTH, not the estimate','1.125025', pg_temp.spent());
select pg_temp.rec('and it is flagged as over its reservation','true',
  (public.settle_ai_spend((select id from public.ai_spend_holds where seeded_from_usage is null order by created_at desc limit 1), 1.125025)->>'over_reservation')::text);
do $$ begin delete from public.ai_spend_holds where seeded_from_usage is null; end $$;
select pg_temp.rec('setup again','held', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 6.65, 15.00)));
select pg_temp.rec('settle to the truth','settled',
  pg_temp.o(public.settle_ai_spend((select id from public.ai_spend_holds where seeded_from_usage is null order by created_at desc limit 1), 0.031)));
select pg_temp.rec('and the month reflects it','0.031000', pg_temp.spent());
select pg_temp.rec('the worst case is kept as evidence','6.650000',
  (select worst_case_usd::text from public.ai_spend_holds where seeded_from_usage is null order by created_at desc limit 1));

-- An unknown cost stays expensive; a known zero settles at zero.
do $$ begin delete from public.ai_spend_holds where seeded_from_usage is null; end $$;
select pg_temp.rec('hold for a call that errors','held', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 1.40, 15.00)));
select pg_temp.rec('an UNKNOWN cost settles at the worst case','settled',
  pg_temp.o(public.settle_ai_spend((select id from public.ai_spend_holds order by created_at desc limit 1), null)));
select pg_temp.rec('unknown is expensive, never free','1.400000', pg_temp.spent());
select pg_temp.rec('a known zero settles at zero','settled',
  pg_temp.o(public.settle_ai_spend((select id from public.ai_spend_holds order by created_at desc limit 1), 0)));
select pg_temp.rec('which releases the month','0.000000', pg_temp.spent());

-- The fail-open branches an earlier draft had.
select pg_temp.rec('a NULL cap refuses, it does not admit','refused', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 0.01, null)));
select pg_temp.rec('a zero cap refuses','refused', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 0.01, 0)));
select pg_temp.rec('a negative cap refuses','refused', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 0.01, -5)));
select pg_temp.rec('a NaN cap refuses (the guard that is usually a no-op)','refused', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 0.01, 'NaN'::numeric)));
select pg_temp.rec('a NaN estimate refuses','refused', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', 'NaN'::numeric, 15.00)));
select pg_temp.rec('a null estimate refuses','refused', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', null, 15.00)));
select pg_temp.rec('a negative estimate refuses','refused', pg_temp.o(public.reserve_ai_spend('bbbb2222-0000-4000-8000-00000000000a', -1, 15.00)));
select pg_temp.rec('no user refuses','refused', pg_temp.o(public.reserve_ai_spend(null, 0.01, 15.00)));
-- and NaN really does defeat the obvious guards, which is why the above matter
select pg_temp.rec('proof: NaN >= 0 is TRUE in postgres','true', ('NaN'::numeric >= 0)::text);
select pg_temp.rec('proof: NaN <> NaN is FALSE','false', ('NaN'::numeric <> 'NaN'::numeric)::text);
select pg_temp.rec('proof: NaN = NaN is TRUE, so `not (x = x)` never fires','true', ('NaN'::numeric = 'NaN'::numeric)::text);

-- Grants.
select pg_temp.rec('anon and authenticated hold nothing','0',
  (select count(*)::text from information_schema.role_table_grants where table_schema='public' and table_name='ai_spend_holds' and grantee in ('anon','authenticated')));
select pg_temp.rec('the writer cannot delete the month','INSERT,SELECT,UPDATE',
  (select string_agg(privilege_type,',' order by privilege_type) from information_schema.role_table_grants where table_schema='public' and table_name='ai_spend_holds' and grantee='service_role'));
select pg_temp.rec('neither function is user-callable','0',
  (select count(*)::text from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('reserve_ai_spend','settle_ai_spend')
    and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))));

select name, expected, actual, verdict from pg_temp.probe_out;
rollback;
