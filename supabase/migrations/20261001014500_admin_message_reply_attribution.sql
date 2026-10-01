-- Replies to the owner's messages: only the owner may sign one as the owner,
-- and a member must be admitted to write one (QA SUPPORT-003 / ADMIN-005).
--
-- admin_message_replies_insert (20260826_admin_messages.sql) checked who
-- wrote the row, whose thread it is and that the message was sent to the
-- caller or to everyone. It never looked at is_admin_reply and never asked
-- whether the caller's profile is active. Any signed-in profile, pending or
-- paused included, could POST /rest/v1/admin_message_replies with
-- is_admin_reply = true into its own thread. The member's Home card
-- (AdminMessageCard.jsx) then shows that text under the owner's name, Admin >
-- Messages shows it to the owner as "You", and because the unread count
-- (20260826b) and the attention snapshot (20260925111000) only count rows
-- with is_admin_reply = false, it raised no badge either.
--
-- 20260915f closed the same forgery on support_messages; this is the same
-- two clauses on this table, word for word:
--   * admission: current_profile_active() or is_admin(), as the ticket and
--     message policies in 20260915c/f. The card lives on Home, which only an
--     active account reaches, so no member loses a reply they could make.
--   * attribution: coalesce(is_admin_reply, false) = false or is_admin().
--     The app's own member send sets false (AdminMessageCard.jsx) and the
--     owner's send sets true from an admin profile (AdminDashboard.jsx), so
--     both legitimate writes still pass.
--
-- Rerunnable: drop policy if exists, then create. Rollback:
-- docs/rollback/20261001014500_admin_message_reply_attribution.rollback.sql

drop policy if exists admin_message_replies_insert on public.admin_message_replies;
create policy admin_message_replies_insert on public.admin_message_replies
  for insert to authenticated
  with check (
    author_id = public.current_profile_id()
    and (
      public.is_admin(public.current_profile_id())
      or (
        user_id = public.current_profile_id()
        and exists (
          select 1 from public.admin_messages m
          where m.id = message_id
            and (m.recipient_id = public.current_profile_id() or m.recipient_id is null)
        )
      )
    )
    and (
      public.current_profile_active()
      or public.is_admin(public.current_profile_id())
    )
    and (
      coalesce(is_admin_reply, false) = false
      or public.is_admin(public.current_profile_id())
    )
  );

comment on policy admin_message_replies_insert on public.admin_message_replies is
  'Who wrote it, whose thread it is, whether they are admitted at all, and whether they may sign a reply as the owner. is_admin_reply is what the card and Admin > Messages render as the owner''s words, and only app_admins membership may set it true.';

notify pgrst, 'reload schema';
