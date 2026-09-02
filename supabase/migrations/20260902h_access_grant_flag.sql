-- Admin Approve and self-claim could not actually activate an account (2026-09-02).
--
-- lock_profile_identity (20260819) reverts any access_status change made under
-- a user JWT. admin_set_access() and claim_beta_access() are SECURITY DEFINER
-- but still run under the caller's JWT, so their access_status writes were
-- silently undone; only the service-role paths (clerk-webhook, send-invite)
-- ever activated a profile. Same fix pattern as lock_profile_founding: the
-- two gated functions raise a transaction-local flag before writing, and the
-- lock honours it. Nothing else can set the flag usefully: a plain client
-- UPDATE has no way to run set_config inside the same statement's trigger
-- context, and the functions keep their own is_admin / beta_access gates.

create or replace function public.lock_profile_identity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
  privileged boolean := auth.jwt() is null or jwt_role = 'service_role';
  granting boolean := coalesce(current_setting('credentialdomd.access_grant', true), '') = '1';
begin
  if new.auth_user_id is distinct from old.auth_user_id and not privileged then
    new.auth_user_id := old.auth_user_id;
  end if;
  if new.access_status is distinct from old.access_status and not (privileged or granting) then
    new.access_status := old.access_status;
  end if;
  return new;
end;
$$;

create or replace function public.admin_set_access(p_profile uuid, p_status text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare pe text;
begin
  if not public.is_admin(public.current_profile_id()) then raise exception 'admin only'; end if;
  if p_status not in ('pending','active','revoked') then raise exception 'bad status'; end if;
  perform set_config('credentialdomd.access_grant', '1', true);
  update profiles set access_status=p_status, updated_at=now() where id=p_profile returning lower(email) into pe;
  if pe is not null and pe <> '' then
    update beta_access set status = case when p_status='active' then 'active' when p_status='revoked' then 'revoked' else status end,
      profile_id = p_profile, activated_at = case when p_status='active' then coalesce(activated_at, now()) else activated_at end, updated_at=now()
      where lower(email)=pe;
  end if;
end $$;

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
