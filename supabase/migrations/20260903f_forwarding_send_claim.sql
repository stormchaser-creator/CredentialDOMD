-- The daily confirmation-email cap becomes a cap (2026-09-03).
--
-- forwarding-address counted forwarding_address_sends, compared the count to
-- MAX_SENDS_PER_DAY, sent the mail, and then inserted the row. Read, decide,
-- act, record: four steps, and two requests that interleave anywhere inside
-- them both read the same count and both send. Ten a day was really "ten a day
-- unless you send them at once", which is the only way anyone abusing it would
-- send them.
--
-- This function makes the count-and-record one indivisible step. The advisory
-- lock is taken on the account id and held to the end of the transaction, so
-- callers for the SAME account queue behind each other and each one sees the
-- rows the previous one wrote. Callers for different accounts never touch.
-- READ COMMITTED alone would not do this: two transactions can both read 9.
--
-- It returns the id of the ledger row it claimed, or null when the account is
-- at the cap. The caller claims BEFORE it calls Resend and deletes the row if
-- the send fails, so a slot is spent only by a message that went out, and a
-- crash between the two costs one slot rather than removing the ceiling.
--
-- Service role only, which is the same audience forwarding_address_sends
-- already had (no policies, no grants to anon or authenticated).
--
-- Additive: no data is touched. Applied to hkpnnsjcwprrwobmpqyy on 2026-09-03
-- through the management API.

create or replace function public.forwarding_address_claim_send(
  p_user_id uuid,
  p_max     int,
  p_window  interval default interval '24 hours'
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_user_id is null or p_max is null or p_max < 0 then
    raise exception 'forwarding_address_claim_send: user id and a non-negative cap are required';
  end if;

  -- Serialize claimants for this one account until the transaction ends.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  if (
    select count(*) from public.forwarding_address_sends
    where user_id = p_user_id and sent_at > now() - p_window
  ) >= p_max then
    return null;
  end if;

  insert into public.forwarding_address_sends (user_id)
  values (p_user_id)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.forwarding_address_claim_send(uuid, int, interval) from public;
revoke all on function public.forwarding_address_claim_send(uuid, int, interval) from anon;
revoke all on function public.forwarding_address_claim_send(uuid, int, interval) from authenticated;
grant execute on function public.forwarding_address_claim_send(uuid, int, interval) to service_role;

comment on function public.forwarding_address_claim_send(uuid, int, interval) is
  'Atomically claim one slot under the per-account confirmation-email cap. Returns the forwarding_address_sends id it inserted, or null when the account is already at p_max inside p_window. Takes a transaction-scoped advisory lock on the account so concurrent callers cannot both read the same count. Service role only; the forwarding-address function claims before it calls Resend and deletes the row if the send fails.';

notify pgrst, 'reload schema';
