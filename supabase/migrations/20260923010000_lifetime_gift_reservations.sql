-- Gift free lifetime access by email BEFORE the person has an account.
--
-- The reviewed per-account gift needs an existing, verified account. New accounts
-- are read-only until paid, so a gift recipient had to sign up, tell the owner, and
-- wait to be found and granted. A reservation lets the owner name a mailbox; the
-- first account that PROVES control of that verified primary mailbox receives
-- Credential and Practice for life, with no card and no checkout.
--
-- Safety properties:
--  * Only a verified primary mailbox claims a gift; an editable profile email never does.
--  * A claim requires a profile with ZERO billing objects, so no subscription can be
--    running. Anything else is left unclaimed for the reviewed per-account gift, which
--    reads live provider state.
--  * The reservation row is the audit record: who gifted, why, and who claimed it.
--  * The existing checkout-block trigger reads access_grants, so a gifted account can
--    never be sent to paid checkout.
begin;

create table public.lifetime_gift_reservations (
 id uuid primary key default gen_random_uuid(),
 email text not null check(email=lower(btrim(email)) and length(email) between 6 and 254
   and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 livemode boolean not null,
 reason text not null check(reason=btrim(reason) and length(reason) between 10 and 500),
 created_by uuid not null references public.profiles(id),
 created_by_subject text not null check(created_by_subject ~ '^user_[A-Za-z0-9]+$'),
 created_at timestamptz not null default clock_timestamp(),
 -- A gift nobody claims must not stay claimable forever by whoever later controls that mailbox.
 expires_at timestamptz not null default (clock_timestamp()+interval '90 days') check(expires_at>created_at),
 claimed_profile_id uuid references public.profiles(id),
 claimed_subject text,
 claimed_at timestamptz,
 revoked_at timestamptz,
 revoked_by uuid references public.profiles(id),
 check((claimed_at is null and claimed_profile_id is null and claimed_subject is null)
    or (claimed_at is not null and claimed_profile_id is not null and claimed_subject ~ '^user_[A-Za-z0-9]+$')),
 check((revoked_at is null)=(revoked_by is null)),
 check(not(claimed_at is not null and revoked_at is not null))
);
-- One open reservation per mailbox and mode. Claimed and revoked rows stay as history.
create unique index lifetime_gift_reservations_open on public.lifetime_gift_reservations(livemode,email)
 where claimed_at is null and revoked_at is null;
alter table public.lifetime_gift_reservations enable row level security;
revoke all on public.lifetime_gift_reservations from public,anon,authenticated,service_role;
grant select on public.lifetime_gift_reservations to service_role;

create function public.lifetime_gift_admin(p_actor uuid,p_actor_subject text)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if p_actor is null or p_actor_subject is null or p_actor_subject !~ '^user_[A-Za-z0-9]+$' then return false; end if;
 if not exists(select 1 from public.profiles where id=p_actor and auth_user_id=p_actor_subject and access_status='active' and deleted_at is null) then return false; end if;
 if public.account_is_closed(p_actor) then return false; end if;
 return exists(select 1 from public.app_admins where profile_id=p_actor);
end $$;

create function public.reserve_lifetime_gift(p_actor uuid,p_actor_subject text,p_email text,p_reason text,p_live boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare g public.lifetime_gift_reservations%rowtype;
begin
 if not public.lifetime_gift_admin(p_actor,p_actor_subject) then return jsonb_build_object('state','admin_required'); end if;
 if p_live is null or p_email is null or p_email<>lower(btrim(p_email)) or length(p_email) not between 6 and 254
  or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  or p_reason is null or p_reason<>btrim(p_reason) or length(p_reason) not between 10 and 500 then return jsonb_build_object('state','invalid_request'); end if;
 -- The reviewed signup body recognises only LIVE lifetime grants, so a test-mode gift could never be honoured. Say so.
 if not p_live then return jsonb_build_object('state','test_mode_unsupported'); end if;
 -- Actor row before the mailbox lock: every path orders profile, then mailbox (the insert below share-locks this row through its foreign key).
 perform 1 from public.profiles where id=p_actor for share;
 -- Same mailbox lock the signup bootstrap takes, so a reservation cannot race that mailbox's first sign-in.
 perform pg_advisory_xact_lock(8220,hashtext(p_live::text||':'||p_email));
 -- Someone who already signed up is gifted through the reviewed per-account flow, which reads live billing state.
 if exists(select 1 from public.limited_signup_enrollments where verified_primary_email=p_email and livemode=p_live)
  then return jsonb_build_object('state','account_exists'); end if;
 select * into g from public.lifetime_gift_reservations where email=p_email and livemode=p_live and claimed_at is null and revoked_at is null for update;
 if found and g.expires_at>clock_timestamp() then return jsonb_build_object('state','already_reserved','id',g.id,'email',g.email,'createdAt',g.created_at,'expiresAt',g.expires_at); end if;
 -- An expired open row still occupies the one-open-per-mailbox index; retire it so the owner can gift again.
 if found then update public.lifetime_gift_reservations set revoked_at=clock_timestamp(),revoked_by=p_actor where id=g.id; end if;
 insert into public.lifetime_gift_reservations(email,livemode,reason,created_by,created_by_subject)
  values(p_email,p_live,p_reason,p_actor,p_actor_subject) returning * into g;
 return jsonb_build_object('state','reserved','id',g.id,'email',g.email,'createdAt',g.created_at,'expiresAt',g.expires_at);
end $$;

create function public.revoke_lifetime_gift_reservation(p_actor uuid,p_actor_subject text,p_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare g public.lifetime_gift_reservations%rowtype;
begin
 if not public.lifetime_gift_admin(p_actor,p_actor_subject) then return jsonb_build_object('state','admin_required'); end if;
 if p_id is null then return jsonb_build_object('state','invalid_request'); end if;
 perform 1 from public.profiles where id=p_actor for share;
 select * into g from public.lifetime_gift_reservations where id=p_id;
 if not found then return jsonb_build_object('state','not_found'); end if;
 -- Take the mailbox lock before the row so the order matches the claim path.
 perform pg_advisory_xact_lock(8220,hashtext(g.livemode::text||':'||g.email));
 select * into g from public.lifetime_gift_reservations where id=p_id for update;
 -- A claimed gift is real lifetime access. Withdrawing that is a separate reviewed decision, never this button.
 if g.claimed_at is not null then return jsonb_build_object('state','already_claimed'); end if;
 if g.revoked_at is null then
  update public.lifetime_gift_reservations set revoked_at=clock_timestamp(),revoked_by=p_actor where id=p_id returning * into g;
 end if;
 return jsonb_build_object('state','revoked','id',g.id,'revokedAt',g.revoked_at);
end $$;

create function public.list_lifetime_gift_reservations(p_actor uuid,p_actor_subject text,p_live boolean)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not public.lifetime_gift_admin(p_actor,p_actor_subject) then return jsonb_build_object('state','admin_required'); end if;
 return jsonb_build_object('state','ready','reservations',coalesce((select jsonb_agg(jsonb_build_object(
   'id',g.id,'email',g.email,'reason',g.reason,'createdAt',g.created_at,'expiresAt',g.expires_at,'claimedAt',g.claimed_at,'revokedAt',g.revoked_at,
   'claimedName',(select coalesce(nullif(btrim(p.name),''),'') from public.profiles p where p.id=g.claimed_profile_id),
   -- Signed up with this mailbox but not applied automatically (existing billing): the owner must use the reviewed per-account gift.
   'signedUp',g.claimed_at is null and exists(select 1 from public.limited_signup_enrollments e where e.verified_primary_email=g.email and e.livemode=g.livemode))
   order by (g.claimed_at is null and g.revoked_at is null) desc,g.created_at desc)
  from (select * from public.lifetime_gift_reservations where livemode=p_live
        order by (claimed_at is null and revoked_at is null) desc,created_at desc limit 200) g),'[]'::jsonb));
end $$;

-- Claim at the single signup choke point. The reviewed bootstrap body is preserved
-- byte for byte; it already treats an existing valid lifetime grant as a lifetime
-- enrollment and activates the pending profile.
alter function public.bootstrap_limited_signup(uuid,text,boolean,text) rename to bootstrap_limited_signup_before_gift;
create function public.bootstrap_limited_signup(p_profile_id uuid,p_clerk_subject text,p_livemode boolean,p_verified_primary_email text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.profiles%rowtype; g public.lifetime_gift_reservations%rowtype; scope_name text; started timestamptz; r jsonb;
begin
 if p_livemode is true and p_clerk_subject ~ '^user_[A-Za-z0-9]+$' and p_verified_primary_email is not null
  and p_verified_primary_email=lower(btrim(p_verified_primary_email)) then
  -- The claim and the reviewed body run inside one subtransaction. The body can REFUSE with an
  -- ordinary return (signup paused, identity changed, membership unavailable). A refusal must
  -- never leave a committed gift beside it, so anything but a confirmed lifetime enrollment
  -- raises, which rolls the claim back; the body is then run again without it.
  begin
   -- Profile row first, then the mailbox lock: the same order the preserved body uses.
   select * into p from public.profiles where id=p_profile_id and auth_user_id=p_clerk_subject for update;
   if found and p.access_status in ('active','pending') and p.deleted_at is null and not public.account_is_closed(p.id) then
    perform pg_advisory_xact_lock(8220,hashtext(p_livemode::text||':'||p_verified_primary_email));
    select * into g from public.lifetime_gift_reservations
     where email=p_verified_primary_email and livemode=p_livemode and claimed_at is null and revoked_at is null
      and expires_at>clock_timestamp() for update;
    if found then
     started:=clock_timestamp();
     if (select count(*) from public.access_grants where profile_id=p.id and livemode=p_livemode and kind='lifetime' and revoked_at is null
          and starts_at<=started and public.continuity_owns_subject(p.id,p_clerk_subject,clerk_subject))=2
       and not exists(select 1 from public.access_grants where profile_id=p.id and livemode=p_livemode and kind='lifetime' and revoked_at is not null) then
      -- Already free for life another way (sealed cohort or the reviewed per-account gift).
      -- Close the reservation to this same verified owner so it cannot dangle; grant nothing new.
      update public.lifetime_gift_reservations set claimed_profile_id=p.id,claimed_subject=p_clerk_subject,claimed_at=started where id=g.id;
     elsif
      -- Never stack onto prior lifetime history (a revoked grant must stay a refusal in the preserved body).
      not exists(select 1 from public.access_grants where profile_id=p.id and livemode=p_livemode and kind='lifetime')
      -- Zero billing objects: nothing can be renewing. Anything else goes to the reviewed per-account gift.
      and not exists(select 1 from public.billing_accounts where profile_id=p.id and livemode=p_livemode)
      and not exists(select 1 from public.billing_subscriptions where profile_id=p.id and livemode=p_livemode)
      and not exists(select 1 from public.billing_checkout_attempts where profile_id=p.id and livemode=p_livemode)
      and not exists(select 1 from public.limited_billing_quotes where profile_id=p.id and livemode=p_livemode)
      and not exists(select 1 from public.limited_paid_purchase_history where profile_id=p.id and livemode=p_livemode)
      -- Imported accounts keep legacy rows under their ORIGINAL subject, so test every subject this profile owns.
      and not exists(select 1 from public.subscriptions s where s.auth_user_id=p_clerk_subject or public.continuity_owns_subject(p.id,p_clerk_subject,s.auth_user_id)) then
      foreach scope_name in array array['credential','practice'] loop
       insert into public.access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at)
        values(p.id,p_clerk_subject,p_livemode,scope_name,'lifetime','admin-gift-reserved:'||g.id::text,started);
      end loop;
      update public.lifetime_gift_reservations set claimed_profile_id=p.id,claimed_subject=p_clerk_subject,claimed_at=started where id=g.id;
     end if;
     if exists(select 1 from public.lifetime_gift_reservations where id=g.id and claimed_at is not null) then
      r:=public.bootstrap_limited_signup_before_gift(p_profile_id,p_clerk_subject,p_livemode,p_verified_primary_email);
      if r->>'state' is distinct from 'enrolled' or r->>'kind' is distinct from 'lifetime' then
       raise exception 'gift claim not confirmed by signup' using errcode='GFT01';
      end if;
      return r;
     end if;
    end if;
   end if;
  exception when sqlstate 'GFT01' then
   null; -- the subtransaction, claim included, is rolled back; fall through to an ordinary signup
  end;
 end if;
 return public.bootstrap_limited_signup_before_gift(p_profile_id,p_clerk_subject,p_livemode,p_verified_primary_email);
end $$;

revoke all on function public.bootstrap_limited_signup_before_gift(uuid,text,boolean,text) from public,anon,authenticated,service_role;
revoke all on function public.lifetime_gift_admin(uuid,text),public.reserve_lifetime_gift(uuid,text,text,text,boolean),
 public.revoke_lifetime_gift_reservation(uuid,text,uuid),public.list_lifetime_gift_reservations(uuid,text,boolean),
 public.bootstrap_limited_signup(uuid,text,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.reserve_lifetime_gift(uuid,text,text,text,boolean),public.revoke_lifetime_gift_reservation(uuid,text,uuid),
 public.list_lifetime_gift_reservations(uuid,text,boolean),public.bootstrap_limited_signup(uuid,text,boolean,text) to service_role;
commit;
