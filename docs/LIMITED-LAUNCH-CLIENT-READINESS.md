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

## Approved account-deletion ownership follow-up

After the separate deletion-path rejection, the owner explicitly approved the isolated account-deletion guard repair and synthetic tests, then directly approved the final cache repair. The change captures account, profile, Clerk session and AppContext load generation when confirmation opens. Closing/reopening clears typed confirmation. A stale confirmation, session replacement, profile change or A→B→A transition cannot authorize deletion. A synchronous busy guard prevents duplicate clicks; Cancel is disabled while deletion is underway.

The helpers accept only genuine issued, immutable deletion contexts, use the captured account's SDK client, and recheck ownership before/after token minting, at final fetch and between asynchronous phases. Storage paths, table filters and server invocation retain the original owner. The final UI reset verifies the same context again when React applies it. Already-dispatched requests for the original owner may complete; this does not promise rollback of a request already sent.

Legitimate data-deletion rights remain independent of membership. Offline and null-profile contexts perform only the original owner's local cleanup/reset; they create no additional SDK client and mint no token. Validation uses actual handler/helper source and the installed SDK with fake transports. No real deletion, customer-data mutation, provider request or deployment was performed.

Confirmed deletion invalidates queued cache callbacks and earlier data loads before the local purge; only the validated deletion context advances with the new load generation. Final reset validates the genuine current context before canceling any timer. A late result for A cannot cancel B's timer or change B's cache generation. The regression that reproduced old data reappearing while server deletion waited now passes. An already-dispatched optional asynchronous storage write or authorized deletion request cannot be rolled back. Historical rejection evidence remains preserved; the user's later direct approval resolved the code-repair scope.

## Remaining activation review

1. Protected backend migrations, row/storage policies, entitlement/activation/quote/checkout/portal handlers, reviewed cohort snapshots, and deployment flags require coordinated verification. Client-side checks cannot establish purchase, eligibility, or account approval. The integrated `ensureProfile` now pins lookup/insert/retry to the initiating owner, session and load generation. Its production-continuity mode requires a validated initializer receipt and exact returned profile UUID; failures never fall through to a fresh insertion or local hydration.
2. A real controlled-account test remains required: verified mailbox invitation binding; lifetime account; grandfathered beta activation and fixed expiry; Core Practice trial; account switch during a delayed write; offline/reconnect; revoked account; expired quote/reconsent; provider settlement; cancellation; saved invoice and attachment exports. Synthetic tests and successful builds do not prove those integrations.
3. Existing paid Core subscribers have no reviewed purchase/upgrade path for Practice after the trial. The client preserves records and does not create a second subscription. A protected upgrade contract requires separate review.
4. Setup completeness is not an entitlement condition. No seven-day deadline, revocation, lifetime expiry, or setup-triggered email was implemented.

## Validation

The initial access, transport, invitation, and rendered-screen foundation passed 40 synthetic tests, with additional resume tests described above. It covers server-time expiry, lifetime/paid overlap, failed refreshes, identity changes, document relinking, atomic restore preflight, transport deadlines/body bounds, invitation privacy, offer/consent validation, strict Stripe hosts, read-only records/exports, and disabled sales controls. These tests perform no provider or customer requests.

All 170 client tests pass with no skips or TODOs. The persistence suite makes all seven original regressions required passing checks. Expanded tests cover same-owner success/recovery as well as delayed settings, token, upload, deletion and replay failures in both enforcement modes. Actual AppContext function tests cover stale background loading, reconciliation, deletion reset and queued cache callbacks. A separate suite runs the installed Supabase SDK with synthetic Clerk tokens and a fake fetch transport, proving token-mint/final-fetch ownership checks, selected parallel DELETE token waits, storage requests, successful/error server response delays and sign-out without network access. The existing deletion contract suite also passes 139 checks.

Both the default-OFF and explicitly enabled production builds pass. New client modules pass targeted ESLint. Existing modified modules retain their prior lint findings, with no additional findings relative to the base commit. These local checks are not an activation pass; the integration and security review above remains necessary.

Build warnings about bundle size, existing dynamic imports, and browser externalization of Node modules predate this work.


## Current-main security and public enrollment integration

