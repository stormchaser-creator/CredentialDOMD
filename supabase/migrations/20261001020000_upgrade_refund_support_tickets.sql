-- 20261001020000_upgrade_refund_support_tickets.sql
-- Additive upgrade for installations that already applied the earlier 0710
-- refund-ticket trigger. Do not rewrite that installation's applied hash.
-- Run this entire file in one transaction (psql -1 or SQL-editor request).
-- Lock order follows ordinary ledger writes: ledger, then its support ticket.
lock table public.limited_refund_requests in share row exclusive mode;
lock table public.support_tickets in share row exclusive mode;

alter table public.limited_refund_requests add column if not exists support_ticket_id uuid;
alter table public.limited_refund_requests add column if not exists support_ticket_standing text;
-- Only inside this locked transaction: backfilling an 811 trigger with a NULL
-- standing must not itself reopen the owner's existing ticket.
drop trigger if exists limited_refund_support_ticket on public.limited_refund_requests;
drop trigger if exists limited_refund_ticket_guard on public.support_tickets;

-- Remember only pre-upgrade rows, so reapplying never rewrites a newer
-- authoritative standing or operator-owned fields.
drop table if exists pg_temp.refund_ticket_upgrade_legacy;
create temporary table refund_ticket_upgrade_legacy on commit drop as
 select id from public.limited_refund_requests
  where support_ticket_id is not null and support_ticket_standing is null;

-- A legacy request already linked to a ticket starts from the current
-- standing. The lease is intentionally irrelevant. Cancellation can have
-- cleared error_code while a retry is in flight; retain the unfinished
-- baseline in that case instead of reopening the same existing ticket later.
-- Before cancellation a linked request already needed support. This one-time
-- baseline preserves operator status/archive; later real standing changes
-- use the new trigger normally. Never overwrite a standing already recorded.
update public.limited_refund_requests
   set support_ticket_standing = case
     when state = 'refunded' then 'refunded'
     when state = 'needs_support' then 'needs_support'
     when subscription_canceled_at is not null then 'unfinished'
     else 'needs_support' end
 where support_ticket_id is not null and support_ticket_standing is null;

-- Before the new guard existed, a member's arbitrary context could claim
-- Support's source. Only the exact server-held ticket/request/owner relation
-- authenticates that reserved marker. Keep the ticket, conversation, status,
-- archive, timestamps and all other context; remove only the forged marker.
update public.support_tickets t
   set context_payload = t.context_payload - 'source' - 'refund_request_id'
 where t.context_payload->>'source' = 'limited_refund'
   and not exists (
     select 1 from public.limited_refund_requests r
      where r.support_ticket_id = t.id and r.profile_id = t.user_id
        and t.context_payload->>'refund_request_id' = r.id::text
   );

-- A ledger link proves the automatic ticket's identity, not that its old
-- editable body is still Support's wording. Clear that label first. Current
-- unambiguous rows regain canonical wording and attribution below; ambiguous
-- rows, or a failed restatement, keep their content without a trusted label
-- until a later successful authoritative ledger restatement.
update public.support_tickets t
   set context_payload = t.context_payload - 'source' - 'refund_request_id'
  from public.limited_refund_requests r, pg_temp.refund_ticket_upgrade_legacy legacy
 where r.id = legacy.id and r.support_ticket_id = t.id and r.profile_id = t.user_id
   and t.context_payload->>'source' = 'limited_refund';

