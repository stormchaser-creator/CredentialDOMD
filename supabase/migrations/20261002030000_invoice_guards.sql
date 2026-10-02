-- Invoice guards (2026-10-02, owner report): a page whose copy predated
-- another device's record of INV-A built and sent INV-C for the same days.
-- The app now asks the server before it builds, sends or records anything
-- (src/utils/invoiceRecordCheck.js). These are the backstop if a path on the
-- phone is ever missed:
--
--  1. One invoice per number per account (any case, outer spaces ignored).
--     This reverses the deliberate "NO unique index" of 20260929210000: the
--     app that ships with this migration takes a 23505 on an invoices insert
--     as "recorded on another device" (src/lib/supabase.js insertRow): it is
--     not queued or retried, and the account is read again. Production held
--     no duplicate (user_id, lower(btrim(number))) group when this was
--     written; if one exists the index cannot be built and this migration
--     stops, changing nothing.
--  2. A duty day, work entry or expense billed on an invoice that exists is
--     never moved onto a different invoice (a second record of the same
--     number moved the twelve days off the first). Clearing it (the invoice
--     deleted) and billing an unbilled row stay allowed. Refused with
--     23P01. The app keeps the row on the invoice the server holds, and an
--     invoice of its own that lists such a row is said on Home and the
--     Invoices tab (src/utils/invoiceRecord.js invoicesBilledTwice).
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

do $$
begin
  if to_regclass('public.invoices') is null then
    raise exception 'invoice_guards: public.invoices is missing';
  end if;
end $$;

create unique index if not exists invoices_user_number_unique
  on public.invoices (user_id, lower(btrim(number)))
  where number is not null and btrim(number) <> '';

comment on index public.invoices_user_number_unique is
  'One invoice per number per account (case and outer spaces ignored). Since migration 20261002030000.';

create or replace function public.credentialdo_keep_billed_invoice()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.invoice_id is not null and new.invoice_id is not null and new.invoice_id <> old.invoice_id
     and exists (select 1 from public.invoices i where i.id = old.invoice_id) then
    raise exception 'already billed on another invoice' using errcode = '23P01';
  end if;
  return new;
end;
$$;

comment on function public.credentialdo_keep_billed_invoice() is
  'Refuses moving a billed row onto a different invoice while the invoice it is on exists. Since migration 20261002030000.';

revoke all on function public.credentialdo_keep_billed_invoice() from public, anon;

do $$
declare
  t text;
begin
  foreach t in array array['duty_days', 'work_log', 'travel_expenses'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists %I on public.%I', t || '_keep_billed_invoice', t);
      execute format('create trigger %I before update of invoice_id on public.%I for each row execute function public.credentialdo_keep_billed_invoice()', t || '_keep_billed_invoice', t);
    end if;
  end loop;
end $$;
