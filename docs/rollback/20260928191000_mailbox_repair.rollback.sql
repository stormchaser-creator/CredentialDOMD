-- docs/rollback/20260928191000_mailbox_repair.rollback.sql
-- Rollback for 20260928191000_mailbox_repair.sql.
--
-- Run as postgres in one transaction (the SQL editor runs a script as one;
-- with psql use -1). Idempotent. Deploy order: remove the
-- admin-mailbox-repair function first, or leave it deployed and it answers
-- 503 once repair_account_mailboxes is gone; it changes nothing either way.
--
-- What it undoes:
--   * apply_account_mailbox goes back to the 20260918a body, byte for byte.
--     Claims the new body put back to 'confirmed' stay confirmed: that is a
--     state the old body reads and keeps (it releases only provider claims).
--   * repair_account_mailboxes is dropped (the five-argument form, and the
--     four-argument draft if a database ever ran it).
--   * The owner's direct DELETE grant and policy on forwarding_addresses come
--     back as 20260903c wrote them.
--
-- What it deliberately does NOT undo: the EXECUTE and table revocations for
-- anon, authenticated and PUBLIC. Nothing legitimate used them (every caller
-- is the service role or postgres, and triggers do not check EXECUTE when
-- they fire), and restoring them would reopen the probe this migration
-- closed. 20260921015000, the same fix for account_is_closed, has no
-- rollback for the same reason.

drop function if exists public.repair_account_mailboxes(uuid, text, jsonb, boolean, text);
drop function if exists public.repair_account_mailboxes(uuid, text, jsonb, boolean);

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
  perform 1 from public.mailbox_claims
    where profile_id = p_profile and proof = 'provider'
      and (v_addr is null or address <> v_addr)
    order by address for update;

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
    return jsonb_build_object('outcome', 'cleared', 'released', v_released);
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

  return jsonb_build_object('outcome', v_outcome, 'released', v_released,
                            'displaced', v_displaced, 'address', v_addr);
end;
$$;


do $$
begin
  execute 'revoke all on function public.apply_account_mailbox(uuid, bigint, text, boolean) from public, anon, authenticated';
  execute 'grant execute on function public.apply_account_mailbox(uuid, bigint, text, boolean) to service_role';
end $$;

grant delete on table public.forwarding_addresses to authenticated;
drop policy if exists forwarding_addresses_owner_delete on public.forwarding_addresses;
create policy forwarding_addresses_owner_delete on public.forwarding_addresses
  for delete to authenticated
  using (user_id = public.current_profile_id());

notify pgrst, 'reload schema';
