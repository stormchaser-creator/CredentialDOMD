# Security integration for the limited launch: rollout list and evidence

**Branch:** `codex/security-limited-launch`, cut from `main` at `a9e38951`.
**Source of the security work:** `security/2026-09-15-batch` at `43294226`
(independently reviewed through `d1df6981`; the three-file delta after that review
is described below).
**Status: integrated and tested in source. Nothing here has been pushed,
deployed, or applied to production.** Deployment is the owner's call, coordinated
by root. This document supersedes `SECURITY-BATCH-CUTOVER-2026-09-18.md`.

## Owner rules in force while this rolls out

- **New launch/email content remains owner-reviewed.** Current welcome and
  invitation email holds remain in place. This source integration sends no
  emails. Five functions in this batch can send or trigger mail:
  `email-inbound`, `forwarding-address`, `reply-ticket`, `send-packet-email`,
  and the `_shared` helpers they use. Deploying them sends nothing by itself.
  Do not pair any deploy with a test trigger, a confirmation resend, or a
  ticket reply.
- Billing, retrieval and SMS stay OFF. This batch changes no price, no plan,
  no lifetime-access promise and no sender gate.
- No blanket claim of a hard spending cap. See "What the AI allowance is".

## What is in, what is deliberately out

**In:** ten migrations (below); seventeen edge-function files across `ai-proxy`,
`clerk-webhook`, `create-ticket`, `reply-ticket`, `delete-account`,
`email-inbound`, `forwarding-address`, `send-packet-email`,
`ticket-attachment-url` and `_shared`; the client half (export redaction of
device-only secrets, per-user device-key scoping, server-derived admin status,
verified-mailbox sender lists, local-only settings preserved across cloud
merges); fifteen security test suites and seven SQL probes.

**Out, on purpose:**
- *Schedule work.* The security branch carried `workPay.js`, a rewritten
  `forecast.js` and `Forecast.jsx`, and two suites. Main fixed the same defect
  its own way (`dcd10ba6`, `316d96d1`, PR6). `WorkLog.jsx`, `billing.js`,
  `forecast.js` and `Forecast.jsx` are byte-identical to main here.
- *The shell runner gate.* PR11 moved the ticket queue out of the shell into
  `scripts/ticket-agent-context.mjs` behind one `APPROVED` rule. The branch's
  `ELIGIBLE`/`GATE` shell clauses were resolved to main's side, and
  `scripts/sql/runner-gate-dryrun.sql` was removed because it tested a clause
  that no longer exists. Eligibility is now enforced where the row is written
  (`20260915c`, `20260915f`).
- Address history (its own branch) and the deploy-script fix (below).

Byte-identical to main, verified: `landing/index.html`, `geminiModel.js`,
`assistant.js`, `ticket-agent.sh`, `ticket-agent-context.mjs`,
`ticket-agent-prompt.md`, `WorkLog.jsx`, `billing.js`, `forecast.js`,
`beta.js`, `billingCatalog.mjs`.

## The delta after the last independent review (`d1df6981..43294226`)

1. `20260918a` now **drops** `claim_mailbox` and `revoke_mailbox`. They do not
   take the mailbox domain lock, so running them beside the three new functions
   would reintroduce the deadlock. Nothing in `supabase/functions` or `src`
   calls them. **Consequence for review:** the reviewers' `d1df6981` harness
   seeds its fixtures through `claim_mailbox` (via its Node mailbox probe), so
   it cannot run against this tree until it moves to `apply_account_mailbox`.
2. `countedInputTokens` returns null unless the post-margin value is still a
   safe integer.
3. The cutover runbook (superseded by this file).

## Migration order

Migrations before functions. `20260915f` carries `20260915c`'s admission
clause, so `c` before `f`, and never `c` alone afterwards.

```
20260915a  lock_profile_insert
20260915b  ticket_attachment_paths
20260915c  ticket_admission
20260915d  verified_mailbox
20260915e  send_reservations
20260915f  ticket_update_and_attribution     (must follow c)
20260915g  ai_reservations
20260916b  mailbox_claims
20260916c  ai_spend_holds                    (seeds; see precondition)
20260918a  mailbox_account_events            (drops claim_mailbox / revoke_mailbox)
```

`20260916a` (ticket approval) and `20260918b` (address history) were already
applied when last checked on 2026-09-18 and are not part of this list.

## Precondition that must be re-read from production, not from this file

The spend seed infers its cutover from a timestamp. It is exact only while
**this month has no shared-key Anthropic usage that lacks a hold.** On
2026-09-18 `ai_usage` held zero Anthropic rows, all time (controlled against 24
Gemini rows). **That reading was not repeated for this integration, because no
production access was used.** Whoever runs the cutover re-runs it first:

