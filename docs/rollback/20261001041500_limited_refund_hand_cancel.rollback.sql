-- docs/rollback/20261001041500_limited_refund_hand_cancel.rollback.sql
-- Rollback for 20261001041500_limited_refund_hand_cancel.sql.
--
-- Run as postgres (the SQL editor runs a script as one transaction; with
-- psql use -1). Idempotent. Run it before the rollbacks of 20260930071000
-- and 20260930070000 when rolling back everything, and only after
-- limited-stripe-webhook and limited-refund are redeployed from the commit
-- before this change (they call limited_refund_subscription_canceled; a
-- missing function makes a cancelled subscription's event answer 503 and a
-- sweep of a hand cancelled request stop as retryable).
--
-- Cancellations already recorded stay on their rows: they are facts Stripe
-- reported, and every earlier function reads them as before. The refund
-- ticket trigger goes back to its 20260930071000 text; a ticket is rewritten
-- with that text the next time its row changes.

drop function if exists public.limited_refund_subscription_canceled(text, boolean, text, uuid, text);
drop function if exists public.limited_refund_subscription_canceled(text, boolean, text, uuid);

-- The 20260930071000 ticket text, only where that migration is still in place.
do $rollback$
begin
  if to_regprocedure('public.limited_refund_support_ticket()') is not null then
    execute $fn$
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
$fn$;
  end if;
end
$rollback$;

notify pgrst, 'reload schema';
