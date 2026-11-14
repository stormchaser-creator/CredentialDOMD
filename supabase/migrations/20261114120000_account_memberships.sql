-- Accounts page facts and the founding member badge for paying members.
--
-- 1. admin_account_memberships(): one row per profile with what Admin >
--    Accounts needs to sort people honestly: an active paid membership, a
--    paid founding place, lifetime or beta access, an expired checkout, and
--    whether the address also asked for a state guide. Read-only; the same
--    administrator gate as admin_attention_counts().
-- 2. Paid founding places mark the profile. profiles.is_founding_member was
--    only ever set for the pre-launch activation cohort (founding_number), so
--    the three people who paid for a founding place (limited_founding_slots
--    state 'paid') never saw the badge. A slot that becomes paid now sets the
--    flag; the three existing ones are backfilled below.
--
--    The trigger runs inside the payment settlement transaction, so it can
--    never be allowed to fail it: any error is swallowed and the badge simply
--    waits. Admin reads the slot table directly, so its view stays right
--    either way.
--
-- Rerunnable: CREATE OR REPLACE, DROP TRIGGER IF EXISTS, idempotent backfill.
-- No begin/commit: apply-migration.sh sends the file as one statement batch,
-- which Postgres runs as one transaction.

create or replace function public.admin_account_memberships()
returns table(
  profile_id uuid,
  paid_active boolean,
  paid_status text,
  paid_through timestamptz,
  cancel_at_period_end boolean,
  founding boolean,
  lifetime boolean,
  beta_until timestamptz,
  checkout_expired boolean,
  guide_requests integer
) language plpgsql stable security definer set search_path='' as $$
begin
  if public.admin_operations_can_read() is not true then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  return query
  select p.id,
    coalesce(s.membership_active,false),
    s.status,
    s.period_end,
    coalesce(s.cancel_at_period_end,false),
    (p.is_founding_member is true or p.founding_number is not null
      or exists(select 1 from public.limited_founding_slots f
        where f.livemode and f.state='paid' and f.profile_id=p.id)),
    exists(select 1 from public.access_grants g
      where g.profile_id=p.id and g.livemode and g.kind='lifetime' and g.revoked_at is null
        and (g.ends_at is null or g.ends_at>now())),
    (select max(b.ends_at) from public.limited_beta_grants b
      where b.profile_id=p.id and b.livemode and b.revoked_at is null),
    (s.profile_id is null and exists(select 1 from public.billing_checkout_attempts a
      where a.profile_id=p.id and a.livemode and a.state='expired')),
    (select count(*)::integer from public.early_access_leads l
      where btrim(coalesce(p.email,''))<>'' and lower(btrim(l.email))=lower(btrim(p.email))
        and l.guide_sent_at is not null)
  from public.profiles p
  left join lateral (
    select x.profile_id, x.membership_active, x.status, x.period_end, x.cancel_at_period_end
    from public.billing_subscriptions x
    where x.profile_id=p.id and x.livemode
    order by x.membership_active desc, x.updated_at desc nulls last
    limit 1
  ) s on true;
end $$;
revoke all on function public.admin_account_memberships() from public,anon,authenticated,service_role;
grant execute on function public.admin_account_memberships() to authenticated;

create or replace function public.founding_slot_marks_profile()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.livemode and new.state='paid' and new.profile_id is not null then
    begin
      perform set_config('credentialdomd.founding_assign','1',true);
      update public.profiles set is_founding_member=true
        where id=new.profile_id and is_founding_member is not true;
      perform set_config('credentialdomd.founding_assign','',true);
    exception when others then
      perform set_config('credentialdomd.founding_assign','',true);
      raise warning 'founding badge not set for profile %: %', new.profile_id, sqlerrm;
    end;
  end if;
  return null;
end $$;
revoke all on function public.founding_slot_marks_profile() from public,anon,authenticated,service_role;

drop trigger if exists founding_slot_marks_profile on public.limited_founding_slots;
create trigger founding_slot_marks_profile
  after insert or update of state, profile_id on public.limited_founding_slots
  for each row when (new.state='paid' and new.profile_id is not null)
  execute function public.founding_slot_marks_profile();

-- Backfill: paid founding places that predate the trigger.
select set_config('credentialdomd.founding_assign','1',true);
update public.profiles p set is_founding_member=true
where p.is_founding_member is not true
  and exists(select 1 from public.limited_founding_slots f
    where f.livemode and f.state='paid' and f.profile_id=p.id);
select set_config('credentialdomd.founding_assign','',true);

