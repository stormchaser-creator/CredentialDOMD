# Public $99 founding membership capacity

The first 100 paid Credential founding memberships cost $99/year, locked while continuously active. After 100 places have been paid for, a new public first purchase costs $149/year. Standard rejoin remains $199, and Credential + Practice remains $245. Historical $99 promises occupy protected places **within** the 100; lifetime access, free trials, legacy founding numbers and bundle payments do not count as paid founding memberships.

## Allocation and payment

- One private program and at most 100 numbered places exist per Stripe mode. Live and test inventory are separate. The reviewed historical cohort is filtered through protected lifetime evidence; staging requires an exact recipient-manifest hash and count. No recipient address is in source control.
- Signup and price previews create no additional places. After explicit consent to an immutable quote, the service claims a place in the same transaction as the durable checkout attempt, before calling Stripe. All claims and settlement acquire the existing account lock before the capacity advisory lock.
- A protected historical promise changes from `promised` to `reserved` when its verified, bound account consents. Other buyers claim a vacant place. A completed checkout without its first payment is `committed`; it does not count as paid. Only the existing exact paid-invoice validator and atomic settlement can record `paid`.
- Paid places are never returned after cancellation, refund or rejoin. First-purchase history still forces an ended membership to rejoin at the current standard price. A bundle purchase can release an unused historical promise because it consumes first-purchase eligibility without taking a discounted Core place. A protected lifetime grant similarly removes an unused promise.
- If all places are occupied but fewer than 100 have paid, public Core checkout returns `founding_capacity_pending`. The website says it is temporarily unavailable. It does not silently substitute $149 or change a quoted amount. Once 100 have paid, stale $99 previews require refreshed consent through `quote_expired`.
- A place is released only after a fresh Stripe retrieval confirms the exact owned Checkout expired, unpaid and without a subscription. The release checks customer, mode, immutable quote/attempt, saved session where available, and private seat ownership. Local timeouts alone never free a place. Old quote evidence remains; late old events cannot affect a reassigned place.

Stripe documents the [`checkout.session.expired` event](https://docs.stripe.com/api/events/types) and [Checkout status/payment/subscription fields](https://docs.stripe.com/api/checkout/sessions/object). The pinned billing API remains `2024-04-10`. This change has no new provider execution claim: the new event path is verified with injected fresh-provider responses and actual local PostgreSQL.

## Public contract

`GET public-membership-offer` needs no authentication and exposes only:

```json
{"schemaVersion":1,"phase":"founding","annualCents":9900,"checkoutEnabled":false,"availability":"paused"}
```

Allowed phases are founding/earlybird/standard with matching amounts 9900/14900/19900. Availability is available/temporarily_full/paused. Paused means global checkout is disabled; temporarily_full preserves the global gate while Core places are held. No counts, emails, customer identifiers or free-access eligibility are public. The RPC is service-only; the GET handler uses fixed site CORS and `Cache-Control: no-store`. Failure returns 503 without a fallback price or availability claim.

The site, authenticated eligibility and consenting checkout use the same SQL capacity helper. Public enrollment does not permanently pin a stale promotional phase. Existing paid members, lifetime accounts, protected promises, and owned saved sessions keep their separate eligibility rules.

## Release boundaries

1. Apply the guarded additive migration with checkout paused. It creates empty private allocation tables, retains all existing rows and gates, and defaults `public_founding_enabled` to false.
2. Stage the reviewed historical promises with `prepare_founding_program(mode, cohort_id, expected_manifest_sha256, expected_count)`. The current private review has four eligible historical promises; the other four cohort mailboxes have protected lifetime evidence. A mismatch stops staging.
3. Coordinate reviewed backend, public GET, and frontend. The shared-file closure includes 12 functions: limited-stripe-webhook, billing-entitlements, limited-customer-portal, billing-quote, limited-checkout, activate-billing-invitation, bootstrap-launch-access, admin-lifetime-access, create-checkout-session, customer-portal, stripe-webhook, public-membership-offer. Legacy billing routes remain source-disabled; invitation activation and welcome/invite mail holds remain unchanged.
4. Set the reviewed founding phase and allocation flag while keeping new checkout OFF. The separate root-owned activation must verify production identity and runtime acceptance before enabling sales. Add `checkout.session.expired` to the existing signed Stripe receiver's event selection for unattended release. No provider change is made by this source package.

After any founding attempt exists, pause sales using `limited_checkout_enabled=false`; retain the allocation ledger, wrappers, expired-event receiver and settlement. Never delete/recreate occupied places or roll back to uncapped checkout. Committed, subscription-bound or ambiguous unpaid places remain held for supported reconciliation; this change does not introduce cancellation/refund automation or guess that an expired local lease proves no payment.

## Verification

- `node --test tests/billing/public-founding.test.mjs tests/billing/limited-launch.test.mjs tests/access-policy/policy.test.mjs`: public contract/failure behavior, exact consent, expiration/retry fencing, deferred historical timing and paid validation.
- `python3 tests/billing/postgres-founding-cap.py`: actual reviewed SQL in disposable PostgreSQL 17. Includes a 110-account race for 96 public places with four protected promises; all 100 paid settlements; $149 transition and stale consent; protected bundle/lifetime release; lost local save; stale-event refusal; private RPC role denial; mode isolation and paused behavior.

Synthetic fixture limits are explicit: provider proofs are injected, continuity helpers are local stubs, and no real refund or external event delivery is asserted. The separate private apply-packet rehearsal reconstructs the recorded production schema and defaults and must be matched by the production precheck immediately before root applies it.
