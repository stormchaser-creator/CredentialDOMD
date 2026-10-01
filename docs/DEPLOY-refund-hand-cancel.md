# Deploy: a refund request whose membership was cancelled by hand

Branch `fix/limit-refund-hand-cancel`. A follow up to `docs/DEPLOY-refund-pay-first.md`;
that deploy must be live first. It holds no production counts, customer data or secrets.
Every database check below is a read (`select`).

## What changes

When the owner cancels a member's subscription by hand in the Stripe dashboard
(`customer.subscription.deleted`) while the member's refund request is unfinished,
`limited-stripe-webhook` now records the cancellation on the request
(`limited_refund_requests.subscription_canceled_at`) after it settles the subscription.
Before, the request kept saying "not cancelled yet" in Profile, in the member's ticket
and in the owner's notifier, and the ticket had to be answered by hand.

What happens to the refund follows the rules already in force. Nothing is refunded by
the webhook itself:

| Request when the subscription is cancelled by hand | Afterwards |
|---|---|
| `requested`, its payment still the subscription's most recent payment | `requested`, cancelled on record. Owed as the member confirmed: the sweep (or the member's next press) refunds it, as after any press whose cancellation went through. No ticket. |
| `requested`, its payment the most recent, its charge refunded in part (the dashboard's prorated refund) or disputed | `needs_support`, `charge_partly_refunded` or `charge_disputed`. A person decides; the ticket says part of the payment was refunded and promises nothing. The sweep never tries a full refund. |
| `requested`, a renewal was paid since | `needs_support`, `refund_payment_changed` (or `refunded_payment_not_latest` when the row holds a refund). A person decides; the ticket promises nothing. |
| `needs_support` for a review only reason (dispute, partial refund, older payment, mismatch) | stays `needs_support`, cancelled on record. The owner resolves it; a full refund in the dashboard then records it as refunded at once. |
| `needs_support` after the retries ran out before the cancellation, payment still the most recent, charge untouched | back to `requested`, cancelled on record, its ticket reopened as "cancelled, refund not through yet". The sweep refunds it. |
| the same, its charge refunded in part or disputed | stays `needs_support`, now `charge_partly_refunded` or `charge_disputed` (nothing promised). |
| the same, a renewal paid since | stays `needs_support`, now `refund_payment_changed` (nothing promised). |

"Most recent payment" is the subscription's newest paid invoice that collected money, read
fresh from Stripe (`invoices.list`, Invoices Read, already granted). A press or the sweep
that finds a subscription cancelled which the request never recorded as cancelled applies
the same rule before refunding, so a missed webhook never refunds last year's payment.
The request's recorded charge is read fresh too (Charges Read, already granted) while its
payment is the most recent. A refund Stripe refuses on a charge that was refunded in part or
disputed meanwhile goes to a person with that review only reason, not Stripe's raw code.
A press or the sweep holding the request when the webhook records the cancellation keeps
working on it; an error an earlier attempt left is cleared with the cancellation, so no
ticket opens for a refund that is going through.

The member's ticket text gains lines for a cancelled row (a refund already issued; a review
only reason), and Profile says "A refund of your payment was issued" when support refunded
the payment in the dashboard before the cancellation, instead of "nothing has been refunded yet".

## Ship order

1. Migration `supabase/migrations/20261001041500_limited_refund_hand_cancel.sql`
   (`supabase db push --dry-run` must list only this file, then `supabase db push`).
   Smoke:
   ```sql
   select has_function_privilege('service_role', 'public.limited_refund_subscription_canceled(text,boolean,text,uuid,text)', 'execute'); -- true
   select has_function_privilege('authenticated', 'public.limited_refund_subscription_canceled(text,boolean,text,uuid,text)', 'execute'); -- false
   select prosrc like '%not recorded as finished yet%' from pg_proc where proname = 'limited_refund_support_ticket';            -- true
   ```
2. Edge functions built from the changed shared modules, webhook first:
   `limited-stripe-webhook`, `limited-refund`, then `limited-checkout`, `billing-quote`,
   `limited-customer-portal`, `activate-billing-invitation` (all `--no-verify-jwt`).
   Smoke: resend one recent delivered `customer.subscription.deleted` event in the Stripe
   dashboard; it answers 200. The next `limited-refund-sweep` run succeeds.
3. The app: merge to `main` (`deploy-gh-pages.yml`). Smoke: the published bundle contains
   "A refund of your payment was issued to the card you paid with".

Watch: `refund_needs_support` log lines with code `refund_payment_changed`,
`charge_partly_refunded` or `charge_disputed` on route `webhook` (a hand cancellation after a
renewal, or with a prorated refund or a dispute: answer that ticket). No new Stripe events
are needed: `customer.subscription.deleted` is already required.

## Rollback

1. App: revert the merge on `main`.
2. Edge functions: redeploy the six functions from the commit before this change.
3. SQL: `docs/rollback/20261001041500_limited_refund_hand_cancel.rollback.sql` (after step 2:
   the new functions call the dropped function). Cancellations already recorded stay on their
   rows; the ticket text goes back to its 20260930071000 wording.
