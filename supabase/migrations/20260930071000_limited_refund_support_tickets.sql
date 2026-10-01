-- 20260930071000_limited_refund_support_tickets.sql
--
-- A refund that cannot finish reaches the owner without the member doing
-- anything (owner request 2026-09-30, Cancel and get a refund).
--
-- Whenever a limited_refund_requests row (20260930070000) becomes one a
-- person has to finish, this opens ONE support ticket for that member, in the
-- member's own name, so it shows in Get help as their ticket and in Admin >
-- Tickets for the owner. A row needs a person when:
--   needs_support  every path that records it: limited_refund_record (Stripe
--                  refused the refund for good, refunded_payment_not_latest,
--                  a disputed or partly refunded charge found when a request
--                  is quoted again), limited_refund_update (refund.failed,
--                  refund.updated, charge.refund.updated after Stripe had
--                  accepted it);
--   unfinished     cancelled but not refunded after a failed refund attempt:
--                  state requested, subscription_canceled_at set, with an
--                  error code (limited_refund_record 'retry' after
--                  'canceled'; a press or the sweep holding the lease since
--                  does not change it). A press or the sweep may still
--                  finish it.
-- The row is linked to its ticket (support_ticket_id), so it gets one ticket
-- however many times it passes through these states. The standing the ticket
-- last reported is kept on the row (support_ticket_standing, written only
-- here): the ticket is reopened and restated only when that standing changes
-- (unfinished to needs_support, refunded to needs_support after a refund
-- fails), never when a press or the sweep takes the lease and gives it back
-- with the same standing, so the owner's own status and archive stay as the
-- owner set them. A request that is then refunded (the next press, the sweep,
-- or the owner in the dashboard) resolves it with a line that says so. Facts
-- that change within one standing (the membership cancelled since) rewrite
-- the text only. The member's replies stay on the thread.
--
-- A trigger, not the edge function: every writer of the row is covered,
-- including the webhook's, in the same transaction as the state it reports.
-- It never blocks that write: a ticket that cannot be written is a warning,
-- the refund's own state is still recorded (the standing is not, so the next
-- write tries again), and the owner's notifier (scripts/signup-notify.py)
-- reports the row either way.
--
-- What the ticket says: the amount, the date of the payment, where the refund
-- stands (whether the membership is cancelled yet) and what happens next. It
-- promises that the owner finishes the refund only where nothing stands in
-- the way; a disputed or partly refunded charge, a refund made of an older
-- payment, a payment a paid renewal has replaced, or a charge or
-- subscription that no longer matches gets neutral text: a person looks at
-- it and replies (limited-refund's reviewOnly answer is the same list). No card data, no Stripe ids. Category billing,
-- priority high, context_payload.source 'limited_refund': the app labels the
-- ticket's text as from CredentialDOMD Support, not from the member
-- (SupportModal, AdminDashboard). Only this trigger may write that source or
-- change such a ticket's subject, text, owner or context
-- (limited_refund_ticket_guard on support_tickets): a member cannot label
-- their own text as Support's. It carries no client_request_id: that key
-- is the member's own (create-ticket), unique per member, and a member who
-- reads a refund row's id could otherwise take it first and make this insert
-- fail. Nothing here sends email: a ticket row is not a reply
-- (trg_notify_ticket_reply fires on support_messages). It is not released to
-- the ticket agent: agent_approved_at stays null, and the runner leaves a
-- limited_refund ticket out even on an admin's own account unless the owner
-- releases it (scripts/ticket-agent-context.mjs).
--
-- Idempotent. Rollback: docs/rollback/20260930071000_limited_refund_support_tickets.rollback.sql

alter table public.limited_refund_requests add column if not exists support_ticket_id uuid;
comment on column public.limited_refund_requests.support_ticket_id is
  'The support ticket opened for this request when it needed a person (20260930071000). No foreign key: a ticket the member deletes must not reopen one, and the link is only ever written by limited_refund_support_ticket().';
alter table public.limited_refund_requests add column if not exists support_ticket_standing text;
comment on column public.limited_refund_requests.support_ticket_standing is
  'The standing the linked ticket last reported (needs_support, unfinished, refunded), written only by limited_refund_support_ticket(): the ticket is reopened only when it changes (20260930071000).';

create or replace function public.limited_refund_support_ticket()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  kind text; amount text; paid text; line text; msg text; subj text; tid uuid; neutral boolean;
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
  -- a person looks first, and nothing is promised. Also a payment that is no
  -- longer the latest (refund_payment_changed: a renewal was paid and the
  -- request could not follow it, so the payment named here is not the one
  -- the guarantee refunds now), a subscription that is not this app's
  -- (subscription_mismatch) and a payment with no charge (charge_missing)
  -- (review round 4).
  neutral := kind = 'needs_support' and new.error_code in ('charge_disputed', 'charge_mismatch', 'charge_partly_refunded', 'refunded_payment_not_latest',
    'refund_payment_changed', 'subscription_mismatch', 'charge_missing');
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
    -- Not cancelled yet, and this payment has money going back (support
    -- refunded it in the dashboard; limited_refund_confirm keeps that refund
    -- on the row) or was refunded in part or in full elsewhere: never
    -- "nothing has been refunded" (review round 6).
    when new.refund_id is not null and new.refund_status in ('failed', 'canceled') then
      'Your membership is not cancelled yet. A refund of this payment was started but did not go through, so the payment has not been returned. '
        || case when neutral then 'Your request needs a person to look at it first.' else 'Your request could not be completed automatically.' end
    when new.refund_id is not null then
      'Your membership is not cancelled yet. A refund of this payment was issued to the card you paid with. '
        || case when neutral then 'Your request needs a person to look at the rest.' else 'The cancellation could not be completed automatically.' end
    when neutral and new.error_code = 'charge_partly_refunded' then
      'Your membership is not cancelled yet. Part of this payment has already been refunded. Your request needs a person to look at it first.'
    when neutral and new.error_code = 'refunded_payment_not_latest' then
      'Your membership is not cancelled yet. A refund of this payment has already been made. Your request needs a person to look at it first.'
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
    if new.support_ticket_id is null then
      insert into public.support_tickets(user_id, subject, body, category, priority, status, context_page, context_payload)
        values (new.profile_id, subj, msg, 'billing', 'high', 'open', 'profile',
          jsonb_build_object('source', 'limited_refund', 'refund_request_id', new.id))
        returning id into tid;
      new.support_ticket_id := tid;
    elsif kind is not distinct from new.support_ticket_standing then
      -- No change of standing: the text only, when a fact changed (say the
      -- membership was cancelled since), and nothing the owner set.
      update public.support_tickets set subject = subj, body = msg
        where id = new.support_ticket_id and user_id = new.profile_id and (subject is distinct from subj or body is distinct from msg);
    elsif kind = 'refunded' then
      update public.support_tickets set subject = subj, body = msg, status = 'resolved', resolved_at = now(), updated_at = now()
        where id = new.support_ticket_id and user_id = new.profile_id;
    else
      -- Needs a person again, or now: back in the open queue with the facts as they are now.
      update public.support_tickets set subject = subj, body = msg, status = 'open', resolved_at = null, archived_at = null, updated_at = now()
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

notify pgrst, 'reload schema';
