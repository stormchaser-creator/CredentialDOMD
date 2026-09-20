> **Superseded by `SECURITY-LIMITED-LAUNCH-ROLLOUT-2026-09-19.md`.** Kept as the record of the 2026-09-18 plan. Its reference to `scripts/sql/runner-gate-dryrun.sql` is obsolete: PR11 moved the ticket queue out of the shell and that probe was removed.

# Security batch cutover runbook

**Batch:** `security/2026-09-15-batch`. **Independently reviewed at:** `d1df6981`.
**Written:** 2026-09-18. **Status: not executed.** Deployment is the owner's call.

## What this batch does and does not claim

It closes a set of measured defects: a ticket queue an ineligible account could
put text into, a forged operator reply, a verified mailbox that could be taken
by a stale provider event or kept by a deleted account, a send path that failed
open, and a monthly AI allowance that four successive implementations failed to
bound.

It does **not** deliver a hard spending cap, and no step below should be
described as switching one on. The allowance is reserved from Anthropic's own
count of each request plus a ten percent operational allowance. Anthropic
documents that count as an estimate and publishes no numeric error bound, so a
month can end fractionally over. The only provider-guaranteed bound is the
context window, which at roughly $6.25 to $9.45 per in-flight request would
make the $15 allowance admit two concurrent calls; that trade was declined and
is recorded in `supabase/functions/ai-proxy/limits.ts`. Scope is the non-admin
**shared Anthropic** route only: Gemini, admin accounts and physicians' own keys
are outside it, and it is not a company-wide provider budget.

## Measured starting state (2026-09-18, read from production)

| Fact | Value | Why it matters here |
| --- | --- | --- |
| `ai_usage` Anthropic rows, all time | **0** | Nothing to seed, nothing in flight |
| `ai_usage` Gemini rows | 24, last 2026-09-16, $0.063 | The table works; the zero above is real, not an unused table |
| `profiles` | 10 total, 6 active, 0 deleted | Blast radius is six accounts |
| Applied from this batch | **none** | `20260916a` (ticket approval) and `20260918b` (address history) are applied and are NOT part of this batch |

The first row is the single most important fact in this document. The reviewer's
standing requirement is to drain in-flight requests and reconcile historical
receipts before enabling paid admission, because a timestamp-inferred cutover
cannot prove a late receipt is represented by a hold. **There are no Anthropic
receipts and no Anthropic traffic to drain.** The reconciliation is therefore
trivially satisfied *today* and stops being satisfied the moment the shared
Anthropic route carries its first call. Re-run the check in step 0 immediately
before cutting over; do not rely on this table.

## External prerequisites (not code, cannot be done from this repo)

1. **Clerk is still on its development instance.** Sign-up is open to anyone.
   The admission gates in this batch are what make that survivable, not a
   substitute for the production instance. Moving to production Clerk rotates
   `auth_user_id` issuance and the webhook signing secret; doing it *after* this
   batch is deliberate, so the mailbox event path is already monotonic when
   identities change.
2. **A real-provider canary is required and has not been run.** Every Anthropic
   result in review came from synthetic fixtures. Unknown until a live call:
   actual `count_tokens` latency on the admission path, and whether returned
   `usage` matches the count closely enough for the ten percent allowance.
3. **`app_secrets.anthropic_shared_key` and `gemini_shared_key` are both set.**
   Verified present. Confirm the Anthropic key's own org-level spend limit in
   the Anthropic console is at or below what the owner is willing to lose, since
   nothing in this repo can enforce a ceiling the provider does not.
4. **`AI_BUDGET_HARD_USD` and `ANTHROPIC_DAILY_LIMIT`** are Supabase function
   secrets with defaults in code. Decide both values before deploying, not after.
5. **Owner decision on the allowance itself.** $15/month at the measured per-call
   costs in `docs/SCALE-AND-COST-PLAN-2026-09-02.md` section 4 (Vera turn $0.134
   typical, $0.234 large; RVU coder $0.019 to $0.121) is roughly 60 to 110 Opus
   calls a month across all users.

## Order, and why it is this order

Migrations before functions, because the new functions call RPCs that must
already exist. Within the migrations, `20260915f` carries `20260915c`'s
admission clause, so `c` before `f` and never `c` alone afterwards.

