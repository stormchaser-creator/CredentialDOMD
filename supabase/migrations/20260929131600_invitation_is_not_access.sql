-- An invitation is not access (owner decision, 2026-09-29).
--
-- An invitation is now an invite to JOIN: the person signs up and pays like
-- anyone else. Until this file, a public.beta_access row activated an
-- account in three places: send-invite (when it sent), clerk-webhook (on
-- every user.created / user.updated) and claim_beta_access() (on app open in
-- the pre-launch gate, and callable by any signed-in user through the API).
-- An account activated that way has access_status 'active' and no grant, so
-- it lands in a read-only app with no paywall instead of checkout.
--
-- send-invite and clerk-webhook no longer activate (their code changes ship
-- with this file). This file makes claim_beta_access() stop activating from
-- an invitation too. What it still does is unchanged:
--   * an administrator (app_admins) is active, and is made active;
--   * an already active account answers 'active';
--   * a paused account answers 'revoked';
--   * every other account answers 'pending', whatever invitation matches its
--     email. It is never written.
-- Existing active accounts, including the five whose historical invitations
-- are linked and active, are untouched: nothing here changes a stored row.
--
-- Rerunnable: CREATE OR REPLACE and grants. No top-level transaction.
-- Rollback: docs/rollback/20260929131600_invitation_is_not_access.rollback.sql
-- restores the 20260925110000 body.

create or replace function public.claim_beta_access()
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  pid uuid := public.current_profile_id();
  cur text;
begin
  if pid is null then return 'no-profile'; end if;
  if public.is_admin(pid) then
    perform set_config('credentialdomd.access_grant', '1', true);
    update profiles set access_status='active' where id=pid and access_status<>'active';
    return 'active';
  end if;
  select access_status into cur from profiles where id=pid;
  if cur = 'active' then return 'active'; end if;
  if cur = 'revoked' then return 'revoked'; end if;
  -- An invitation (beta_access) is an invite to join, never access.
  return 'pending';
end $$;

comment on function public.claim_beta_access() is
  'Reports the caller''s app access: active (administrators are made active), revoked, or pending. Since 20260929131600 an invitation never activates an account; an invited person signs up and pays like anyone else.';

revoke execute on function public.claim_beta_access() from public, anon;
grant execute on function public.claim_beta_access() to authenticated, service_role;

notify pgrst, 'reload schema';
