# Autonomous support foundation

Status: staged, unapplied, and disabled by default. No customer email, live database change, schedule change, deployment, payment action, or model call was performed for this implementation. This is the first backend stage, not an operating autonomous company.

## What is implemented

- Reuses `support_tickets` and `support_messages`; creates no parallel conversation system.
- Authenticated customer intake commits the ticket/reply, source event, and jobs in one PostgreSQL transaction. Identity comes from a verified Clerk subject mapped to an active profile, never a client-supplied profile ID or editable email.
- Stable client request UUIDs deduplicate retries and reject changed payloads. Per-profile admission is serialized and limited to 20 submissions per hour and 60 per day; a retry of an already accepted request remains available at the cap.
- Ticket categories preserve the existing database enum. Both broker and RPC map the UI aliases `feedback` to `other` and `idea` to `feature_request`; all six existing canonical categories remain accepted. Category values cannot confer any author, admin, approval, or release permission.
- Customer-selected `low`, `normal`, `high`, and `urgent` priorities are retained. Priority cannot approve an action or authorize a release. Resolving a ticket stops new job claims and suppresses queued email; a later customer reply reopens the ticket and clears its archived/resolved timestamps.
- Internal intake can ingest an existing canonical ticket or customer message. It cannot accept an arbitrary body, recipient, author, SQL statement, or shell command.
- A receipt job provides a fixed, truthful acknowledgement. Answer jobs use only an exact question match against approved, unexpired public product knowledge, otherwise a fixed escalation message. No free-form model output reaches customers in this stage.
- Workers claim jobs with `SKIP LOCKED`, a 90-second visibility lease, an unpredictable fencing token, and five maximum attempts. Completion rechecks policy, pause status, and the latest customer input sequence. An old worker cannot publish after its claim expires or is replaced.
- The non-login `CredentialDO Support` actor has no physician profile or admin membership. New protected message metadata is service-owned. Legacy human message records remain intact.
- Completion atomically records the reply and durable email outbox. Draft mode records explicit drafts without posting a message or sending mail.
- Outbound mail uses the existing Resend provider. An explicit support-mail binding must reference an existing confirmed `forwarding_addresses` row owned by the same profile. The binding, version, ticket state, active account, actor, and policy are checked again immediately before submission. Editable `profiles.email` is never a recipient source.
- Email submission has a separate capability credential and runtime/DB gates. The server supplies the entire envelope and stable `support/<outbox UUID>` idempotency key. The handler accepts no recipient or email body.
- A timeout or ambiguous result becomes `unknown`, not success and not a new queued send. Signed provider receipts deduplicate independently and can reconcile a lost submission response. Acceptance and delivery are separate states. Bounce/complaint status wins over later acceptance receipts and suppresses future mail to that address.
- High-impact requests are typed proposals, bound to a canonical action hash and capability. A verified Clerk subject must map to `app_admins` to approve. Approval expires after 24 hours, execution is one-time, and an uncertain action cannot be executed again automatically. There is no financial, release, identity, or clinical executor.

## Files and boundaries

| File | Responsibility |
| --- | --- |
| `supabase/migrations/20260918090000_autonomous_support_foundation.sql` | Tables, service-only grants, actor guard, transactional intake, worker/outbox leases, verified binding, receipt and approval primitives |
| `supabase/migrations/20260918092000_support_customer_read.sql` | Transactional service-only customer list/read functions, exact ticket ownership, protected actor labels, stable pagination |
| `supabase/functions/_shared/supportPolicy.mjs` | Deterministic approved-knowledge matching, exact approval shapes, Resend outcome and receipt parsing |
| `supabase/functions/_shared/supportHandlers.mjs` | Bounded HTTP broker, per-operation capabilities, strict request fields, draft/send gates |
| `supabase/functions/_shared/supportDependencies.ts` | Clerk/JWKS, service database adapter, Svix verification, Resend adapter |
| `supabase/functions/support-operations/index.ts` | New isolated Edge Function entry point |
| `tests/support/foundation.test.mjs` | Handler/policy tests with injected dependencies and synthetic data |
| `tests/support/postgres-foundation.py` | Actual migration on a disposable local PostgreSQL 17 server, including concurrent clients |
| `src/utils/supportOperationsClient.js` | Off-by-default flag, Clerk-session binding, in-memory retry IDs, exact-ticket response checks, neutral legacy labels |
| `src/components/pages/SupportModal.jsx` | Feature-flagged create/reply/read integration, protected reply labels, stale-view cancellation, explicit text-only pilot |
| `tests/support/client.test.mjs`, `tests/support/ui.test.mjs` | Client loss/retry/account-switch tests and actual React render checks for both flag states |
| `src/utils/adminSupportThread.js`, `tests/support/admin-thread.test.mjs`, `tests/support/admin-race.test.mjs` | Admin reader, neutral legacy/protected automation labels, and callback race checks, integrated separately in `AdminDashboard.jsx` |
| `scripts/signup-notify.sh` | Staged customer-reply notification filter excludes null authors and service actors before and after the support migration |

