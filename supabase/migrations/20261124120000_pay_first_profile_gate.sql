-- One step sign-up, the server half (owner, 2026-11-24: "Whatever system we
-- had where it was two steps should be reconciled into one step"). With
-- access_policy_settings.pay_first_signup_enabled on, a sign-in can no longer
-- make a NEW app profile unless that email has paid through pay-first sign-up
-- (or the owner gifted it lifetime access). The sign-in screen already shows
-- Clerk's form as sign-in only; this covers every other way a Clerk user can
-- appear (Clerk's hosted pages, its API), since clerk-webhook and
-- initialize-clerk-profile both make profiles through initialize_clerk_profile.
-- File: supabase/migrations/20261124120000_pay_first_profile_gate.sql
-- Rollback: docs/rollback/20261124120000_pay_first_profile_gate.rollback.sql
-- Needs: 20261120190000_pay_first_signup.sql.
--
-- Unchanged while the flag is off. Existing accounts (a profile for the
-- subject, or a legacy one claim_clerk_continuity binds) sign in as before:
-- only the "no profile yet" insert is gated. initialize_clerk_profile is
-- 20261001061700's body except for the lines marked 20261124120000.
-- No top-level transaction: the Supabase CLI wraps it.

-- True when a new profile may be made for this verified primary email.
create or replace function public.pay_first_new_profile_allowed(p_verified_primary_email text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select not coalesce((select pay_first_signup_enabled from public.access_policy_settings where singleton),false)
  -- Paid through pay-first sign-up: provisioning is making this account.
  or exists(select 1 from public.pay_first_signups
   where email_norm=lower(btrim(p_verified_primary_email)) and state in ('paid','provisioning','needs_owner'))
  -- A lifetime gift the owner granted to this mailbox, not yet claimed.
  or exists(select 1 from public.lifetime_gift_reservations
   where email=lower(btrim(p_verified_primary_email)) and claimed_at is null and revoked_at is null and expires_at>clock_timestamp())
$$;

create or replace function public.initialize_clerk_profile(
 p_target_subject text,p_verified_primary_email text,p_target_issuer text,
 p_provider_updated_ms bigint,p_checked_at timestamptz,p_source_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; p profiles%rowtype;
 data_deleted timestamptz; -- 20260930020000
 hinted uuid; mailbox_due boolean:=false; -- 20260930051700
 signin_due boolean:=false; created boolean:=false; -- 20261001061700
begin
 result:=claim_clerk_continuity(p_target_subject,p_verified_primary_email,p_target_issuer,p_provider_updated_ms,p_checked_at,p_source_proof);
 if result->>'state' is distinct from 'no_match' then return result; end if;
 -- 20260930051700: the mailbox domain lock before the profile row, as every mailbox writer takes them.
 select id into hinted from profiles where auth_user_id=p_target_subject;
 if hinted is not null and reopened_mailbox_due(hinted) then perform mailbox_domain_lock(); mailbox_due:=true;
 -- 20261001061700: or the account routes no address yet and its verified primary can be routed to it.
 elsif hinted is not null and signin_mailbox_due(hinted,p_verified_primary_email,p_provider_updated_ms) then perform mailbox_domain_lock(); signin_due:=true; end if;
 select * into p from profiles where auth_user_id=p_target_subject for update;
 if not found then
  -- 20261124120000: no new unpaid account while pay-first sign-up is on.
  if not pay_first_new_profile_allowed(p_verified_primary_email) then return jsonb_build_object('state','signup_requires_payment'); end if;
  insert into profiles(id,auth_user_id) values(gen_random_uuid(),p_target_subject) returning * into p;
  -- 20261001061700: no other transaction can see this row yet, so the domain lock may follow it.
  created:=true;
  if signin_mailbox_due(p.id,p_verified_primary_email,p_provider_updated_ms) then perform mailbox_domain_lock(); signin_due:=true; end if;
 end if;
 if p_checked_at<clock_timestamp()-interval '5 minutes' then raise exception 'provider identity proof expired'; end if;
 data_deleted:=reopen_account_after_data_deletion(p.id,p_target_subject); -- 20260930020000
 if account_is_closed(p.id) then return jsonb_build_object('state','account_unavailable'); end if;
 -- 20260930051700: the reopened account's own verified primary routes to it again.
 if mailbox_due and p.id=hinted then perform restore_reopened_mailbox(p.id,p_target_subject,p_verified_primary_email,p_provider_updated_ms,p_checked_at); end if;
 -- 20261001061700: an account that routes no address gets its verified primary, as clerk-webhook would route it.
 if signin_due and (created or p.id=hinted) then perform route_signin_primary(p.id,p_target_subject,p_verified_primary_email,p_provider_updated_ms); end if;
 return jsonb_build_object('schemaVersion',1,'state','current','profileId',p.id,'subject',p_target_subject,'issuer',p_target_issuer,'continuity',null)
  -- 20260930020000
  || case when data_deleted is null then '{}'::jsonb else jsonb_build_object('dataDeletedAt',data_deleted) end;
end $$;

-- Reached only through initialize_clerk_profile (which runs as its owner).
revoke all on function public.pay_first_new_profile_allowed(text) from public,anon,authenticated,service_role;
revoke all on function public.initialize_clerk_profile(text,text,text,bigint,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.initialize_clerk_profile(text,text,text,bigint,timestamptz,jsonb) to service_role;

notify pgrst, 'reload schema';
