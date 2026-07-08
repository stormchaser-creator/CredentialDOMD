# CredentialDOMD — Current State

## UPDATE 2026-07-08 — autonomy prep session (Claude, Studio)

**Done this session (no credentials needed):**
- `founding-count` edge function fixed: counts `tier='founding'` active subs, cap 100 (was legacy `pro/practice` + 333). Source fixed; **still needs deploy**.
- `PricingModal.jsx` founding-counter fetch now hits the Supabase functions URL directly — the old relative `/api/founding/count` could never work on static GitHub Pages, so the founding tier was permanently invisible.
- All 12 marketing docs synced to Architecture D ($12/100/24-mo lock); fabricated "12 signed up in week one" claim removed; `COMPETITIVE_PRICING.md` + `LAUNCH_PLAYBOOK.md` banner-marked SUPERSEDED.
- AutoAIBiz venture config (venture.yaml, use-cases.yaml, outreach templates) synced to Architecture D — agents no longer quote $1.99.
- AutoAIBiz learning daemon installed as launchd service (`com.autoaibiz.learning`); venture competence 9/13 → 11/13 (ledger + maven fixed; compass + justice still short of "competent").
- Supabase CLI + Stripe CLI installed on the Studio (were absent).
- NOTE: remote main had a full **Clerk auth migration** (phases 1–3) the Studio checkout didn't have; local work rebased on top and pushed. Sections below describing "Supabase Auth" are pre-Clerk.

**Eric's remaining launch steps (in order, ~1 hour):**
1. `stripe login`
2. `cd ~/Projects/CredentialDOMD && STRIPE_MODE=test ./scripts/create-stripe-products.sh` → verify → run live
3. Stripe dashboard → Webhooks → add `https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/stripe-webhook` (checkout.session.completed, customer.subscription.updated, customer.subscription.deleted) → copy `whsec_…`
4. `supabase login`
5. `export STRIPE_SECRET_KEY=sk_live_… STRIPE_WEBHOOK_SECRET=whsec_… && ./scripts/set-supabase-secrets.sh`
6. `./scripts/deploy-functions.sh` (deploys the fixed founding-count too)
7. Test purchase with a Stripe test card; confirm row lands in `subscriptions`

---

**Date:** 2026-05-04
**Author:** Cowork session (Claude), reading the actual repo (no carryover from prior summaries)
**Purpose:** ground-truth status so Eric can decide next steps

---

## TL;DR

The app is built and deployed. Pricing model is **Architecture D (May 2026)** — 8 tiers, round-dollar prices, no $1.99 / no charm pricing. Founding tier is **$12/mo locked 24 months for first 100 physicians** (not $1.99 — that was a pre-Architecture-D model). **Cannot take a real payment today.** Stripe products are scaffolded in code but have not been created in the live Stripe account; webhooks and secrets are not yet wired. There is one inconsistency in the founding-count edge function that should be fixed before launch.

---

## Pricing as it exists in the repo today

Source of truth: `src/utils/pricingEngine.js` and `src/utils/pricingConstants.js`.

| Tier | Display | Monthly cents | Annual cents | Stripe lookup_key | Notes |
|------|---------|---------------|--------------|-------------------|-------|
| Free | $0 | 0 | 0 | `free_zero_v1` | 5 credential cap. Forever-free. |
| Resident / Fellow | Free | 0 | 0 | `resident_free_v1` | Requires ACGME/AOA verification. Auto-converts to Solo 90 days post-grad. |
| **Founding Physician** | **$12/mo** or $120/yr | **1200** | **12000** | `founding_monthly_usd_v1` / `founding_annual_usd_v1` | First 100 physicians. **24-month lock.** Hidden until ≥10 claimed (`FOUNDING_COUNTER_VISIBILITY_THRESHOLD = 10`). Auto-converts to Solo at month 25. |
| Solo | $19/mo or $190/yr | 1900 | 19000 | `solo_monthly_usd_v1` / `solo_annual_usd_v1` | 14-day trial. |
| Locum | $29/mo or $290/yr | 2900 | 29000 | `locum_monthly_usd_v1` / `locum_annual_usd_v1` | Recommended tier. Eric is customer #1 per commit `37472c7`. |
| Practice | $39/provider/mo annual | n/a | 39000/seat | `practice_annual_per_seat_usd_v1` | 2–25 seats. Annual only. |
| Group | $29/provider/mo annual | n/a | 29000/seat | `group_annual_per_seat_usd_v1` | 26–100 seats. Annual only. |
| Enterprise | Contact sales | n/a | n/a | n/a | 100+ seats. |