Existing live ticket functions, email triggers, CLI worker, launch agent, and cron entries were not replaced. The SupportModal caller selects the new API only when `VITE_SUPPORT_OPERATIONS_ENABLED` is exactly `true`; the default keeps legacy create/reply/attachment calls. The migration adds its own message guard but does not alter historical migrations or existing trigger definitions. New tables and RPCs are inaccessible to `anon` and `authenticated`; the broker holds service access. Never provide that service credential, the delivery key, or customer data to a code-writing worker. Engineering work must continue in an isolated checkout without production credentials or push rights.

The current adapter uses `SUPABASE_SERVICE_ROLE_KEY`, which has broad database privileges. Separate HTTP operation keys restrict broker operations; they do **not** reduce that database credential's privileges. A dedicated database role or constrained proxy, with only the reviewed support RPCs and necessary profile/admin lookup access, remains an implementation and deployment prerequisite before unattended operation. Its grants and inability to query unrelated application data must be tested independently.

The staged signup notifier now requires a nonnull profile author and `(to_jsonb(m)->>'support_actor_id') IS NULL` before classifying a message as a customer reply. The JSON field lookup works on the legacy schema where that column does not exist, so this filter can precede the migration. Customer replies remain selected; admin, null-author, and service-actor replies are excluded. The notifier itself was never executed, and no running copy or schedule was changed. Install the reviewed filter wherever this notifier runs before enabling automated publication.

## Customer UI and read contract

`VITE_SUPPORT_OPERATIONS_ENABLED` is absent from the reviewed local environment and defaults false. It controls customer API routing only; setting it does not enable the server worker, publication, email, or billing. When false, the existing screenshot upload/read flow stays available. When true, the pilot supports text submissions with current categories/priorities and explicitly states that new attachments are unavailable; existing attachments still use the existing authorized link function. There is no silent fallback from an uncertain new submission to a legacy mutation.

The new client obtains a fresh default Clerk session token and pins the session/user before and after the request. The modal remounts private state when the account changes, and generation counters reject late updates after switching/closing a ticket. New submissions reuse the same request UUID and body after an ambiguous response. Concurrent duplicate clicks share one request. Changed content cannot reuse an uncertain request. Owned read responses expose the committed request UUID, allowing a later conversation/list refresh to reconcile a lost receipt before starting another message. Pending tokens/requests are kept in memory only.

Closing/reopening the modal or leaving/reopening a ticket restores an uncertain submission's exact saved text and offers **Retry same ticket** or **Retry same reply**. Editing that pending payload is disabled until the request is confirmed. Reply retry waits for the initial conversation read to finish so reconciliation cannot compete with a second submission. Switching tabs preserves an ordinary unsent draft; closing clears ordinary draft fields. Pending requests survive those view changes in the account-specific client, but not a full page reload or account change.

The server reads only the verified caller's own tickets, even if that caller is an app admin. `read_ticket` requires an exact ticket UUID and an optional cursor message from that same ticket. Messages are returned in pages of 100 using `(created_at,id)` ordering, including correct behavior when timestamps match. Results expose no author email, provider envelope or service credential. Read access remains available to an authenticated profile whose membership is inactive; new submissions still require active status. This permits reviewing existing support history without granting operational authority.

