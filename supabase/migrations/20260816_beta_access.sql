-- Beta access control: invite-only gate managed from the in-app Admin page.
-- profiles.access_status gates the app for non-admins; beta_access is the
-- allowlist the owner manages (email -> invited/active/revoked).

alter table public.profiles add column if not exists access_status text not null default 'pending'
  check (access_status in ('pending','active','revoked'));
alter table public.profiles add column if not exists last_seen_at timestamptz;

create table if not exists public.beta_access (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  status text not null default 'invited' check (status in ('invited','active','revoked')),
  invited_at timestamptz not null default now(),
  invited_by uuid references public.profiles(id) on delete set null,
  invite_sent_at timestamptz,
  activated_at timestamptz,
  profile_id uuid references public.profiles(id) on delete set null,
  lead_id uuid references public.early_access_leads(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists beta_access_email_key on public.beta_access (lower(email));

alter table public.beta_access enable row level security;
drop policy if exists beta_access_admin_all on public.beta_access;
create policy beta_access_admin_all on public.beta_access
  for all to authenticated
  using (public.is_admin(public.current_profile_id()))
  with check (public.is_admin(public.current_profile_id()));

-- Admins see every profile's access state (user directory); owners still see only their own row
-- through the existing owner policy.
drop policy if exists profiles_admin_read on public.profiles;
create policy profiles_admin_read on public.profiles
  for select to authenticated
  using (public.is_admin(public.current_profile_id()));
drop policy if exists profiles_admin_access_update on public.profiles;
create policy profiles_admin_access_update on public.profiles
  for update to authenticated
  using (public.is_admin(public.current_profile_id()))
  with check (public.is_admin(public.current_profile_id()));

-- Self-claim: the signed-in user asks "am I invited?". Only the Clerk-verified
-- email claim in the JWT is trusted (never profiles.email, which the user can edit).
create or replace function public.claim_beta_access()
returns text
language plpgsql security definer set search_path = public as $$
declare
  pid uuid := public.current_profile_id();
  jwt_email text := lower(coalesce(auth.jwt()->>'email', ''));
  cur text;
  ba public.beta_access%rowtype;
begin
  if pid is null then return 'no-profile'; end if;
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
grant execute on function public.claim_beta_access() to authenticated;

-- Heartbeat for the user directory.
create or replace function public.touch_last_seen()
returns void language sql security definer set search_path = public as $$
  update profiles set last_seen_at = now() where id = public.current_profile_id();
$$;
grant execute on function public.touch_last_seen() to authenticated;

-- Admin action: approve/revoke a profile directly (by profile id) and keep beta_access in step.
create or replace function public.admin_set_access(p_profile uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare pe text;
begin
  if not public.is_admin(public.current_profile_id()) then raise exception 'admin only'; end if;
  if p_status not in ('pending','active','revoked') then raise exception 'bad status'; end if;
  update profiles set access_status=p_status, updated_at=now() where id=p_profile returning lower(email) into pe;
  if pe is not null and pe <> '' then
    update beta_access set status = case when p_status='active' then 'active' when p_status='revoked' then 'revoked' else status end,
      profile_id = p_profile, activated_at = case when p_status='active' then coalesce(activated_at, now()) else activated_at end, updated_at=now()
      where lower(email)=pe;
  end if;
end $$;
grant execute on function public.admin_set_access(uuid, text) to authenticated;

-- The founder is active; the API keys stop living in Postgres (device-local from now on).
update public.profiles set access_status='active' where id in (select profile_id from public.app_admins);
update public.profiles set api_key=null, anthropic_api_key=null where api_key is not null or anthropic_api_key is not null;
