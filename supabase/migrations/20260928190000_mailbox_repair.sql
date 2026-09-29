-- Mailbox repair (2026-09-28): three findings from the 2026-09-28 review.
--
-- 1. GRANTS. Supabase's public-schema default privileges grant EXECUTE on
--    every new function, and ALL on every new table, straight to anon and
--    authenticated. `revoke ... from public` does not touch those direct
--    grants; 20260921015000 found this for account_is_closed and closed it.
--    Measured on hkpnnsjcwprrwobmpqyy on 2026-09-28, the same gap was still
--    open on three objects the mailbox and forwarding migrations created:
--
--      mailbox_domain_lock()           anon, authenticated EXECUTE. SECURITY
--                                      DEFINER: any browser could take the
--                                      one lock every mailbox mutation
--                                      serializes on.
--      lock_profile_verified_email()   PUBLIC, anon, authenticated EXECUTE.
--                                      A trigger function, so a direct call
--                                      only errors, but it is revoked like
--                                      every other trigger function here
--                                      (20260920230000, 20260925140000).
--                                      Triggers do not check EXECUTE when
--                                      they fire, so the lock keeps working.
--      account_tombstones (table)      anon, authenticated ALL. RLS with no
--                                      policy hides the rows, but TRUNCATE,
--                                      REFERENCES and TRIGGER are not RLS
--                                      governed, and the migration's own
--                                      comment says nothing in the browser
--                                      reads or writes it.
--
--    Every other function those migrations created (account_is_closed,
--    apply_account_mailbox, confirm_forwarding_claim, remove_forwarding_claim,
--    forwarding_address_claim_send) already reads postgres + service_role
--    only in production. They are restated below anyway, so the whole
--    mailbox domain's grants are written in one place and a fresh database
--    ends up where production is.
--
-- 2. CONSISTENCY. When a member's verified primary address is also a
--    forwarding address the SAME account confirmed, apply_account_mailbox
--    turns that claim's proof from 'confirmed' into 'provider'. That part is
--    right and is kept: while Clerk verifies the address, removing the
--    forwarding row must not stop the route (remove_forwarding_claim releases
--    only 'confirmed' claims). What was wrong is the other end. When the
--    member later changes their Clerk primary, the provider event released
--    every provider claim the account held except the new one, including
--    this one, while the forwarding row went on saying Confirmed. Forwards
--    from that address then went nowhere, with nothing on screen to say so.
--
--    Now a released provider claim goes back to 'confirmed' when the same
--    account still holds a confirmed forwarding row for that address, in the
--    same statement set and under the same locks, so the route follows the
--    row the member can see. No evidence is invented: the account opened the
--    emailed challenge itself, and the provider is only withdrawing its own,
--    separate statement. Nothing changes for any other account.
--
--    The same invariant had one more door. The owner still held a direct
--    DELETE grant and policy on forwarding_addresses from 20260903c, so a
--    PostgREST DELETE removed the row while the confirmed claim went on
--    routing (the exact defect 20260918a closed for the app's own path by
--    moving removal into remove_forwarding_claim). Nothing uses that grant:
--    the app removes through the forwarding-address function, which runs
--    remove_forwarding_claim with the service role. It is revoked, so the
--    row and the route can only move together.
--
-- 3. REPAIR. clerk-webhook threw on every user event from 2026-09-20 to the
--    fix, so no account has a provider claim and profiles.verified_email is
--    null on all of them. The fixed webhook repairs an account only on its
--    next user.updated. repair_account_mailboxes() is the database half of
--    the admin-mailbox-repair function: given Clerk's CURRENT verified
--    primary for each user, it makes exactly the call the webhook would have
--    made, apply_account_mailbox with Clerk's own updated_at as the clock, as
--    scripts/sql/backfill-verified-mailbox.sql intends. A preview runs the
--    same calls and rolls them back, so its counts are the apply's counts. An
--    account whose call would change nothing material is rolled back even on
--    apply, so a second run writes nothing at all, not even updated_at.
--
-- Idempotent: every statement can run twice. No data is changed by applying
-- this file; it reports, without changing, any confirmed forwarding row
-- whose address does not route to its own account (0 on 2026-09-28).
-- Rollback: docs/rollback/20260928190000_mailbox_repair.rollback.sql

