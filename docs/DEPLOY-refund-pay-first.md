# Deploy: pay first, and Cancel and get a refund

Branch `feat/pay-first-refund`. This is the order to ship it in, the check to
run after each step, what to watch in the first hour, what Stripe must allow
and send, and how to undo each step. It holds no production counts, customer
data or secrets. Every database check below is a read (`select`), run in the
Supabase SQL editor or through the Management API.

Project ref: `hkpnnsjcwprrwobmpqyy`. Functions deploy with `--no-verify-jwt`
like every other function here: the handlers verify Clerk themselves, and the
refund sweep arrives from pg_net with the hook secret and no Supabase JWT.

## What ships

| Piece | What it is |
|---|---|
| `20260930070000_limited_refunds.sql` | The refund ledger `limited_refund_requests` and its functions (claim, lease, record, confirm, update, for_subscription). |
| `20260930071000_limited_refund_support_tickets.sql` | A trigger that opens one billing ticket in the member's name when a refund needs a person (reopened only when where the refund stands changes), and a guard on `support_tickets` so only that trigger writes such a ticket's text, which the app labels as from CredentialDOMD Support. |
| `20260930072000_limited_refund_sweep.sql` | `limited_refund_stalled`, `dispatch_limited_refund_sweep` and the pg_cron job `limited-refund-sweep` (every 10 minutes) that finishes refunds nobody presses again. |
| Edge functions | New `limited-refund`. Rebuilt from the changed shared modules (`limitedLaunchHandlers.mjs`, `limitedLaunchDependencies.ts`): `limited-stripe-webhook`, `limited-checkout`, `billing-quote`, `limited-customer-portal`, `activate-billing-invitation`. |
| App | Pay first on sign up; Cancel and get a refund in Profile and on Cancel Subscription. Ships by merging to `main` (`deploy-gh-pages.yml`). |
| Owner notifier | `scripts/signup-notify.py` / `.sh` on the Studio: REFUND NEEDS SUPPORT and REFUND UNFINISHED lines. |
| Stripe | Four refund events on the webhook endpoint, and the key permissions below. |

## Stripe: permissions and webhook events

### Restricted key used by the edge functions (`STRIPE_SECRET_KEY`)

Every call the limited billing functions make, by resource:

| Resource | Access | Used for |
|---|---|---|
| Charges | Read (Write is fine) | Reading the refunded charge (`charges.retrieve`). |
| Refunds | Write | `refunds.create`, `refunds.list`, `refunds.retrieve`. |
| Subscriptions | Write | `subscriptions.cancel` (the refund), `retrieve`, `list`. |
| Invoices | Read | `invoices.retrieve`, and `invoices.list` (new: the last paid invoice while a renewal is only drafted or unpaid). |
| Customers | Write | `customers.create`, `retrieve` at checkout. |
| Checkout Sessions | Write | `create`, `retrieve`, `list`, `expire`. |
| Prices, Products | Read | The pinned catalog price at checkout. |
| Customer portal | Write | `billingPortal.sessions.create`; configuration read. |
| Invoice Items | Read | The historical v1 webhook path only. |

Charges, Refunds and Subscriptions are confirmed Write on the key named
"CredentialDOMD production billing". Confirm the rest in the Stripe dashboard
(Developers, API keys, the key, Permissions) before step 1. The new code needs
nothing beyond Read on Invoices that the old code did not already need
(`invoices.retrieve` was already in use).

### Webhook endpoint (`.../functions/v1/limited-stripe-webhook`)

The endpoint uses an explicit event selection. It must send all of these, in
test and in live:

- Already required: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
- New and required: `charge.refunded`, `charge.refund.updated`.
- New, sent only on newer API versions (add them if the dashboard offers them): `refund.updated`, `refund.failed`.

