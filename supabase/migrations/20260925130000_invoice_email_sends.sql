-- Server-sent invoice email (2026-09-25, owner approved; tickets e8cc2a02 and
-- 821d2f76). iOS Mail and the share sheet flatten line breaks, so an invoice
-- sent from the phone arrived as one run-on paragraph. The new function
-- send-invoice-email mails it from docs@credentialdomd.com as text/plain with
-- the paragraphs intact. This migration gives it two things:
--
-- 1. invoices.last_emailed_at, invoices.last_emailed_to
--    When, and to whom, the invoice was last emailed, so the Resend screen can
--    say so. Written ONLY by the function, after a confirmed send, as those
--    two columns alone (updated_at untouched, never moved backwards), the same
--    narrow shape as the favorite star. Nullable, no default, no check:
--    toSnakeObj sends "" as null and a NOT NULL or CHECK failure would reject
--    the whole row.
--
--    APPLY BEFORE THE CLIENT SHIPS, and before the function deploys. The app
--    loads invoices with select *, so once these columns exist every client
--    (old ones included) carries the keys in its cached rows and writes them
--    back on the next edit. That is harmless while the columns exist; it is
--    also why the rollback must revert the client first.
--
-- 2. public.invoice_email_sends, the sent-once ledger.
--    The app sends a client request id with every Send and reuses it on a
--    retried tap. The row, unique on (user_id, client_request_id), is what
--    makes the retry answer "already sent" instead of mailing the billing
--    office twice. Server-only: RLS on with no policy, no grant to PUBLIC,
--    anon or authenticated. service_role gets exactly what the function and
--    delete-account need (select, insert, update, delete). No letter text or
--    file bytes are kept, only who, when and the outcome.
--
-- The hourly cap is NOT here: the function counts public.send_reservations
-- through reserve_send(), the ledger send-packet-email already uses, so the two
-- send paths share one budget.
--
-- Rerunnable: IF NOT EXISTS throughout; a pre-existing column of the wrong type
-- is refused rather than accepted.

begin;

do $$
begin
  if to_regclass('public.invoices') is null or to_regclass('public.profiles') is null then
    raise exception 'invoice_email_sends: invoices or profiles does not exist';
  end if;
end $$;

alter table public.invoices add column if not exists last_emailed_at timestamptz;
alter table public.invoices add column if not exists last_emailed_to text;

do $$
declare
  bad text;
begin
  select string_agg(table_name || '.' || column_name || ' is ' || data_type, ', ')
    into bad
    from information_schema.columns
   where table_schema = 'public' and table_name = 'invoices'
     and ((column_name = 'last_emailed_at' and data_type <> 'timestamp with time zone')
       or (column_name = 'last_emailed_to' and data_type <> 'text'));
  if bad is not null then
    raise exception 'invoice_email_sends: wrong column type: %', bad;
  end if;
end $$;

create table if not exists public.invoice_email_sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- No foreign key: an invoice can be deleted and regenerated, and the record
  -- of what was mailed about it should outlive that.
  invoice_id uuid not null,
  client_request_id uuid not null,
  status text not null check (status in ('sending', 'sent', 'failed', 'unknown')),
  attempts integer not null default 1 check (attempts >= 1),
  recipient text not null,
  cc text,
  reply_to text,
  subject text not null,
  attachment_count integer not null default 1,
  receipt_count integer not null default 0,
  provider_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

create unique index if not exists invoice_email_sends_request_uniq
  on public.invoice_email_sends (user_id, client_request_id);
create index if not exists invoice_email_sends_invoice_idx
  on public.invoice_email_sends (user_id, invoice_id, sent_at desc);

alter table public.invoice_email_sends enable row level security;
-- In a stock Supabase project PUBLIC, anon and authenticated arrive holding
-- table grants, and service_role arrives with every privilege including
-- TRUNCATE. Strip all of it, then grant back only what is used.
revoke all on table public.invoice_email_sends from public;
revoke all on table public.invoice_email_sends from anon;
revoke all on table public.invoice_email_sends from authenticated;
revoke all on table public.invoice_email_sends from service_role;
grant select, insert, update, delete on table public.invoice_email_sends to service_role;

comment on table public.invoice_email_sends is
  'Sent-once ledger for send-invoice-email: one row per client request id (the app reuses it when a Send tap is retried). status sending|sent|failed|unknown; only a failed row may be attempted again. RLS on, no policy, service_role only. No letter text or file bytes. Deleted with the account by delete-account.';
comment on column public.invoices.last_emailed_at is
  'When send-invoice-email last confirmed a send of this invoice. Written by the function alone; null when never emailed from the server.';
comment on column public.invoices.last_emailed_to is
  'The recipient of that send.';

commit;

-- PostgREST caches the schema. Without this the new columns and table are not
-- visible to the API until its next reload.
notify pgrst, 'reload schema';
