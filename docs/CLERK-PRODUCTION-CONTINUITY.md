# CredentialDOMD production identity continuity

## Scope and status

This source package initializes a verified production Clerk identity before ordinary profile creation or launch enrollment. It preserves an existing profile UUID, historical access evidence, saved rows and stored file bytes. It does not copy Clerk users, passwords or verification flags. Source defaults are off; a successful local test is not a production migration or activation receipt.

The old `scripts/clerk-relink.mjs` is retired. Do not use editable `profiles.email`, names, waitlist membership or the historical August cutover instructions to establish ownership or reverse a binding.

## Protected identity and recovery

`20260920120000_clerk_identity_continuity.sql` creates a sealed run, account bindings and append-only preparation/binding events. An operator-reviewed manifest contains rows in this exact order:

```text
[profile UUID or null, development subject, verified primary mailbox,
 provider updated_at milliseconds, provider created_at milliseconds,
 explicitly reviewed lifetime eligibility]
```

`scripts/clerk-continuity-plan.mjs` builds a private mode-0600 plan from an authenticated Clerk export and exact subject-to-profile matches. It performs no network requests and has no apply mode. Its hash uses the same canonical scalar-array rendering as the SQL stage routine. `stage_clerk_continuity` validates current profile ownership and stages the run disabled; `set_clerk_continuity_enabled` requires its exact run and manifest hash. Private identity manifests do not belong in Git.

First binding requires a signed production JWT, a fresh production API read proving its verified primary mailbox, and a fresh development API read of the exact staged source identity. Both mailbox proofs must agree with protected evidence. The source creation timestamp must match; its update timestamp cannot precede the staged snapshot. Proofs expire after five minutes, including time spent waiting for SQL locks. Expiration raises and rolls back pending database changes.

The initializer serializes with profile inserts. A competing profile, closed account or changed binding fails closed. Production direct-client inserts and retired source-subject recreation are refused. The production webhook initializes continuity before profile synchronization. Retries return the same binding and profile UUID; they do not reset trial clocks or duplicate grants.

Preexisting verified Clerk accounts without a profile receive their first UUID once. `continuity_lifetime_source(profileUUID, currentSubject)` exposes immutable eligibility evidence to the separate protected enrollment service. The original owner promise cutoff is **2026-09-19T15:56:26.238Z**. Eligibility remains an explicit reviewed manifest decision; a pre-cutoff creation date alone does not silently include test identities. `continuity_owns_subject` lets that service recognize preserved historical subjects without rewriting grants, cohort rows or payment receipts.

## Files, device state and retired sessions

Document bytes and explicit paths stay in place. At first binding, an empty document path is filled only when the exact existing `<source subject>/<document UUID>` object exists. This records the prior inferred location; the binding journal records the number of recovered pointers. Backup, document-mail and account-deletion consumers resolve current and legacy prefixes through the service-only `clerk_storage_subjects` routine.

A permissive storage policy authorizes the bound production identity for its protected legacy document prefix. A restrictive companion denies retired development access to that prefix despite the old prefix-equals-subject policy. Historical subscription subjects remain unchanged, with a restrictive policy denying bound source sessions. Profile and UUID-scoped rows cease to match the old subject after atomic binding. Unbound development users retain their existing access while both issuers are trusted. This is conditional retirement, not removal of the development issuer from Supabase.

The review of the production policy inventory found direct JWT/UID references in profile insert/select/update, subscription select, document storage, and `user_events`' UUID-based select policy. The latter does not match Clerk `user_*` subjects; that existing compatibility limitation is not a retired-subject bypass. No claim is made that arbitrary future policies inherit these restrictions.

`continuityRecovery.js` accepts only the authenticated initializer receipt, canonical production issuer and captured current session/generation. Device recovery is copy-only into absent destination keys. Existing conflicting destination values are retained and reported. A durable journal permits interrupted retries, and completed journals never repopulate later-cleared destination state. Old source keys are retained; this package does not erase them.

Explicit sign-out or confirmed deletion retires unfinished recovery before local purge through `purgeUserStorage`. The retirement marker survives purge. Known continuity recovery fails closed if that marker cannot be durably recorded. Involuntary logout with `keepVault: true` does not retire recoverable vault state. Callers must await and handle retirement failures. Async adapters must provide the required atomic compare-and-set boundary; Web Locks coordinate cooperating tabs. Already-dispatched storage writes cannot be rolled back. If all local storage is unreadable after reload, the app cannot discover an old journal; recovery itself must remain unavailable.

`secretBox.js` decrypts legacy ciphertext using the protected old derivation only for the current authenticated binding. New encryption uses the current subject. Recovery/configuration must precede local hydration and queued-operation replay.

## Integration and activation order