Without the refund events a refund that fails after Stripe accepted it keeps
reading "on its way" in Profile and never reaches `needs_support`, and a
dashboard refund of a request that stopped before its cancellation does not
cancel the subscription. The button has no separate switch: it shows to every
paid member the moment the app ships, so the events go in first (step 0).

## Before you start

1. The branch is green: `LC_ALL=C PG_BIN="$(pg_config --bindir)" npm test` and `npm run build`.
2. The hook secret exists in the vault (name only, never the value):
   `select exists (select 1 from vault.secrets where name = 'welcome_hook_secret');` answers `true`.
   The functions have `WELCOME_HOOK_SECRET` set (`supabase secrets list --project-ref hkpnnsjcwprrwobmpqyy` shows the name).
3. pg_cron and pg_net are in use: `select jobname, active from cron.job where jobname = 'welcome-email-sweep';` answers one active row.
4. Rehearse once in the QA lab (mock Stripe): a paid sign up, Cancel and get a refund, a refund stopped after the cancellation that the sweep then finishes, and a second device during settlement ("Your checkout is being confirmed").

## Deploy order

Each step has a smoke check. Stop at the first one that fails and take that
step's rollback.

### Step 0. Stripe events, test and live

Add the events above to the test endpoint and to the live endpoint. Then check
each mode read-only with a key that can read Webhook Endpoints:

```sh
STRIPE_PREFLIGHT_KEY=<test key> node scripts/stripe-refund-events-preflight.mjs
STRIPE_PREFLIGHT_KEY=<live key> node scripts/stripe-refund-events-preflight.mjs
```

Smoke: both exit 0 and list one enabled endpoint with `"missing": []`.
Rollback: none needed. The old webhook answers 200 to event types it does not
handle, so the extra events are harmless if everything else is rolled back.

### Step 1. The three migrations

They are additive and inert until the functions ship: the old functions never
call them, the trigger fires only on ledger writes, and the sweep's calls
answer 404 until `limited-refund` exists (step 3).

```sh
supabase db push --dry-run --project-ref hkpnnsjcwprrwobmpqyy   # must list exactly the three files above
supabase db push --project-ref hkpnnsjcwprrwobmpqyy
```

If the dry run lists anything else, stop and apply only these three, in
order, in the SQL editor.

Smoke:

```sql
select to_regclass('public.limited_refund_requests') is not null;                          -- true
select count(*) from pg_proc where proname like 'limited_refund_%';                          -- 11
select has_function_privilege('anon', 'public.limited_refund_claim(uuid,text,boolean,jsonb)', 'execute');          -- false
select has_function_privilege('service_role', 'public.limited_refund_for_subscription(uuid,boolean,text)', 'execute'); -- true
select tgname from pg_trigger where tgrelid = 'public.limited_refund_requests'::regclass and not tgisinternal;       -- limited_refund_support_ticket
select tgname from pg_trigger where tgrelid = 'public.support_tickets'::regclass and tgname = 'limited_refund_ticket_guard'; -- one row
select jobname, schedule, active from cron.job where jobname = 'limited-refund-sweep';     -- one active row, 5,15,...,55
```

Rollback: the three rollback files in reverse order (see Rollback).

### Step 2. `limited-stripe-webhook`

```sh
supabase functions deploy limited-stripe-webhook --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy
```

Smoke: in the Stripe dashboard (live endpoint), resend one recent delivered
event such as `invoice.paid`: it answers 200. The function logs show no boot
error and no `limited_billing_failure` with phase `config`. The welcome email
sweep still answers 200 on its next run (every 10 minutes).
Rollback: redeploy the previous version (see Rollback).

### Step 3. `limited-refund`

```sh
supabase functions deploy limited-refund --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy
```

Smoke, with no credentials:

```sh
curl -s -X POST https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/limited-refund -H 'content-type: application/json' -d '{"action":"status"}'
# {"error":"unauthorized"}
curl -s -X POST https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/limited-refund -H 'x-hook-secret: not-the-secret' -d '{}'
# {"error":"not_authorized"}
```