Constants (from `pricingConstants.js`):

- `FOUNDING_COHORT_CAP = 100`
- `FOUNDING_LOCK_MONTHS = 24`
- `FOUNDING_COUNTER_VISIBILITY_THRESHOLD = 10`
- `TRIAL_DAYS_INDIVIDUAL = 14`
- `FREE_CREDENTIAL_LIMIT = 5`
- `ANNUAL_DISCOUNT_PCT = 16.67` ("Get 2 months free")

> **The "first $1.99" claim from a prior summary is stale.** It came from
> commit `ec722a9` ("Pricing: full tier ladder 1-333 spots, $1.99 to $7.99,
> then $11.99 after 333"). That model was replaced by Architecture D in
> commit `31aac16` ("Architecture D pricing + SEO foundation + Stripe
> scaffold"). The header of `pricingEngine.js` is explicit: *"No $X.99
> charm pricing — round-9 only ($19, $29, $39, $99, $190). Replaces legacy
> cohort-based ($4.99→$14.99) ... pricing model from previous version."*
> `COMPETITIVE_PRICING.md` (dated 2026-03-19) still describes the old
> model and is now out of date relative to the code.

---

## What works end-to-end right now

Can do today with no further work:

- **Static landing pages** — built (`landing/`, plus per-state pages routed via `vercel.json` and `netlify.toml`).
- **Auth + sign-up** — Supabase Auth on project `hkpnnsjcwprrwobmpqyy`. The `.env` has live `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.
- **Free tier app experience** — license/DEA/CME tracking up to 5 credentials, all 50 states, email reminders. All client-side via Supabase.
- **Locum tier features in code** — multi-state license matrix, IMLC compact tracker, agency share, deduction memo (commit `37472c7`).
- **Frontend pricing modal** — `PricingModal.jsx` reads from `pricingEngine.js` and respects the founding visibility threshold.
- **NPI proxy edge function** (`npi-proxy`) — appears deployable, no Stripe dependency.
- **AI document scanning + CV generation** — Gemini-keyed (`VITE_GEMINI_API_KEY`), client-side. (Note: prod plan calls for backend proxy; see `.env.example`.)
- **CI auto-deploy to gh-pages on `main`** (commit `91d6b04`).

---

## What is NOT working — and what's needed to take a real payment

### Block 1: Stripe products and prices have not been created in Stripe

**Evidence:**
- `scripts/create-stripe-products.sh` exists and is fully written for both `live` and `test` modes.
- `scripts/stripe-products-live.json` and `scripts/stripe-products-test.json` **do not exist** → the script has not been run successfully.
- `.env` does not contain any `price_…` values; Architecture D resolves prices via Stripe `lookup_key` server-side instead, so the React app doesn't need them, but Stripe must still have the products.

**To fix:**
1. Authenticate Stripe CLI: `stripe login` (or `stripe login --interactive` and grant Products/Prices/Coupons write).
2. Run the script in test mode first:
   ```bash
   cd ~/Projects/CredentialDOMD
   STRIPE_MODE=test ./scripts/create-stripe-products.sh
   ```
3. Verify the resulting `scripts/stripe-products-test.json`.
4. Run live: `./scripts/create-stripe-products.sh` (defaults to live mode).

### Block 2: Stripe secrets not set in Supabase

**Evidence:**
- `scripts/set-supabase-secrets.sh` requires `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` env vars to be set in shell first; there is no record of it having been run.
- The `create-checkout-session` edge function reads `STRIPE_SECRET_KEY` from the Deno env and will 500 without it.

**To fix:**
1. Get `sk_live_…` from `dashboard.stripe.com/apikeys`.
2. Create the webhook endpoint in Stripe dashboard pointing at
   `https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/stripe-webhook` with
   events `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted` (per `STRIPE-SETUP.md`). Copy the resulting
   `whsec_…` signing secret.
3. ```bash
   export STRIPE_SECRET_KEY=sk_live_…
   export STRIPE_WEBHOOK_SECRET=whsec_…
   ./scripts/set-supabase-secrets.sh
   ```

### Block 3: Edge functions not deployed

**Evidence:**
- `scripts/deploy-functions.sh` exists; comments explicitly say "Run this after getting your Stripe price IDs and Supabase access token."
- The function source is in `supabase/functions/{create-checkout-session, customer-portal, stripe-webhook, npi-proxy, founding-count, send-onboarding-email}/index.ts` — written, not deployed.

**To fix:**
```bash
cd ~/Projects/CredentialDOMD
./scripts/deploy-functions.sh
```

### Block 4: founding-count edge function is out of date with Architecture D

**Evidence — `supabase/functions/founding-count/index.ts`:**
```ts
.in("status", ["pro", "practice"])         // legacy tier names
JSON.stringify({ claimed: count ?? 0, total: 333 })   // 333, not 100
```

But Architecture D uses tier names `founding | solo | locum | practice | group`,
and `FOUNDING_COHORT_CAP = 100`. Server-side enforcement in
`create-checkout-session/index.ts` correctly uses 100, but the public
counter would mis-display. Frontend reads `total` from this endpoint.

**To fix:** update `founding-count/index.ts` to count rows where the
subscription's product/lookup_key is one of
`founding_monthly_usd_v1` / `founding_annual_usd_v1` (or where the linked
`tier` is `founding`), and return `total: 100`. Then redeploy.

### Block 5: production environment values

`.env.example` lists `VITE_GEMINI_API_KEY`, `VITE_NPI_PROXY_URL`, etc., but
the live `.env` only has Supabase. Whatever is missing here must also be set
in Vercel project settings before deploy.

---

## Concrete "take a real payment" sequence

Minimum viable path, in order:

1. ✅ Already done: Architecture D pricing in code, edge function source written, Supabase project provisioned with auth.
2. `stripe login` (Eric's account, EWAI per the script's `--live` banner).
3. `./scripts/create-stripe-products.sh` (live mode).
4. In Stripe dashboard → Webhooks: add endpoint, copy `whsec_…`.
5. Export `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, run `./scripts/set-supabase-secrets.sh`.
6. `./scripts/deploy-functions.sh`.
7. Fix `founding-count/index.ts` (cap=100, Architecture D tier names) and redeploy that function.
8. Test end-to-end with a Stripe test card on the deployed site (use a `STRIPE_MODE=test` run first, then live).
9. Confirm webhook receipt by inspecting `subscriptions` table in Supabase after a test purchase.

After that, the public funnel — Free → trial → Solo/Locum, or Founding-cohort
direct — is wired.

---

## What I deliberately did NOT do

- No code changes to CredentialDOMD this session (per Eric's instruction: "for #5, just deliver the status summary, no execution").
- Did not run `create-stripe-products.sh`, did not set Supabase secrets, did not deploy functions.
- Did not modify `COMPETITIVE_PRICING.md` despite it being out of date (separate decision).

---

## Files I read (so you can audit)

- `src/utils/pricingEngine.js`
- `src/utils/pricingConstants.js`
- `scripts/create-stripe-products.sh`
- `scripts/deploy-functions.sh`
- `scripts/set-supabase-secrets.sh`
- `supabase/functions/create-checkout-session/index.ts`
- `supabase/functions/founding-count/index.ts`
- `STRIPE-SETUP.md`
- `COMPETITIVE_PRICING.md` (noted as stale)
- `.env`, `.env.example`, `vercel.json`, `netlify.toml`, `CLAUDE.md`
- `git log --oneline -10` — last 10 commits
