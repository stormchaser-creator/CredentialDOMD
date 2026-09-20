# Limited launch client foundation

## Publication and activation are separate

The client switch `VITE_LIMITED_LAUNCH_ACCESS_ENABLED` is absent by default and evaluates to false. This change does not alter deployment configuration, billing gates, cohorts, account access, Clerk settings, or customer messages. It is a reviewable foundation, **not approval to activate enforcement or payments**.

No email, invitation, provider notification, customer grant, or payment was issued while implementing this change. The owner must review exact email copy and recipients before sending.

## Implemented client behavior

- Read a fresh default Clerk session token for the signed-in account and request `billing-entitlements`. Validate its policy version, capabilities, server timestamps, lifetime flags, Practice trial, optional grandfathered free beta, and protected checkout/activation fields.
- Use monotonic elapsed time with the server evaluation timestamp. Expiration removes affected write permission while retaining the server-provided read/export capabilities. Lifetime grants and separately purchased access remain independent. Stale or failed refreshes pause writes.
- Reset cached access across accounts and reject late tokens, responses, and checkout redirects from a different session or account. Requests have a timeout and bounded response body.
- Guard the shared local collection/settings setters and backup restore before replacing saved data. A denied restore preserves the original data. Document relinking checks both the original and destination feature scopes.
- Preserve Credential and Practice saved-record views when write permission ends. Records include locally stored collections, saved invoice PDF downloads, attachment downloads, and links to existing full exports.
- Keep the grandfathered free beta separate from the Core purchaser's Practice trial. Dates come from the server. Free-beta copy says no card, no automatic charge, and no cancellation required. Lifetime copy does not expire or depend on setup completion.
- Capture `/app/#launch_invite=<opaque token>` before mounting sign-in/error reporting; remove the fragment immediately and retain the token only in the current tab's session storage. The token grants no client permission. Explicit activation calls `activate-billing-invitation`; no activation is triggered on page load.
- Show purchase controls only when protected server fields allow them. Display the exact server offer and consent text. `limited-checkout` receives only the quote ID, consent hash, and explicit boolean consent. An expired or replaced quote requires another review and confirmation.
- Use the protected `limited-customer-portal` for existing subscriptions, including from the paused-access screen. The limited-launch cancellation page never invokes the legacy deletion countdown or reactivation write.

## Saved checkout resume follow-up

The client consumes the backend `43691f6b` contract: optional `checkoutResumeAvailable` and `checkoutResumeOfferId`. A true resume flag requires billing enabled and exactly `core` or `core_locum`; false or absent cannot carry an actionable offer ID. Resume grants no Credential or Practice capability.

When new-purchase eligibility is false but an owned incomplete checkout can be resumed, the screen shows one **Resume checkout** action for that saved offer. It requests a fresh `billing-quote`, displays the exact terms, and resets consent. The existing `limited-checkout({quoteId, consentHash, consent:true})` flow remains unchanged. The server verifies and returns the saved checkout; the client does not create an alternative subscription or substitute another offer.

Review, quote refresh, purchase, and redirect all recheck the exact offer against current account access. Expired offers, ownership/offer conflicts, pending backend work, stale membership, and late responses do not bypass consent or open a payment page. Six synthetic follow-up tests cover the optional contract, both saved offers, blocked alternatives, initial consent state, account switches, stale responses, and backend refusals.

## Invitation diagnostics follow-up

Error reports and React console diagnostics redact invitation values, including encoded or malformed values, before clipping messages, stacks, URLs, and nested extra fields. Existing API-secret scrubbing remains in place. If browser history cleanup fails, the invitation is discarded from pending session storage and diagnostics still redact its URL. Invitation capture and redemption behavior are unchanged.

Eight additional synthetic tests cover failed history cleanup, encoded and quoted keys, clipping boundaries, filename and nested extra fields, beacon/fetch delivery, development and React console output, and ordinary report deduplication and limits. They use synthetic strings and fake transports.

## Approved persistence repair

