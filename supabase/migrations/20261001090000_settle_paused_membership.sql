-- 20261001090000_settle_paused_membership.sql
--
-- A paid membership is still paid while an administrator has the account
-- paused. Pause (admin_change_profile_access, access_status 'revoked') stops
-- access and changes no subscription or payment: Stripe keeps billing, and
-- every event about the subscription (a renewal's invoice, a portal change,
-- a retried checkout event) is settled while the pause lasts. The settlement
-- (settle_limited_billing_subscription_before_founding) counted a verified
-- payment as the membership only for an account that is active, so an event
-- settled during a pause wrote billing_subscriptions.membership_active false.
-- Approve restores access_status and, as its comment says, changes no
-- subscription, so the member came back read-only, with no membership, until
-- Stripe happened to send another event. QA lab, 2026-10-01: a member paused
-- a few seconds after paying, while the last checkout event was still being
-- retried, then approved, was read-only with "active" status (the Messages
-- seen stamp was refused; SUPPORT-003, twice).
--
-- This wraps settle_limited_billing_subscription: after an applied
-- settlement with a verified payment, an account paused by an administrator
-- (access_status 'revoked', not deleted, its invitation not revoked) keeps
-- membership_active true on the row this event settled, as an active account
-- would. Nothing else changes: a paused account still has no access (the
-- access snapshot and credentialdo_profile_scope_write_allowed require
-- access_status 'active'), a pending account is still activated only by the
-- wrapped body, an event without a verified payment still writes false, and
-- no Practice trial is recorded for a paused account
-- (record_credential_purchase_trial requires an active one). The reviewed
-- body keeps its definition under the private name
-- settle_limited_billing_subscription_before_paused.
--
-- Needs 20261001081000 first (the function it wraps). Idempotent. No
-- top-level transaction: the runner supplies one.
-- Rollback, before any rollback of 20261001081000:
-- docs/rollback/20261001090000_settle_paused_membership.rollback.sql

do $$ begin
 if to_regprocedure('public.settle_limited_billing_subscription_before_cancel_at(jsonb,uuid,jsonb)') is null then
  raise exception '20261001081000_billing_cancel_at must be applied first';
 end if;
 if to_regprocedure('public.settle_limited_billing_subscription_before_paused(jsonb,uuid,jsonb)') is null then
  alter function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) rename to settle_limited_billing_subscription_before_paused;
 end if;
end $$;

create or replace function public.settle_limited_billing_subscription(p_args jsonb,p_quote_id uuid,p_paid_proof jsonb)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare result text; pid uuid; live boolean; invitation uuid;
begin
 pid:=(p_args->>'p_profile_id')::uuid; live:=(p_args->>'p_livemode')::boolean;
 result:=public.settle_limited_billing_subscription_before_paused(p_args,p_quote_id,p_paid_proof);
 -- The wrapped body has validated the proof against this event and account.
 if result='applied' and p_paid_proof is not null then
  select invitation_id into invitation from public.limited_billing_quotes where attempt_id=p_quote_id and profile_id=pid and livemode=live;
  if exists(select 1 from public.profiles where id=pid and access_status='revoked' and deleted_at is null)
    and not exists(select 1 from public.limited_billing_invitations where id=invitation and revoked_at is not null) then
   update public.billing_subscriptions set membership_active=true
    where profile_id=pid and livemode=live and subscription_id=p_args->>'p_subscription_id'
     and last_event_id=p_args->>'p_event_id' and status='active' and not membership_active;
  end if;
 end if;
 return result;
end $$;

revoke all on function public.settle_limited_billing_subscription_before_paused(jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.settle_limited_billing_subscription(jsonb,uuid,jsonb) to service_role;

notify pgrst, 'reload schema';
