-- Support replies: close the paths 20260928150000 left open (review 2026-09-28).
--
-- Applies after 20260928150000_support_reply_verifications.sql. Idempotent.
--
-- 1. Who is exempt from the verified-reply rule. 20260928150000 listed the
--    operator sessions (session_user postgres or supabase_admin) and let every
--    other session through. The Supabase CLI logs in as its own roles
--    (cli_login_postgres, NOINHERIT, SET ROLE postgres), which were not on the
--    list, so a data-fix migration pushed with the CLI stored an unverified
--    support reply. It also let every service_role write through, and the
--    same management token that runs SQL can fetch the service_role key, so a
--    refused session could POST the reply to PostgREST instead. Now the ONLY
--    unverified support reply accepted is one an admin writes in the app:
--    through PostgREST (session_user authenticator), under the caller's own
--    token (role authenticated or anon, never service_role), with author_id
--    equal to that token's profile (current_profile_id()). reply-ticket writes
--    admin replies that way from this release on.
--      * The role is read with current_setting('role'): the function is
--        SECURITY DEFINER (it reads the vault), so current_user inside it is
--        its owner, while the role setting is what PostgREST set.
--
-- 2. Rewrites. 20260928150000 refused a rewrite of a support reply only from
--    an operator session; the service role could still PATCH a verified
--    reply's body and leave its verification pointing at text it no longer
--    matches. A change to body, ticket, author, flag or verification of a
--    verified or support reply is now refused from every role. Nothing in the
--    app edits a message after it is sent.
--
-- 3. support_messages.emailed_at: send-ticket-reply claims a message here
--    before it emails it (update ... where emailed_at is null), and emails
--    only the stored row, never a body a request carries. A reply is emailed
--    at most once however often the function is called.
--
-- What this does NOT do. The HMAC key in the vault can be read by postgres,
-- which is what the management API runs as, and the recipe is in this public
-- repository. Anyone holding that token (or the owner's shell, where it lives)
-- can sign a reply without disabling anything; they can also disable this
-- trigger. These rules stop the accidental path and make the deliberate one
-- visible: scripts/ticket-fix/reconcile.mjs, run by the hourly runner, alerts
-- the owner about any verification that neither post-reply.mjs nor the runner
-- recorded, and about one text verified for several tickets. Making the key
-- unreachable needs a signer the owner's shell cannot read (owner decision).
--
-- Order (see docs/rollback/20260928161000_support_reply_hardening.rollback.sql
-- for the rollback):
--   1. Deploy reply-ticket (admin replies written as the caller) and
--      send-ticket-reply (stored row, once) first. Both work before this
--      migration: the insert policy already lets an admin sign a reply, and
--      send-ticket-reply sends without the once-only claim, with a warning,
--      until emailed_at exists.
--   2. Then apply this file. Applied first, every in-app admin reply would be
--      refused until reply-ticket is deployed.
begin;

alter table public.support_messages add column if not exists emailed_at timestamptz;
comment on column public.support_messages.emailed_at is
  'When send-ticket-reply claimed this message for its one email (20260928161000). Null: not emailed.';

create or replace function public.require_verified_support_reply()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- PostgREST connects as authenticator and sets the request role. Every
  -- other session (management API, SQL editor, psql, the CLI's login roles)
  -- is an operator session, whatever role it switches to.
  via_api constant boolean := session_user = 'authenticator';
  api_role constant text := coalesce(nullif(current_setting('role', true), ''), 'none');
  own_session boolean := false;
  v public.support_reply_verifications%rowtype;
  hmac_key text;
begin
  if tg_op = 'UPDATE' then
    if (old.verification_id is not null
        or coalesce(old.is_admin_reply, false) or coalesce(new.is_admin_reply, false)
        or public.is_admin(old.author_id) or public.is_admin(new.author_id))
       and (new.body is distinct from old.body
            or new.ticket_id is distinct from old.ticket_id
            or new.author_id is distinct from old.author_id
            or new.is_admin_reply is distinct from old.is_admin_reply
            or new.verification_id is distinct from old.verification_id) then
      raise exception 'support reply % cannot be rewritten', old.id
        using errcode = '42501', hint = 'Post a new reply with node scripts/ticket-fix/post-reply.mjs.';
    end if;
    return new;
  end if;

  if new.verification_id is null then
    if coalesce(new.is_admin_reply, false) or public.is_admin(new.author_id) then
      -- Nested so current_profile_id() (which reads the request's token) is
      -- asked only of an app request.
      if via_api and api_role in ('authenticated', 'anon') then
        own_session := new.author_id is not distinct from public.current_profile_id();
      end if;
      if not own_session then
        raise exception 'support replies need a verified reply unless an admin writes them in the app'
          using errcode = '42501',
                hint = 'Use node scripts/ticket-fix/post-reply.mjs --ticket <uuid> --reply <file.json>, one ticket per call.';
      end if;
    end if;
    return new;
  end if;

  select * into v from public.support_reply_verifications where id = new.verification_id for update;
  if not found then
    raise exception 'reply verification % does not exist', new.verification_id using errcode = '42501';
  end if;
  if v.ticket_id is distinct from new.ticket_id then
    raise exception 'reply verification % belongs to another ticket', v.id using errcode = '42501';
  end if;
  if encode(sha256(convert_to(new.body, 'UTF8')), 'hex') is distinct from v.body_sha256 then
    raise exception 'reply body does not match verification %', v.id using errcode = '42501';
  end if;
  select decrypted_secret into hmac_key from vault.decrypted_secrets where name = 'support_reply_hmac_key';
  if hmac_key is null then
    raise exception 'vault secret support_reply_hmac_key is missing' using errcode = '42501';
  end if;
  if encode(extensions.hmac(convert_to(v.id::text || ':' || v.ticket_id::text || ':' || v.body_sha256, 'UTF8'),
                            convert_to(hmac_key, 'UTF8'), 'sha256'), 'hex') is distinct from v.hmac then
    raise exception 'reply verification % has an invalid signature', v.id using errcode = '42501';
  end if;
  if v.used_at is not null then
    raise exception 'reply verification % was already used', v.id using errcode = '42501';
  end if;
  update public.support_reply_verifications set used_at = now(), used_by_message_id = new.id where id = v.id;
  return new;
end
$$;

revoke all on function public.require_verified_support_reply() from public, anon, authenticated;
comment on function public.require_verified_support_reply() is
  'Refuses a support reply without a valid, unused verification unless an admin writes it in the app under their own token, and refuses any rewrite of a support reply (20260928161000).';

drop trigger if exists trg_require_verified_support_reply on public.support_messages;
create trigger trg_require_verified_support_reply
  before insert or update on public.support_messages
  for each row execute function public.require_verified_support_reply();

notify pgrst, 'reload schema';
commit;
