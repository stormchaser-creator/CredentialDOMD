-- docs/rollback/20260929131600_invitation_is_not_access.rollback.sql
-- Rollback for 20260929131600_invitation_is_not_access.sql.
--
-- Restores claim_beta_access() exactly as 20260925110000_admin_access_regrant_guard.sql
-- left it: a pending account whose JWT email matches a beta_access row that is
-- not revoked is activated. Only roll back together with the send-invite and
-- clerk-webhook code that activates from an invitation, and only if the owner
-- reverses the 2026-09-29 decision that an invitation is not access.
--
-- Run as postgres. Idempotent. No stored row changes.

create or replace function public.claim_beta_access()
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  pid uuid := public.current_profile_id();
  jwt_email text := lower(coalesce(auth.jwt()->>'email', ''));
  cur text;
  ba public.beta_access%rowtype;
begin
  if pid is null then return 'no-profile'; end if;
  perform set_config('credentialdomd.access_grant', '1', true);
  if public.is_admin(pid) then
    update profiles set access_status='active' where id=pid and access_status<>'active';
    return 'active';
  end if;
  select access_status into cur from profiles where id=pid;
  if cur = 'active' then return 'active'; end if;
  if cur = 'revoked' then return 'revoked'; end if;
  if jwt_email = '' then return 'pending'; end if;
  select * into ba from beta_access where lower(email)=jwt_email;
  if not found then return 'pending'; end if;
  if ba.status = 'revoked' then return 'revoked'; end if;
  update beta_access set status='active', activated_at=coalesce(activated_at, now()), profile_id=pid, updated_at=now() where id=ba.id;
  update profiles set access_status='active', updated_at=now() where id=pid;
  return 'active';
end $$;

comment on function public.claim_beta_access() is null;

revoke execute on function public.claim_beta_access() from public, anon;
grant execute on function public.claim_beta_access() to authenticated, service_role;

notify pgrst, 'reload schema';
