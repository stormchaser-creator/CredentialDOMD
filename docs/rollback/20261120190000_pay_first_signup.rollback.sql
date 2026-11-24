-- docs/rollback/20261120190000_pay_first_signup.rollback.sql
-- Rollback for 20261120190000_pay_first_signup.sql.
--
-- Run as postgres. Idempotent. FIRST turn the flag off and leave the sweep
-- and the edge functions deployed until no pay-first sign-up is waiting:
--   update public.access_policy_settings set pay_first_signup_enabled=false where singleton;
-- This script refuses while any hold is paid but not finished (paid,
-- provisioning, needs_owner) or still open, so a buyer's payment is never
-- left without the record that finishes their account. A finished sign-up's
-- account, membership and founding place are ordinary rows and stay.
--
-- What it removes: the flag column, pay_first_signups, billing_disputes,
-- every pay-first routine and the sweep job; founding_public_state,
-- owner_notify_rows and owner_notify_email_kinds go back to their previous
-- bodies. profiles.email_proven_at is dropped last (docs@ then files for
-- every account as before).

do $$ declare waiting boolean;
begin
 -- The sign-up gate (20261124120000) reads pay_first_signups: roll it back first.
 if to_regprocedure('public.pay_first_new_profile_allowed(text)') is not null then
  raise exception 'run docs/rollback/20261124120000_pay_first_profile_gate.rollback.sql first';
 end if;
 if to_regclass('public.pay_first_signups') is null then return; end if;
 execute $q$select exists(select 1 from public.pay_first_signups
   where state in ('paid','provisioning','needs_owner') or (state in ('creating','open') and clock_timestamp()<expires_at+interval '15 minutes'))$q$ into waiting;
 if waiting then
  raise exception 'pay-first sign-ups are still waiting: finish them (Admin > Accounts) or let their Checkouts expire first';
 end if;
end $$;

do $cron$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'pay-first-signup-sweep';
  end if;
end
$cron$;

-- As 20260922010000.
create or replace function public.founding_public_state(p_livemode boolean)
returns text language plpgsql stable security definer set search_path=public,pg_temp as $$
declare paid integer; occupied integer;
begin
 if not exists(select 1 from public.access_policy_settings where singleton and public_founding_enabled)
  or not exists(select 1 from public.limited_founding_programs where livemode=p_livemode) then return 'disabled'; end if;
 select count(*) filter(where state='paid'),count(*) into paid,occupied from public.limited_founding_slots
  where livemode=p_livemode and not(state='promised' and public.founding_lifetime_email(promise_email,p_livemode));
 if paid=100 then return 'paid_out'; end if;
 return case when occupied<100 then 'available' else 'reserved' end;
end $$;
revoke all on function public.founding_public_state(boolean) from public,anon,authenticated,service_role;

-- The owner rows the migration added, taken out of the body as text.
do $$ declare body text; s integer; e integer;
 head constant text:='    -- Pay-first sign-up (20261120190000).';
 tail constant text:='  ) as r(kind, name, email, extra, created_at, key)';
begin
 if to_regprocedure('public.owner_notify_rows(timestamptz)') is null then return; end if;
 select pg_get_functiondef('public.owner_notify_rows(timestamptz)'::regprocedure) into body;
 s:=position(head in body);
 if s=0 then return; end if;
 e:=position(tail in body);
 if e<s then raise exception 'review owner_notify_rows by hand: the pay-first rows are not where the migration put them'; end if;
 body:=left(body,s-1)||substr(body,e);
 execute body;
end $$;
revoke all on function public.owner_notify_rows(timestamptz) from public, anon, authenticated, service_role;

-- As 20261119150000.
create or replace function public.owner_notify_email_kinds()
returns text[] language sql immutable set search_path = public, pg_temp as $$
  select array['waitlist', 'guide only', 'renewal reminder', 'founding', 'app profile', 'BETA JOINED', 'CHECKOUT STARTED', 'PAID',
               'LIFETIME GIFT CLAIMED', 'REFUND NEEDS SUPPORT', 'REFUND UNFINISHED', 'FIXED', 'FIXED BY ITSELF']
$$;
revoke all on function public.owner_notify_email_kinds() from public, anon, authenticated;

drop function if exists public.dispatch_pay_first_sweep();
drop function if exists public.admin_pay_first_signups();
drop function if exists public.record_billing_dispute(text,boolean,text,integer,text,text);
drop function if exists public.prove_pay_first_email(uuid,text);
drop function if exists public.mark_pay_first_link_emailed(uuid);
drop function if exists public.pay_first_link_due(boolean,integer);
drop function if exists public.pay_first_email_unproven(uuid);
drop function if exists public.pay_first_token_gate(uuid);
drop function if exists public.finish_pay_first_provision(uuid,uuid,text,text,boolean);
drop function if exists public.adopt_pay_first_signup(uuid,uuid,uuid,text,text,text,text,uuid,jsonb);
drop function if exists public.mark_pay_first_paid(uuid,uuid,text,text,text);
drop function if exists public.claim_pay_first_provision(uuid,text,text,text);
drop function if exists public.pay_first_sweep_batch(boolean,integer);
drop function if exists public.release_pay_first_hold(text,jsonb);
drop function if exists public.save_pay_first_session(uuid,text);
drop function if exists public.hold_pay_first_founding(boolean,text,text,text);
drop function if exists public.pay_first_founding_consent();
drop function if exists public.pay_first_open_holds(boolean);
drop table if exists public.billing_disputes;
drop table if exists public.pay_first_signups;
alter table public.access_policy_settings drop column if exists pay_first_signup_enabled;
alter table public.profiles drop column if exists email_proven_at;

notify pgrst, 'reload schema';
