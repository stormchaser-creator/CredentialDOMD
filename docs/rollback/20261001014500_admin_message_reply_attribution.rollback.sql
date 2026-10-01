-- docs/rollback/20261001014500_admin_message_reply_attribution.rollback.sql
-- Rollback for 20261001014500_admin_message_reply_attribution.sql.
--
-- Run as postgres. Idempotent. Puts admin_message_replies_insert back to its
-- 20260826_admin_messages.sql definition, which reopens the hole that
-- migration closed: any signed-in profile may again label its own reply as
-- the owner's (is_admin_reply = true) and pending or paused profiles may
-- write replies. Only roll back if the new policy refuses a legitimate write.

drop policy if exists admin_message_replies_insert on public.admin_message_replies;
create policy admin_message_replies_insert on public.admin_message_replies
  for insert to authenticated
  with check (
    author_id = public.current_profile_id()
    and (
      is_admin(public.current_profile_id())
      or (
        user_id = public.current_profile_id()
        and exists (
          select 1 from public.admin_messages m
          where m.id = message_id
            and (m.recipient_id = public.current_profile_id() or m.recipient_id is null)
        )
      )
    )
  );

comment on policy admin_message_replies_insert on public.admin_message_replies is null;

notify pgrst, 'reload schema';
