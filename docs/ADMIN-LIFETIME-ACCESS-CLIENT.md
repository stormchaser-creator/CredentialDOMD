# Owner-granted lifetime access: client review

This change adds an administrator-only workflow under **Admin → Users**. It does not introduce a public free plan, send an invitation, or change a subscription.

## Workflow

1. The recipient creates and verifies an account at `/app/`. Creating an account requires no card.
2. The administrator chooses **Give free lifetime access** on that registered account.
3. `admin-lifetime-access` reviews the exact profile UUID and Clerk subject. The dialog displays the returned provider-verified primary email, profile UUID and sign-in identity. Editable profile email is not an ownership claim.
4. The administrator enters a 10–500-character audit reason and explicitly confirms both Credential and Practice free for life.
5. The server rechecks administrator authorization, target identity and billing before recording the grant. Only a matching successful receipt updates the directory view.

Existing lifetime grants remain intact. A renewing paid subscription or open/unresolved checkout blocks the grant; the UI cannot override that result. The member must manage renewal through their billing portal first. The grant never performs an automatic cancellation or refund.

## Endpoint contract

Both operations use a bounded private POST to `admin-lifetime-access` with the initiating account's default Clerk JWT.

Review request:

```json
{"action":"review","profileId":"<exact UUID>","clerkSubject":"<exact subject>"}
```

Review response includes `schemaVersion: 1`, exact `target` (`profileId`, `clerkSubject`, `name`, `verifiedPrimaryEmail`), boolean `lifetime` scopes, boolean `canGrant`, `billing` (`hasExistingSubscription`, `status`, `notice`), and `reviewId`/`expiresAt`. A blocked review can return both receipt fields as null. A usable receipt requires a UUID and timestamp.

Grant request:

```json
{"action":"grant","reviewId":"<review UUID>","requestId":"<stable request UUID>","reason":"<audit reason>","confirmed":true}
```

Success must include the exact reviewed profile, subject and verified mailbox; both lifetime scopes true; `grantId`, `grantedAt`; and `cardRequired`, `subscriptionCreated`, `emailSent` all false. The client never treats a changed identity, partial scope, or unexpected side effect as success.

## Client safeguards

- No grant on opening, reviewing, selecting an account, or checking a box.
- No client email/admin claims, direct grant-table writes, legacy approval RPC, Stripe call, or email endpoint in the new workflow.
- Exact actor/session checks before dispatch and throughout response reading; target and component lifecycle guards discard stale results.
- Duplicate clicks share one request. An uncertain retry preserves the request UUID and audit reason; changing its payload requires a new review.
- A server-blocked review stays blocked even if display data is mutated locally. Server authorization and billing checks remain authoritative.
- Forty-five-second deadline covers token lookup, fresh provider checks, fetch and body reading; response size is limited to 16 KiB. Provider diagnostics are not displayed or logged.
- Review/grant data stays in memory; no new browser storage or analytics.

## Validation and integration

`node --test tests/admin-lifetime/*.test.mjs` exercises the real transport and actual component handlers with synthetic dependencies. Coverage includes blocked renewing billing/checkout, existing lifetime access, confirmation, duplicate and uncertain retries, session/account changes, closing a pending dialog, exact response identity, timeouts and malformed responses.

The server endpoint, audited grant migration, and provider checks are a separate coordinated release dependency. The UI grants no access by itself. No live SQL, provider settings, real recipients, grants or emails were used in client verification.
