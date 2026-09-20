# Limited launch billing — prepared, all switches OFF

This increment runs against synthetic dependencies and disposable PostgreSQL only. It does not create real invitations, send mail, capture cards, create live Stripe objects, change customer accounts, apply a live migration, or deploy a function. The isolated branch starts at `a9e38951`. Historical v1 product IDs, prices, checkout code and settlement remain recognizable.

## Approved customer paths

1. **Existing registered lifetime cohort:** the separately reviewed exact profile/Clerk snapshot receives lifetime Credential and Practice. That grant has no expiry. It prevents another Checkout before any Stripe customer or card collection. No seven-day revocation or account-closing policy is implemented.
2. **Earlier no-card wording cohort:** an immutable reviewed opt-in mailbox manifest identifies the physicians owed 30 days free beta. A selected invitation from that manifest starts exactly 720 hours of Credential and Practice when a signed-in physician first proves the invited mailbox through Clerk. It creates no Stripe account, card, invoice, subscription, or automatic charge. Email preparation/sending does not start the clock. Repeat acceptance, concurrent devices, another profile, and an identity relink cannot restart it. At expiry the profile retains owner read/export; the two feature scopes require explicit paid opt-in for further writes.
3. **Explicit paid opt-in:** the protected invitation selects Credential at $99 founding, $149 early bird, or $199 standard per year. Credential + Practice is $245 per year at every phase. Checkout collects a card and the first annual payment; it contains no Stripe trial or automatic bundle conversion. Current recurring subscriptions retain the immutable original price. A new purchase after a consumed founding/early-bird promotion quotes the current $199 standard amount. A first paid Credential subscription separately starts the previously approved single 30-day Practice feature trial, with no automatic upgrade or charge. The bundle needs no Practice trial.

The initial invitation guard is **at most ten reviewed invitations per Stripe mode**, across batches. This is a rollout guard, not an advertised 100/200 scarcity claim. Every customer email still requires owner review of exact copy and recipients before sending. These source files have no email delivery adapter or mail trigger.

## Source and configuration

- `limitedLaunchCatalog.mjs` is a separate v2 catalog; `billingCatalog.mjs` remains the v1 historical catalog.
- Source switches `LIMITED_LAUNCH.billingEnabled`, `checkoutEnabled`, `invitationEnabled`, and `enforcementEnabled` default to `false`.
- Protected `access_policy_settings.limited_checkout_enabled`, `limited_invitation_enabled`, and existing `enforcement_enabled` default to `false`. Applying the new migration does not enable any of them.
- Product IDs are observed configuration: `STRIPE_CREDENTIAL_V2_PRODUCT_ID` and `STRIPE_CREDENTIAL_PRACTICE_V2_PRODUCT_ID`. The runtime does not invent IDs or find products by display name. Test/live resources must be configured independently.
- Payment mode, Stripe secret/signing secret and reviewed cancellation-only portal configuration use the existing `CREDENTIALDOMD_BILLING_MODE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PORTAL_CONFIGURATION_ID` runtime contract.
- Invitation binding uses `CLERK_SECRET_KEY` to retrieve the authenticated subject from the Clerk backend, and accepts only email addresses whose verification status is `verified`. Editable profile email and browser-supplied email are never eligibility evidence. This is separate from the issuer-pinned JWT check.

Reviewed Stripe product metadata:

| Key | Credential | Credential + Practice |
|---|---|---|
| `app` | `credentialdomd` | `credentialdomd` |
| `offer_id` | `core` | `core_locum` |
| `pricing_policy_version` | `2026-09-19-credential-practice-v1` | same |
| `catalog_version` | `2026-09-limited-launch-v2` | same |

Annual USD lookup keys:

| Lookup key | Amount |
|---|---:|
| `credentialdomd_core_founding_annual_v2` | 9900 cents |
| `credentialdomd_core_earlybird_annual_v2` | 14900 cents |
| `credentialdomd_core_standard_annual_v2` | 19900 cents — product default |
| `credentialdomd_core_locum_standard_annual_v2` | 24500 cents — product default |

`node scripts/prepare-limited-stripe-catalog.mjs --dry-run` is offline and key-free. The separate `--apply` path is sandbox-only, validates existing metadata/immutable prices, and uses stable idempotency keys. It never mutates legacy products. When a product already exists, pass its observed ID; don't repeatedly create products without saving the returned IDs. This audit did not execute `--apply`.

## HTTP contract

All app routes use verified Clerk identity, same-site CORS, bounded request bodies, no-store responses, and server-controlled Stripe URLs. A success-page visit never creates an entitlement.

### `activate-billing-invitation`

