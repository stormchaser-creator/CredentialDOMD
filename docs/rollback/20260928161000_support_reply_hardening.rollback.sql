-- Rollback for 20260928161000_support_reply_hardening.sql.
--
-- Restores the 20260928150000 trigger function: operator sessions are
-- session_user postgres or supabase_admin, service_role writes are exempt,
-- and only operator sessions are refused a rewrite. support_messages.emailed_at
-- is kept (send-ticket-reply works with or without it; dropping it would
-- forget which replies were emailed). To remove reply verification entirely,
-- run docs/rollback/20260928150000_support_reply_verifications.rollback.sql
-- after this file.
begin;

create or replace function public.require_verified_support_reply()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  operator constant boolean := session_user in ('postgres', 'supabase_admin');
  v public.support_reply_verifications%rowtype;
  hmac_key text;
begin
  if tg_op = 'UPDATE' then
    if operator
       and (old.verification_id is not null
            or coalesce(old.is_admin_reply, false) or coalesce(new.is_admin_reply, false)
            or public.is_admin(old.author_id) or public.is_admin(new.author_id))
       and (new.body is distinct from old.body
            or new.ticket_id is distinct from old.ticket_id
            or new.author_id is distinct from old.author_id
            or new.is_admin_reply is distinct from old.is_admin_reply
            or new.verification_id is distinct from old.verification_id) then
      raise exception 'support reply % cannot be rewritten with operator SQL', old.id
        using errcode = '42501', hint = 'Post a new reply with node scripts/ticket-fix/post-reply.mjs.';
    end if;
    return new;
  end if;

  if new.verification_id is null then
    if operator and (coalesce(new.is_admin_reply, false) or public.is_admin(new.author_id)) then
      raise exception 'support replies written with operator SQL need a verified reply'
        using errcode = '42501',
              hint = 'Use node scripts/ticket-fix/post-reply.mjs --ticket <uuid> --reply <file.json>, one ticket per call.';
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

drop trigger if exists trg_require_verified_support_reply on public.support_messages;
create trigger trg_require_verified_support_reply
  before insert or update on public.support_messages
  for each row execute function public.require_verified_support_reply();

notify pgrst, 'reload schema';
commit;
