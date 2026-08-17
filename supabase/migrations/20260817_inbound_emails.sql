-- Inbound email ledger (2026-08-17).
--
-- One row per email Resend delivers to the email-inbound edge function
-- (webhook event email.received). The row is written by the function with the
-- service role before anything else happens, so it doubles as the idempotency
-- claim: message_id is unique, and a Svix retry of an already-finished message
-- is answered 200 without a second reply, forward, or upload.
--
-- Routes:
--   cme      cme@credentialdomd.com    attachments -> Storage + documents rows
--   forward  any other local part      whole message relayed to the owner
--
-- Status: processing (claimed) -> done | failed | unregistered | rate_limited.
-- A failed or stale (>10 min processing) row may be re-claimed by a retry.
--
-- Nobody but admins can read this table (support triage, abuse review). No
-- anon or authenticated INSERT/UPDATE: writes are service-role only.
--
-- NOT APPLIED by the worktree. Apply with supabase db push (or the management
-- API) before deploying email-inbound.

create table if not exists public.inbound_emails (
  id               uuid primary key default gen_random_uuid(),
  message_id       text not null unique,          -- RFC Message-ID, or resend:<email_id> when absent
  email_id         text,                          -- Resend received-email id (Emails > Receiving)
  from_addr        text not null default '',
  to_addr          text not null default '',      -- the credentialdomd.com address the message was routed on
  subject          text not null default '',
  route            text not null default 'forward'
                   check (route in ('cme', 'forward')),
  status           text not null default 'processing'
                   check (status in ('processing', 'done', 'failed', 'unregistered', 'rate_limited')),
  attachment_count integer not null default 0,    -- files stored (cme) or re-attached (forward)
  detail           text,                          -- short outcome or error text, no message body
  profile_id       uuid,                          -- cme route: the matched profile
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_inbound_emails_created_at on public.inbound_emails (created_at desc);
create index if not exists idx_inbound_emails_from_recent on public.inbound_emails (from_addr, created_at desc);

alter table public.inbound_emails enable row level security;

-- Supabase's default grants would let anon/authenticated at the table if a
-- policy ever appeared; revoke so RLS is not the only gate.
revoke all on table public.inbound_emails from anon;
revoke all on table public.inbound_emails from authenticated;
grant select, delete on table public.inbound_emails to authenticated;

drop policy if exists inbound_emails_admin_read on public.inbound_emails;
create policy inbound_emails_admin_read on public.inbound_emails
  for select to authenticated
  using (is_admin(current_profile_id()));

drop policy if exists inbound_emails_admin_delete on public.inbound_emails;
create policy inbound_emails_admin_delete on public.inbound_emails
  for delete to authenticated
  using (is_admin(current_profile_id()));

comment on table public.inbound_emails is
  'Emails received at credentialdomd.com via Resend (email.received webhook -> email-inbound function). Idempotency claim by message_id. Admin-read only; service-role writes.';

notify pgrst, 'reload schema';
