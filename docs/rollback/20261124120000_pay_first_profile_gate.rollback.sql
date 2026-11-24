-- docs/rollback/20261124120000_pay_first_profile_gate.rollback.sql
-- Rollback for 20261124120000_pay_first_profile_gate.sql. Run as postgres.
-- Idempotent. initialize_clerk_profile goes back to 20261001061700's body
-- (a sign-in may again make a new profile with no payment), then the gate
-- routine is dropped. Run this BEFORE the 20261120190000 rollback, which
-- refuses while the gate exists (the gate reads pay_first_signups).

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

revoke all on function public.initialize_clerk_profile(text,text,text,bigint,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.initialize_clerk_profile(text,text,text,bigint,timestamptz,jsonb) to service_role;
drop function if exists public.pay_first_new_profile_allowed(text);

notify pgrst, 'reload schema';
