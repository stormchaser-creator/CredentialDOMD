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

## Known activation blockers

1. **Persistence races remain unresolved.** Initial guards cover collection CRUD, upload, bulk sync, tombstones, and replay admission, but a write already waiting on asynchronous work can outlive its account or entitlement. Queued writes, document operations, replay retries, and replay queue reconciliation need the separately reviewed owner-pinning changes. Do not interpret the local guards as a replacement for server authorization.
2. Automatic approval review rejected both a broader persistence patch and a narrower guard-only retry, describing them as unrequested changes to live data-write/document-upload paths and citing potential orphaning/incorrect writes and synthetic failures. Rejected changes were not applied. The proposed changes and exact refusal evidence are retained privately for owner review; no further retry or splitting is authorized by this document.
3. Protected backend migrations, row/storage policies, entitlement/activation/quote/checkout/portal handlers, reviewed cohort snapshots, and deployment flags require coordinated verification. Client-side checks cannot establish purchase, eligibility, or account approval.
4. A real controlled-account test remains required: verified mailbox invitation binding; lifetime account; grandfathered beta activation and fixed expiry; Core Practice trial; account switch during a delayed write; offline/reconnect; revoked account; expired quote/reconsent; provider settlement; cancellation; saved invoice and attachment exports. Synthetic tests and successful builds do not prove those integrations.
5. Existing paid Core subscribers have no reviewed purchase/upgrade path for Practice after the trial. The client preserves records and does not create a second subscription. A protected upgrade contract requires separate review.
6. Setup completeness is not an entitlement condition. No seven-day deadline, revocation, lifetime expiry, or setup-triggered email was implemented.

## Validation

The access, transport, invitation, and rendered-screen suite contains 40 passing synthetic tests. It covers server-time expiry, lifetime/paid overlap, failed refreshes, identity changes, document relinking, atomic restore preflight, transport deadlines/body bounds, invitation privacy, offer/consent validation, strict Stripe hosts, read-only records/exports, and disabled sales controls. These tests perform no provider or customer requests.

Both the default-OFF and explicitly enabled production builds pass. New client modules pass targeted ESLint. Existing modified modules retain their prior lint findings, with no additional findings relative to the base commit. Separate persistence regression evidence must be read alongside these passing checks; it is not an activation pass.

Build warnings about bundle size, existing dynamic imports, and browser externalization of Node modules predate this work.
