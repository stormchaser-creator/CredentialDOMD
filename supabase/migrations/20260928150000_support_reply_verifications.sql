-- One verified path for every support reply written with operator SQL (2026-09-28).
--
-- Why: the two batch replies that carried the most false statements (09-02,
-- one insert to 11 tickets; 09-25 20:16Z, one insert to 8 tickets) were not
-- written by the hourly agent. Both were operator sessions inserting straight
-- into support_messages through the management API while the agent was locked
-- out, so no check the agent runs ever saw them. The only point where every
-- writer can be stopped is the table.
--
-- What:
--   * public.support_reply_verifications: one row per reply that passed
--     scripts/ticket-fix/reply.mjs (fixed reply rules, claims bound to
--     evidence). It stores sha256 of the exact stored body and an HMAC-SHA256,
--     keyed with the vault secret support_reply_hmac_key, over
--     "<id>:<ticket_id>:<body_sha256>", plus the verification report.
--     RLS on, no policies, no grants to anon, authenticated or service_role.
--   * support_messages.verification_id points at that row. A unique index lets
--     one verification back one message only.
--   * trg_require_verified_support_reply, BEFORE INSERT OR UPDATE:
--       - a support reply (is_admin_reply, or an admin author, which is what
--         notify_ticket_reply emails) inserted from an operator session needs a
--         verification_id. An operator session is session_user postgres or
--         supabase_admin: the management API, the SQL editor, psql.
--       - any verification_id, from any role, must exist, belong to the same
--         ticket, match sha256 of the body, carry a valid HMAC and be unused.
--         It is then marked used.
--       - an operator UPDATE may not rewrite the body, ticket, author, flag or
--         verification of a support reply.
--     Edge functions (reply-ticket, create-ticket, support-operations run as
--     service_role through PostgREST) and the in-app admin reply
--     (authenticated) are unaffected: their session_user is authenticator.
--     session_user, not current_user: SET ROLE does not change it, so an
--     operator session cannot step around the rule with SET ROLE service_role.
--   * The vault secret is created here from 32 random bytes if it is absent.
--     It is never selected, printed or copied by this file.
--
-- Bypassing it takes ALTER TABLE ... DISABLE TRIGGER, which is deliberate and
-- visible. Idempotent.
--
-- Order: apply this BEFORE merging the runner change that writes
-- verification_id (scripts/ticket-agent-isolated.mjs replySQL). Until then
-- the new runner stops at its preflight and sends nothing.
-- Rollback: docs/rollback/20260928150000_support_reply_verifications.rollback.sql
begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.support_reply_verifications (
  id uuid primary key,
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  hmac text not null check (hmac ~ '^[0-9a-f]{64}$'),
  report jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_by_message_id uuid
);
comment on table public.support_reply_verifications is
  'One row per support reply that passed scripts/ticket-fix/reply.mjs. trg_require_verified_support_reply checks the body hash and the HMAC (vault secret support_reply_hmac_key) before the reply is stored.';

alter table public.support_reply_verifications enable row level security;
-- New public tables arrive with every privilege for anon, authenticated and
-- service_role from the project's default privileges. Nothing here needs any.
revoke all on table public.support_reply_verifications from public, anon, authenticated, service_role;

alter table public.support_messages
  add column if not exists verification_id uuid references public.support_reply_verifications(id);
create unique index if not exists support_messages_verification_uniq
  on public.support_messages (verification_id) where verification_id is not null;
comment on column public.support_messages.verification_id is
  'The support_reply_verifications row this reply was checked against. Required for support replies written with operator SQL (20260928150000).';

do $key$
begin
  if not exists (select 1 from vault.secrets where name = 'support_reply_hmac_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'support_reply_hmac_key',
      'HMAC key for support reply verifications (scripts/ticket-fix/reply.mjs, 20260928150000).');
  end if;
end
$key$;

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