-- The reviewed 811 trigger/guard definitions are repeated deliberately in this
-- NEW migration so an already-applied 0710 receives the same behavior without
-- replaying or editing historical migration content.
create or replace function public.limited_refund_support_ticket()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  kind text; amount text; paid text; line text; msg text; subj text; tid uuid; neutral boolean; trusted_context jsonb;
begin
  -- The lease plays no part: a press or the sweep holding it leaves the
  -- standing as it was, so taking and giving back the lease is no change.
  kind := case
    when new.state = 'needs_support' then 'needs_support'
    when new.state = 'requested' and new.subscription_canceled_at is not null and new.error_code is not null then 'unfinished'
    when new.state = 'refunded' then 'refunded' end;
  if kind is null then return new; end if;
  -- A refund that finished without ever needing a person has no ticket.
  if kind = 'refunded' and new.support_ticket_id is null then return new; end if;
  -- The same standing with a ticket already written: the owner's status and
  -- archive stay; only the facts are restated below, if they changed.

  -- Stops where a refund may not be owed as asked, or may not be possible:
  -- a person looks first, and nothing is promised.
  neutral := kind = 'needs_support' and new.error_code in ('charge_disputed', 'charge_mismatch', 'charge_partly_refunded', 'refunded_payment_not_latest');
  amount := '$' || to_char(new.amount_cents / 100.0, 'FM999990.00');
  paid := to_char(new.paid_at at time zone 'UTC', 'FMMonth FMDD, YYYY');
  line := case
    when kind = 'refunded' then
      'Refunded. The refund was issued on ' || to_char(coalesce(new.refunded_at, now()) at time zone 'UTC', 'FMMonth FMDD, YYYY')
        || ' to the card you paid with. Nothing more is needed.'
    when kind = 'unfinished' then
      'Your membership is cancelled. The refund has not gone through yet, so the payment has not been returned.'
    when new.subscription_canceled_at is not null and new.refund_status in ('failed', 'canceled') then
      'Your membership is cancelled. The refund was started but did not go through, so the payment has not been returned.'
    when new.subscription_canceled_at is not null then
      'Your membership is cancelled. The refund could not be completed automatically, so the payment has not been returned.'
    when neutral then
      'Your membership is not cancelled yet, and nothing has been refunded. Your request needs a person to look at it first.'
    else 'Your membership is not cancelled yet, and the payment has not been returned. Your request could not be completed automatically.' end;
  msg := 'CredentialDOMD opened this ticket for you automatically.' || E'\n\n'
    || 'Refund: ' || amount || ', your annual membership payment made on ' || paid || '.' || E'\n'
    || 'Status: ' || line
    || case when kind = 'refunded' then ''
            when neutral then E'\n\nThe owner of CredentialDOMD will look at it and reply here.'
            else E'\n\nThe owner of CredentialDOMD will finish this refund for you and reply here. You do not need to do anything.' end
    || case when new.livemode then '' else E'\n\n(Test mode.)' end;
  subj := case when kind = 'refunded' then 'Your refund of ' || amount
              when neutral then 'Your refund request for ' || amount
              else 'Your refund of ' || amount || ' will be finished for you' end
    || case when new.livemode then '' else ' (test mode)' end;

  begin
    -- An ambiguous legacy ticket can intentionally lack this trusted marker.
    -- A later authoritative restatement restores it, preserving other context.
    -- Lock before reading it so a concurrent context edit cannot be lost.
    -- Keep even this optional read inside the refund-safe exception boundary.
    select (case when jsonb_typeof(context_payload) = 'object' then context_payload else '{}'::jsonb end)
      || jsonb_build_object('source', 'limited_refund', 'refund_request_id', new.id)
      into trusted_context from public.support_tickets
      where id = new.support_ticket_id and user_id = new.profile_id for update;
    if new.support_ticket_id is null then
      insert into public.support_tickets(user_id, subject, body, category, priority, status, context_page, context_payload)
        values (new.profile_id, subj, msg, 'billing', 'high', 'open', 'profile',
          jsonb_build_object('source', 'limited_refund', 'refund_request_id', new.id))
        returning id into tid;
      new.support_ticket_id := tid;
    elsif kind is not distinct from new.support_ticket_standing then
      -- No change of standing: the text only, when a fact changed (say the
      -- membership was cancelled since), and nothing the owner set.
      update public.support_tickets set subject = subj, body = msg, context_payload = trusted_context
        where id = new.support_ticket_id and user_id = new.profile_id and (subject is distinct from subj or body is distinct from msg or context_payload is distinct from trusted_context);
    elsif kind = 'refunded' then
      update public.support_tickets set subject = subj, body = msg, context_payload = trusted_context, status = 'resolved', resolved_at = now(), updated_at = now()
        where id = new.support_ticket_id and user_id = new.profile_id;
    else
      -- Needs a person again, or now: back in the open queue with the facts as they are now.
      update public.support_tickets set subject = subj, body = msg, context_payload = trusted_context, status = 'open', resolved_at = null, archived_at = null, updated_at = now()
        where id = new.support_ticket_id and user_id = new.profile_id;
    end if;
    new.support_ticket_standing := kind;
  exception when others then
    -- The refund's own state is what matters here; the notifier still reports it.
    raise warning 'limited refund %: support ticket not written (%)', new.id, sqlstate;
  end;
  return new;
