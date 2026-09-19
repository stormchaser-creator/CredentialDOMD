# Credential / Practice policy foundation — disabled

This is staged source, not an activated paid trial. Billing remains off, the open-ended beta remains on, and no existing account or data is changed by the source update. The migration is unapplied. No real cohort is embedded in the repository.

## Approved policy

- Credential annual membership: $99 for eligible waitlist founding members, $149 early bird, $199 standard. The $99/$149 rates stay locked while that membership continues; the phase flag changes new offers, not existing subscriptions. Cancellation followed by rejoining uses the then-current eligible offer; it must not recover a canceled old rate automatically.
- Credential + Practice: $245/year, with no bundle discount.
- A verified Credential purchase includes one free 30-day Practice trial. It has no Stripe trial, automatic upgrade, scheduled charge, or new subscription at expiry. Continuing Practice requires a separate, explicit purchase decision.
- Existing registered accounts receive lifetime Credential and Practice access. Waitlist-only people are not registered accounts. Capture and reconcile an explicit immutable profile/Clerk identity manifest; do not infer the cohort later from `profiles.created_at`, editable email, founding badges, last-seen date or mutable status. Pending/revoked registrations may be in the cohort; the grant does not reactivate an account or bypass revocation.

## Public API

`billingCatalog.mjs` re-exports `PUBLIC_BILLING_POLICY`, `CREDENTIAL_PRICE_PHASES`, `getPublicBillingOffer(id, phase)` and `getPublicBillingOffers(phase)`. IDs stay `core` and `core_locum`; legacy feature tier IDs stay `founding` and `locum`. New product “Practice” is not the old multi-provider `practice` tier.

`unitAmount` and `annualCents` are identical integer cents. Public offers include `pricePhase`, `priceLockedWhileActive`, `eligibilityLabel`, `practiceTrialDays`, `trialAutoCharges:false` and `billingEnabled:false`. The planned default public phase is `founding`; it is not proof that an individual qualifies. `pricingEngine.getPublicTiers()` and `priceFor()` read this policy. Legacy TIERS metadata remains for existing accounts; public cards enumerate only the two current product IDs.

The old v1 `BILLING_CATALOG` remains solely for historical settlement/test bootstrap compatibility. Both `billingEnabled` and `newSalesEnabled` are false. Even enabling old settlement alone cannot open old $149 checkout behind the new $99 public price. Do not turn on `newSalesEnabled`: a new eligible-price quote/consent checkout implementation is still required.

## Capability response

The new optional `billing-entitlements` POST handler verifies Clerk profile identity and never uses email/admin fallback for membership. No request-selected profile is accepted. Responses are `no-store` and `no-referrer`.

```json
{
  "schemaVersion": 1,
  "policyVersion": "2026-09-19-credential-practice-v1",
  "evaluatedAt": "server timestamp",
  "enforcementEnabled": false,
  "accessStatus": "active",
  "purchasedOfferId": null,
  "lifetime": { "credential": false, "practice": false },
  "practiceTrial": { "state": "none", "startsAt": null, "endsAt": null, "autoCharges": false },
  "capabilities": {
    "credential": { "read": true, "write": true, "export": true },
    "practice": { "read": true, "write": true, "export": true }
  },
  "billingEnabled": false
}
```

While the source gate is false, active beta accounts keep access and the handler never reads new tables. Grant fields are not yet reconciled in this mode. When eventually enabled, the user's own JWT calls `credentialdo_access_snapshot()`; DB/source versions and enforcement must agree. `access_policy_settings.enforcement_enabled` defaults false and a rerun never resets a prior setting.

The DB snapshot composes live settled paid rows, exact-identity lifetime grants and unexpired trial grants. Test-mode grants never enter a production access snapshot. Reads/exports survive a trial's expiry, paid Credential access stays intact, and account revocation overrides access. Existing v1 paid rows remain recognizable. This does not migrate the older UUID/auth.users `subscriptions` table: reconciliation is a cutover prerequisite.

## Immutable cohort and trial records

`canonicalCohortMembers([{profileId,clerkSubject}, ...])` produces stable sorted JSON pairs. A service operator hashes these exact UTF-8 bytes with SHA256 after reconciling authoritative registrations at the approved cutoff. `seal_lifetime_access_cohort(cohortId,cutoff,sha256,pairs)` checks the digest, unique pairs and their current profile binding, then atomically seals the manifest and both lifetime grants. Only service role can call it. Raw grant inserts/updates are not granted even to service role. Identical retries return the sealed record; changed membership or cutoff under the same cohort ID is rejected. Deleted/relinked identities are not silently restored or transferred. Never publish actual manifests.

