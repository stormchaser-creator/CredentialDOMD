-- One ticket per composed request, even when the member retries (QA SUPPORT-001, 2026-09-30).
--
-- create-ticket took no request key. When the ticket committed but the
-- response was lost, the sheet said "We could not confirm receipt" and kept
-- the text, and tapping Send ticket again inserted a second ticket. The member
-- client now sends a client_request_id that stays the same across retries of
-- the same composed ticket; create-ticket looks it up before inserting or
-- uploading and returns the existing row. The unique index makes two racing
-- requests settle on one row. Replies already have this on support_messages
-- (20260925112000).
--
-- Apply BEFORE deploying the create-ticket function that writes the column
-- (a function deployed first answers without the key, as before).
-- Rerunnable: IF NOT EXISTS only. Existing rows keep a null key.
-- Rollback: docs/rollback/20260930010100_support_ticket_request_key.rollback.sql

alter table public.support_tickets add column if not exists client_request_id uuid;
create unique index if not exists support_tickets_client_request_uniq
  on public.support_tickets (user_id, client_request_id) where client_request_id is not null;
comment on column public.support_tickets.client_request_id is
  'Idempotency key from the sender for one composed ticket; retries reuse it. Null for rows written before 2026-09-30 and by callers that send none.';

notify pgrst, 'reload schema';
