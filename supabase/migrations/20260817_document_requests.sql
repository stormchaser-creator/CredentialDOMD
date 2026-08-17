-- Document requests (2026-08-17).
--
-- A credentialer emails the physician: "send your DEA, board cert, titers".
-- The physician forwards that email from the address on their profile to
-- docs@credentialdomd.com (requests@ and packets@ are aliases). The
-- email-inbound edge function (route "docs") matches the sender to a profile,
-- parses the ORIGINAL requester and subject out of the forwarded text, and
-- writes one row here with the service role. The app lists rows under
-- More > Requests; "Reply by email" calls the send-packet-email edge function,
-- which emails the chosen documents to from_addr and flips status to replied.
--
-- Writes are service-role only (email-inbound inserts, send-packet-email
-- updates). The owner may select and update their own rows (dismiss, edit
-- from_addr before replying); there is deliberately no client INSERT policy.
-- Admins may select every row for support triage.
--
-- NOT APPLIED by the worktree. Apply with supabase db push (or the management
-- API) before deploying email-inbound and send-packet-email.

create table if not exists public.document_requests (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  from_addr           text not null,                 -- the ORIGINAL requester (parsed from the forwarded email); fallback = forwarding sender
  from_name           text,
  subject             text,
  body_text           text,
  message_id          text,                          -- Message-ID of the forwarded email as received at docs@
  original_message_id text,                          -- Message-ID of the requester's own email, when the forward carried it
  forwarded_by        text,                          -- the physician's sending address
  received_at         timestamptz default now(),
  status              text not null default 'new'
                      check (status in ('new', 'replied', 'dismissed')),
  replied_at          timestamptz,
  reply_email_id      text,                          -- Resend email id of the packet reply
  doc_ids             jsonb default '[]'::jsonb,     -- documents.id[] attached in the reply
  inbound_ledger_id   uuid,                          -- inbound_emails.id of the forwarded message
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_document_requests_user_status_received
  on public.document_requests (user_id, status, received_at desc);

alter table public.document_requests enable row level security;

-- Default grants would let anon/authenticated at the table if a policy ever
-- appeared; revoke, then grant back only what the policies below use.
revoke all on table public.document_requests from anon;
revoke all on table public.document_requests from authenticated;
grant select, update on table public.document_requests to authenticated;

drop policy if exists document_requests_owner_select on public.document_requests;
create policy document_requests_owner_select on public.document_requests
  for select to authenticated
  using (user_id = public.current_profile_id());

drop policy if exists document_requests_owner_update on public.document_requests;
create policy document_requests_owner_update on public.document_requests
  for update to authenticated
  using (user_id = public.current_profile_id())
  with check (user_id = public.current_profile_id());

drop policy if exists document_requests_admin_select on public.document_requests;
create policy document_requests_admin_select on public.document_requests
  for select to authenticated
  using (is_admin(public.current_profile_id()));

comment on table public.document_requests is
  'Credentialer document requests forwarded by physicians to docs@credentialdomd.com. Inserted by email-inbound (route docs), replied via send-packet-email. Owner select/update, admin select, service-role writes.';

-- The inbound ledger gains a third route for docs@ / requests@ / packets@.
alter table public.inbound_emails drop constraint if exists inbound_emails_route_check;
alter table public.inbound_emails
  add constraint inbound_emails_route_check check (route in ('cme', 'docs', 'forward'));

notify pgrst, 'reload schema';