`verifiedCorePurchase()` is a pure strict verifier for a future provider adapter: it requires an exact paid first invoice, exact current policy/phase/amount/quantity, customer/profile/Clerk binding, current active subscription, and matching invoice line. Legacy/Basil invoice shapes are understood. It intentionally rejects tax/discount/credit/proration cases pending explicit support, rather than guessing an amount. It is not signature verification; the future caller must verify Stripe signatures and fetch provider state first.

After current billing settlement, the service-only `record_credential_purchase_trial(proof)` checks the settled customer/subscription and creates an immutable receipt plus one Practice grant. Start time is provider-confirmed payment time, expiry is exactly720hours later, and retries/renewal/rejoin cannot extend it. Identity relinking cannot create another grant for the same profile. Per-account locks serialize concurrent receipt attempts. This function is not wired into the deployed webhook; no paid event is claimed to grant a working trial yet.

## Retention and write enforcement

The migration adds restrictive INSERT/UPDATE/DELETE policies to known Practice collections that exist in the database: contracts, work log, invoices, encounters, travel expenses, tax payments, schedule days, task notes, duty days, deductions and rotations. It preserves existing owner/SELECT policies. The predicate is true while rollout is disabled, preserving beta behavior; after activation it requires the owning user's current Practice write entitlement. Trial expiry does not cancel Credential, set a deletion date, erase records, change a subscription, or call Stripe.

This is a database foundation, not completed UI/service enforcement. Keep deployment disabled until all current collections/storage/service-role write paths and the field ownership of shared records have been checked. Credential-side write capabilities are supplied for future UI use; credential-table write policies are unchanged in this bounded foundation. Service jobs bypass RLS and need explicit entitlement guards for premium actions. Offline queues/imports/direct state writes must preserve uncommitted work and surface denial honestly. Normal reading, downloading saved invoices/documents and full backup export must remain available; generating/sending new invoices remains a write action.

## Required cutover work — none authorized by this source

1. Reconcile all authoritative registered Clerk identities against profiles at the approved cutoff; review the private sealed manifest before any grant. A profiles-only list is not proof of complete Clerk inventory. Preserve intentional account deletion and revocation.
2. Establish verified mailbox binding for the waitlist founding price, including an immutable eligible-waitlist cutoff. Never use editable `profiles.email`. No eligible-price quote exists yet, so checkout stays closed. Never grandfather a canceled subscription from an old mutable badge. Reconcile old paid subscriptions and preserve existing provider price IDs/rates.
3. Implement new server-owned checkout/quote consent using the current public policy. Preserve idempotency, quantity and mode guards. Explicit Practice purchase must update/reconcile the existing membership without accidentally creating a second concurrently billed subscription; upgrade timing/proration needs owner-approved terms. Trial expiry must make **zero** provider mutation calls.
4. Integrate verified paid-invoice fulfillment atomically with the trial receipt. Handle provider signatures, retries, tax/credit cases, refunds and current access revocation. Review exact webhook destination API version. The old handler now recognizes Basil invoice parents, but real new-policy provider integration remains untested.
5. Complete client hook/context and archive navigation, read-only controls, imports/direct writes/queue handling, actual UI expiry/account-switch tests, storage authorization, and service-side action gates. Never map trial expiry into `cancelled_at`/`data_deletion_date` or the legacy seven-day deletion flow.
6. Apply migrations and source changes only after independent review and synthetic tests, then test genuine provider and Clerk/Supabase boundaries in sandbox. Separately authorize activation; do not infer permission from a price/copy change.

## Local tests

- `node --test tests/access-policy/policy.test.mjs tests/billing/readiness.test.mjs scripts/founding-pricing.test.mjs`
- `python3 tests/access-policy/postgres-policy.py` — PostgreSQL17 at the documented Homebrew path, disposable private Unix socket, synthetic identities only, no network/provider/production access. It tests exact migration rollback/rerun, permission denials, frozen cohort retry/tamper behavior, identity and revocation isolation, concurrent receipts, expiry retention/write rejection and no timer reset.
