-- An invoice emailed before it was recorded gets its "Emailed <date> to
-- <address>" once its row arrives (review of release/goal2, 2026-10-01).
-- File: supabase/migrations/20261002040000_invoice_emailed_stamp_on_record.sql
-- Rollback: docs/rollback/20261002040000_invoice_emailed_stamp_on_record.rollback.sql
--
-- WHY. "Email it for me" on Work log, Days & call and Expenses emails an
-- invoice the app records only once send-invoice-email confirms the send
-- (a draft). The function stamps last_emailed_at / last_emailed_to on the
-- invoice row after a send, but a draft has no row yet, and the row the app
-- then inserts has both columns forced to null (invoices_keep_last_emailed,
-- 20260925130000). Nothing stamped it afterwards unless the Invoices tab's
-- email screen was opened for that invoice, so most emailed invoices never
-- showed when and to whom they went, and the next invoice to the same party
-- got no address pre-filled from them.
--
-- WHAT. After a row is inserted into public.invoices, the latest confirmed
-- send in the sent-once ledger (public.invoice_email_sends, status 'sent')
-- for that account and invoice id stamps it, never moving it backwards. The
-- function runs as its owner (SECURITY DEFINER): the ledger is service-role
-- only, and the stamp is the server's (the BEFORE trigger lets its owner
-- write it). No letter text or anything else is read. A row with no
-- confirmed send stays as it is.
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

do $$
begin
  if to_regclass('public.invoices') is null or to_regclass('public.invoice_email_sends') is null then
    raise exception 'invoice_emailed_stamp_on_record: public.invoices or public.invoice_email_sends is missing (20260925130000)';
  end if;
end $$;

create or replace function public.invoices_stamp_from_email_ledger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
  v_to text;
begin
  select s.sent_at, s.recipient
    into v_at, v_to
    from public.invoice_email_sends s
   where s.user_id = new.user_id
     and s.invoice_id = new.id
     and s.status = 'sent'
     and s.sent_at is not null
   order by s.sent_at desc
   limit 1;
  if v_at is not null then
    update public.invoices
       set last_emailed_at = v_at, last_emailed_to = v_to
     where id = new.id
       and user_id = new.user_id
       and (last_emailed_at is null or last_emailed_at < v_at);
  end if;
  return null;
end;
$$;

-- Nobody calls a trigger function; it fires regardless of EXECUTE.
revoke execute on function public.invoices_stamp_from_email_ledger() from public;
revoke execute on function public.invoices_stamp_from_email_ledger() from anon, authenticated;
grant execute on function public.invoices_stamp_from_email_ledger() to postgres, service_role;

comment on function public.invoices_stamp_from_email_ledger() is
  'AFTER INSERT on invoices: stamps last_emailed_at / last_emailed_to from the latest confirmed send (invoice_email_sends, status sent) of that invoice id, for an invoice emailed before the app recorded it. Never moves the stamp backwards. Since migration 20261002040000.';

drop trigger if exists invoices_stamp_from_email_ledger on public.invoices;
create trigger invoices_stamp_from_email_ledger
  after insert on public.invoices
  for each row execute function public.invoices_stamp_from_email_ledger();
