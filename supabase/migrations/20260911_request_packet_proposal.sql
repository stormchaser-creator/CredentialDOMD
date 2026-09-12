-- The packet proposal, built when the request arrives (2026-09-11).
--
-- A forwarded request used to be the FIRST of seven taps: open More > Requests,
-- open the row, ask Vera (and wait for the turn), approve, open the email
-- modal, check the recipient, send. The owner's words: "once that request
-- lands in the user's request box, it needs to be acknowledged and generated
-- and on the board have a final click approval to send." So email-inbound now
-- matches every asked-for item against the physician's documents on arrival
-- and stores the result here; the app shows it and one button, "Approve and
-- send", which send-packet-email turns into the reply.
--
--   proposal     what the matcher built: { v, method, items, docIds, missing,
--                coverNote }. Null when the matcher threw; the request is
--                still there and the old hand-built reply still works.
--   proposal_at  when it was built, so a stale proposal can be told from a
--                fresh one once documents change underneath it.
--   ack_sent_at  when the requester was told "received, documents follow once
--                approved" from docs@ on the physician's behalf. Null means no
--                acknowledgement went out (guard refused it, send failed, or
--                the physician switched them off). The inbound function checks
--                this before sending, so a redelivered webhook cannot
--                acknowledge the same request twice.
--
-- profiles.ack_requests is the physician's switch for that acknowledgement.
-- It defaults on because the point of the feature is that forwarding is the
-- last thing they type; a physician who would rather the credentialer hear
-- nothing until the packet goes can turn it off.
--
-- Additive and nullable (or defaulted). Nothing dropped, nothing renamed.
-- NOT APPLIED by the worktree; the operator applies migrations.

alter table public.document_requests
  add column if not exists proposal    jsonb,
  add column if not exists proposal_at timestamptz,
  add column if not exists ack_sent_at timestamptz;

comment on column public.document_requests.proposal is
  'Packet proposal built on arrival by email-inbound: { v, method, items, docIds, missing, coverNote }. Null when it could not be built.';
comment on column public.document_requests.proposal_at is
  'When the proposal was built.';
comment on column public.document_requests.ack_sent_at is
  'When the requester was sent the received-once-approved acknowledgement from docs@. Null when none went out.';

alter table public.profiles
  add column if not exists ack_requests boolean not null default true;

comment on column public.profiles.ack_requests is
  'Whether docs@ acknowledges a forwarded document request to the requester on the physician''s behalf. Default on.';

notify pgrst, 'reload schema';
