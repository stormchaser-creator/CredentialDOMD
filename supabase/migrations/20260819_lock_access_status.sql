-- Two fixes to profiles identity control:
--  (1) access_status is a GATE, not a preference: a user token must never
--      change it (self-promotion to 'active' unlocked the shared AI key).
--      Only service_role / direct SQL (the webhook, admin RPCs) may.
--  (2) email is the owner's own contact field and several flows need it set
--      (reminders, backups, inbound matching, packet reply-to); the old lock
--      froze it entirely, leaving 3 of 5 profiles blank. Admin is now decided
--      by the verified Clerk JWT claim (clerkAuth.ts), NOT profiles.email, so
--      letting the owner edit their own email is no longer an escalation path.
--      Allow it; keep auth_user_id and access_status frozen.
create or replace function public.lock_profile_identity()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
  privileged boolean := auth.jwt() is null or jwt_role = 'service_role';
begin
  if new.auth_user_id is distinct from old.auth_user_id and not privileged then
    new.auth_user_id := old.auth_user_id;
  end if;
  if new.access_status is distinct from old.access_status and not privileged then
    new.access_status := old.access_status;
  end if;
  return new;
end;
$$;
comment on function public.lock_profile_identity() is
  'BEFORE UPDATE on profiles: user tokens cannot change auth_user_id or access_status; email is theirs to edit; service_role/direct SQL may change anything.';
