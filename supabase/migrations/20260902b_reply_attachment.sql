-- Screenshot attachments on ticket replies, both sides (2026-09-02).
--
-- support_tickets keeps its one screenshot at context_payload.attachment_path
-- (create-ticket). Replies get the same thing as a plain column: reply-ticket
-- uploads the image to the private "documents" bucket under
-- tickets/<ticket_id>/replies/<message_id>.<ext> and records the key here;
-- ticket-attachment-url mints owner-or-admin signed links for it. Nullable,
-- no default, so every existing row and every client that sends no
-- attachment is untouched. trg_notify_ticket_reply posts to_jsonb(new), so the
-- column reaches send-ticket-reply with no trigger change.
--
-- ticket_thread (what both thread views read) is re-created with the column
-- appended. It carried no reloptions on the live project, so a plain
-- CREATE OR REPLACE keeps its grants and behavior.
--
-- Applied to the live project on 2026-09-02 through the management API.

alter table public.support_messages add column if not exists attachment_path text;

comment on column public.support_messages.attachment_path is
  'Storage key in the private documents bucket for the one screenshot attached to this reply (tickets/<ticket_id>/replies/<message_id>.<ext>); null when none. Read through ticket-attachment-url, never directly.';

create or replace view public.ticket_thread as
  select m.id, m.ticket_id, m.body, m.is_admin_reply, m.created_at, m.author_id,
    p.email as author_email,
    m.attachment_path
  from public.support_messages m
  left join public.profiles p on p.id = m.author_id
  where exists (
    select 1 from public.support_tickets t
    where t.id = m.ticket_id
      and (t.user_id = public.current_profile_id() or is_admin(public.current_profile_id()))
  )
  order by m.created_at;

notify pgrst, 'reload schema';
