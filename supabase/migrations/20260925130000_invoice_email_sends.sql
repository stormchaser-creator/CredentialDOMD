-- Server-sent invoice email (2026-09-25, owner approved; tickets e8cc2a02 and
-- 821d2f76). iOS Mail and the share sheet flatten line breaks, so an invoice
-- sent from the phone arrived as one run-on paragraph. The new function
-- send-invoice-email mails it from docs@credentialdomd.com as text/plain with
-- the paragraphs intact. This migration gives it two things:
--
-- 1. invoices.last_emailed_at, invoices.last_emailed_to
--    When, and to whom, the invoice was last emailed, so the Resend screen can
--    say so and the email screen can pre-fill the address. Written ONLY by
--    the function, after a confirmed send, as those two columns alone
--    (updated_at untouched, never moved backwards), the same narrow shape as
--    the favorite star. Nullable, no default, no check.
--
--    Server-owned, and enforced here: trigger invoices_keep_last_emailed
--    silently keeps the stored values on any write by a user token (anon,
--    authenticated), so the rest of that write (a payment, a write-off) still
--    lands. Without it, the app's full-row writes (updateItem, the self-heal
--    bulkSync, a queued replay) put a device's cached copy back: a desktop tab
--    opened before an email went out from the phone would record a payment
--    and erase the stamp, or roll it back to an older recipient. The current
--    app strips the two keys from every write (SERVER_OWNED_FIELDS in
--    src/lib/supabase.js); the trigger also covers app versions still cached
--    on devices, which load invoices with select * and write every key back.
--    service_role (the function), postgres and supabase_admin pass untouched.
--
--    APPLY BEFORE the function deploys, and before the client that offers
--    Send by email ships (the client itself never writes these columns).
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

-- The stamp is the server's. A user token can neither set it on INSERT nor
-- change it on UPDATE (an upsert is both: the INSERT half nulls it, the
-- UPDATE half puts the stored value back). Reverted, not raised, so the
-- write that carried it still succeeds. SECURITY INVOKER, so current_user is
-- the role PostgREST switched to for the request (the same test
-- support_guard_actor uses).
create or replace function public.invoices_keep_last_emailed()
returns trigger
language plpgsql security invoker set search_path = public, pg_temp
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.last_emailed_at := null;
    new.last_emailed_to := null;
  else
    new.last_emailed_at := old.last_emailed_at;
    new.last_emailed_to := old.last_emailed_to;
  end if;
  return new;
end;
$$;

-- Nobody calls a trigger function; it fires regardless of EXECUTE. Postgres
-- grants EXECUTE to PUBLIC on creation, so take it away the way
-- 20260913_view_and_rpc_lockdown.sql does for the other trigger functions.
revoke execute on function public.invoices_keep_last_emailed() from public;
revoke execute on function public.invoices_keep_last_emailed() from anon, authenticated;
grant execute on function public.invoices_keep_last_emailed() to postgres, service_role;

comment on function public.invoices_keep_last_emailed() is
  'BEFORE INSERT OR UPDATE on invoices: last_emailed_at / last_emailed_to are written only by send-invoice-email (service_role). A user token cannot set or change them; its write lands with the stored values kept, so a stale device cannot erase or roll back when and to whom an invoice was emailed.';

drop trigger if exists invoices_keep_last_emailed on public.invoices;
create trigger invoices_keep_last_emailed
  before insert or update on public.invoices
  for each row execute function public.invoices_keep_last_emailed();

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