1. Apply the reviewed account-closure security prerequisite and identity migration. The identity migration requires the existing profiles, documents, subscriptions and storage schemas; it stages no real users.
2. Review the authoritative export, exact subject/profile joins and lifetime inclusion list. Stage its exact private manifest disabled. Keep a private receipt and hash.
3. Deploy the initializer, updated webhook and all changed storage consumers together. The identity helper is a dependency of `initialize-clerk-profile`, `clerk-webhook`, `backup-link`, `build-backup`, `send-packet-email` and `delete-account`.
4. Configure server environment names below, verify production JWT trust and the production `supabase` template used by existing data/storage calls, then configure the production signed webhook. Its guarded user-created/updated path must initialize before any ordinary insert.
5. Integrate the frontend's default-off `VITE_CLERK_CONTINUITY_ENABLED` path. POST `{}` to `initialize-clerk-profile` with the current default JWT before `ensureProfile`, launch bootstrap, hydration and replay. Accept only an exact current owner/session/issuer receipt. Initialization failure must stop; do not fall back to email lookup or unprotected insertion.
6. Integrate protected launch enrollment with `continuity_lifetime_source` and `continuity_owns_subject`. Review the combined migration and frontend tests, then coordinate database run enablement, Edge gate, production frontend key and frontend gate. Avoid a mixed release that creates production profiles before continuity.
7. Use an authorized controlled-account test to verify actual provider identity, unchanged UUID, preserved rows/documents, device recovery, lifetime evidence, new-account enrollment and retired development denial. Synthetic tests do not replace this provider/runtime verification.

Server environment names (values remain private):

- `CLERK_ISSUER`: canonical production issuer `https://clerk.credentialdomd.com`.
- `CLERK_SECRET_KEY`: production API secret, server only.
- `CLERK_CONTINUITY_SOURCE_SECRET_KEY`: development API read secret, server only.
- `CLERK_CONTINUITY_SOURCE_ISSUER`: exact staged development issuer.
- `CLERK_CONTINUITY_ENABLED`: absent/false until coordinated activation.
- Existing Supabase runtime and `CLERK_WEBHOOK_SECRET` configuration remain required.

The development API is required only for first binding. A bound identity can resume without it. Disabling the gate does not reverse an existing binding. Do not automatically switch profile subjects back or move files as a rollback: review the protected journal and all subsequently written data first.

### Separate feature limit

The credential-recipient portal's immutable invitation subjects and legacy-file validation are not adapted by this package. Keep that feature disabled until its own lineage and recipient-access review is complete. This package does not authorize new outbound mail or enable billing/other feature gates.

### Reserved logins for reviewed existing members

Existing members may be provisioned with an unverified reserved primary email so
the normal sign-in page recognizes them before their first production login.
This is a new provider identity linked to the original application account after
mailbox verification, not a copy of provider passwords, sessions or MFA secrets.
Provisioning and its provider acceptance checks are separate from this source
change. Nothing in the webhook creates provider users or sends an invitation.

The importer contract is `private_metadata.credentialdomd_continuity` with exactly
`{ schemaVersion: 1, runId, manifestSHA256, sourceSubject }`. These values identify
the protected, enabled database run and its prepared source account; public and
unsafe metadata are never accepted. The provider `external_id` must also match
the marker's `sourceSubject`. The provider primary email must have
`reserved: true` and either null verification or `verification.status: unverified`.

Only after the regular verified identity read reports `verified_primary_required`
does the webhook consult `reservedContinuity.ts`. The helper rereads the current
production identity, checks the run, exact prepared account and source profile
(including the read-only `account_is_closed` tombstone probe),
rejects any existing target profile/binding, and freshly verifies the exact legacy
identity. It rechecks database state after the source-provider read. A successful
deferral acknowledges the event with no database writes. It does not bind the
identity, route inbound mail, start a trial, or grant lifetime/admin access.

After the member completes email-code verification, the normal verified webhook
or authenticated initializer performs the existing protected binding. Bound
accounts, unrelated unverified identities, malformed/conflicting evidence, and
provider/database failures do not qualify for deferral. Existing retry behavior
is preserved for them; this change is not a general mailbox-revocation repair.

Before provisioning, inspect fresh source MFA and enterprise-auth requirements
and stop for any account whose required protections would be lost. The initial
sealed snapshot does not include those flags. Never mark a reserved email verified
administratively to skip the member's normal email-code proof.

Provider references: [createUser](https://clerk.com/docs/reference/backend/user/create-user)
and [official Backend API schema](https://github.com/clerk/openapi-specs/blob/main/bapi/2021-02-05.yml).

## Validation

- `tests/clerk-continuity/client-recovery.test.mjs` and `server.test.mjs`: **49 passed**, including actual helpers, proof freshness, exact-subject manifest joins, retirement and device-secret fallback.
- `tests/clerk-continuity/sql.test.mjs`: **14 passed** in disposable PostgreSQL with synthetic identities, actual migration applied twice, real RLS/concurrency and lock-wait checks. The local shim is deliberately smaller than the production schema; the release integrator also tests against the reconstructed production schema.
- Existing document deletion, webhook, mail-throttle, backup and device-secret checks pass. Changed JavaScript lint, Edge-entrypoint bundling and production build are required before the source handoff.

All tests in this package use local synthetic state or mocked providers. No live identity was relinked and no customer file, message, provider account or billing gate was changed by this source work.
