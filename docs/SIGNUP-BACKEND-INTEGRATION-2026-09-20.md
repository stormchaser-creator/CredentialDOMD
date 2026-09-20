# CredentialDOMD signup backend integration

## Current source state

This branch combines the reviewed security backend (`1f136c07`) and limited
billing backend (`43691f6b`) with current main (`cacc604b`). All source and SQL
activation gates remain OFF. The current `send-welcome` and `send-invite`
review holds are retained from main. No deployment, customer email, live SQL,
Stripe object or charge is produced by this package.

Root coordinates the authorized release. New launch/email content remains
owner-reviewed; this document adds no new blanket recipient approval rule.

## Signup contract

1. Production Clerk authenticates the physician and verifies their primary
   mailbox. The reviewed `initialize-clerk-profile` route resolves protected
   continuity **before** profile creation. Never use an editable profile email
   or a browser-selected mailbox to inherit an account.
2. `POST bootstrap-launch-access {}` verifies the JWT subject, rechecks the
   same profile binding, and reads the current primary mailbox from Clerk.
   It creates no profile and no provider subscription.
3. The service-only SQL transaction assigns the following protected outcome:

| Evidence | Signup outcome |
| --- | --- |
| Existing lifetime grant, or bound verified registered Clerk account created by `2026-09-19T15:56:26.238Z` | Lifetime Credential and Practice; no card or expiry |
| Verified primary mailbox in a sealed historical no-card waitlist cohort | Both features for exactly 720 hours from first activation; no card, subscription or automatic charge; subsequent explicit Credential opt-in at $99/year |
| Reviewed existing manual founding invitation | Preserves its approved founding eligibility |
| Fresh verified primary mailbox without protected historical eligibility | Credential $149/year early bird, or Credential + Practice $245/year |

The ten-person safeguard still limits manually prepared invitation rows. It is
not public scarcity and does not block the eleventh ordinary paid signup.
Legacy registered accounts without an old database profile qualify through the
immutable continuity proof; the initializer allocates their profile UUID once.

An existing revoked/deleted account cannot reactivate through this route.
Retries, primary-mailbox changes and verified account continuity preserve the
first beta timestamps. Original cohort, grant and receipt subjects are retained.
Only the protected continuity journal can authorize an old subject's evidence.

The response has `schemaVersion`, `policyVersion`, `enrollmentKind`,
`accessStatus`, `freeBeta`, `pricePhase`, `cardRequired` and
`subscriptionCreated:false`. It contains no invitation token or mailbox. The
client refreshes `billing-entitlements` for authoritative capabilities. Missing
continuity, mailbox verification or enrollment state fails closed.

## Explicit purchase

The browser requests a server quote for `core` or `core_locum`, then accepts
that exact unexpired quote's consent hash. Server-owned prices are $99/$149/$199
for eligible Credential phases and $245 for the complete package. New paid
Checkout requires a card and payment of the first annual term. A paid Credential
purchase includes one separate 30-day Practice feature trial. This does not
restart or extend the historical free beta and never switches subscriptions or
charges automatically. Cancellation followed by rejoining uses the then-current
standard price; continuous renewals keep the original pinned annual price.

Saved incomplete Checkout resumes only its owned durable session. Active or
uncertain subscriptions prevent another Checkout. Payment activation requires a
verified Stripe signature, current paid provider state and atomic database
settlement. An old open quote does not inherit consent after a subject changes.

## Migration and deployment order

Use the captured production metadata and applied-migration history to select
missing migrations; do not replay all historical repository SQL blindly.

1. Security migrations `20260915a` through `g`, `20260916b`, `20260916c`, then
   `20260918a`. Immediately before the spend seed, recheck current UTC-month
   Anthropic usage and in-flight work. The September 20 read-only preflight
   observed zero current-month Anthropic rows, not a perpetual guarantee.
2. Billing foundations `20260918_founding_billing_readiness`,
   `20260919183000`, `20260919213000`, `20260919233000`.
3. Reviewed identity continuity `20260920120000` (separate source package;
   requires the account tombstone security migration).
4. `20260920220000_self_service_signup` and
   `20260920221000_continuity_access_evidence`.
5. Reviewed service/storage write enforcement, after the same prerequisites.
   Preserve read/export, support and deletion behavior as specified by that
   package's tests.
6. Deploy the reviewed security routes, initializer, bootstrap, entitlement,
   quote, Checkout, portal and webhook adapters with their own verified auth.
   Clerk routes require gateway `--no-verify-jwt`; signed provider webhooks also
   use their own raw-body signature checks. The initializer must be available
   before the client stops using the old profile-creation path.
7. Stage the trusted registered-account and historical no-card cohorts; validate
   subject/profile/domain bindings and preserve existing profile UUIDs, storage
   namespaces and device encryption continuity. Publish the compatible client
   only after these dependencies are ready.
8. Activate the mutually compatible server, SQL and client gates as a reviewed
   release, then verify real signup and existing-account continuity. Flags alone
   cannot substitute for cohort, provider, storage and client readiness.

`node scripts/list-clerk-functions.mjs` or
`scripts/deploy-clerk-functions.sh --list` provides a network-free transitive
dependency list. It includes shared billing webhook consumers. Review the list
before deploying; it is not an instruction to activate every listed function.
The older `deploy-functions.sh` has obsolete configuration and gateway defaults
and must not be used for this cutover. The historical Clerk preflight uses a
Keychain-backed implementation; this package did not run it. Use the release
operator's established authenticated CLI path for live verification.

