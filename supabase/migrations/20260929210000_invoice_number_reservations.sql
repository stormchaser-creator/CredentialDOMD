-- Invoice numbers are handed out by the server (2026-09-29, PRAC-030).
-- File: supabase/migrations/20260929210000_invoice_number_reservations.sql
-- Rollback: docs/rollback/20260929210000_invoice_number_reservations.rollback.sql
--
-- WHY. An invoice number (INV-20260929-02, EXP-20260929-01) was worked out on
-- the device from its own copy of the invoices list. Two browsers holding the
-- same list each issued INV-...-02, and a deleted invoice's number came back
-- on the next invoice, although the billing office already held the first.
-- An AP department treats the number as the invoice's identity.
--
-- WHAT. allocate_invoice_number(kind, day, at_least) takes a per-account,
-- per-day lock, reads the highest suffix already issued for that prefix (in
-- invoices AND in this ledger), writes the next number here and returns it.
-- A number written here is never issued again, whether or not an invoice
-- with it is ever saved or later deleted. The app asks for the number when it
-- builds the preview, before the invoice text can be shared. Offline it falls
-- back to its own number with a short device suffix (src/utils/invoiceNumber.js).
--
-- The ledger holds only the numbers. It is not a synced collection (not in
-- TABLE_MAP), the app never writes it directly, and the owner can read their
-- own rows. delete-account removes an account's rows (USER_TABLES, optional)
-- except those reserved in the last six days (INVOICE_NUMBER_KEEP_DAYS): an
-- account whose data was deleted reopens with the same profile id
-- (20260930020000), and with its invoices and this ledger both emptied the
-- allocator handed out INV-<day>-01 again the same day, a number a billing
-- office already held. A number reserved longer ago has a day outside the
-- allocator's reach (p_day within 2 days of today) and can go.
--
-- NO unique index on invoices(user_id, number): a second device's colliding
-- insert would be rejected whole and live only on that device. This ledger is
-- what keeps numbers apart.
--
-- Existing invoice numbers are copied in, so deleting any invoice issued
-- before this migration never frees its number either.
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'invoice_number_reservations: public.profiles is missing';
  end if;
  if to_regclass('public.invoices') is null then
    raise exception 'invoice_number_reservations: public.invoices is missing';
  end if;
  if to_regprocedure('public.current_profile_id()') is null then
    raise exception 'invoice_number_reservations: public.current_profile_id() is missing';
  end if;
  if to_regprocedure('public.credentialdo_scope_write_allowed(text)') is null then
    raise exception 'invoice_number_reservations: public.credentialdo_scope_write_allowed(text) is missing';
  end if;
end $$;

create table if not exists public.invoice_number_reservations (
  user_id uuid not null references public.profiles(id) on delete cascade,
  number text not null,
  reserved_at timestamptz not null default now(),
  primary key (user_id, number)
);

comment on table public.invoice_number_reservations is
  'Every invoice number the server has issued to an account (allocate_invoice_number). A number here is never issued again. Written only by that function. Since migration 20260929210000.';

alter table public.invoice_number_reservations enable row level security;

revoke all on table public.invoice_number_reservations from public, anon, authenticated;
grant select on table public.invoice_number_reservations to authenticated;
grant all on table public.invoice_number_reservations to service_role;

drop policy if exists invoice_number_reservations_owner_read on public.invoice_number_reservations;
create policy invoice_number_reservations_owner_read on public.invoice_number_reservations
  for select to authenticated using (user_id = public.current_profile_id());

-- Every number already on an invoice is taken.
insert into public.invoice_number_reservations (user_id, number, reserved_at)
select i.user_id, i.number, coalesce(i.created_at, now())
  from public.invoices i
 where i.user_id is not null and nullif(i.number, '') is not null
on conflict (user_id, number) do nothing;

create or replace function public.allocate_invoice_number(p_kind text, p_day text, p_at_least integer default 1)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.current_profile_id();
  v_prefix text;
  v_high integer;
  v_next integer;
  v_number text;
begin
  if v_user is null then
    raise exception 'allocate_invoice_number: not signed in' using errcode = '42501';
  end if;
  if not public.credentialdo_scope_write_allowed('practice') then
    raise exception 'allocate_invoice_number: practice is read-only for this account' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('INV', 'EXP') then
    raise exception 'allocate_invoice_number: kind must be INV or EXP' using errcode = '22023';
  end if;
  -- The device's local day, YYYYMMDD, within a day of the server's.
  if p_day is null or p_day !~ '^[0-9]{8}$'
     or to_date(p_day, 'YYYYMMDD') not between (now() at time zone 'utc')::date - 2 and (now() at time zone 'utc')::date + 2 then
    raise exception 'allocate_invoice_number: day must be today as YYYYMMDD' using errcode = '22023';
  end if;

  v_prefix := p_kind || '-' || p_day || '-';
  -- One allocation at a time per account and prefix.
  perform pg_advisory_xact_lock(hashtextextended('allocate_invoice_number:' || v_user::text || ':' || v_prefix, 0));

  select coalesce(max((regexp_match(n, '^' || v_prefix || '([0-9]{1,4})'))[1]::integer), 0)
    into v_high
    from (
      select number as n from public.invoices where user_id = v_user and number like v_prefix || '%'
      union all
      select number from public.invoice_number_reservations where user_id = v_user and number like v_prefix || '%'
    ) issued;

  -- at_least: the device's own next number, which counts invoices it holds
  -- that have not reached the server yet.
  v_next := greatest(v_high + 1, least(coalesce(p_at_least, 1), 999), 1);
  if v_next > 999 then
    raise exception 'allocate_invoice_number: no numbers left for %', v_prefix using errcode = '54000';
  end if;
  v_number := v_prefix || lpad(v_next::text, 2, '0');
  insert into public.invoice_number_reservations (user_id, number) values (v_user, v_number);
  return v_number;
end;
$$;

comment on function public.allocate_invoice_number(text, text, integer) is
  'The next invoice number for the signed-in account (INV or EXP, the device''s local day). Records it in invoice_number_reservations so no device is given it again. Since migration 20260929210000.';

revoke all on function public.allocate_invoice_number(text, text, integer) from public, anon;
grant execute on function public.allocate_invoice_number(text, text, integer) to authenticated;

-- PostgREST picks up the new function without waiting for its next reload.
notify pgrst, 'reload schema';
