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
