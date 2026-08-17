-- 2026-08-16 (webhook): let the service-role Clerk webhook write profiles.email.
--
-- profiles_lock_identity reverts any email change when auth.jwt() is not null.
-- PostgREST sets request.jwt.claims for every JWT-bearing request, including
-- the service_role key, so the clerk-webhook edge function's fill-blanks email
-- write on an existing row was silently reverted (3 of 5 live profiles have
-- email null/'' for this reason). The user-facing lock is unchanged: a Clerk
-- (authenticated) or anon JWT still cannot change email or auth_user_id.
-- Direct SQL (no JWT) is unchanged as well.
--
-- Not applied by the webhook worktree; run via supabase db push or the
-- management API when the owner is ready.

create or replace function public.lock_profile_identity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
begin
  if new.email is distinct from old.email
     and auth.jwt() is not null
     and jwt_role <> 'service_role' then
    new.email := old.email;
  end if;
  new.auth_user_id := old.auth_user_id;
  return new;
end;
$$;

comment on function public.lock_profile_identity() is
  'BEFORE UPDATE on profiles: authenticated/anon JWTs cannot change email or auth_user_id; service_role (Clerk webhook) and direct SQL may change email, auth_user_id is immutable for all.';