```
20260915a  lock_profile_insert
20260915c  ticket_admission
20260915d  verified_mailbox
20260915e  send_reservations
20260915f  ticket_update_and_attribution     (must follow c)
20260915g  ai_reservations
20260916b  mailbox_claims
20260916c  ai_spend_holds                    (seeds; see step 0)
20260918a  mailbox_account_events            (drops claim_mailbox/revoke_mailbox)
```

`20260916a` and `20260918b` are already applied; do not re-run them.

## Steps

**Step 0 — re-establish the cutover precondition.** Immediately before anything
else, re-run the Anthropic usage check. If it returns anything other than zero
rows, **stop**: the seed's timestamp inference is no longer sufficient and the
receipts must be reconciled against holds by hand first.

```sql
select count(*) as calls, min(created_at), max(created_at)
  from public.ai_usage
 where provider = 'anthropic'
   and created_at >= date_trunc('month', now() at time zone 'utc');
```

**Step 1 — dry-run the whole chain, rolled back.** Each of these applies real
migration files inside a transaction and ends in `rollback`:

- `scripts/sql/mailbox-tombstone-probe.sql` (36 assertions)
- `scripts/sql/ai-spend-seed-probe.sql` (5)
- `scripts/sql/runner-gate-dryrun.sql` (8)
- `scripts/sql/ticket-admission-dryrun.sql`, `mailbox-claims-dryrun.sql`,
  `mailbox-events-dryrun.sql`, `ai-and-send-ledger-dryrun.sql`, `ai-spend-dryrun.sql`

Any failure stops the cutover. These are the same probes the independent review
re-ran; a failure here means the live schema differs from the one they reviewed.

**Step 2 — apply the migrations in the order above**, one at a time, each
followed by re-reading the ledger probe so a partial apply is visible rather
than assumed.

**Step 3 — verify the schema, not the migration log.** After the chain:

- `public.account_tombstones` exists and has **no** foreign key to `profiles`
  (a cascade would delete the record at the moment it matters)
- `claim_mailbox` and `revoke_mailbox` are **gone**
- every function writing `public.mailbox_claims` contains `mailbox_domain_lock()`
- `messages_thread_insert`'s expression contains both `is_admin_reply` and
  `current_profile_active`
- `anon` and `authenticated` cannot execute the mutation RPCs

**Step 4 — deploy the edge functions.** Changed in this batch: `ai-proxy`,
`clerk-webhook`, `create-ticket`, `reply-ticket`, `delete-account`,
`email-inbound`, `forwarding-address`, `send-packet-email`,
`ticket-attachment-url`, and `_shared`. Deploy `_shared` consumers together;
`ai-proxy` **last**, so the ledger exists before anything reserves against it.

**Step 5 — the canary, with the owner watching.** One real Anthropic call
through the shared key from a non-admin account. Confirm, in order: a
`count_tokens` request precedes the paid request; one `ai_spend_holds` row
appears and then settles; `ai_usage` records a cost; the settled amount is at or
below the reservation. Record the count-versus-billed difference — that number
is the first real evidence about the ten percent allowance, and everything said
about the cap's tightness until now is synthetic.

**Step 6 — watch the first day.** `ai_spend_holds` rows that never settle mean a
path exits without settlement. Repeated `ai_token_count_unavailable` means the
counter is rate-limited or slow enough to matter, which is the most likely real
regression and is invisible in synthetic tests.

## Rollback

Functions roll back by redeploying the previous revision; that is the fast path
and should be taken first, because the schema is additive and safe to leave.

The migrations are not designed for rollback. `20260918a` drops
`claim_mailbox`/`revoke_mailbox`, so reverting to the old writers means
re-applying `20260916b`'s definitions; nothing calls them, so the practical
rollback is "redeploy the old functions and leave the new schema in place". The
one destructive-looking step is the `ai_spend_holds` seed, which only inserts.

## Limitations carried into production

1. The allowance is operational, not a guaranteed ceiling (above).
2. The seed's cutover is timestamp-inferred. It is exact only while step 0
   returns zero. The durable fix is to stamp each hold with the `ai_usage` row
   it settled, which is a live write-path change and is not in this batch.
3. Real-provider behaviour is unmeasured until step 5.
4. Gemini, admins and physicians' own keys are outside the allowance entirely.
