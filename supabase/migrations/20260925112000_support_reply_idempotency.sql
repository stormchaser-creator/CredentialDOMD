-- One reply per composed message, even when the admin retries (2026-09-25).
--
-- Resolve & archive and Send reply called reply-ticket with no request key.
-- When the reply committed but the archive update failed, or the response was
-- lost, a second tap inserted a second support_messages row, and
-- trg_notify_ticket_reply (AFTER INSERT, one email per admin row) emailed the
-- physician twice. The admin client now sends a client_request_id that stays
-- the same across retries of the same reply; reply-ticket looks it up before
-- uploading or inserting and returns the existing row. The unique index makes
-- two racing requests settle on one row, so the trigger fires once.
--
-- Apply BEFORE deploying the reply-ticket function that writes the column.
-- Rerunnable: IF NOT EXISTS only. Existing rows keep a null key.
begin;

alter table public.support_messages add column if not exists client_request_id uuid;
create unique index if not exists support_messages_client_request_uniq
  on public.support_messages (ticket_id, client_request_id) where client_request_id is not null;
comment on column public.support_messages.client_request_id is
  'Idempotency key from the sender for one composed reply; retries reuse it. Null for rows written before 2026-09-25 and by callers that send none.';

notify pgrst,'reload schema';
commit;
