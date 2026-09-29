-- A verified support reply on a member's ticket is emailed to the member
-- (owner decision, 2026-09-29).
--
-- Why: the ticket agent (scripts/ticket-agent-isolated.mjs replySQL) and
-- scripts/ticket-fix/post-reply.mjs store a reply with the ticket owner as
-- author_id, is_admin_reply true and a verification_id (20260928150000).
-- notify_ticket_reply emailed only an admin author's reply on someone else's
-- ticket, so none of those replies ever reached a member's inbox (measured on
-- 2026-09-29: emailed_at set on 0 of 375 support_messages).
--
-- What:
--   * public.verified_support_reply_to_member(message id): true only for a
--     stored support reply (is_admin_reply) whose verification is the one the
--     trigger checked and consumed for THIS message (same ticket,
--     used_by_message_id = the message, sha256 of the stored body, a valid
--     HMAC under the vault key support_reply_hmac_key), stored the way both
--     writers store it (author is the ticket owner), on a ticket whose owner
--     is not an admin. SECURITY DEFINER (it reads the verification table,
--     which no API role can, and the vault); returns a boolean and nothing
--     else.
--     service_role may execute it (send-ticket-reply re-checks the stored row
--     with it); anon and authenticated may not.
--   * notify_ticket_reply keeps the admin rule unchanged (an admin's reply in
--     the app on someone else's ticket) and adds one: a reply for which the
--     function above is true. Both call send-ticket-reply with the row, which
--     re-reads the stored row, claims support_messages.emailed_at, and emails
--     it once from "CredentialDOMD Support" with a link to the ticket.
--   * Never emailed: a member's own message; a support reply on an admin's own
--     ticket (the owner's tickets); any row without a valid, consumed
--     verification. It is an AFTER INSERT trigger, so an UPDATE (the
--     emailed_at claim itself) never sends, and replies stored before this
--     migration are not sent retroactively.
--
-- Authorship. Replies stay stored with the ticket owner as author. A separate
-- support identity would need a profile row in app_admins (an admin principal
-- with no login, which every is_admin() check would then trust) or the
-- author-less support_actor_id design of 20260918090000, which production
-- does not have (author_id is NOT NULL there). The verification row is the
-- support identity here: the checked writers create it and the trigger
-- consumes it for exactly one message. (As 20260928150000 says, the HMAC key
-- is readable by postgres, so this marks the accidental path, not a boundary
-- against a deliberate forger; reconcile.mjs reports verifications no checked
-- path recorded.) scripts/signup-notify.sh no longer reports these rows as
-- "[TICKET REPLY]" from the member.
--
-- Needs 20260928150000 (verifications) and 20260928161000 (emailed_at, the
-- once-only claim); stops with an error without them rather than create a
-- sender that could email a reply twice.
--
-- Order: 1. the app build with the /app/#support/<ticket id> link (an older
-- build opens the app without the Support sheet); 2. send-ticket-reply (it
-- accepts a verified reply only through this function, so before this
-- migration it sends nothing new); 3. this file. Applied before step 2, the
-- old send-ticket-reply answers "author not admin" to each verified member
-- reply, and that reply is never emailed (the trigger fires once).
-- Idempotent.
-- Rollback: docs/rollback/20260929134100_support_reply_email.rollback.sql

do $needs$
begin
  if to_regclass('public.support_reply_verifications') is null then
    raise exception 'support_reply_email: apply 20260928150000_support_reply_verifications.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'support_messages' and column_name = 'emailed_at') then
    raise exception 'support_reply_email: apply 20260928161000_support_reply_hardening.sql first (support_messages.emailed_at is the once-only claim)';
  end if;
end
$needs$;

create or replace function public.verified_support_reply_to_member(p_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce((
    select coalesce(m.is_admin_reply, false)
       and m.author_id = t.user_id
       and not public.is_admin(t.user_id)
       and v.ticket_id = m.ticket_id
       and v.used_by_message_id = m.id
       and v.used_at is not null
       and v.body_sha256 = encode(sha256(convert_to(m.body, 'UTF8')), 'hex')
       and k.decrypted_secret is not null
       and v.hmac = encode(extensions.hmac(convert_to(v.id::text || ':' || v.ticket_id::text || ':' || v.body_sha256, 'UTF8'),
                                           convert_to(k.decrypted_secret, 'UTF8'), 'sha256'), 'hex')
      from public.support_messages m
      join public.support_tickets t on t.id = m.ticket_id
      join public.support_reply_verifications v on v.id = m.verification_id
      left join vault.decrypted_secrets k on k.name = 'support_reply_hmac_key'
     where m.id = p_message_id
  ), false)
$$;

-- Supabase's default privileges grant EXECUTE on a new public function to
-- anon and authenticated directly; revoking from public does not remove those.
revoke all on function public.verified_support_reply_to_member(uuid) from public, anon, authenticated;
grant execute on function public.verified_support_reply_to_member(uuid) to service_role;
comment on function public.verified_support_reply_to_member(uuid) is
  'True only for a stored support reply whose verification (20260928150000) was consumed by this message and still matches its body and HMAC, stored with the ticket owner as author, on a ticket whose owner is not an admin. notify_ticket_reply and send-ticket-reply email exactly these to the member (20260929134100).';

create or replace function public.notify_ticket_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_id uuid;
  hook_secret text;
begin
  if public.is_admin(new.author_id) then
    -- An admin's reply in the app: emailed when it is on someone else's ticket.
    select user_id into owner_id from public.support_tickets where id = new.ticket_id;
    if owner_id is null or owner_id = new.author_id then
      return new;
    end if;
  elsif new.verification_id is null or not public.verified_support_reply_to_member(new.id) then
    -- A member's own message, or anything that is not a verified support
    -- reply on a member's ticket.
    return new;
  end if;
  hook_secret := (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret');
  if hook_secret is null then
    raise warning 'notify_ticket_reply: vault secret welcome_hook_secret is missing; reply % saved but not emailed', new.id;
    return new;
  end if;
  perform net.http_post(
    url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-ticket-reply',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    body := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
end
$$;

revoke all on function public.notify_ticket_reply() from public, anon, authenticated;
grant execute on function public.notify_ticket_reply() to postgres, service_role;
comment on function public.notify_ticket_reply() is
  'AFTER INSERT trigger on support_messages: calls send-ticket-reply, which emails the ticket owner, for (1) an admin''s reply on someone else''s ticket and (2) a verified support reply on a member''s ticket (verified_support_reply_to_member, 20260929134100). A member''s own message and any reply on an admin''s own ticket send nothing. Reads the x-hook-secret from vault secret welcome_hook_secret at call time.';

drop trigger if exists trg_notify_ticket_reply on public.support_messages;
create trigger trg_notify_ticket_reply
  after insert on public.support_messages
  for each row execute function public.notify_ticket_reply();

notify pgrst, 'reload schema';
