# Admin lifetime access

An active administrator can grant an existing registered account lifetime Credential and Practice access without a card, checkout, subscription or email. This is a protected administrative gift, not a public free plan. Existing lifetime promises, trial dates, purchase history and cohort provenance remain intact.

## Deployment boundary

The source is disabled unless `CREDENTIALDOMD_ADMIN_LIFETIME_ENABLED=true`. Apply `20260921010000_admin_lifetime_access.sql` after the reviewed 18-migration launch set. This migration creates no reviews or gifts and changes no launch settings. Deploy only the new `admin-lifetime-access` entrypoint for this increment, using the normal Clerk-verification workflow (`--no-verify-jwt` at the legacy gateway; the handler verifies Clerk itself). Existing launch/security function deployment is a separate release package.

Dependencies already used by billing: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_ISSUER`, `CLERK_SECRET_KEY`, `CREDENTIALDOMD_BILLING_MODE` and `STRIPE_SECRET_KEY`. Clerk and Stripe key modes must match `test` or `live`. No new credential retrieval path is introduced. No Stripe key is needed for an account that has no protected or legacy billing history; its primary mailbox is still verified with Clerk.

For an account with billing history, the existing server key must permit customer, subscription and Checkout Session reads. A currently scheduled cancellation additionally requires invoice and pending invoice-item reads. Missing access, incomplete pagination, uncertain billing or provider failures deny the grant. The handler never calls a Stripe mutation or an email provider.

## Contract

`POST admin-lifetime-access` with `{action:'review',profileId,clerkSubject}` returns schemaVersion 1, target identity including the fresh Clerk verified primary mailbox, lifetime scopes, billing summary, `canGrant`, `reasonCode`, `reviewId` and `expiresAt`. The latter two are null for blocked reviews. The reviewed target comes from the exact profile UUID and verified Clerk subject, never an editable profile email.

A usable review lasts five minutes. Grant input is `{action:'grant',reviewId,requestId,reason,confirmed:true}`. The request ID is a UUID retained across retries, and the trimmed reason is 10–500 characters (ordinary tabs/newlines allowed). No client price, mailbox, privilege or billing override is accepted. Success returns UUID `grantId`, `grantedAt`, the same target, both lifetime scopes, and `cardRequired:false`, `subscriptionCreated:false`, `emailSent:false`.

## Authorization and consistency

- Verify the request with the configured Clerk issuer, then recheck active `app_admins` membership and exact actor/profile binding inside each protected RPC.
- Reject revoked, deleted or tombstoned actors/targets, including account tombstones where `profiles.deleted_at` is still null.
- Bind a durable review to the target, current protected billing context, provider evidence and verified primary mailbox. Grant rechecks all of them after acquiring account and profile locks.
- Observe billing at review and grant. Any renewing subscription, unresolved Checkout or uncertain historical billing blocks the gift. Scheduled cancellation is accepted only with a paid latest invoice, one licensed annual flat-rate item, no scheduled/pending changes, and no open/draft invoices or pending invoice items.
- A provider proof starts before provider reads and must still be at most 60 seconds old after database locks. Changed evidence requires another review. A completed matching retry returns its original audit receipt; it never adds another grant or changes dates.
- Insert only missing lifetime scopes, preserve prior scope provenance, and activate an eligible pending profile in the same transaction. Test-mode gifts do not activate the shared live profile. An audit failure rolls back the entire operation.
- A narrow Checkout trigger shares the profile lock with the gift transaction and prevents a newly gifted account from starting a new paid Checkout, including through the historical claim routine.

The audit stores actor/target IDs, subject IDs, reason, timestamp and proof fingerprint; it contains no mailbox or card details. The temporary review stores the verified mailbox for exact confirmation and is removed if its target profile is hard-deleted. Service callers cannot directly edit grants, reviews or audit rows. The migration adds no email trigger and retains existing welcome/invite holds.

## Validation

- 38 mocked handler/provider tests: authorization, mode/ownership, body limits, failed reads, malformed/truncated lists, scheduled-cancellation billing checks, primary mailbox changes and retries.
- 34 actual PostgreSQL checks on the reconstructed 63-table baseline after the exact reviewed 18 packet and the separate gift packet: permissions, both-scope atomicity, preserved provenance, tombstones, expiry, changed identities/billing, rollback on audit failure, six concurrent retries, competing Checkout and proof expiry during a real lock wait.
- 8 actual client-to-handler synthetic smoke scenarios; edge entrypoint bundles and Clerk deployment discovery includes it.

Reproduce the database suite with metadata-only inventory files and private prepared SQL packets:

```sh
python3 tests/admin-lifetime/postgres-gifts.py --root "$PWD" --inventory INVENTORY.json --founding FOUNDING-HELPERS.json --base-packet BASE18.sql --gift-packet ADMIN-LIFETIME.sql
node --test tests/admin-lifetime-access.test.mjs
```

These checks use no customer records, production writes, real deletions, emails or provider mutations. Cron is an inert local metadata adapter. No live gift has been exercised by this implementation work. External Stripe changes made after a verified read are not a distributed database transaction; a later explicit renewal change in Stripe remains outside the gift's control. Ambiguous legacy billing is conservatively blocked for reconciliation.

Stripe documents that scheduled cancellation may retain pending charges, which is why the additional invoice checks are required: [cancellation behavior](https://docs.stripe.com/billing/subscriptions/cancel), [pending invoice items](https://docs.stripe.com/api/invoiceitems/list), [Checkout Session states](https://docs.stripe.com/api/checkout/sessions/list).