The exact Clerk dependency closure for this backend source is:

```text
activate-billing-invitation
admin-shared-key
ai-proxy
backup-link
billing-entitlements
billing-quote
bootstrap-launch-access
build-backup
callsync-feed
create-checkout-session
create-ticket
customer-portal
delete-account
forwarding-address
limited-checkout
limited-customer-portal
limited-stripe-webhook
public-record
reply-ticket
send-guide
send-invite
send-packet-email
send-reminders
stripe-webhook
submit-feedback
ticket-attachment-url
```

Also deploy the reviewed `clerk-webhook` and `email-inbound` security changes;
they verify provider signatures rather than Clerk bearer tokens. Add
`initialize-clerk-profile` and any other explicitly changed consumers from the
identity package after merging it, then regenerate the dependency closure.
Deploying a held `send-invite` must retain its hold. This package does not change
`send-welcome`, so it is not a required deployment here. Do not activate unrelated
future support/credential-portal functions to update shared branding.

## Rollback boundaries

- Stop new purchases by turning OFF the new-checkout and public-signup gates
  in source, SQL and client together. Keep already-purchased membership reads,
  cancellation portal and signed webhook settlement available; disabling all
  webhook processing after accepting payment would strand a paid account.
- Preserve durable quote/consent/payment rows, original price IDs, cohort
  manifests, grant dates and continuity journal. Do not recreate tables, reset
  trials, delete Stripe subscriptions or erase identity evidence as rollback.
- Enforcement OFF restores the earlier write policy for otherwise-owned rows;
  use it only as a documented temporary rollback. It does not revoke Stripe
  charges, lifetime grants or account bindings. Keep the security identity,
  mailbox, abuse and storage ownership controls in place.
- Once an account is bound to production Clerk, reverting the public Clerk
  key/issuer or disabling initialization can strand that physician. Identity
  rollback requires the continuity package's recovery plan; never change
  `profiles.auth_user_id` back by an ad hoc email match.
- Keep all welcome/invite email holds and reviewed content unchanged throughout.

## Configuration to reconcile at release

- Production Clerk publishable key, `CLERK_ISSUER`, Supabase third-party trust
  and `CLERK_SECRET_KEY` must refer to the same production instance.
- The continuity initializer also requires
  `CLERK_CONTINUITY_SOURCE_SECRET_KEY` for the exact development instance,
  `CLERK_CONTINUITY_SOURCE_ISSUER` and a coordinated
  `CLERK_CONTINUITY_ENABLED` gate. A prepared legacy claim needs a fresh source
  provider check; a production mailbox match alone cannot take over that account.
- `CREDENTIALDOMD_BILLING_MODE`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_CONFIGURATION_ID`,
  `STRIPE_CREDENTIAL_V2_PRODUCT_ID` and
  `STRIPE_CREDENTIAL_PRACTICE_V2_PRODUCT_ID` must match the intended account and
  mode. Test catalog IDs are not live catalog IDs. Preserve historical prices.
- Source gates: `SELF_SERVICE_SIGNUP.enabled`, `PUBLIC_BILLING_POLICY`,
  `LIMITED_LAUNCH`. SQL gates include `enforcement_enabled`,
  `limited_checkout_enabled`, `limited_invitation_enabled`,
  `limited_self_service_enabled`, plus the separately reviewed continuity run.
- The client public signup and access-policy flags must match that release.
  Legacy `FREE_BETA.active` cannot remain an unconditional bypass after paid
  enforcement is enabled.
- Existing welcome/invite holds remain; no email trigger is an activation test.

## Evidence and remaining limits

The source package tests quote/consent/settlement, verified profile binding,
signup promises, retry and relink behavior with synthetic inputs. The private
schema reconstruction uses 63 relevant tables, 140 constraints and 81 policies
from the September 20 production metadata. It excludes real rows, cron,
outbound notification triggers and unreviewed function bodies; it is a stronger
migration compilation check, not a full production restore or live signup proof.

`tests/billing/postgres-launch-integration.py` consumes the private schema-only
inventory with `--inventory`, reviewed founding helper definitions with
`--founding`, this worktree with `--root`, and the reviewed identity migration
with `--continuity`. It creates a disposable local PG17
cluster with TCP disabled and a private Unix socket, then always stops and
removes it. The actual joint claim/bootstrap checks prove existing and
missing-profile lifetime, explicitly excluded/new paid signup, historical
720-hour beta, retry stability, retained legacy Storage writes, actual founding
trigger behavior and zero billing-customer creation. The historical cap100
limits that legacy display numbering only; it is not paid-signup eligibility.

The earlier sandbox run already exercised all four real hosted Stripe prices,
including a decline/resume and 3DS authentication, signed payment/cancellation
callbacks and tracked cleanup. Its localhost return was blocked by Chrome, so
it does not prove integrated app navigation. Do not describe those checks as
missing merely because this source review does not repeat real purchases.

Remaining release proof includes production Clerk continuity and device crypto,
reviewed cohort import, live-mode catalog/portal/webhook configuration, combined
frontend/backend checks, exact migration preconditions, and deployed signup.
Changing an existing Credential subscription to the $245 package remains a
separate unimplemented upgrade contract. Do not create a second subscription
or auto-charge at Practice trial expiry to fill that gap.
