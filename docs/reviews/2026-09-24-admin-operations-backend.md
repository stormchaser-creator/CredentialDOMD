# Administrative operations backend

Source changes are staged in `20260924020000_admin_operations.sql`. They have been executed against disposable local PostgreSQL with synthetic data. Production schema, deployment, and customer behavior have not been verified.

## Reporting contract

`admin_operations_report(p_days integer default 30)` accepts only 7, 30, or 90. It returns:

```json
{
  "schema_version": 1,
  "generated_at": "ISO timestamp",
  "period_start": "UTC midnight N-1 days ago",
  "period_end": "same instant as generated_at",
  "days": 30,
  "accounts": { "total": 0, "active": 0, "new_in_period": 0 },
  "support": { "open": 0, "urgent": 0, "waiting_approval": 0, "oldest_open_at": null },
  "errors": { "in_period": 0 },
  "daily": [{ "day": "YYYY-MM-DD", "signups": 0, "page_views": 0, "tickets": 0, "errors": 0 }]
}
```

Counts are calculated in the database independently of list page sizes. Global profile totals exclude deleted/tombstoned accounts; the active count is account status and does not establish paid membership. Signup profiles also require an auth identity and nonblank email and exclude administrator accounts. They do not prove completed mailbox verification. Daily signup rows and the period aggregate use the same predicate.

Support snapshot counts cover unarchived `open`, `in_progress`, and `waiting_user` tickets. Urgent is a subset of that queue; waiting approval means a non-admin owner and no agent approval. Daily ticket creation includes all statuses. Page views combine aggregate counters with legacy raw rows only before the counter cutover, avoiding overlapping source counts. Page loads are not unique visitors.

Error counts reflect retained rows, not a complete historical incident count. Existing seven-day pruning and manual deletion remain; longer report windows must disclose incomplete error history. All timestamped period metrics use `[period_start, period_end)` and dense UTC calendar days. Recorded daily page counters have date granularity.

## Control contracts

`admin_change_profile_access(p_profile_id uuid, p_status text, p_expected_status text, p_expected_updated_at timestamptz, p_expected_subject text, p_reason text, p_request_id uuid)` accepts `pending`, `active`, or `revoked` and returns `{audit_id, duplicate, profile:{id, access_status, updated_at}}`.

`admin_change_invite(p_invite_id uuid, p_action text, p_status text, p_expected_status text, p_expected_updated_at timestamptz, p_expected_profile_id uuid, p_reason text, p_request_id uuid)` accepts `set_status` (`invited` or `revoked`) or `remove` (null status), returning `{audit_id, duplicate, invite:{id,status,updated_at}|null}`. Linked or historically activated invitations must be managed from their account; removing or changing them here is refused.

Both functions require a trimmed 10–500 character reason, a UUID request ID, and expected state. Identity/version conflicts use SQLSTATE `40001`; permission failures use `42501`; validation uses `22023`. Retry uncertain outcomes with the identical request ID and unchanged payload. A duplicate returns the original committed result. A changed payload or actor cannot reuse an earlier ID. A new review after a conflict requires current server state and a new ID.

The actor comes from the verified current profile and active administrator membership. Targets that are administrators, self, deleted, closed, or relinked are protected. Profile and linked-invite changes are atomic, and linkage is by protected profile ID, never editable email. Existing identity and membership triggers are retained. The access-grant flag covers existing legacy founding triggers, is restored afterward, and the returned profile version is read after those triggers finish.

Account restriction does not cancel renewal, charge/refund money, modify a lifetime grant, or create a paid entitlement. Existing legacy founding badges can still be assigned by their established activation trigger; those badges are distinct from the authoritative paid founding capacity ledger.

## Audit and grants

`admin_operations_audit` exposes `id`, `request_id`, `actor_profile_id`, `target_profile_id`, `invite_id`, `action`, `reason`, `before_state`, `after_state`, `created_at`, and internal replay hash/result. Administrators can read it with RLS; browser and service-role writes are denied. The narrow definer functions write it in the same transaction as the action. Rows intentionally have no cascading profile/invite foreign keys so evidence survives later account deletion. Audit state excludes email, ticket bodies, provider proofs, and credentials.

The old two-argument `admin_set_access` execute grant and direct browser `beta_access` writes are revoked. The blanket administrator update policy on arbitrary customer profiles is removed. Owner profile policies remain. Service-role invite provisioning and the existing definer self-claim function retain access. New RPC search paths are empty and object names are qualified; default PUBLIC/anon/service-role execute grants are explicitly removed.

## Validation and release notes

`python3 tests/admin-operations/postgres-operations.py` passed 72 assertions on PostgreSQL 17. It creates a temporary private socket, uses synthetic records, and stops/removes its database. `ADMIN_TEST_PG_BIN` can select another installed PostgreSQL bin directory. The suite executes the exact new migration twice, the real existing identity/founding/profile-enforcement trigger SQL, and tests authorization, row-cap independence, UTC boundaries, audit tamper protection, rollback, stale versions, concurrent conflicts, idempotent replay, and financial-state preservation.

This migration and the new admin UI are a paired release: old client controls lose their previous unaudited write paths. Verify the new UI against a staging database before applying production SQL, coordinate client rollout, and retain the audited write paths when rolling UI changes back. Restoring broad grants would undo the security property. Do not modify checkout, mail, automation, trial, lifetime, or identity-continuity gates as part of this release.