The reviewed client through `b44de9b3` was integrated onto `cacc604b`, preserving the existing physician-first website, CredentialDOMD branding, marketing mode, email holds, legal text and deployment configuration. Relevant security client changes from `1f136c07` add server-derived admin display, verified forwarding-mailbox display, device secret/cache/export redaction, local-only preference preservation, request routing corrections and withheld Vera source links. Backend security and billing changes are integrated separately; deploy the matching server contracts and policies as one coordinated release.

All three client build switches are absent/false by default:

- `VITE_LIMITED_LAUNCH_ACCESS_ENABLED`: consumes protected entitlements and consented quote/checkout/portal contracts. In this mode the app never invokes the historical `claim_beta_access` grant RPC.
- `VITE_PUBLIC_SELF_SERVICE_SIGNUP_ENABLED`: after stable profile initialization, POSTs `{}` to `bootstrap-launch-access`. Only the server decides lifetime, grandfathered beta or paid enrollment from its trusted identity/cohort records. No email, cohort, price or eligibility is supplied by the browser. A separately fetched entitlement snapshot remains the only authority. Successful enrollment is not repeated on routine refresh; failed enrollment is retryable, and account/session/load changes discard late results.
- `VITE_CLERK_CONTINUITY_ENABLED`: before ordinary profile access, POSTs `{}` with the default Clerk token to `initialize-clerk-profile`. Requires a production-issuer receipt matching the initiating subject/session and immutable profile UUID. Bound legacy identities recover absent local slots from the authenticated source namespace before hydration or replay; conflicts stop initialization with a recovery message. Secret-password legacy derivation uses only that fresh authenticated binding, never an email or local receipt alone. A current/fresh identity clears legacy derivation. Failed initialization cannot create a replacement identity or silently load destination storage.

The fresh public paid path is early-bird Credential at $149/year or the full $245/year package. Protected earlier invitations/cohorts retain their server-approved $99 rate and the exact 30-day no-card beta promise. Existing eligible registered identities retain trusted lifetime access. Price and renewal consent are displayed from the validated server quote; no subscription starts from sign-in, enrollment or reviewing an offer. The Core purchaser's included 30-day Practice access remains separate, with explicit paid opt-in and no automatic Practice charge.

New pending accounts without saved collections see **Choose your membership**. Existing records retain the read/export notice. The local synthetic preview mounts the actual membership/notice/access hook and client with fake transports and captured payment navigation; it does not prove Clerk production configuration, payment settlement, migrations, storage policies or live provider behavior.

### Continuity limitations before activation

The imported recovery adapter covers browser localStorage. Native/Capacitor-only legacy data requires a separately guarded adapter. Recovery preserves source slots and does not rewrite queued payloads or storage paths: exact server profile continuity and protected storage-prefix authorization must be present before replay. Recovery errors stop ordinary app hydration. An explicit purge now persists a retirement marker before deleting local data. Pending and later recovery attempts cannot recreate retired device slots. Marker failure stops deletion/signout and is surfaced to the user; canonical cloud access and authenticated legacy password decryption remain available after intentional retirement. Ordinary involuntary expiry keeps its previous vault-preserving behavior; a genuine server wipe explicitly retires recovery.


### Final client integration validation

The combined client/continuity regression suite passes 244 tests, including protected bootstrap and identity receipt validation, actual hook lifecycle/order, profile token/fetch ownership, failed continuity with no insertion/hydration fallback, retired device migration with canonical cloud access, explicit purge failure, and first-write reconciliation without render loops. Thirty of these tests exercise the imported recovery/retirement helpers. Existing device-secret checks (196), deletion contracts (139), local preference persistence (41), AI refusal handling (66), Vera source/evidence tests (26) and public packaging/mode tests (30) are also retained.

A synthetic installed-SDK negative control reproduced an ordinary failed save re-entering the queue between local purge and asynchronous Clerk signout completion. Explicit signout now invalidates captured write contexts for that owner before purge, independently of load-generation invalidation. Later token dispatch and failed-write requeue are rejected; other accounts' pending work and fresh same-owner actions after a failed Clerk signout remain usable. Existing signout confirmations remain before retirement/invalidation. No provider request, real deletion, payment or email was used for this verification.

All client rollout flags, public marketing mode, backend deployment configuration and email holds remain unchanged/OFF in source. Native-only device migration, matching backend/security/storage enforcement, reviewed cohort/identity sealing, provider webhook settlement and a controlled production signup remain release-coordinator dependencies. Shared frontend/backend contract scripts must run on the combined branch rather than a frontend-only checkout.