Then within 10 minutes the sweep's own call succeeds:

```sql
select status, return_message from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'limited-refund-sweep')
 order by start_time desc limit 3;                                          -- succeeded
```

and the function's invocation log shows a 200 for it (a run with nothing to do
writes no log line).
Rollback: `supabase functions delete limited-refund --project-ref hkpnnsjcwprrwobmpqyy`, and unschedule the sweep with the sweep rollback.

### Step 4. `limited-checkout`, `billing-quote`, `limited-customer-portal`, `activate-billing-invitation`

```sh
for f in limited-checkout billing-quote limited-customer-portal activate-billing-invitation; do
  supabase functions deploy "$f" --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy
done
```

Smoke: each answers `{"error":"unauthorized"}` (or its route's usual refusal)
to an unauthenticated POST, and the logs show no `limited_billing_failure`
with code `billing_unavailable` and phase `refund` (that would mean
`limited-checkout` cannot read the ledger). On the live site, signed in, the
membership card still loads.
Rollback: redeploy the previous versions of these four.

### Step 5. The app

Merge the branch to `main`; `deploy-gh-pages.yml` builds and publishes it.

Smoke: the workflow is green and the published bundle carries the new copy:

```sh
curl -s https://credentialdomd.com/app/ | grep -o 'assets/[^"]*\.js' | head -1   # then fetch it and grep
# "Cancel and get a refund" and "Complete your payment to open your account" are present
```

In the app, signed in as the owner: Profile loads; a lifetime or gifted
account shows no refund button. The sign up page for a new account goes
straight to the offer review.
Rollback: revert the merge on `main` (the workflow redeploys the previous app).

### Step 6. The owner notifier

Update the checkout the Studio's launchd job runs `scripts/signup-notify.sh`
from, then run it once by hand.

Smoke: it exits 0 and prints no "is not reported until the notifier matches
its columns" line for `limited_refund_requests`.
Rollback: restore the previous script; its table probe is tolerant either way.

## The first hour

Watch these; each has a fixed code and no ids.

- Edge function logs (`limited-refund`, `limited-checkout`, `billing-quote`, `limited-stripe-webhook`):
  - `refund_needs_support`, `refund_retryable`, `refund_settlement_deferred`: a refund that needs a person, or will be retried.
  - `limited_refund_sweep` with outcomes other than `refunded`: the sweep met something it could not finish (`refund_pending` is retried, `refund_needs_support` went to a person).
  - `refund_without_request`: a full refund was made in the dashboard for a membership that still renews. Cancel that subscription in the dashboard if that was the intent.
  - `limited_billing_failure` with code `billing_unavailable` on `limited-checkout` or `billing-quote`: stop and look before anything else.
  - `checkout_awaiting_settlement` answers: expected now and then (a second device during settlement); many in a row mean the webhook is not settling.
- Stripe dashboard: the webhook endpoint's failed deliveries (any `charge.refunded` or `charge.refund.updated` failing), and the Refunds list against the app's records.
- Database (reads):

  ```sql
  select state, subscription_canceled_at is not null as cancelled, count(*)
    from limited_refund_requests where livemode group by 1, 2;
  select count(*) from limited_refund_requests
   where livemode and state = 'requested' and requested_at < now() - interval '30 minutes';   -- 0 expected
  select status, start_time from cron.job_run_details
   where jobid = (select jobid from cron.job where jobname = 'limited-refund-sweep')
   order by start_time desc limit 6;                                                          -- succeeded
  ```

- Owner notifier lines `REFUND NEEDS SUPPORT` and `REFUND UNFINISHED`, and auto opened billing tickets in Admin > Tickets
  (shown as "CredentialDOMD (automatic) for" the member). A `REFUND NEEDS SUPPORT` line that says "not cancelled yet"
  (the sweep gave up after 12 attempts and 2 hours, or a dispute was found before the cancellation) means the membership
  still renews. First open the subscription in Stripe and compare its most recent paid invoice with the row's payment
  (`invoice_id`):
  - Still the row's payment: when the refund is owed, refund that charge in full in the Stripe dashboard, and the
    `charge.refunded` event cancels and settles the subscription too (the request goes back to requested for it).
  - A renewal was paid since (the code is `refund_payment_changed`, or any "not cancelled yet" row that waited past a
    renewal date): when the refund is owed, refund the RENEWAL's charge (the subscription's most recent paid invoice)
    in full in the Stripe dashboard, and do NOT cancel the subscription by hand. The `charge.refunded` event moves the
    request to that payment (`limited_refund_adopt`), cancels and settles the subscription, records the refund, and
    resolves the member's ticket; the member's Profile then reads refunded. Check afterwards that the row is
    `refunded` with the renewal's `charge_id` and the subscription shows cancelled. Do not refund the row's own
    (older) charge here: that refunds last year's payment, the row goes to `refunded_payment_not_latest`, and the
    request never moves to the renewal after that (neither the sweep nor a press refunds a second payment, and a
    dashboard refund of the renewal does not move it either: it is logged as `refund_without_request` and the row
    keeps the older refund; reconcile both by hand). A
    subscription cancelled by hand first is not moved: the row keeps saying "not cancelled yet" and the ticket has
    to be answered by hand. The sweep itself moves a request to a paid renewal before it cancels
    (`limited_refund_follow`), so this is only a request it could not move.
  Check the subscription shows cancelled afterwards either way. For a disputed charge, answer the dispute first; the
  ticket promises the member nothing (nor does it for `refund_payment_changed`, `subscription_mismatch` or
  `charge_missing`).
