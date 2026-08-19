-- profiles_lock_identity froze auth_user_id for every caller, which is right
-- for user tokens but blocks the one legitimate move: re-keying a profile
-- from a Clerk development user id to its production id after the cutover.
-- Allow it only when there is no JWT (the management API / direct SQL) or
-- the caller is the service role; anon and authenticated stay frozen.
create or replace function public.lock_profile_identity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
  privileged boolean := auth.jwt() is null or jwt_role = 'service_role';
begin
  if new.email is distinct from old.email and not privileged then
    new.email := old.email;
  end if;
  if new.auth_user_id is distinct from old.auth_user_id and not privileged then
    new.auth_user_id := old.auth_user_id;
  end if;
  return new;
end;
$$;
comment on function public.lock_profile_identity() is
  'BEFORE UPDATE on profiles: user tokens cannot change email or auth_user_id; service_role and direct SQL may (Clerk webhook fills, dev->prod re-link).';
