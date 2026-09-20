# Historical beta: explicit purchase before the original end

## Source contract

A verified historical no-card beta member can choose Credential at their protected annual price or Credential + Practice at $245 during the existing beta. The same profile, records and original beta expiry remain in place. Merely activating beta or requesting a quote never creates a Stripe subscription or collects a card. Lifetime members remain excluded from Checkout.

The protected preview and consent receipt pin `beta_ends_at` and `billing_start_at` beside the existing offer, price phase and amount. `billing_start_at` is the original beta end rounded **up** to Stripe's integer-second precision; the beta grant itself is unchanged. A preview expires at the earlier of thirty minutes or the original beta end. No request can supply its own charge date or amount.

A completed, explicitly accepted Checkout requires a card. The first annual invoice is scheduled for the pinned billing date. Until a verified annual invoice is paid, existing beta grants determine access; a zero-payment Checkout confirmation is not paid membership. The paid annual period remains anchored at the original date even if the payment completes later. Credential's separate first-purchase Practice trial begins with the first verified payment, as before.

## Stripe behavior and boundary

Use `subscription_data.billing_cycle_anchor` with `proration_behavior:'none'`, annual price only and `payment_method_collection:'always'` / `payment_method_types:['card']`. Do not use `trial_end`, trial days or a one-time item. The deployed Stripe SDK 15.12.0 targets API 2024-04-10 and defines all these fields; its Checkout trial-end parameter requires at least 48 hours, which cannot honor opt-in at any point during beta.

[Stripe's Checkout billing-cycle documentation](https://docs.stripe.com/payments/checkout/billing-cycle?payment-ui=embedded-page) describes the free initial period, full invoice at the anchor and late completion: if Checkout remains open past that date, completing it charges for the annual period starting at the original anchor. Checkout's minimum 30-minute expiration means the last-minute case cannot rely on session expiry matching beta expiry. The hosted submit message therefore states the exact UTC date, $0 before it, and payment on completion if later.

New Checkout creation with an already-passed pinned anchor requires a fresh preview and consent. An already-saved owned open Checkout can be resumed under its original terms. An expired Stripe session is closed locally and requires a fresh quote; it is never silently replaced using changed terms.

API creation acceptance is not hosted-payment completion proof. The coordinator is conducting real sandbox checks separately; do not activate this path until that evidence passes. No provider calls, real recipients, production writes or deployment are part of the source tests.

## Client response additions

Quote retains schemaVersion 1 and adds:

- `paymentTiming`: `now` or `after_beta`.
- `amountDueNowCents`: annual amount for immediate purchase, zero in the original deferred consent schedule. An owned Checkout resumed after beta expiry retains that original schedule; it is not a fresh estimate of the amount due on completion. The client must show the expired-beta payment consequence using the authoritative beta state and resume capability.
- `paymentAtCheckout`: true for immediate purchase, false for deferred purchase.
- `betaEndsAt`: original protected beta expiry or null.
- `firstChargeAt`: pinned UTC billing start or null.

The exact consent text/hash/version remains mandatory. Deferred consent includes the late-completion consequence. PostgreSQL may preserve six fractional digits; clients must not truncate the grant timestamp before comparing the rounded provider timestamp.

Entitlements add `scheduledMembership`, null or:

```json
{
  "offerId": "core",
  "startsAt": "2026-10-20T12:00:00Z",
  "annualCents": 9900,
  "currency": "usd",
  "interval": "year",
  "status": "scheduled",
  "cancelAtPeriodEnd": false,
  "firstChargeCanceled": false
}
```

Statuses are `scheduled`, `payment_pending` and `canceling`. An owned incomplete Checkout with an available resume action instead returns `scheduledMembership: null`; resume and scheduled-membership states are mutually exclusive. This object permits billing management, not paid feature access. It cannot coexist with eligibility to create another subscription. Cancellation before the first billing date preserves the original free-beta access through its fixed expiry. `firstChargeCanceled` is true only when the current cancellation is effective by the first-charge date; canceling later renewal does not automatically void an already-issued first invoice. Refund policy is separate.

## Migration and deployment boundary

Apply additive `20260921020000_beta_deferred_billing.sql` after the reviewed baseline and administrator-lifetime migration. It changes protected preview/quote timing, subscription cancellation metadata and the service-only functions; it creates no cohort, grant, customer, subscription, invoice, charge or email and changes no rollout setting.

Updated Edge dependency closure:

- `billing-quote`
- `limited-checkout`
- `limited-stripe-webhook`
- `billing-entitlements`
- `limited-customer-portal`
- `activate-billing-invitation`

Manual invitation activation remains disabled. Preserve the welcome/invitation email holds, legacy billing sales disabled, existing provider identities and source catalog prices. Coordinate the reviewed frontend, schema and functions with the production cutover; schema acceptance alone does not prove real hosted Checkout or webhook delivery. To pause new sales, turn off the protected checkout gate while preserving webhook settlement and the billing portal. After a deferred quote or provider subscription exists, retain the new schema and timing-aware settlement; reverting to old handlers could misclassify an unpaid active subscription.

## Verification

Backend verification: 37 focused Node checks, 52 neighboring access/legacy-billing/signup checks, and 57 actual PostgreSQL checks passed (146 total). See the private release receipt for reviewed source hashes. The disabled-policy tests use explicit disabled fixtures because the reviewed release source already enables enforcement and self-service; this change does not alter those switches. The focused Node suite covers immediate purchases plus deferred quote/card parameters, last-day/minute opt-in, precise and stable timing, no-payment completion, initial annual payment, renewal, late payment, cancellation, altered identity/terms, money mismatch, duplicate prevention, expired-beta owned resume and snapshot validation. The disposable PostgreSQL fixture executes the actual additive migration and protected functions with synthetic identities and no TCP/provider connection.
