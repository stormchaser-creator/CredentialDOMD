# One step, pay first sign-up

Owner decisions (Eric): 2026-11-20 "I want a one step build." 2026-11-24 "They click the
sign up button and it takes them to the sign up and pay page", and no Stripe Dashboard or
Stripe config change. Every **Sign up** on the site opens `/app/?start=signup`, the
sign-up-and-pay page: the visitor ticks the Terms box there, pays $99 in Stripe Checkout
(email and card), and comes back signed in. The account is made only after the payment,
from the email Stripe collected. Everything new is **off** until both flags are on.

## Flags (both must be on)

| Flag | Where | Default |
|---|---|---|
| `access_policy_settings.pay_first_signup_enabled` | database | `false` |
| `VITE_PAY_FIRST_SIGNUP_ENABLED` | site build | unset (off); `"true"` in `.github/workflows/deploy-gh-pages.yml` since 2026-11-24 |

Build flag off: the sign-in screen is exactly as today (`?start=signup` is ignored).
Build flag on: the Clerk form only signs in, always. There is no account-first fallback:
if the database flag is off, the offer is paused or Sign up is refused (`signup_disabled`),
the page says "Sign up is not open right now" and Log in still works.

Database flag on: `initialize_clerk_profile` makes no new profile unless that email has a
paid pay-first hold or an unclaimed owner lifetime gift
(`20261124120000_pay_first_profile_gate.sql`, answer `signup_requires_payment`;
clerk-webhook acknowledges it with 200 so Clerk does not resend). So a Clerk user made any
other way (Clerk's hosted pages, its API) gets no app account without paying. Existing
accounts and legacy continuity members sign in as before.

## How it works

1. **Start** (`public-signup-checkout`, no sign-in): `hold_pay_first_founding` holds one
   founding place under lock 8222 (the lock every claim and settlement takes), with rate
   limits inside the lock, then Checkout opens (`flow: 'pay_first'`, the reviewed
   renewal terms as the submit text, 2 hours, no recovery link). The start refuses
   (`terms_required`) unless our page sent the Terms tick; the hold stores the reviewed
   consent (version, text, hash), which `adopt` checks again. Checkout itself asks for no
   Terms tick (`consent_collection` needs a Dashboard Terms URL; not used).
2. **Provision** (one function, four callers: webhook, the payer's return, a 5-minute
   sweep, Admin > Accounts **Finish paid sign-up**): lease per hold, fresh Stripe read
   (complete, paid, matching app/catalog/mode), Clerk lookup before any
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

## Deploy order

1. Migration `20261120190000_pay_first_signup.sql` (flag column default off). Approved for
   production 2026-11-24 as targeted SQL with the flag off (owner: "Yes, do the backend prep
   with the flag off").
2. Functions: `public-signup-checkout` and `public-signup-status` (both `--no-verify-jwt`),
   `limited-stripe-webhook`, `email-inbound`, `owner-notify`. Approved 2026-11-24, flag off.
3. At go-live only (owner's own words first): migration `20261124120000_pay_first_profile_gate.sql`,
   then `initialize-clerk-profile` and `clerk-webhook` (they know `signup_requires_payment`).
   Not applied with the prep: it replaces the sign-in routine and does nothing while the flag is off.
4. **No Stripe Dashboard change.** The Terms tick is on our page. `checkout.session.completed`
   and `checkout.session.expired` are already sent. The dispute alert only fires if the
   endpoint also sends `charge.dispute.created`; that is optional and not part of this build.
5. Site build with `VITE_PAY_FIRST_SIGNUP_ENABLED=true`, then turn on the database flag (owner's
   own words for each). Between the two, Sign up says it is not open; Log in works.
   Owner approved go-live 2026-11-24 ("Yes, have Claude take the one-step sign-up live"):
   the build flag is the `VITE_PAY_FIRST_SIGNUP_ENABLED: "true"` line in the deploy
   workflow's build env, and the database flag is turned on as soon as that build serves.

## Rollback

1. `update access_policy_settings set pay_first_signup_enabled=false where singleton;`
   Sign up stops and new unpaid profiles are allowed again at once; with the pay-first
   site build still up, Sign up says it is not open until step 3.
2. Leave the functions and the sweep deployed until Admin > Accounts shows no paid sign-up
   to finish.
3. Revert the site build (remove the `VITE_PAY_FIRST_SIGNUP_ENABLED` line from the deploy
   workflow, or revert the merge).
4. `docs/rollback/20261124120000_pay_first_profile_gate.rollback.sql` (if it was applied), then
   `docs/rollback/20261120190000_pay_first_signup.rollback.sql` (refuses while the gate exists,
   or while any hold is paid but unfinished, or still open).