- New sign ups: pending accounts reach Stripe Checkout, and a paid one turns active within a minute.

## Rollback

Undo in reverse order, and only as far as needed. The ledger's own rollback
comes last and only after everything that calls it is gone, or live checkout
breaks.

1. **App.** Revert the merge on `main`. Smoke: the published bundle no longer contains "Cancel and get a refund".
2. **Owner notifier.** Restore the previous script. Smoke: one manual run exits 0.
3. **Sweep.** Run `docs/rollback/20260930072000_limited_refund_sweep.rollback.sql` as postgres. Smoke: `select count(*) from cron.job where jobname = 'limited-refund-sweep';` answers 0.
4. **Edge functions.** Redeploy, from the commit before the merge, every function built from the changed shared modules: `limited-checkout`, `billing-quote`, `limited-customer-portal`, `activate-billing-invitation`, `limited-stripe-webhook`. Then `supabase functions delete limited-refund --project-ref hkpnnsjcwprrwobmpqyy`. Smoke: a POST to `limited-refund` answers 404; checkout still opens for a pending account in test mode.
5. **Tickets.** Run `docs/rollback/20260930071000_limited_refund_support_tickets.rollback.sql`. Tickets already opened stay (they are the member's conversation) and become ordinary tickets: the guard on `support_tickets` goes too. Smoke: both trigger queries in step 1 answer no row.
6. **Ledger.** Run `docs/rollback/20260930070000_limited_refunds.rollback.sql`. It refuses while any live refund is recorded: export those rows first and decide what to keep. Smoke: `select to_regclass('public.limited_refund_requests');` answers null. (The new `limited-checkout` reads a missing refund function as "no unfinished refund", so a rollback run out of order does not stop checkout, but follow the order.)
7. **Stripe.** The refund events may stay on the endpoint (the old webhook answers 200 and ignores them). Key permissions need no change.

## Why the order

- Stripe events before anything a member can press, because the button has no switch and the refund safety depends on those events.
- Migrations before functions, because the new `limited-checkout` and webhook call the ledger functions.
- `limited-refund` before the app, because the app's button calls it; the webhook first among the functions, so a refund made in the dashboard during the rollout is recorded.
- The app last, because it is the only piece a member sees.
