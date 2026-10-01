-- 20261001041500_limited_refund_hand_cancel.sql
--
-- A refund request whose membership the owner cancelled by hand in the Stripe
-- dashboard (owner request, 2026-09-30). Until now nothing recorded that
-- cancellation on the request: limited-stripe-webhook settled the deleted
-- subscription (access ended), but a request still 'requested' or handed to
-- a person ('needs_support') before its cancellation kept saying "not
-- cancelled yet" in Profile, in the member's ticket and in the owner's
-- notifier for good, and its ticket had to be answered by hand.
--
-- limited_refund_subscription_canceled(p_subscription_id, p_livemode,
-- p_paid_invoice_id, p_token, p_charge_review): Stripe says the request's subscription is
-- cancelled (limited-stripe-webhook on customer.subscription.deleted, after
-- it settles the subscription; or the leaseholder of a press, the sweep or
-- the webhook finding it cancelled when the request never recorded its
-- cancellation, p_token its lease). p_paid_invoice_id is the subscription's
-- most recent invoice that collected a payment, read fresh from Stripe by
-- the caller (null when it has none). p_charge_review is what the caller
-- read fresh on the request's recorded charge when that payment is the most
-- recent one: 'charge_partly_refunded' (the owner picked the dashboard's
-- prorated refund when cancelling, say) or 'charge_disputed', else null; it
-- counts only for the most recent payment. The cancellation is
-- recorded on the row (subscription_canceled_at) and what happens to the
-- refund follows the rules already in force:
--   requested, and its payment is still the most recent one: stays
--     requested, cancelled. The member confirmed the cancellation and the
--     refund of the most recent annual payment together, and that is still
--     the payment on record, so the refund is owed as confirmed: the sweep
--     (20260930072000) or the member's next press refunds it, exactly as
--     after a press whose cancellation went through and whose refund did not
--     (limited_refund_record 'canceled' clears the error the same way). A
--     refund support already made of that charge is found and recorded then.
--     Its charge refunded in part or disputed (p_charge_review): needs_support
--     with that reason instead (review-only, "Part of this payment has
--     already been refunded"), never left owed in full for the sweep, whose
--     full refund Stripe would refuse.
--   requested, and a renewal was paid since (its payment is not the most
--     recent): needs_support, refund_payment_changed (refunded_payment_not_latest
--     when the row holds a refund of its own payment). The guarantee refunds
--     the most recent payment and a cancelled subscription can no longer be
--     followed to it (limited_refund_follow refuses a cancelled request), so
--     nothing is refunded automatically: a person decides (review-only, the
--     same neutral text as every other refund_payment_changed).
--   needs_support for a reason where a refund may not be owed as asked (the
--     review-only list: a dispute, a partial refund, a refund of an older
--     payment, a payment a renewal replaced, a subscription or charge that
--     does not match): stays needs_support, cancelled. The owner resolves it;
--     a full refund in the dashboard then records it as refunded
--     (limited_refund_confirm, now that the cancellation is on record).
--   needs_support for any other reason, before its cancellation (the sweep
--     used up its attempts, say, while Stripe would not cancel), and its
--     payment is still the most recent: back to requested, cancelled, with
--     its error kept, so its ticket reads "cancelled, the refund has not
--     gone through yet" (standing unfinished) and the sweep finishes the
--     refund the member confirmed, as limited_refund_confirm already reopens
--     such a row when the owner refunds it in the dashboard. Its charge
--     refunded in part or disputed (p_charge_review): stays needs_support
--     (owner resolved) with that reason. Its payment no
--     longer the most recent: stays needs_support (owner resolved), with
--     refund_payment_changed (refunded_payment_not_latest when the row holds
--     a refund), so nothing is promised about a payment the guarantee no
--     longer covers.
-- A request a press or the sweep is working on (a live lease the caller does
-- not hold) is left to it when its payment is the most recent one and its
-- charge is untouched, with the cancellation recorded and any earlier error
-- cleared (as limited_refund_record 'canceled' clears it), so the ticket
-- trigger never reads a working request as cancelled and unfinished;
-- otherwise the answer is 'busy' and Stripe delivers the event again. Answers 'not_found', 'duplicate' (refunded, or
-- the cancellation is recorded already), 'canceled', 'reopened', 'recorded'
-- (needs_support, cancellation noted), 'needs_support' (moved there now),
-- 'busy' or 'lease_lost'. Service role only.
--
-- limited_refund_support_ticket() (20260930071000) is restated with the
-- lines a cancelled row now reaches: cancelled with a refund of its payment
-- issued, and cancelled where a person looks first (nothing claimed about
-- money the row does not hold). Its standings and when it reopens a ticket
-- are unchanged.
--
-- Needs 20260930070000 and 20260930071000. Idempotent.
-- Rollback: docs/rollback/20261001041500_limited_refund_hand_cancel.rollback.sql

-- The four argument form an earlier draft of this migration created (never
-- released): replaced by the form with p_charge_review.
drop function if exists public.limited_refund_subscription_canceled(text, boolean, text, uuid);

create or replace function public.limited_refund_subscription_canceled(p_subscription_id text, p_livemode boolean, p_paid_invoice_id text, p_token uuid, p_charge_review text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.limited_refund_requests%rowtype; held boolean; latest boolean; review boolean; charge_review text;
begin
  if p_charge_review is not null and p_charge_review not in ('charge_disputed', 'charge_partly_refunded') then
    raise exception 'limited_refund_subscription_canceled: unknown charge review' using errcode = '22023';
  end if;
  select * into r from public.limited_refund_requests where subscription_id = p_subscription_id and livemode = p_livemode;
  if not found then return 'not_found'; end if;
  perform 1 from public.billing_accounts where profile_id = r.profile_id and livemode = r.livemode for update;
  select * into r from public.limited_refund_requests where id = r.id for update;
  if r.state = 'refunded' or r.subscription_canceled_at is not null then return 'duplicate'; end if;
  held := r.lease_until is not null and r.lease_until > clock_timestamp();
  if p_token is not null and (r.state <> 'requested' or r.lease_token is distinct from p_token or not held) then return 'lease_lost'; end if;
  latest := p_paid_invoice_id is not null and p_paid_invoice_id = r.invoice_id;
  -- The charge the caller read is the request's only while its payment is the most recent.
  charge_review := case when latest then p_charge_review end;
  -- The same list as REFUND_REVIEW_ONLY and the ticket's neutral text.
  review := r.error_code in ('charge_disputed', 'charge_mismatch', 'charge_partly_refunded', 'refunded_payment_not_latest',
    'refund_payment_changed', 'subscription_mismatch', 'charge_missing');
  if r.state = 'needs_support' then
    if latest and not coalesce(review, false) and charge_review is null then
      update public.limited_refund_requests set state = 'requested', subscription_canceled_at = now(), lease_token = null, lease_until = null, updated_at = now()
        where id = r.id;
      return 'reopened';
    end if;
    -- A renewal replaced the payment it holds, or its charge was refunded in
    -- part or disputed: the ticket and the member read the review-only text.
    update public.limited_refund_requests set subscription_canceled_at = now(), updated_at = now(),
      error_code = case when coalesce(review, false) then error_code
                        when latest then charge_review
                        when refund_id is not null then 'refunded_payment_not_latest' else 'refund_payment_changed' end
      where id = r.id;
    return 'recorded';
  end if;
  if held and p_token is null then
    if not latest or charge_review is not null then return 'busy'; end if;
    -- The leaseholder records its own steps; the cancellation is a fact. An
    -- error an earlier attempt left is cleared with it, as
    -- limited_refund_record 'canceled' clears it: cancelled with a stale
    -- error would read as unfinished and open a ticket for a refund that is
    -- going through.
    update public.limited_refund_requests set subscription_canceled_at = now(), error_code = null, updated_at = now() where id = r.id;
    return 'canceled';
  end if;
  if latest and charge_review is null then
    update public.limited_refund_requests set subscription_canceled_at = now(), error_code = null, updated_at = now() where id = r.id;
    return 'canceled';
  end if;
  update public.limited_refund_requests set state = 'needs_support', subscription_canceled_at = now(),
    error_code = case when charge_review is not null then charge_review
                      when r.refund_id is not null then 'refunded_payment_not_latest' else 'refund_payment_changed' end,
    lease_token = null, lease_until = null, updated_at = now() where id = r.id;
  return 'needs_support';
end $$;

comment on function public.limited_refund_subscription_canceled(text, boolean, text, uuid, text) is
  'A refund request''s subscription found cancelled at Stripe (20261001041500): records the cancellation; a request still for the most recent payment with an untouched charge stays owed (requested) or is reopened from a non review-only needs_support; one a renewal replaced, or whose charge was refunded in part or disputed, goes to a person. Never refunds anything itself.';

revoke all on function public.limited_refund_subscription_canceled(text, boolean, text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.limited_refund_subscription_canceled(text, boolean, text, uuid, text) to service_role;

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
    -- Cancelled, with a refund of this payment on the row that Stripe
    -- accepted (support refunded it in the dashboard; limited_refund_confirm
    -- keeps it): never "has not been returned" (20261001041500).
    when kind = 'unfinished' and new.refund_id is not null and new.refund_status in ('pending', 'succeeded', 'requires_action') then
      'Your membership is cancelled. A refund of this payment was issued to the card you paid with, and it is not recorded as finished yet.'
    when kind = 'unfinished' then
      'Your membership is cancelled. The refund has not gone through yet, so the payment has not been returned.'
    when new.subscription_canceled_at is not null and new.refund_status in ('failed', 'canceled') then
      'Your membership is cancelled. The refund was started but did not go through, so the payment has not been returned.'
    when new.subscription_canceled_at is not null and new.refund_id is not null then
      'Your membership is cancelled. A refund of this payment was issued to the card you paid with. '
        || case when neutral then 'Your request needs a person to look at the rest.' else 'A person will check that it is finished.' end
    -- Cancelled (the owner cancelled it by hand in the dashboard, say) where a
    -- refund may not be owed as asked: nothing is claimed about the money
    -- that the row does not hold (20261001041500).
    when new.subscription_canceled_at is not null and neutral and new.error_code = 'charge_partly_refunded' then
      'Your membership is cancelled. Part of this payment has already been refunded. Your request needs a person to look at it first.'
    when new.subscription_canceled_at is not null and neutral and new.error_code = 'refunded_payment_not_latest' then
      'Your membership is cancelled. A refund of this payment has already been made. Your request needs a person to look at it first.'
    when new.subscription_canceled_at is not null and neutral then
      'Your membership is cancelled. Your request needs a person to look at it first.'
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
  'BEFORE INSERT OR UPDATE on limited_refund_requests (20260930071000, lines restated 20261001041500): opens one billing ticket in the member''s name when the request needs a person (needs_support, or cancelled and not refunded after a failed attempt), reopens it only when that standing changes (support_ticket_standing), resolves it when the refund is recorded. Never fails the write.';

revoke all on function public.limited_refund_support_ticket() from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