end $$;

comment on function public.limited_refund_support_ticket() is
  'BEFORE INSERT OR UPDATE on limited_refund_requests (20260930071000): opens one billing ticket in the member''s name when the request needs a person (needs_support, or cancelled and not refunded after a failed attempt), reopens it only when that standing changes (support_ticket_standing), resolves it when the refund is recorded. Never fails the write.';

revoke all on function public.limited_refund_support_ticket() from public, anon, authenticated, service_role;

drop trigger if exists limited_refund_support_ticket on public.limited_refund_requests;
create trigger limited_refund_support_ticket
  before insert or update on public.limited_refund_requests
  for each row execute function public.limited_refund_support_ticket();

-- Only limited_refund_support_ticket() (running as its owner) writes a
-- ticket marked context_payload.source 'limited_refund', or changes such a
-- ticket's subject, text, owner or context: the app shows that text as
-- CredentialDOMD Support's, so nobody else may put words there. A member's
-- own ticket that claims the source (create-ticket copies the member's
-- context) is filed without it. Status, priority, archive and the agent
-- release stay the owner's and the member's to change. Security invoker on
-- purpose: current_user is the caller, or the refund trigger's owner inside it.
create or replace function public.limited_refund_ticket_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare writer name;
begin
  select pg_get_userbyid(p.proowner) into writer from pg_proc p where p.oid = to_regprocedure('public.limited_refund_support_ticket()');
  if writer is not null and current_user = writer then return new; end if;
  if tg_op = 'INSERT' then
    if new.context_payload->>'source' = 'limited_refund' then
      new.context_payload := new.context_payload - 'source' - 'refund_request_id';
    end if;
    return new;
  end if;
  if (old.context_payload->>'source' = 'limited_refund' or new.context_payload->>'source' = 'limited_refund')
     and (new.subject is distinct from old.subject or new.body is distinct from old.body
          or new.user_id is distinct from old.user_id or new.context_payload is distinct from old.context_payload) then
    raise exception 'an automatic refund ticket is written only by the refund ledger' using errcode = '42501';
  end if;
  return new;
end $$;

comment on function public.limited_refund_ticket_guard() is
  'BEFORE INSERT OR UPDATE on support_tickets (20260930071000): only limited_refund_support_ticket() writes context_payload.source ''limited_refund'' or changes such a ticket''s subject, body, owner or context.';

revoke all on function public.limited_refund_ticket_guard() from public, anon, authenticated, service_role;

drop trigger if exists limited_refund_ticket_guard on public.support_tickets;
create trigger limited_refund_ticket_guard
  before insert or update on public.support_tickets
  for each row execute function public.limited_refund_ticket_guard();

-- Current, unambiguous legacy standings are restated by the same server
-- renderer as future transitions. Their baseline already matches, so this
-- changes only automated subject/body/context, never status/archive/approval/
-- priority/order, and inserts no ticket or support message.
update public.limited_refund_requests r
   set support_ticket_standing = r.support_ticket_standing
  from pg_temp.refund_ticket_upgrade_legacy legacy
 where r.id = legacy.id
   and (r.state in ('needs_support', 'refunded')
     or (r.state = 'requested' and r.subscription_canceled_at is not null and r.error_code is not null));

notify pgrst, 'reload schema';