-- ── 1. Grants ───────────────────────────────────────────────────────────────

revoke all on function public.mailbox_domain_lock() from public, anon, authenticated;
grant execute on function public.mailbox_domain_lock() to postgres, service_role;

revoke all on function public.lock_profile_verified_email() from public, anon, authenticated;

revoke all on table public.account_tombstones from public, anon, authenticated;
grant select, insert, update on table public.account_tombstones to postgres, service_role;

do $$
declare f text;
begin
  foreach f in array array[
    'public.account_is_closed(uuid)',
    'public.apply_account_mailbox(uuid, bigint, text, boolean)',
    'public.confirm_forwarding_claim(text, bigint)',
    'public.remove_forwarding_claim(uuid, uuid, bigint)',
    'public.forwarding_address_claim_send(uuid, integer, interval)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ── 2a. The forwarding row and its route move together ─────────────────────

revoke delete on table public.forwarding_addresses from authenticated;
drop policy if exists forwarding_addresses_owner_delete on public.forwarding_addresses;

-- ── 2b. A released provider claim falls back to the account's confirmation ──
--
-- The body is 20260918a's, byte for byte, except for the two blocks marked
-- 20260928190000 and the 'restored' count in two answers. The lock order is
-- still domain lock, then profiles -> forwarding_addresses -> mailbox_claims.
create or replace function public.apply_account_mailbox(
  p_profile uuid,
  p_event_ms bigint,
  p_address text,
  p_terminal boolean default false
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_addr text := nullif(lower(btrim(coalesce(p_address, ''))), '');
  v_seen bigint;
  v_prof record;
  v_displaced uuid;
  v_cur record;
  v_released int := 0;
  v_restored int := 0;
  v_outcome text;
begin
  if p_profile is null then
    return jsonb_build_object('outcome', 'refused', 'why', 'no profile');
  end if;
  if p_event_ms is null or not (p_event_ms > 0) then
    return jsonb_build_object('outcome', 'refused', 'why', 'no usable event clock');
  end if;
  if v_addr is not null and (position('@' in v_addr) < 2 or length(v_addr) not between 6 and 254) then
    return jsonb_build_object('outcome', 'refused', 'why', 'address is not usable');
  end if;

  -- The domain lock precedes every row lock in this function. See
  -- mailbox_domain_lock() for why ordering alone could not do this.
  perform public.mailbox_domain_lock();

  -- THE ACCOUNT FENCE. It is what orders two events about the same account
  -- even when they name different addresses.
  select id, verified_email, verified_email_event_ms
    into v_prof
    from public.profiles
   where id = p_profile
     for update;
  if not found then
    return jsonb_build_object('outcome', 'refused', 'why', 'no such profile');
  end if;
  v_seen := v_prof.verified_email_event_ms;

  -- A closed account takes nothing, however new the event. This is asked
  -- BEFORE the clock comparison on purpose: staleness is about ordering two
  -- events, and there is no ordering that gives a deleted account an address.
  if not p_terminal and public.account_is_closed(p_profile) then
    return jsonb_build_object('outcome', 'terminal_account', 'why', 'the account is closed');
  end if;

  -- Terminal always applies: a deletion is a fact about the account, not a
  -- position in a clock, and a provider clock ahead of our receipt clock is
  -- one skewed machine rather than an exotic case.
  if not p_terminal and v_seen is not null and p_event_ms < v_seen then
    return jsonb_build_object('outcome', 'stale', 'seen_ms', v_seen, 'event_ms', p_event_ms);
  end if;

  if p_terminal then
    -- The tombstone first: it is the part that has to survive everything else,
    -- including the profiles row itself being deleted later.
    insert into public.account_tombstones (profile_id, event_ms)
    values (p_profile, p_event_ms)
    on conflict (profile_id) do update
      set event_ms = greatest(coalesce(public.account_tombstones.event_ms, 0), excluded.event_ms);

    -- Then kill the pending challenges at the source as well as at the gate.
    -- The tombstone is what makes the repro impossible; this is so a token
    -- from a closed account is not merely refused but absent. Locked before
    -- mailbox_claims, because the lock order in this file is
    -- profiles -> forwarding_addresses -> mailbox_claims and the terminal path
    -- is not allowed its own private ordering.
    perform 1 from public.forwarding_addresses
      where user_id = p_profile and verified_at is null order by id for update;
    update public.forwarding_addresses
       set token_hash = null, token_expires_at = null
     where user_id = p_profile and verified_at is null;

    -- Close EVERY claim this account holds, both kinds. Locked in address
    -- order, which is the rule every writer here follows.
    perform 1 from public.mailbox_claims
      where profile_id = p_profile order by address for update;

    update public.mailbox_claims
       set profile_id = null, proof = null, terminal_at = now(),
           event_ms = greatest(event_ms, p_event_ms), updated_at = now()
     where profile_id = p_profile;
    get diagnostics v_released = row_count;

    update public.profiles
       set verified_email = null, verified_email_at = null,
           verified_email_event_ms = greatest(coalesce(verified_email_event_ms, 0), p_event_ms),
           updated_at = now()
     where id = p_profile;

    return jsonb_build_object('outcome', 'terminal', 'closed', v_released);
  end if;

  -- Release the PROVIDER claims this account holds that are not the address it
  -- is keeping. Confirmed claims are untouched: they are the physician's own
  -- separate evidence.
  --
  -- 20260928190000: the account's CONFIRMED forwarding rows are read below,
  -- so they are locked first, in id order, before any claim row: the order in
  -- this file is profiles -> forwarding_addresses -> mailbox_claims. FOR
  -- SHARE, because all this needs is that none is deleted underneath it.
  perform 1 from public.forwarding_addresses
    where user_id = p_profile and verified_at is not null order by id for share;

  perform 1 from public.mailbox_claims
    where profile_id = p_profile and proof = 'provider'
      and (v_addr is null or address <> v_addr)
    order by address for update;

  -- 20260928190000: a provider claim this account is letting go of, on an
  -- address the SAME account also confirmed as a forwarding address, goes
  -- back to the proof the account produced itself instead of to nobody.
  -- Taking the address as provider (below) turned the confirmed claim into a
  -- provider one; releasing it here used to leave the forwarding row saying
  -- Confirmed with no route behind it. event_ms only rises, as on every other
  -- write to this table.
  update public.mailbox_claims c
     set proof = 'confirmed', event_ms = greatest(c.event_ms, p_event_ms), updated_at = now()
   where c.profile_id = p_profile and c.proof = 'provider'
     and (v_addr is null or c.address <> v_addr)
     and c.terminal_at is null
     and exists (select 1 from public.forwarding_addresses f
                  where f.user_id = p_profile and f.verified_at is not null
                    and lower(btrim(f.email)) = c.address);
  get diagnostics v_restored = row_count;

  update public.mailbox_claims
     set profile_id = null, proof = null,
         event_ms = greatest(event_ms, p_event_ms), updated_at = now()
   where profile_id = p_profile and proof = 'provider'
     and (v_addr is null or address <> v_addr);
  get diagnostics v_released = row_count;

  if v_addr is null then
    update public.profiles
       set verified_email = null, verified_email_at = null,
           verified_email_event_ms = p_event_ms, updated_at = now()
     where id = p_profile;
    return jsonb_build_object('outcome', 'cleared', 'released', v_released, 'restored', v_restored);
  end if;

  -- Take the address. Same rules 20260916b established, now inside the same
  -- transaction as everything else.
  select * into v_cur from public.mailbox_claims where address = v_addr for update;

  if found and v_cur.terminal_at is not null then
    v_outcome := 'terminal_address';
  elsif not found then
    insert into public.mailbox_claims (address, profile_id, proof, event_ms)
    values (v_addr, p_profile, 'provider', p_event_ms);
    v_outcome := 'claimed';
  elsif v_cur.profile_id is not distinct from p_profile and v_cur.proof = 'provider' and v_cur.event_ms = p_event_ms then
    v_outcome := 'unchanged';
  elsif p_event_ms < v_cur.event_ms then
    v_outcome := 'stale_address';
  elsif p_event_ms = v_cur.event_ms and v_cur.profile_id is distinct from p_profile then
    -- One clock, two different claims. One is wrong and we cannot tell which,
    -- so nothing moves rather than letting the second arrival win.
    v_outcome := 'held';
  else
    v_displaced := case when v_cur.profile_id is distinct from p_profile then v_cur.profile_id else null end;
    update public.mailbox_claims
       set profile_id = p_profile, proof = 'provider', event_ms = p_event_ms, updated_at = now()
     where address = v_addr and event_ms = v_cur.event_ms
       and profile_id is not distinct from v_cur.profile_id and terminal_at is null;
    v_outcome := 'claimed';

    -- THE DISPLACED MIRROR. Cleared here, in the same transaction, because the
    -- unique index on lower(profiles.verified_email) would otherwise make every
    -- future mirror write for the new holder fail 23505 for good.
    if v_displaced is not null then
      update public.profiles
         set verified_email = null, verified_email_at = null, updated_at = now()
       where id = v_displaced and lower(verified_email) = v_addr;
    end if;
  end if;

  if v_outcome = 'claimed' or v_outcome = 'unchanged' then
    update public.profiles
       set verified_email = v_addr, verified_email_at = now(),
           verified_email_event_ms = p_event_ms, updated_at = now()
     where id = p_profile;
  else
    -- We did not get it, so the account must not display it either.
    update public.profiles
       set verified_email = null, verified_email_at = null,
           verified_email_event_ms = greatest(coalesce(verified_email_event_ms, 0), p_event_ms),
           updated_at = now()
     where id = p_profile;
  end if;

  return jsonb_build_object('outcome', v_outcome, 'released', v_released, 'restored', v_restored,
                            'displaced', v_displaced, 'address', v_addr);
end;
$$;

-- ── 3. The repair, for admin-mailbox-repair ─────────────────────────────────
--
-- p_users is Clerk's current state, one element per user the edge function
-- found non-banned, non-locked, with a verified primary address:
--   {"subject": "user_...", "email": "<normalized primary>", "updated_ms": <Clerk updated_at>}
-- Anything else in the array refuses the whole request; so does one Clerk
-- user listed twice (the input was stitched from more than one read).
--
-- Answers counts only. No address leaves this function.
--   change    accounts whose routing or mirror the call changes (on a preview:
--             would change)
--   current   accounts the call would leave exactly as they are
--   skipped   noAccount: no profile carries that Clerk subject
--             closed:    the account is closed (apply_account_mailbox would
--                        refuse it too)
--             unusable:  the address is one the claims ledger cannot hold
--   outcomes  apply_account_mailbox's own outcome names, for the changed ones
create or replace function public.repair_account_mailboxes(
  p_actor uuid,
  p_actor_subject text,
  p_users jsonb,
  p_apply boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_profile uuid;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_outcome text;
  n_total int;
  n_distinct int;
  n_no_account int := 0;
  n_closed int := 0;
  n_unusable int := 0;
  n_current int := 0;
  n_change int := 0;
  tally jsonb := '{}'::jsonb;
begin
  -- Authorization is decided here as well as in the edge function: an active,
  -- open account whose protected subject matches, with an app_admins row.
  if p_actor is null or p_actor_subject is null or p_actor_subject !~ '^user_[A-Za-z0-9]+$'
     or not exists (select 1 from public.profiles
                     where id = p_actor and auth_user_id = p_actor_subject
                       and access_status = 'active' and deleted_at is null)
     or public.account_is_closed(p_actor)
     or not exists (select 1 from public.app_admins where profile_id = p_actor) then
    return jsonb_build_object('state', 'admin_required');
  end if;

  if p_apply is null or p_users is null or jsonb_typeof(p_users) <> 'array'
     or jsonb_array_length(p_users) > 10000 then
    return jsonb_build_object('state', 'invalid_request');
  end if;
  -- CASE, not OR: the key count must not be asked of a non-object.
  if exists (
    select 1 from jsonb_array_elements(p_users) e
     where case
             when jsonb_typeof(e) <> 'object' then true
             when (select count(*) from jsonb_object_keys(e)) <> 3 then true
             when jsonb_typeof(e -> 'subject') is distinct from 'string'
               or jsonb_typeof(e -> 'email') is distinct from 'string'
               or jsonb_typeof(e -> 'updated_ms') is distinct from 'number' then true
             when (e ->> 'subject') !~ '^user_[A-Za-z0-9]+$' then true
             when (e ->> 'email') <> lower(btrim(e ->> 'email')) or length(e ->> 'email') > 320 then true
             when (e ->> 'updated_ms') !~ '^[1-9][0-9]{0,15}$' then true
             else false
           end
  ) then
    return jsonb_build_object('state', 'invalid_request');
  end if;
  select count(*), count(distinct e ->> 'subject') into n_total, n_distinct
    from jsonb_array_elements(p_users) e;
  if n_total <> n_distinct then
    return jsonb_build_object('state', 'invalid_request');
  end if;

  -- The whole run holds the mailbox domain, so no webhook event interleaves
  -- with it and a preview's counts are the apply's counts.
  perform public.mailbox_domain_lock();

  begin
    for r in
      select x.subject, x.email, x.updated_ms
        from jsonb_to_recordset(p_users) as x(subject text, email text, updated_ms bigint)
       order by x.subject
    loop
      select id into v_profile from public.profiles where auth_user_id = r.subject;
      if not found then
        n_no_account := n_no_account + 1;
        continue;
      end if;
      if public.account_is_closed(v_profile) then
        n_closed := n_closed + 1;
        continue;
      end if;
      if length(r.email) not between 6 and 254 or position('@' in r.email) < 2 then
        n_unusable := n_unusable + 1;
        continue;
      end if;

      -- One account, in its own subtransaction. What counts as a change is
      -- the routing (every claim this account holds, and the claim on the
      -- address) and the mirror with its watermark. Timestamps alone are
      -- not a change: a call that moves nothing else is rolled back, which
      -- is what makes a second run write nothing.
      begin
        select jsonb_build_object(
                 'mirror', (select jsonb_build_array(verified_email, verified_email_event_ms)
                              from public.profiles where id = v_profile),
                 'claims', coalesce((select jsonb_agg(jsonb_build_array(c.address, c.profile_id, c.proof, c.event_ms,
                                                                        c.terminal_at is not null) order by c.address)
                                       from public.mailbox_claims c
                                      where c.profile_id = v_profile or c.address = r.email), '[]'::jsonb))
          into v_before;

        v_result := public.apply_account_mailbox(v_profile, r.updated_ms, r.email, false);
        v_outcome := coalesce(v_result ->> 'outcome', 'no_answer');

        select jsonb_build_object(
                 'mirror', (select jsonb_build_array(verified_email, verified_email_event_ms)
                              from public.profiles where id = v_profile),
                 'claims', coalesce((select jsonb_agg(jsonb_build_array(c.address, c.profile_id, c.proof, c.event_ms,
                                                                        c.terminal_at is not null) order by c.address)
                                       from public.mailbox_claims c
                                      where c.profile_id = v_profile or c.address = r.email), '[]'::jsonb))
          into v_after;

        if v_after = v_before then
          n_current := n_current + 1;
          raise exception using errcode = 'MBR01', message = 'no material change';
        end if;
        n_change := n_change + 1;
        tally := jsonb_set(tally, array[v_outcome], to_jsonb(coalesce((tally ->> v_outcome)::int, 0) + 1));
      exception when sqlstate 'MBR01' then
        null;
      end;
    end loop;

    -- A preview undoes the whole run, after counting it.
    if not p_apply then
      raise exception using errcode = 'MBR02', message = 'preview';
    end if;
  exception when sqlstate 'MBR02' then
    null;
  end;

  return jsonb_build_object(
    'state', 'ready',
    'applied', p_apply,
    'total', n_total,
    'change', n_change,
    'current', n_current,
    'skipped', jsonb_build_object('noAccount', n_no_account, 'closed', n_closed, 'unusable', n_unusable),
    'outcomes', tally);
end;
$$;

revoke all on function public.repair_account_mailboxes(uuid, text, jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.repair_account_mailboxes(uuid, text, jsonb, boolean) to service_role;

-- ── Report, change nothing ──────────────────────────────────────────────────
-- A confirmed forwarding row whose address routes nowhere, or elsewhere, is
-- the state finding 2 produced. None existed when this was written. Any found
-- here is named by count only, for a person to look at: this migration cannot
-- tell a released route from one the provider moved to another account.
do $$
declare n int;
begin
  select count(*) into n
    from public.forwarding_addresses f
   where f.verified_at is not null
     and not exists (select 1 from public.mailbox_claims c
                      where c.address = lower(btrim(f.email)) and c.profile_id = f.user_id);
  raise notice 'confirmed forwarding rows that do not route to their own account: %', n;
end $$;

notify pgrst, 'reload schema';
