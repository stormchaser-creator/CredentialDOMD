# Limit the account-closure probe to its supported callers

The production catalog showed that `account_is_closed(uuid)` retained direct `anon` and `authenticated` execution grants from Supabase's public-schema defaults. The original mailbox migration revoked `PUBLIC`, which does not remove those direct grants. A caller with a profile UUID could therefore ask whether it was tombstoned or marked deleted.

`20260921015000_restrict_closed_account_probe.sql` explicitly revokes all three untrusted execution paths and preserves `postgres` and `service_role`. It does not change the function body, any account record, or a rollout switch.

The live catalog identified eight callers: six are `SECURITY DEFINER` functions owned by `postgres`; `apply_account_mailbox` and `confirm_forwarding_claim` are `SECURITY INVOKER` but already callable only by the privileged service path. No RLS policy calls the probe directly. The authenticated storage policy calls `owns_continuity_document`, whose definer ownership preserves the nested check. No browser direct RPC caller was found.

Verification passed 63 tracked PostgreSQL checks (including six new permission regressions) and 14 checks against the reconstructed production schema. It uses the observed Supabase default grants in a disposable PostgreSQL reconstruction, direct anonymous/authenticated denial, retained service access, and supported mailbox/continuity/admin/storage callers. The corrected deferred-billing apply packet pins the actual pre-change catalog and verifies the exact post-change permissions while preserving protected data and all four disabled rollout switches. The previous rejected packet remains archived; it is not edited or weakened.
