-- An invoice handed to the share sheet is stamped on the server first
-- (2026-09-30, ticket "Invoicce").
-- File: supabase/migrations/20260930230000_invoice_number_shared.sql
-- Rollback: docs/rollback/20260930230000_invoice_number_shared.rollback.sql
--
-- WHY. The app records an invoice only after the share sheet answers. On an
-- iPhone the page was reloaded (an automatic update) or thrown away (iOS,
-- while Mail was open) before it answered, twice in one day: the invoice went
-- to the agency and nothing anywhere said so. The device's own note of it
-- lived in localStorage, which was full on that phone, and a note on one
-- device is not seen on another.
--
-- WHAT. Two columns on the number ledger (20260929210000) and two functions:
--   mark_invoice_number_shared(number, shared, contract_id, shared_at)
--       stamps (or, with shared = false, clears) shared_at on the signed-in
--       account's row for that number. A number the device made itself
--       (offline, INV-20260930-03-K7Q) has no row yet and gets one, so it is
--       never issued again either. Called without waiting, as the file goes
--       to the share sheet or the clipboard. shared_at is when the device
--       handed the file over, not when the stamp arrives: a stamp sent again
--       days later (no signal at the time) must not date the share, and Mark
--       as sent on another device, days late. It is held to the last 60 days
--       and never later than now, and a stamp from before the account's data
--       was last deleted is refused (returns false).
--   list_shared_invoice_numbers()
--       the account's stamped numbers that no invoice carries, newest last,
--       for the "went to the share sheet and is not recorded" note on every
--       device.
--
-- The ledger stays numbers only: no amount, recipient, period or invoice is
-- stored. The contract id says which Work screen shows the note. A stamp from
-- before the account's data was last deleted (profiles.data_deleted_at) is
-- never listed, and delete-account, which keeps the last six days of the
-- ledger (20260929210000), clears the stamp and contract id on what it keeps.
-- The app clears a stamp once its invoice is recorded, so deleting that
-- invoice later never lists it again.
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

do $$
begin
  if to_regclass('public.invoice_number_reservations') is null then
    raise exception 'invoice_number_shared: public.invoice_number_reservations is missing (20260929210000)';
  end if;
  if to_regprocedure('public.current_profile_id()') is null then
    raise exception 'invoice_number_shared: public.current_profile_id() is missing';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'data_deleted_at') then
    raise exception 'invoice_number_shared: public.profiles.data_deleted_at is missing (20260930020000)';
  end if;
end $$;

alter table public.invoice_number_reservations add column if not exists shared_at timestamptz;
alter table public.invoice_number_reservations add column if not exists shared_contract_id text;

comment on column public.invoice_number_reservations.shared_at is
  'When an invoice with this number was last handed to the share sheet or the clipboard (mark_invoice_number_shared). Null when never, or when the share was cancelled. Since migration 20260930230000.';
comment on column public.invoice_number_reservations.shared_contract_id is
  'The locum contract the shared invoice bills (its id only), so the right Work screen says it is not recorded. Since migration 20260930230000.';

-- The first version took no p_shared_at. Two overloads would make the
-- PostgREST call ambiguous, so it goes.
drop function if exists public.mark_invoice_number_shared(text, boolean, text);

create or replace function public.mark_invoice_number_shared(p_number text, p_shared boolean default true, p_contract_id text default null, p_shared_at timestamptz default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.current_profile_id();
  v_number text := btrim(coalesce(p_number, ''));
  v_day text;
  v_contract text := nullif(left(btrim(coalesce(p_contract_id, '')), 64), '');
  v_recent integer;
  v_at timestamptz := least(now(), greatest(coalesce(p_shared_at, now()), now() - interval '60 days'));
begin
  if v_user is null then
    raise exception 'mark_invoice_number_shared: not signed in' using errcode = '42501';
  end if;
  -- A number this app issues: INV-/EXP-, the local day, a suffix, and an
  -- offline device tag.
  if v_number !~ '^(INV|EXP)-[0-9]{8}-[0-9]{1,4}(-[A-Z0-9]{3})?$' then
    raise exception 'mark_invoice_number_shared: not an invoice number' using errcode = '22023';
  end if;

  if not coalesce(p_shared, true) then
    update public.invoice_number_reservations
       set shared_at = null, shared_contract_id = null
     where user_id = v_user and number = v_number;
    return found;
  end if;

  -- Shared before the account's data was last deleted: that share went with
  -- the data, and is never listed on any device.
  if exists (select 1 from public.profiles p where p.id = v_user and p.data_deleted_at is not null and v_at <= p.data_deleted_at) then
    return false;
  end if;

  update public.invoice_number_reservations
     set shared_at = v_at, shared_contract_id = v_contract
   where user_id = v_user and number = v_number;
  if found then
    return true;
  end if;

  -- A number the server did not issue: only one made on the device the day
  -- it was handed over (within two days either side, as
  -- allocate_invoice_number takes), and not hundreds in a day. The day is
  -- the hand-off's (v_at), not today's: a number made with no signal is
  -- usually stamped late too, and its stamp still dates it.
  v_day := substring(v_number from '^[A-Z]+-([0-9]{8})-');
  if to_date(v_day, 'YYYYMMDD') not between (v_at at time zone 'utc')::date - 2 and (v_at at time zone 'utc')::date + 2 then
    raise exception 'mark_invoice_number_shared: number is not from the day it was shared' using errcode = '22023';
  end if;
  select count(*) into v_recent
    from public.invoice_number_reservations
   where user_id = v_user and reserved_at > now() - interval '1 day';
  if v_recent >= 500 then
    raise exception 'mark_invoice_number_shared: too many numbers today' using errcode = '54000';
  end if;
  insert into public.invoice_number_reservations (user_id, number, shared_at, shared_contract_id)
  values (v_user, v_number, v_at, v_contract)
  on conflict (user_id, number) do update set shared_at = excluded.shared_at, shared_contract_id = excluded.shared_contract_id;
  return true;
end;
$$;

comment on function public.mark_invoice_number_shared(text, boolean, text, timestamptz) is
  'Stamps (p_shared true) or clears (false) that the signed-in account handed an invoice with this number to the share sheet, at p_shared_at (the device''s hand-off time, held to the last 60 days; now when null). Numbers only. Since migration 20260930230000.';

revoke all on function public.mark_invoice_number_shared(text, boolean, text, timestamptz) from public, anon;
grant execute on function public.mark_invoice_number_shared(text, boolean, text, timestamptz) to authenticated;

create or replace function public.list_shared_invoice_numbers()
returns table (number text, shared_at timestamptz, contract_id text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.number, r.shared_at, r.shared_contract_id
    from public.invoice_number_reservations r
    left join public.profiles p on p.id = r.user_id
   where r.user_id = public.current_profile_id()
     and r.shared_at is not null
     and r.shared_at > now() - interval '60 days'
     and (p.data_deleted_at is null or r.shared_at > p.data_deleted_at)
     and not exists (
       select 1 from public.invoices i
        where i.user_id = r.user_id and lower(btrim(i.number)) = lower(r.number)
     )
   order by r.shared_at
   limit 20
$$;

comment on function public.list_shared_invoice_numbers() is
  'The signed-in account''s numbers handed to the share sheet (mark_invoice_number_shared) that no invoice carries yet, newest last, at most 20 from the last 60 days. Since migration 20260930230000.';

revoke all on function public.list_shared_invoice_numbers() from public, anon;
grant execute on function public.list_shared_invoice_numbers() to authenticated;

notify pgrst, 'reload schema';
