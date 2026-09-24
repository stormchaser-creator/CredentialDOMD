# CredentialDOMD administrative operations release

The administrative area now opens with a report based on database counts, provides searchable working lists with explicit coverage, and records account-access changes as atomic audited transactions. This addresses misleading totals, silently failed reads, and partially applied or falsely successful access changes found in the existing implementation.

## Included

- **Overview & reports:** 7/30/90 UTC calendar-day reports, including today's partial day; exact global account/profile and open-ticket snapshots; urgent and owner-approval queues; daily signup profiles, page loads, ticket creation and retained error reports. Every response includes schema version, generation time and explicit boundaries. Urgent/approval/active-account cards pass filters into the working lists.
- **Exports:** aggregate CSV from the exact displayed snapshot, with definitions, source limitations, interval and timestamps. Strict response validation, formula-safe cells, no personal data, and exports disabled while loading, failed or stale.
- **Working lists:** reads scoped to the selected section; deterministic paged loading; displayed loaded/total counts; account and ticket filters; visible failed reads and retry. Refresh keeps loaded components mounted so filters and action notices survive a successful refresh. Reactive server-sourced administrator status replaces the previous one-time snapshot.
- **Account and invitation controls:** reviewed confirmation dialog, 10–500 character reason, expected version/status/identity, duplicate-click protection, immutable request payload for retry, and exact server receipt validation. The server locks relevant rows and saves the action plus audit together. Self/admin/deleted/closed targets and changed identities are refused. Linked invitations are managed through their account.
- **Control history:** read-only recent audit entries, pagination, reasons, actor and target IDs, before/after state and receipt. Historical lifetime/billing ledgers retain their separate meanings.
- **Error triage:** other-build reports are no longer claimed to be fixed. Deletion requires confirmation and matching returned IDs; partial and failed operations remain visible and surviving reports remain on screen. Error groups support keyboard expansion.

## Definitions that matter

Account profiles are not verified physicians or paid memberships. Active administrative status alone does not prove product entitlement. New signup profiles require an identity and nonblank email, exclude administrators and deleted/closed accounts, and do not prove mailbox verification. Billing and lifetime controls keep their existing verification and entitlement rules.

Current open support includes unarchived open, in-progress and waiting-on-user tickets. Snapshot backlog is distinct from tickets created within the report interval. Page loads are recorded events, not unique visitors. Traffic uses the existing aggregate/legacy cutover without double counting. Existing seven-day pruning and manual deletion mean retained errors are not a complete 30/90-day incident history.

Search filters apply to **loaded** working records. Coverage and Load more are explicit; an exact overview count can exceed matching loaded detail records. This release does not pretend otherwise.

## Research and collaboration

[Research](RESEARCH-2026-09-24.md) connects concrete code findings to primary Supabase, OWASP, W3C and GOV.UK guidance. Claude was consulted through the existing configured OAuth connection using a general architecture question with tools, project context, hooks and MCP disabled. No repository code, customer data or credentials were supplied to the model. Its recommendations informed explicit report definitions, separate access/billing concepts, transactional auditing, immutable retries and conflict handling. Local source audits and testing were performed separately.

Do not revive the older `ADMIN-BACKEND-PLAN.md`: its sample pricing, auth model and client-only view gate are obsolete. The current implementation and reviewed policies in `AGENTS.md` govern.

## Backend contract and rollout

[Backend contract and validation](../reviews/2026-09-24-admin-operations-backend.md) documents RPC signatures, grants, audit schema and paired-release requirements. The migration is `supabase/migrations/20260924020000_admin_operations.sql`.

Source implementation and local verification are complete. **This is a draft release; the production migration and production UI deployment have not been performed.** No production read or write was used as a test.

Release sequence:

1. Apply the exact migration to the normal staging database, after the existing migrations. Confirm the three RPCs and history work through a real staging administrator's Clerk/Supabase identity; repeat denied reads/writes as an ordinary staging member.
2. Build the application with the existing environment. Test refresh, sign-out, report export, account pause/restore and audit replay on disposable staging accounts. The synthetic local browser preview verifies UI behavior but does not replace this identity/provider acceptance check.
3. Coordinate the database migration and app rollout. The migration intentionally revokes legacy unaudited write paths; cached old admin controls will fail closed until the client updates. Deploy the paired UI, require the operator to refresh, and verify report schema/version and successful history reads.
4. For recovery, keep the narrowed grants and audit ledger. Do not restore broad unaudited writes merely to support an old client. Roll forward with the repaired UI or temporarily disable affected admin controls. Existing checkout and email release gates are outside this release.

## Verification

- Full existing regression suite: 1,175 tests passed, zero failed/skipped, run serially to avoid the host's concurrent PostgreSQL shared-memory limit.
- Administrative PostgreSQL suite: 72 assertions on the exact migration and real preexisting identity, founding and profile guards; includes permissions, >500-row totals, dense UTC dates, rollback, stale versions, concurrency, replay and unchanged financial state.
- Administrative UI/helper tests cover failed and reordered reads, stale exports, CSV injection, bad receipts, duplicate writes, account unmount, error deletion receipts and preserved data.
- Production build and changed-file ESLint; browser inspection using only synthetic data.

Commands:

```sh
npm test
npm run test:admin-db
npm run build
```

For constrained local machines use `node --experimental-vm-modules --test --test-concurrency=1 'tests/**/*.test.mjs' 'scripts/*.test.mjs'`. The DB suite accepts `ADMIN_TEST_PG_BIN` or `PG_BIN`, otherwise discovers a local `initdb`. The deployment workflow runs it after the main tests when PostgreSQL is available.

## Next priorities

1. Server-side search and status/priority/archive filters before pagination; preserve shareable filter state. This will make every report queue immediately navigable at larger scale.
2. Replace other legacy optimistic lead/proposal/message mutations with confirmed writes and appropriate audit events. Those workflows are not covered by the new account-control audit ledger.
3. Add an incident acknowledgement/resolution ledger and retained daily aggregates before promising historical reliability trends; keep raw error payload retention short.
4. Build provider-backed billing reconciliation from actual invoices, refunds, current subscription prices and paid founding allocations. Define gross receipts, net receipts, annual recurring revenue and normalized monthly recurring revenue separately; never infer them from access status or legacy founding badges.
5. Introduce read-only support and scoped write roles when multiple operators need them, then saved reports and scheduled delivery. Defer bulk account changes, impersonation and a general report builder until single-account controls and report definitions have production evidence.