Protected service metadata labels automation **CredentialDO Support · Automated**. Verified support-account authors are **Support team**. Ordinary own messages are **You**. Historical records where an agent may have used the owner's ID are neutral **Reply on your ticket**, and unknown legacy provenance is **Reply**. Editable email and `is_admin_reply` alone never establish a named human author. The UI no longer promises personal replies from Eric or guaranteed email delivery. A successful ticket/reply response confirms stored intake only.

The AdminDashboard reader now retains the legacy view when the feature flag is off and reads protected fields through the existing `support_messages` RLS boundary when enabled. Only a null profile author plus the exact service actor and a job ID establishes its automated label; historical author IDs and admin flags remain neutral **Reply**. Its create/reply mutations still use the legacy functions. No existing `ticket_thread` view definition was overwritten.

## Request contract

POST JSON to the new `support-operations` function. The supported browser origin is `https://credentialdomd.com`; preflight is supported. CORS is not authentication. All customer/owner requests require an issuer-verified RS256 Clerk JWT with `sub`, `exp`, and `iat`, at most one-hour age, and a matching app authorized party if that claim is present. The internal operations require distinct high-entropy Bearer keys of at least 32 characters; reusing a key across roles is rejected.

| Operation | Authorization | Accepted fields beyond `operation` |
| --- | --- | --- |
| `create_ticket` | Active customer from Clerk subject | `requestId`, `subject`, `body`, optional `category`, optional `priority` |
| `reply_ticket` | Active customer; ticket ownership checked transactionally | `requestId`, `ticketId`, `body` |
| `list_tickets` | Authenticated profile from Clerk subject | None; latest 100 owned tickets |
| `read_ticket` | Authenticated profile; exact ticket ownership | `ticketId`, optional `beforeMessageId` |
| `ingest` | Intake key | `ticketId`, optional `messageId` |
| `process_one` | Worker key | `kind`: `receipt` or `answer` |
| `deliver_one` | Delivery key | None |
| `request_approval` | Worker key | `ticketId`, `capability`, exact typed `action` |
| `decide_approval` | Verified owner subject in `app_admins` | `approvalId`, Boolean `approve` |

Raw provider callbacks use POST `/support-operations/provider-receipt`. They must pass Svix verification against the independently configured Resend signing secret before any receipt is recorded. Neither the request body nor an internal worker key substitutes for a provider signature. Only the supported event types with a valid `support_outbox` tag are processed.

The broker reads at most 64 KiB, including chunked bodies. API errors are sanitized. `state: queued` confirms transactionally stored intake; `draft` confirms a stored draft; `published` confirms an in-app message; `accepted` confirms a provider message ID; only a verified delivery event produces `delivered`. No response claims the underlying issue is solved.

## Environment and database gates

| Setting | Purpose / initial value |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Server broker only; existing platform variables |
| `CLERK_ISSUER` | Exact expected issuer; no editable email authorization |
| `SUPPORT_INTAKE_KEY` | Internal canonical-record ingestion only |
| `SUPPORT_WORKER_KEY` | One-job processing and typed approval proposals only |
| `SUPPORT_DELIVERY_KEY` | One outbox submission only |
| `SUPPORT_AUTOMATION_MODE` | Defaults to `disabled`; permitted operating modes are `shadow` and `active` |
| `VITE_SUPPORT_OPERATIONS_ENABLED` | Frontend build flag, defaults false; only switches customer API routing |
| `SUPPORT_OUTBOUND_ENABLED` | Defaults false; must be literal `true` for delivery |
| `SUPPORT_CANARY_VERIFIED` | Defaults false; must be literal `true` for delivery |
| `RESEND_API_KEY` | Existing provider credential, held only by broker |
| `SUPPORT_RESEND_WEBHOOK_SECRET` | Resend endpoint signing secret; independent of the API/internal keys |

The database singleton starts with `mode=disabled`, publication/outbound false, and no canary timestamp. Enabling publication or outbound requires active mode and a canary timestamp; outbound additionally requires publication. Job processing requires the deployment and database modes to match. Missing configuration fails closed. Runtime gates alone cannot enable database publication or mail.

