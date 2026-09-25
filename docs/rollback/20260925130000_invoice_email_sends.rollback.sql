-- Rollback for 20260925130000_invoice_email_sends.sql.
--
-- ORDER MATTERS. Undeploy send-invoice-email and revert the CLIENT first, then
-- run this, and expect every open app to need a reload. The current app never
-- writes the two invoice columns (SERVER_OWNED_FIELDS in src/lib/supabase.js),
-- but app versions from before that strip load invoices with select *, cache
-- lastEmailedAt / lastEmailedTo on their invoice rows and write them back on
-- the next edit; with the columns gone PostgREST rejects the WHOLE invoice row
-- (a recorded payment included), not merely the stamp.
--
-- The columns and the ledger are inert when unused, so there is rarely a
-- reason to run this. Prefer undeploying the function and leaving them.
--
-- Refuses once an invoice has actually been emailed: the ledger is then the
-- only record of what was sent to a billing office, and the stamp is what the
-- Resend screen shows.
--
-- The trigger goes first: it names the two columns, and a trigger left behind
-- on invoices without them would fail every invoice write.

begin;

do $$
begin
  if to_regclass('public.invoice_email_sends') is not null
     and exists (select 1 from public.invoice_email_sends where status in ('sent', 'unknown')) then
    raise exception 'invoice_email_sends rollback: invoices have been emailed; leave the ledger and columns in place';
  end if;
  if exists (select 1 from public.invoices where last_emailed_at is not null) then
    raise exception 'invoice_email_sends rollback: an invoice carries last_emailed_at; leave the columns in place';
  end if;
end $$;

drop trigger if exists invoices_keep_last_emailed on public.invoices;
drop function if exists public.invoices_keep_last_emailed();
drop table if exists public.invoice_email_sends;
alter table public.invoices drop column if exists last_emailed_at;
alter table public.invoices drop column if exists last_emailed_to;

commit;

notify pgrst, 'reload schema';
