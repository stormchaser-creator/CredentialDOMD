-- Admin Messages tab badge (2026-08-26): the tab showed the total sent-message
-- count instead of an unread count, so it never went away. Surface the last
-- physician reply time per message so the client can compare it against a
-- local "last viewed inbox" timestamp, same pattern AdminMessageCard already
-- uses on the physician side (settings.adminMessagesSeenAt).

create or replace view public.admin_messages_overview as
  select
    m.id, m.subject, m.body, m.created_at, m.recipient_id,
    p.email as recipient_email,
    p.name as recipient_name,
    (select count(*) from public.admin_message_replies r where r.message_id = m.id) as reply_count,
    (select max(r.created_at) from public.admin_message_replies r
      where r.message_id = m.id and r.is_admin_reply = false) as last_physician_reply_at
  from public.admin_messages m
  left join public.profiles p on p.id = m.recipient_id
  where is_admin(public.current_profile_id())
  order by m.created_at desc;

grant select on public.admin_messages_overview to authenticated;

notify pgrst, 'reload schema';
