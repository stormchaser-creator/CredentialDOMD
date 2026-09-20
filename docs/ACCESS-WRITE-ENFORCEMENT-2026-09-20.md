# Backend product-write enforcement — staged, disabled

This source package closes browser/Storage and current service-intake write paths after free-beta expiry, and separates Credential writes from Practice writes. It does not enable rollout flags, create membership grants, send mail, deploy functions, or apply SQL to a live database.

## Changes

- The service-only `credentialdo_service_write_snapshot(profile, current_subject)` RPC validates the exact current, nondeleted profile binding. Historical lifetime, beta and trial evidence uses the separately sealed `continuity_owns_subject` relation. It never substitutes JWT claims. Service errors and malformed results fail closed.
- Additional restrictive INSERT/UPDATE policies cover the six substantive Credential collections omitted by the prior package. `share_log`, `notification_log` and `alert_acks` remain available for export/share, delivery and acknowledgement bookkeeping.
- Documents require both the original and proposed scope on UPDATE. Newly assigned non-null paths must identify that document and its proved current/historical owner. Metadata-only rows remain possible where a schema permits null; the reviewed production schema currently has `storage_path NOT NULL`, which this package does not alter.
- Document-object uploads and overwrites check every matching metadata alias. A foreign alias denies the operation. A protected `access_document_practice_paths` table retains Practice provenance when document metadata is deleted, preventing same-ID recreation from turning old Practice bytes into a Credential overwrite. The marker is monotonic for a path: once Practice, later byte writes require Practice even after an authorized unlink. No raw browser or service-role table grant permits forging/clearing markers.
- Markers cascade on hard profile deletion and are cleared on account tombstoning. Cleanup retries and migration reruns cannot recreate markers for deleted profiles. Existing SELECT/DELETE policies are untouched; no entitlement check rejects DELETE.
- Narrow service write triggers cover documents, peer references and new document requests. Existing request status/proposal/export UPDATEs remain available. Support ticket attachment paths keep their separate existing authorization.
- Profile updates distinguish read/display/notification preferences from substantive Credential settings and Practice tax settings. The guard uses the real database role, so a Clerk token lacking an explicit role claim cannot bypass it. Existing trusted account/grant activation and deletion remain separate.
- AI POST admission checks Credential capability before secrets, quotas or provider work; GET status is unchanged. CallSync checks Practice before its upstream fetch. Recognized inbound intake checks Credential before retrieving content or sending replies and again at current write boundaries. Forwarded support mail is outside this product gate. Unavailable policy data remains retryable; a terminal membership refusal only updates the inbound ledger.

## Ordering and activation boundary

The new migration is `20260920230000_access_write_enforcement.sql`. It requires the identity continuity migration, existing access foundation, limited-launch billing/history, and the coordinating agent's self-service/continuity-access migrations. Apply/review them in their recorded order before deploying consumers of the new RPC. Deploying consumers without their RPC makes paid operations unavailable by design.

Every new enforcement predicate/guard preserves existing behavior while `access_policy_settings.enforcement_enabled` is false. This migration contains no write to that configuration table, access grants, beta grants, invitations, billing settings or email holds. Private provenance bookkeeping does not activate an entitlement. The existing unconditional launch welcome/invitation email holds remain unchanged.

The generic AI proxy has no trusted server operation route distinguishing Vera from RVU prompts. This package gates shared paid AI at Credential; it cannot promise RVU-only computation separation from a caller-selected prompt. Practice persistence and CallSync are independently enforced. A trusted operation-specific AI contract would be a separate change.

The new SQL fixture tests a synthetic schema and an explicit continuity contract fixture. It does not replace the coordinating agent's full reconstructed-schema test with the real identity migration and existing profile locks, nor does it prove deployed Storage service role behavior. These remain integration/activation checks, not completed live operations.

## Local evidence, 2026-09-20

All tests below used synthetic data; no provider, credential, deployment or live database action ran.

| Command | Result |
| --- | --- |
| `node --test tests/access-policy/write-enforcement.test.mjs tests/access-policy/write-consumers.test.mjs` | 14 passed |
| `python3 tests/access-policy/postgres-write-enforcement.py` | 48 passed; disposable PostgreSQL 17, private Unix socket, no TCP listener |
| `node scripts/ai-spend-media.test.mjs` | 28 passed |
| `node scripts/send-throttle.test.mjs` | 474 passed |
| `git diff --check` | Clean |

The handler tests bundle the real AI, CallSync and inbound sources plus the real helper. Mocked I/O records attempted provider calls and content writes; denied requests make neither. The SQL tests apply the exact migration twice, compare existing ownership/read/delete policy definitions, and exercise missing/forged role claims, foreign aliases, old/new document scopes, metadata delete/recreate, service writes, support attachments, preferences, signup INSERT, trusted activation and account-deletion cleanup. The existing AI spending fixture supplies a verified synthetic subject and an explicit disabled-policy snapshot; the spending/counting assertions remain unchanged.

Reviewed source SHA256 values:

```text
66bf1a4ecb1ea48c536c3e7b7ba1f45f374ff44a9c6ab317989625eb5df2c439  supabase/migrations/20260920230000_access_write_enforcement.sql
93764c85006c998c5b1e6c4b7221c641e570eaadf18deee462c51700742f3309  supabase/functions/_shared/accessWrite.mjs
147d9894eabd127a5d945db4f143a30d21cafe9d3d8bb4e34d4a439ebf44b1a0  supabase/functions/ai-proxy/index.ts
f617a22e31eb236daf6aba4a8722a6736e6d3b3a7a46e8cfa49955f9c51533e5  supabase/functions/callsync-feed/index.ts
4d8aa96aa1581b47092b9ac12807d78e4b0eca7c60e5e4041d83389cd0d2571e  supabase/functions/email-inbound/index.ts
0dbae19d1baa6f7bbf643c9af0c4996edbbda28285748eef251b86b2d8461a6d  tests/access-policy/write-enforcement.test.mjs
54159b063bb5481ea702e3f333f7f3e7c3cb234362447b6e22c9b680bdc0e8a2  tests/access-policy/write-consumers.test.mjs
a55a8e1b0917f97db7e33556c03856ed6fe8f0040af3da9e9b96f313303382fa  tests/access-policy/postgres-write-enforcement.py
8f450ff14b75d25a667357117c4df2360b0cf8f19a314a38737300efc5126de9  scripts/ai-spend-media.test.mjs
```