POST `{ "invitationToken": "opaque token" }`.

Returns `{ schemaVersion:1, policyVersion, profileId, freeBeta:{state,startsAt,endsAt,autoCharges:false}, cardRequired:false, subscriptionCreated:false }`.

For grandfathered invitations it activates the profile and starts beta. For a paid-only invitation it binds the verified identity but does not activate a pending profile until payment is verified. Both source and database invitation gates must be enabled. This path does not initialize Stripe or require a Stripe payment secret. A test-mode grant cannot activate a shared live profile.

### `billing-quote`

POST `{ "offerId": "core" | "core_locum", "invitationToken": "optional token" }`.

Returns financial summary fields (`annualCents`, `currency`, `interval`, `pricePhase`, `priceLockedWhileActive`, `practiceTrialDays`, `trialAutoCharges:false`, `paymentAtCheckout:true`) plus opaque `quoteId`, `expiresAt`, `consentVersion`, `consentHash`, and exact `consentText`. The server stores the quote against the profile, Clerk subject, mode and protected invitation. Quotes last 30 minutes. Display the exact amount/renewal/trial text before offering confirmation. Active free beta returns `free_beta_active`; paid opt-in follows expiry.

### `limited-checkout`

POST **only** `{ "quoteId": "opaque UUID", "consentHash": "returned hash", "consent": true }`.

Returns `{ "url": "https://checkout.stripe.com/..." }`. No client price, phase, email, offer, customer, quantity, metadata or redirect is accepted. Expired or changed consent requires a fresh quote and confirmation. A durable attempt pins the accepted quote, exact product/price, consent record, Clerk subject, and Stripe idempotency key. An open session is reused. Provider uncertainty retains the old attempt and eventually requires operator reconciliation; it never creates a second key after the safety window. Any nonterminal subscription blocks a second Checkout. Default Stripe quantity is one and `payment_method_collection` is `always`; no trial, coupon, or promotion-code flag is passed.

Checkout explicitly restricts `payment_method_types` to `['card']`. The pinned 2024-04-10 API can create an incomplete subscription after a failed payment; only that subscription's exact saved, owned open Checkout can resume. It never authorizes a second Checkout. Stripe documents this legacy behavior in its [Basil Checkout change](https://docs.stripe.com/changelog/basil/2025-03-31/checkout-legacy-subscription-upgrade).

### `limited-customer-portal`

POST `{}`. Returns a reviewed Stripe portal URL. Cancellation and payment-method updates remain available to the billing owner after membership revocation. Product, quantity, and subscription plan changes must remain disabled in the configured portal.

### `limited-stripe-webhook`

Verifies the raw signed event, separates test/live mode, obtains an exclusive fenced reconciliation lease, then freshly reads the subscription and invoice. It verifies exact price, quantity, annual amount, invoice paid state, server quote and stable customer/profile/Clerk binding. An `active` subscription with an unpaid invoice does not grant paid membership. Pending activation, subscription settlement, event acknowledgment and the first paid Practice trial happen in one SQL transaction. A trial failure rolls everything back for retry. Original-price renewals don't restart trials. Historical v1 subscriptions route through their original settlement validator.

Historical v2 settlement requires the immutable price ID pinned before Checkout and retains its exact amount/product/currency/cadence checks. It accepts that price after archive or lookup-key transfer; new sales still require the active sales lookup. The webhook reads bounded bytes once and reconstructs the historical v1 request from those verified bytes, so oversized open streams cannot leave an unread clone blocking cancellation.

Common errors: `billing_disabled`, `invitation_activation_disabled`, `unauthorized`, `membership_unavailable`, `invitation_required`, `verified_invitation_email_required`, `invitation_unavailable`, `lifetime_access_already_granted`, `free_beta_active`, `quote_consent_required`, `quote_expired`, `subscription_already_exists`, `checkout_offer_already_selected`, `checkout_pending`, `checkout_needs_reconciliation`, and generic `billing_unavailable`. Responses omit provider secrets/internal errors.

## Entitlement snapshot

`billing-entitlements` preserves schema version 1 and adds validated `freeBeta:{state,startsAt,endsAt,autoCharges:false}`, `checkoutEligible`, `pricePhase`, and `invitationActivationEnabled`. `billingEnabled` reflects the protected database checkout switch. The disabled source adapter still avoids querying unapplied tables and reports billing off. During the coordinated cutover, source policy/read adapter, source billing flags, database gates, and client capability enforcement must be reviewed together.

