# One step, pay first sign-up

Owner decision (Eric, 2026-11-20): "I want a one step build." A visitor taps **Sign up**,
pays $99 in Stripe Checkout, and comes back signed in. The account is made after the
payment, from the email Stripe collected. Everything new is **off**; login-first sign-up
stays the default and the fallback.

## Flags (both must be on)

| Flag | Where | Default |
|---|---|---|
| `access_policy_settings.pay_first_signup_enabled` | database | `false` |
| `VITE_PAY_FIRST_SIGNUP_ENABLED` | site build | unset (off) |

Either off: the sign-in screen is exactly as today. If the build has it on and the
database does not, the first **Sign up** tap is refused (`signup_disabled`) and the screen
turns back to login first at once.

## How it works

1. **Start** (`public-signup-checkout`, no sign-in): `hold_pay_first_founding` holds one
   founding place under lock 8222 (the lock every claim and settlement takes), with rate
   limits inside the lock, then Checkout opens (`flow: 'pay_first'`, Terms tick,
   the reviewed renewal terms as the submit text, 2 hours, no recovery link).
2. **Provision** (one function, four callers: webhook, the payer's return, a 5-minute
   sweep, Admin > Accounts **Finish paid sign-up**): lease per hold, fresh Stripe read
   (complete, paid, Terms accepted, matching app/catalog/mode), Clerk lookup before any
   create, `initializeProductionProfile` (as `clerk-webhook`), `adopt_pay_first_signup`
   (the unchanged bootstrap, preview, claim, pin and save), Stripe metadata under
   idempotency keys, then the webhook's own `settleSubscription`.
3. **Sign in**: the paying browser holds a nonce (only its sha256 left the browser); with
   it, `public-signup-status` mints a one-use Clerk sign-in token (600 s) for 15 minutes
   from the first one. Everyone else logs in with the email code.
4. **docs@**: an account made from a Stripe-typed email files nothing until its owner signs
   in once with the email code (`pay_first_email_unproven`).

Pay-first events that arrive before the account exists answer 503, so Stripe sends them
again (for up to 3 days); the sweep and the return page finish the job anyway.

## Deploy order (Eric / Codex; nothing here was deployed)

1. Migration `20261120190000_pay_first_signup.sql` (flag column default off).
2. Functions: `public-signup-checkout` and `public-signup-status` (both `--no-verify-jwt`),
   `limited-stripe-webhook`, `email-inbound`, `owner-notify`.
3. Stripe Dashboard (test, then live): **set a Terms of Service URL in Public details**
   (`https://credentialdomd.com/terms`). Stripe's docs require it for the Terms checkbox
   (`consent_collection.terms_of_service`); without it **Sign up** fails to open Checkout.
   Add `charge.dispute.created` to the webhook endpoint's events for the dispute alert.
   `checkout.session.completed` and `checkout.session.expired` are already sent.
4. Site build with `VITE_PAY_FIRST_SIGNUP_ENABLED=true`.
5. Turn on the database flag in **test mode**, run `qa-lab/e2e/pay-first-signup.spec.mjs`,
   Eric approves, then live.

## Rollback

1. `update access_policy_settings set pay_first_signup_enabled=false where singleton;`
   Login first resumes at once.
2. Leave the functions and the sweep deployed until Admin > Accounts shows no paid sign-up
   to finish.
3. Revert the site build.
4. `docs/rollback/20261120190000_pay_first_signup.rollback.sql` (refuses while any hold is
   paid but unfinished, or still open).
