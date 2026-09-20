# Existing-account login preparation

This offline tool prepares reserved production Clerk identities for an explicitly reviewed subset of a sealed continuity manifest. It does not create accounts, contact providers, read credentials, send messages, or change records/access. The owner-approved full proposed subset is eleven real existing accounts; the sealed manifest still contains twelve entries, including one excluded test identity. A separate owner-only pilot, then the remaining ten, can each use a pinned subset without changing that manifest.

## Provider contract

Clerk's backend create-user API defaults supplied email addresses to verified. The proposed request explicitly supplies `email_address_identification_status: ['reserved']` to avoid that default. A reserved address remains unverified and is reserved for sign-in; actual mailbox verification still happens through Clerk. `external_id` is a unique retry correlation key. It is not proof of mailbox control. `skip_password_requirement: true` is permitted only because the target instance supports email-code sign-in; it does not copy or reset an existing password. [Clerk createUser documentation](https://clerk.com/docs/reference/backend/user/create-user), [official Clerk SDK REST field definitions](https://github.com/clerk/clerk-sdk-python/blob/main/docs/sdks/users/README.md).

The sole planned REST payload is:

```json
{
  "external_id": "user_ExactSealedSource",
  "email_address": ["verified-source@synthetic.test"],
  "email_address_identification_status": ["reserved"],
  "skip_password_requirement": true,
  "private_metadata": {
    "credentialdomd_continuity": {
      "schemaVersion": 1,
      "runId": "reviewed-run-uuid",
      "manifestSHA256": "reviewed-manifest-sha256",
      "sourceSubject": "user_ExactSealedSource"
    }
  }
}
```

The example is illustrative; the actual UUID/hash must pass validation. There are no password/hash, OTP, session, verified-email, phone, MFA, legal-check bypass, backdating, or grant fields. Ordinary social-provider linkage in the source may coexist with verified email-code login; it is not copied. Source MFA, passkeys, enterprise/SAML or SSO-matched identifiers require separate review and block this path.

## Private inputs and output

`scripts/clerk-existing-account-import.mjs` accepts only `--input`, `--review`, `--expected-review-sha256` and `--output`. The independent SHA pins the exact reviewed file bytes. `--apply` and credential flags are rejected. Output creation uses mode `0600` and exclusive creation; existing files cannot be overwritten. Keep the directory private as well. Standard output contains counts and a plan hash only.

```sh
node scripts/clerk-existing-account-import.mjs \
  --input /private/path/fresh-evidence.json \
  --review /private/path/reviewed-batch.json \
  --expected-review-sha256 REVIEWED_FILE_SHA256 \
  --output /private/path/new-plan.json
```

The reviewed file pins run/hash, source/target issuer and instance IDs, twelve manifest members, expected production user count, selected subject count and `selectedSubjectSHA256`. The selection digest is SHA-256 of the JSON array of lexicographically sorted selected subjects, without added spaces. Every other sealed member must have an explicit `synthetic_test`, `owner_excluded`, or `deferred_batch` exclusion. The latter allows the owner-only pilot followed by the remaining batch. The full sealed manifest digest is recomputed using the existing PostgreSQL-compatible canonical format.

The evidence input contains:

- `manifest`: unchanged sealed continuity manifest.
- `sourceSnapshot` and `targetSnapshot`: `{readAt, instanceId, complete: true, users: [...]}` from the exact authenticated provider instances. `readAt` must be captured before beginning the complete scan. If present, `totalCount` must match the reviewed expected count, and `completedAt` must follow `readAt`. Pagination must be complete; a cursor or failed-page count blocks preparation. All target email addresses, including unverified/secondary addresses, must be retained for collision checks.
- `accountSnapshot`: fresh, scoped continuity run and account/profile/closure state. Each account supplies exact sealed source fields plus `state`, `targetSubject`, `profileSubject`, `profileAccessStatus`, `closed` and `unexpectedSourceProfile`. Tombstones/soft deletion, revocation, unexpected profiles and conflicting bound targets block the affected identity. Binding must already agree with the current profile owner to skip a completed import; the tool never resets a bound account to prepared.
- `authConfig`: `{readAt, instanceId, emailCodeSignInEnabled: true, emailCodeVerificationEnabled: true}` derived from a current authenticated configuration read. This evidence does not authorize changing configuration.

Fresh provider, database and configuration evidence has a five-minute maximum age and ten-second future allowance. The historical manifest timestamp is preserved. Missing or stale evidence produces an explicit hold; never retimestamp an old export to make it current. The plan always has `applyAuthorized: false`, `providerWrites: 0`, and `executableCreates: 0`. `readyForReview` means only that the offline evidence is internally consistent.

## Retry and deployment boundaries

Before any eventual production create:

1. Deploy and verify reserved-user webhook deferral. Its backend-only marker must match the enabled prepared run/hash/source and fresh verified source mailbox; reserved production identifiers must not cause profile insertion or grants before the user verifies their mailbox.
2. Review the exact private batch/payload hash and refresh the complete evidence. Recheck the source identity and production collision state immediately before each mutation. Stop if the original evidence ages out or the target count changes unexpectedly.
3. For a production target to count as an already imported identity, require the exact external ID, primary mailbox, protected marker and consistent continuity binding. Never adopt another identity based on email alone. A conflicting secondary address also blocks the batch.
4. After an uncertain response, do not blindly resend creation. Reconcile a fresh complete production read by external ID and every mailbox. The same offline planner can identify an exact reserved or verified target as `skip_existing`; mismatches remain held. The pinned expected production count must be refreshed and reviewed for the observed partial result; a plan pinned to zero will not silently accept one new account. The tool is not an automatic retry executor. A confirmed partial import is not automatically deleted or rolled back. Any production subject matching a sealed legacy subject blocks preparation.
5. Verify actual provider readback and real email-code login before the remaining batch. This offline test does not prove provider creation, automatic-email behavior, reserved-identifier sign-in, webhook delivery or successful account binding.

The production identity's new creation timestamp does not replace original lifetime evidence. Existing continuity code independently requires fresh provider verification before restoring the old profile UUID, records and approved access. The importer cannot change that authority. No Stripe, database migration, access grant or customer message is part of this tool.

## Local verification

```sh
node --test tests/clerk-continuity/import-plan.test.mjs
```

Synthetic cases cover manifest/subset pinning, stale/incomplete evidence, account closure and ownership changes, MFA/SSO/passkey holds, all-address collisions, exact reserved and verified retries, owner-only and remaining-account batches, allocated-profile continuity, protected payload allowlist, private output and rejected mutation arguments. Fixtures contain synthetic addresses only.
