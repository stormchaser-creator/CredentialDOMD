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
--                  state requested, subscription_canceled_at set, the lease
--                  given back with an error code (limited_refund_record
--                  'retry' after 'canceled'). A press may still finish it.
-- The row is linked to its ticket (support_ticket_id), so it gets one ticket
-- however many times it passes through these states. Entering one of them
-- again reopens that ticket and restates the facts; a request that is then
-- refunded (the next press, or the owner in the dashboard) resolves it with a
-- line that says so. The member's replies stay on the thread.
--
-- A trigger, not the edge function: every writer of the row is covered,
-- including the webhook's, in the same transaction as the state it reports.
-- It never blocks that write: a ticket that cannot be written is a warning,
-- the refund's own state is still recorded, and the owner's notifier
-- (scripts/signup-notify.py) reports the row either way.
--
-- What the ticket says: the amount, the date of the payment, where the refund
-- stands and that the owner will finish it. No card data, no Stripe ids.
-- Category billing, priority high. It carries no client_request_id: that key
-- is the member's own (create-ticket), unique per member, and a member who
-- reads a refund row's id could otherwise take it first and make this insert
-- fail. Nothing here sends email: a ticket row is not a reply
-- (trg_notify_ticket_reply fires on support_messages), and it is not released
-- to the ticket agent (agent_approved_at stays null).
--
-- Idempotent. Rollback: docs/rollback/20260930071000_limited_refund_support_tickets.rollback.sql

alter table public.limited_refund_requests add column if not exists support_ticket_id uuid;
comment on column public.limited_refund_requests.support_ticket_id is
  'The support ticket opened for this request when it needed a person (20260930071000). No foreign key: a ticket the member deletes must not reopen one, and the link is only ever written by limited_refund_support_ticket().';

create or replace function public.limited_refund_support_ticket()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  kind text; was text; amount text; paid text; line text; msg text; subject text; tid uuid;
begin
  kind := case
    when new.state = 'needs_support' then 'needs_support'
    when new.state = 'requested' and new.subscription_canceled_at is not null and new.error_code is not null and new.lease_token is null then 'unfinished'
    when new.state = 'refunded' then 'refunded' end;
  if tg_op = 'UPDATE' then
    was := case
      when old.state = 'needs_support' then 'needs_support'
      when old.state = 'requested' and old.subscription_canceled_at is not null and old.error_code is not null and old.lease_token is null then 'unfinished'
      when old.state = 'refunded' then 'refunded' end;
  end if;
  -- Only a change of standing: a press claiming the row, or a status that
  -- settles, leaves the ticket as it is.
  if kind is null or kind is not distinct from was then return new; end if;
  -- A refund that finished without ever needing a person has no ticket.
  if kind = 'refunded' and new.support_ticket_id is null then return new; end if;

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
    else 'Your refund request could not be completed automatically.' end;
  msg := 'CredentialDOMD opened this ticket for you automatically.' || E'\n\n'
    || 'Refund: ' || amount || ', your annual membership payment made on ' || paid || '.' || E'\n'
    || 'Status: ' || line
    || case when kind = 'refunded' then '' else E'\n\nThe owner of CredentialDOMD will finish this refund for you and reply here. You do not need to do anything.' end
    || case when new.livemode then '' else E'\n\n(Test mode.)' end;
  subject := 'Your refund of ' || amount || ' will be finished for you' || case when new.livemode then '' else ' (test mode)' end;

  begin
    if new.support_ticket_id is null then
      insert into public.support_tickets(user_id, subject, body, category, priority, status, context_page, context_payload)
        values (new.profile_id, subject, msg, 'billing', 'high', 'open', 'profile',
          jsonb_build_object('source', 'limited_refund', 'refund_request_id', new.id))
        returning id into tid;
      new.support_ticket_id := tid;
    elsif kind = 'refunded' then
      update public.support_tickets set body = msg, status = 'resolved', resolved_at = now(), updated_at = now()
        where id = new.support_ticket_id and user_id = new.profile_id;
    else
      -- Needs a person again: back in the open queue with the facts as they are now.
      update public.support_tickets set body = msg, status = 'open', resolved_at = null, archived_at = null, updated_at = now()
        where id = new.support_ticket_id and user_id = new.profile_id;
    end if;
  exception when others then
    -- The refund's own state is what matters here; the notifier still reports it.
    raise warning 'limited refund %: support ticket not written (%)', new.id, sqlstate;
  end;
  return new;
end $$;

comment on function public.limited_refund_support_ticket() is
  'BEFORE INSERT OR UPDATE on limited_refund_requests (20260930071000): opens one billing ticket in the member''s name when the request needs a person (needs_support, or cancelled and not refunded after a failed attempt), reopens it when it needs one again, resolves it when the refund is recorded. Never fails the write.';

revoke all on function public.limited_refund_support_ticket() from public, anon, authenticated, service_role;

drop trigger if exists limited_refund_support_ticket on public.limited_refund_requests;
create trigger limited_refund_support_ticket
  before insert or update on public.limited_refund_requests
  for each row execute function public.limited_refund_support_ticket();

notify pgrst, 'reload schema';