The owner explicitly approved isolated repair and testing of saves and document uploads during account switches, followed by review before deployment. The earlier rejected partial patch was not applied. The complete repair captures the initiating account and Clerk session, checks both before/after token minting and immediately before SDK fetch, and checks again before retries, metadata writes, queue writes and state updates. These ownership checks apply with membership enforcement OFF as well as ON.

Settings keep device-only fields outside cloud/queued data. Document retries retain original file bytes under the original account and upload them before acknowledging metadata. No later document CRUD cleanup request runs under a switched account; a sign-out purge is not undone by a late failure. A request already sent while authorized may complete on the server; the client stops later requests and effects, while database/storage authorization remains necessary.

Replay acknowledges unique completed queue entries against a fresh queue read, preserving new or identical appended entries. A delete stays pending until both deletion and its tombstone succeed. Concurrent callers within this tab share one replay. This does not add a cross-tab storage transaction.

Background cloud/local loading and document reconciliation carry an account and load generation. Delayed results cannot update another account, start its next upload, or queue an old profile's data under its identity. Document edits retain their original metadata for feature-scope checks; an unknown prior document cannot claim Credential scope after Practice expires.

The delayed device-cache save also captures its owner and load generation together with its data. A callback from an older render cannot file that render's data under a newly loaded account.

## Remaining activation review

1. Protected backend migrations, row/storage policies, entitlement/activation/quote/checkout/portal handlers, reviewed cohort snapshots, and deployment flags require coordinated verification. Client-side checks cannot establish purchase, eligibility, or account approval. The existing `ensureProfile` helper still uses the shared client across its internal lookup/insert/retry; the caller rejects stale results, but that helper's internal request ownership remains part of security integration review. Profile creation was outside this save/upload repair.
2. Independent review reproduced a separate existing account-deletion race: `LegalSection` reads the current profile/session again after an awaited request, so a confirmation begun under account A can continue under account B. Automatic approval review rejected the proposed deletion-helper protection as outside the explicit save/upload repair scope and involving irreversible erasure. No deletion-path patch was applied or retried. A private review-only proposal and synthetic reproduction await explicit authorization for that bounded deletion path. The current save/upload repair does not resolve it.
3. A real controlled-account test remains required: verified mailbox invitation binding; lifetime account; grandfathered beta activation and fixed expiry; Core Practice trial; account switch during a delayed write; offline/reconnect; revoked account; expired quote/reconsent; provider settlement; cancellation; saved invoice and attachment exports. Synthetic tests and successful builds do not prove those integrations.
4. Existing paid Core subscribers have no reviewed purchase/upgrade path for Practice after the trial. The client preserves records and does not create a second subscription. A protected upgrade contract requires separate review.
5. Setup completeness is not an entitlement condition. No seven-day deadline, revocation, lifetime expiry, or setup-triggered email was implemented.

## Validation

The initial access, transport, invitation, and rendered-screen foundation passed 40 synthetic tests, with additional resume tests described above. It covers server-time expiry, lifetime/paid overlap, failed refreshes, identity changes, document relinking, atomic restore preflight, transport deadlines/body bounds, invitation privacy, offer/consent validation, strict Stripe hosts, read-only records/exports, and disabled sales controls. These tests perform no provider or customer requests.

The persistence suite now makes all seven original regressions required passing checks rather than executing TODOs. Expanded tests cover same-owner success/recovery as well as delayed settings, token, upload, deletion and replay failures in both enforcement modes. Actual AppContext function tests cover stale background loading and reconciliation. A separate suite runs the installed Supabase SDK with synthetic Clerk tokens and a fake fetch transport, proving token-mint and final-fetch ownership checks without network access.

Both the default-OFF and explicitly enabled production builds pass. New client modules pass targeted ESLint. Existing modified modules retain their prior lint findings, with no additional findings relative to the base commit. These local checks are not an activation pass; the integration and security review above remains necessary.

Build warnings about bundle size, existing dynamic imports, and browser externalization of Node modules predate this work.