Each job records policy version `support-2026-09-v1`. Changing the DB policy version fences in-flight publication. It is not a substitute for reviewing a new deployment. Drafts do not automatically become published when mode changes; any promotion/reprocessing workflow needs a separate reviewed implementation.

## Reliability and provider semantics

The outbox is a state machine: `draft → queued → leased → sending → accepted → delivered`, with separate `suppressed`, `failed`, `unknown`, `bounced`, and `complained` states. A crashed `leased` worker can be replaced. A crashed `sending` worker becomes `unknown`; a second worker does not submit again. The original attempt can settle later, or a signed receipt can recover it using the immutable outbox tag.

Resend retains idempotency keys for 24 hours. This foundation deliberately does not automatically retry ambiguous submissions, even inside that window. A future reconciler must respect the provider window, reuse the identical envelope/key, and never treat an expired key as permission to resend an uncertain message. Signed events are delivered at least once and can arrive out of order, so provider event IDs are deduplicated and state precedence is monotonic. These mechanisms reduce duplicates; they are not a claim of exactly-once external delivery. See [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys) and [Resend webhooks](https://resend.com/docs/webhooks/introduction).

Recipient revocation and ticket/policy pauses are checked immediately before the provider request. They cannot recall an email already accepted by the provider or eliminate a change made after that final check. Email text contains only the fixed acknowledgement, approved public answer, or fixed escalation; it never includes the customer's ticket text, attachments, credential documents, or clinical details.

Escalation keeps the case open and records `workflow_state=escalated`; it does not yet notify an operator or create a resolution follow-up. Unknown sends, dead jobs, suppressed mail, and pending approvals are durable and queryable, but an alerting/reconciliation process must be connected before unattended operation.

## Review and pilot prerequisites

1. Finish the separately pending production security batch. Confirm the deployed ticket/message/profile/forwarding schema and grants. Historical SQL references `auth.users` while current application functions use `profiles.id`; the local test fixture models the latter. The root agent verified live read-only metadata on September 18, 2026: ticket owner and message author foreign keys point to `profiles(id)`, message-author deletion cascades, and `is_admin(NULL::uuid)` returns false. The existing notify trigger tests `if not is_admin(new.author_id)` first, so it skips the null automation author. Keep the fixture regression and fail deployment preflight if this behavior changes. Use the unique new migration versions; never rewrite an applied migration.
2. Review the migration and broker independently. Apply only in a staging project first. Implement and validate the dedicated restricted database identity described above, Clerk token verification, and the real Deno dependency imports. Local tests do not substitute for those integration checks.
3. Verify the new SupportModal and AdminDashboard read paths in the actual browser, including actor labels and lost-response retry after navigation. Confirm every other ticket reader tolerates null `author_id`. Reconfirm that the legacy admin email trigger skips the new actor and does not duplicate outbound mail.
4. Pilot the feature-flagged SupportModal routing only after applying both reviewed support migrations and deploying the broker. Other callers, including Vera and AdminDashboard, still use `create-ticket`/`reply-ticket` and do not enqueue these jobs. Add a reviewed canonical-record intake integration and reconciliation scan for those sources using source IDs for deduplication. New attachment ingestion is not yet part of the transactional route.
5. Review and populate approved public knowledge with exact normalized questions, source URL, revision, and expiry. No knowledge content is seeded automatically. Configure explicit confirmed mailbox bindings. Clerk-asserted verified-email bindings require an additional adapter; there is currently no fallback to profile email.
6. Configure separate operation credentials and Resend signature endpoint in staging, using the platform's secret store. The Supabase gateway JWT setting must accommodate Clerk/internal/Svix authorization while the function continues to enforce its own scoped checks. No gateway configuration was changed here.
7. Run shadow jobs against synthetic cases and verify drafts and escalation accuracy. Run a restricted canary using controlled accounts and verified mailboxes, including genuine signed provider callbacks and negative signatures. No real-provider messages were sent in this implementation.
8. Only after those checks, connect a bounded scheduler and enable the reviewed routine-support policy. Avoid double replies with the existing worker. Keep initial engineering changes independently reviewed. A later explicit standing release policy may authorize narrow reversible copy/help/accessibility fixes after isolated tests, independent review, canary, and rollback; auth, billing, data access, clinical calculations, and new spend retain separate owner authorization. This foundation implements no auto-deployment.

Routine support replies do not require individual owner approval after the approved pilot. Approval primitives cover higher-impact actions only. Billing remains off, and this foundation cannot collect a charge or issue a refund.

Read-only legacy-trigger preflight must return `true` below. Also inspect `pg_get_functiondef('public.notify_ticket_reply()'::regprocedure)` and the installed trigger definitions to confirm the null-author check precedes all outbound work. A missing function, SQL null, changed control flow, or an additional mail trigger blocks the pilot until reviewed. The local regression reproduces the live guard and asserts that a published service-actor reply adds no legacy send call.

```sql
select public.is_admin(null::uuid) is false as automation_skips_legacy_admin_mail;
select pg_get_functiondef('public.notify_ticket_reply()'::regprocedure);
```

## Outstanding implementation work

- Operator overview, reliable alerting, paused/human-claimed cases, and owner approval UI.
- Resolution/follow-up events tied to actual tested/deployed fixes; reopening if the user reports failure. No automatic “fixed” or closure claim is implemented.
- Inbound support email authentication, opaque per-ticket reply routing, attachment quarantine, deduplication, and bounce handling integration. Current `support@` email routing is not a ticket ingestion system.
- Safe mailbox-binding UI/adapter; self-service verified Clerk email support if desired.
- Broader knowledge retrieval and an evaluated language model with tool isolation and evidence checks, if exact FAQ matching is insufficient.
- Engineering, CME source-monitoring, tutorial, marketing, policy, and refund workflows. Ticket text remains untrusted data; none may gain a shell, production credential, payment credential, or release permission through this broker.
- Retention/minimization policy for source text, drafts, provider metadata, and approval evidence.

## Validation

Run from the project root:

```sh
node --test tests/support/foundation.test.mjs
node --test tests/support/client.test.mjs tests/support/ui.test.mjs tests/support/admin-thread.test.mjs tests/support/admin-race.test.mjs
python3 tests/support/postgres-foundation.py
```

The Python harness requires PostgreSQL 17 at `/opt/homebrew/opt/postgresql@17/bin`. It starts an ephemeral server on a private Unix socket with TCP disabled, uses synthetic identities/content, applies the exact migration twice, stops the server, and deletes the fixture. It never reads a production connection string.

Latest completed checks: **30 Node tests (16 handler, 7 client, 1 actual React render, 6 admin-reader/callback) and 112 PostgreSQL checks passed**. They cover every current SupportModal category and the Vera idea alias, priorities, duplicate intake, transactional migration/intake rollback, concurrent admission caps, exact-ticket ownership/read pagination, protected actor labels, account-switch fencing, lost-receipt reconciliation and saved-draft recovery, service grants, 12 competing workers, expired claims, stale input/policy, explicit drafts, protected actor metadata (including malformed service-role inserts), the live-shaped legacy email guard, the exact signup-notifier reply predicate on legacy/current schema shapes and actual customer/automated messages, revoked/foreign mailboxes, pre-submission pauses/resolution, ambiguous/crashed sends, duplicate/out-of-order receipts, suppression, exact approval hashes, one-time execution, and revoked owner authority. PostgreSQL counts include helper assertions. The notifier passes `zsh -n` without being executed.

Scoped ESLint, TypeScript syntax transformation, and the full production frontend build also passed. The build retains existing Anthropic browser-external/chunk-size warnings. The Edge Function has not been deployed. The local environment has no Deno runtime, so runtime import resolution/JWKS/Svix/Resend integration remains a staging prerequisite. Handler tests inject verifiers and provider responses; PostgreSQL tests exercise actual SQL and concurrency against a representative current schema, not a live production clone.

Pilot reliability targets: every successful new intake has one canonical event and its intended jobs; zero duplicate publications in concurrent/replay tests; zero automatic resends from unknown state; zero mail to unverified/revoked bindings; all dead/unknown/escalated items visible within one scheduler interval; a receipt within two minutes and a supported answer/escalation within five minutes for at least 99% of controlled pilot cases. These are acceptance targets, not measured production service levels.