`checkoutResumeAvailable` and `checkoutResumeOfferId` identify an incomplete subscription with an owned saved open Checkout and matching quote. The client can offer “Resume checkout” for that offer, obtain a fresh quote/consent, and call the existing `limited-checkout`; the handler freshly checks that Stripe still links the open session to the same incomplete subscription. This is distinct from eligibility to create a new subscription. A stale promotional preview cannot start a new attempt after paid purchase history changes eligibility.

The SQL enforces Credential/Practice owner write scopes for the collection lists in this migration and the prior foundation. Existing SELECT/ownership stays intact. Read/export survives beta expiry. Revoked/deleted account state is stronger than a grant. Storage uploads and privileged service routes must be covered by the separate security/access integration review before activating enforcement; a list of collection policies alone is not a full service-route enforcement certificate.

## Protected data routines

- `seal_limited_free_beta_cohort`: reviewed sorted lowercase mailbox JSON, SHA-256 of canonical compact JSON, immutable cohort ID, review reason. No `created_at` query determines who saw the old promise.
- `prepare_limited_billing_invitations`: up to ten reviewed rows, email, cryptographically random token **hash**, expiry (up to 30 days), protected price phase, review reason, optional previously sealed `freeBetaCohortId`. No sending or activation. Generate tokens with at least 32 random bytes; only approved draft delivery holds the raw token, never logs/analytics.
- `bind_limited_billing_invitation`: accepts only the server's verified Clerk mailbox list and current profile/subject. Unclaimed tokens expire; after a valid binding the profile keeps its reviewed offer so an email expiry cannot defeat the promised beta or later opt-in. Revocation/identity changes still stop use.
- `create_limited_billing_preview` / `claim_limited_billing_checkout` / `pin_limited_billing_price`: server-only quote, consent and durable attempt lifecycle.
- `settle_limited_billing_subscription`: server-only atomic verified provider settlement.
- The additive `20260919233000_limited_paid_purchase_history.sql` records a protected first verified paid invoice for either offer, without weakening or replacing Core's exact receipt/trial validator. After an ended package membership, a new Credential purchase quotes the current standard price. Original invitation phase and purchase provenance remain stored for later reviewed policies about continuously active membership changes. This change does not implement upgrades or downgrades.

No customer role can execute these mutations or read invitation token hashes. Direct service-role table writes are also denied for the new invitation, beta, preview and quote tables; use the narrow routines. Existing account reconciliation/checkout fencing is reused.

## Validation and remaining review

Run:

```sh
node --test tests/billing/limited-launch.test.mjs tests/billing/readiness.test.mjs tests/access-policy/policy.test.mjs
python3 tests/billing/postgres-limited-launch.py
```

The Python suite starts PostgreSQL 17 under `/private/tmp` with a private Unix socket and no TCP listener, applies the exact migration, exercises concurrent claims, then destroys the fixture. It uses synthetic identities and payments. This is not evidence of a real Stripe checkout/webhook, Clerk mailbox integration or applied production migration.

Follow-up validation: 58 JavaScript tests and 46 disposable PostgreSQL checks pass. A separate private offline harness also verifies the real Stripe 15.12.0 SDK's request serialization and HMAC verification against synthetic provider responses and the exact four migrations. It covers all four owner-observed sandbox price IDs plus the separate historical-free-beta → first-paid-Core path. The harness performs no provider requests, reads no credentials, and creates no real customers or subscriptions; its catalog IDs are observed, while its provider responses are fixtures.

Runtime configuration names for a separately authorized sandbox integration are `CREDENTIALDOMD_BILLING_MODE=test`, `STRIPE_CREDENTIAL_V2_PRODUCT_ID`, `STRIPE_CREDENTIAL_PRACTICE_V2_PRODUCT_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_CONFIGURATION_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_ISSUER`, and `CLERK_SECRET_KEY`. Product IDs are non-secret; all credentials remain in the approved secret store. The Stripe API version remains `2024-04-10`. These environment variables do not enable the source or database gates by themselves. The signed webhook route needs the gateway configuration appropriate to raw Stripe signatures; the app routes verify Clerk themselves.

Before any enablement: review and reconcile stable Clerk profile bindings and lifetime cohort; review the exact grandfathered opt-in mailbox snapshot and invitation draft recipients/copy; verify sandbox metadata and both product IDs; exercise real test-mode signed checkout/webhook/portal, failure/retry/cancellation and expiry flows; review all privileged service/storage write gates with the security work; then obtain the separate owner decision to deploy/enable. No email may be sent merely because an invitation row is prepared. No automated lifetime expiry or account closure is included. A later bundle upgrade requires an explicit proration preview/consent and mutation of the **same** subscription item; this increment offers first purchases only and performs no surprise upgrade.
