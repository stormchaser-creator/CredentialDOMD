# Founding billing readiness — billing remains OFF

The owner approved **Core $149/year** and **Core + Locum $245/year**, and separately directed that billing remain off while launch is prepared. No launch date or automatic beta expiry is set. This change creates no Stripe objects, collects no card, charges no account and applies no production migration.

## Canonical contract

`supabase/functions/_shared/billingCatalog.mjs` is shared by the UI, bootstrap and handlers. It has two annual offers and `billingEnabled: false`. New offers never include free, resident, monthly, trial or unrelated-app products. Historical client entitlement tier IDs remain for compatibility.

A checkout request contains only `{ "offerId": "core" }` or `{ "offerId": "core_locum" }`. Checkout identity comes from verified Clerk authentication, followed by the current profile's active access and numbered founding membership. An existing owner may still open the cancellation portal after app membership is revoked. Stripe price, customer binding, metadata, quantities and return URLs are chosen by the server. Only the exact configured Stripe product/price may be sold.

The unapplied migration creates profile-owned billing tables, separate from the obsolete UUID-to-`auth.users` subscription schema. Test billing data is isolated from live data and cannot produce a client entitlement. Ordinary users cannot write billing state or run its service RPC. The webhook resolves current Stripe state, validates the customer/profile/Clerk binding, and acknowledges a delivery only after its database operation succeeds. An exclusive per-account lease covers the authoritative provider read and database settlement; a fencing token rejects any worker that outlives that lease. This reconciles same-second and delayed events from current Stripe state. Payment status and app membership eligibility remain separate so cancellation access survives membership revocation. Duplicate delivery is idempotent; competing live subscriptions require reconciliation and receive a retryable failure. Durable checkout attempts survive day boundaries and process crashes; an open Stripe session is reused, and only confirmed expiry permits another attempt. Uncertain creation past Stripe’s idempotency retention window fails closed for operator reconciliation.

## Local verification

- `node --test tests/billing/readiness.test.mjs` — injected I/O, no network or credentials.
- `python3 tests/billing/postgres-readiness.py` — exact migration in disposable PostgreSQL 17 with a private Unix socket, no TCP listener. Requires `/opt/homebrew/opt/postgresql@17/bin`; fixture is destroyed afterward.
- `./scripts/create-stripe-products.sh` — offline test-mode preview, no key required.

`--apply --mode=test` is a separate explicit action requiring a test key in `STRIPE_SECRET_KEY`; it was **not run** as part of this change. The bootstrap validates existing immutable prices and reuses deterministic product IDs. It prints one JSON result, never captures CLI log text as an ID, and refuses live mutation while billing is disabled.

## Before any later activation

This is a prepared implementation, **not production billing certification**. Keep the catalog disabled and beta active until the owner separately approves launch. Remaining launch work includes:

1. Legal business identity and launch terms; production Clerk cutover, the independent security repair review, and verified protected membership records.
2. Test-mode Stripe account/bootstrap execution and real signed-webhook replay, including complete checkout, payment failure/recovery, cancellation and portal flows.
3. An operational retry/alert workflow for unexpected competing live subscriptions or checkout creation that remains uncertain beyond 23 hours. These exceptional states fail closed and require reconciliation. Same-second provider changes and expired workers are handled by the tested reconciliation lease.
4. Confirm there are no existing paid records in the legacy `subscriptions` table, or deliberately migrate and reconcile them before switching the client to the new profile-owned tables. Existing tier names do not substitute for migrating billing records. Configure and review a Stripe portal configuration with cancellation and payment-method updates enabled, subscription/product/quantity updates disabled; its ID is required as `STRIPE_PORTAL_CONFIGURATION_ID`. The handler checks those settings before creating a portal session.
5. Review and apply the new migration, configure `CREDENTIALDOMD_BILLING_MODE` with one matching Stripe secret key, webhook signing secret, reviewed portal configuration and the Clerk issuer, then deploy the three functions with gateway JWT checking disabled. Clerk signature validation and Stripe signature validation happen inside the handlers. The standalone Stripe endpoint must use the pinned API version `2024-04-10` until its payload fixtures are deliberately upgraded.
6. The owner’s explicit enablement decision. Turning off beta by itself cannot enable billing because the separate canonical catalog switch remains false.

The handler tests inject a verified identity and signed event; they validate downstream ownership and fulfillment rules, not external JWKS availability or Stripe cryptographic verification. The runtime uses Clerk's existing verifier and Stripe's asynchronous raw-body verifier with the Deno Web Crypto provider.

Primary API references used: [Stripe product IDs](https://docs.stripe.com/api/products/create), [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment), [Supabase signed Stripe webhooks](https://supabase.com/docs/guides/functions/examples/stripe-webhooks).