```sql
select count(*), min(created_at), max(created_at) from public.ai_usage
 where provider = 'anthropic'
   and created_at >= date_trunc('month', now() at time zone 'utc');
```

Anything other than zero means drain in-flight calls or reconcile receipts
against holds by hand before enabling paid admission.

## Read-only verification after the migrations

- exactly **one** permissive policy per command on `support_tickets` and
  `support_messages`. `20260915f` recreates `tickets_owner_or_admin_update`;
  any *other* permissive UPDATE policy ORs with it and reopens the hole. (A
  hand-written test baseline with a differently named policy demonstrated
  exactly this.)
- `account_tombstones` exists with **no** foreign key to `profiles`
- `claim_mailbox` and `revoke_mailbox` are gone
- every function writing `mailbox_claims` contains `mailbox_domain_lock()`
- the nine mutation RPCs are executable by `service_role` only

## Function deploy order

`_shared` consumers together; mail-capable functions under the owner rule
above; **`ai-proxy` last**, so the ledger exists before anything reserves
against it. All Clerk-authenticated functions deploy with `--no-verify-jwt`.

## Canary, with the owner watching

One real shared-key Anthropic call from a non-admin account. Confirm in order:
a `count_tokens` request precedes the paid request; one `ai_spend_holds` row
appears and settles; `ai_usage` records a cost; settled is at or below reserved.
Record count versus billed: it is the first real evidence about the ten percent
allowance. **This canary has never been run.** It sends no email.

## Rollback

Redeploy the previous function revisions first; the schema is additive and safe
to leave. The migrations are not designed for rollback. `20260918a` drops two
functions nothing calls, so the practical rollback is "old functions, new
schema". The spend seed only inserts.

## What the AI allowance is

Every admitted request is priced from Anthropic's own count of that request,
built from the same object that is sent, plus ten percent, plus the full
`max_tokens` at the output rate. Anthropic documents the count as an estimate
with no numeric error bound, so this is an operational allowance and a month
can end fractionally over. Scope is the non-admin shared Anthropic route only.

## Evidence, and what kind of evidence it is

**Source tests (this tree):** 83 suites green, 3 red; the same three are red
on pristine `main` (missing built portal assets and a sandboxed `pg_ctl` path),
so no failure is caused by this integration. 32 edge functions bundle, Vite
build clean, ESLint 46 errors against main's 50.

**Disposable PostgreSQL 17.9** (local throwaway cluster, private Unix socket,
TCP disabled, hand-written minimal baseline, synthetic identities, rolled back
or discarded). **This is not the production schema and these are not live
results.**
- all ten security migrations apply in order
- mailbox tombstone, domain lock, crossed transfer: 36 of 36
- AI spend ledger: 37 of 37; AI and send reservations: 15 of 15; seed rerun: 5 of 5
- ticket admission and attribution: 14 of 15; the miss is the negative control
  that expects the pre-`15f` hole to be open, which it cannot be once `15f` is
  applied
- nine mutation RPCs: `anon` false, `authenticated` false, `service_role` true
- **two real sessions, crossed transfer** (A owns X, B owns Y, A takes Y while
  B takes X): both `claimed`, the second session waited 2.3 s on the domain
  lock, zero deadlock errors, final state correct
- twelve simultaneous confirmations of one token: 1 `confirmed`, 11
  `already_confirmed`

**Finding from building that cluster:** the repo cannot rebuild production from
its own migrations. From an empty database with a Supabase shim, 24 of 79
migrations fail on objects created outside the chain (`beta_access`,
`app_admins`, `early_access_leads`, `inbound_emails`, `storage.*`, `pg_cron`).
That limits review fidelity and is a recovery gap in its own right.

## Known limitations and open items

1. Real-provider behaviour is unmeasured until the canary.
2. Seed cutover is timestamp-inferred; the durable fix stamps each hold with the
   usage row it settled.
3. PR11's `historySQL` and `messagesSQL` are scoped to the approved ticket's
   owner, not to `APPROVED`. Approving one ticket therefore brings that
   customer's other ticket text into the agent's context as history. Bounded by
   `20260915c` once applied (only active accounts can file), and by design, but
   worth a conscious decision.
4. **For payment specifically:** `fix/deploy-clerk-billing-functions` at
   `9bc20f5d` is not in this branch. Without it neither deploy script deploys
   `create-checkout-session`, `customer-portal` or `stripe-webhook` with
   `--no-verify-jwt`, and the first checkout 401s at the gateway.
5. Clerk is still on its development instance.
